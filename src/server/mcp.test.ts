import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { FeedbackStore } from './storage.js';
import { NeedMarkMcp, serveMcp, MCP_TOOLS } from './mcp.js';
import { input, codeContext } from '../../tests/fixtures.js';

const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true }))); });
async function setup() {
  const folder = await mkdtemp(join(tmpdir(), 'needmark-mcp-')); folders.push(folder);
  const store = new FeedbackStore(folder);
  return { store, mcp: new NeedMarkMcp(store, undefined, { pollMs: 20 }) };
}
const json = (result: { content: { type: string; text?: string }[] }) => JSON.parse(result.content[0]!.text!);
const textOf = (result: { content: { type: string; text?: string }[] }) => result.content[0]!.text!;

function client(mcp: NeedMarkMcp) {
  const stdin = new PassThrough(), stdout = new PassThrough();
  const done = serveMcp(mcp, stdin, stdout, '0.1.0');
  let buffer = '';
  const waiting = new Map<number, (value: unknown) => void>(), received: unknown[] = [];
  stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
      received.push(message); waiting.get(message.id)?.(message);
    }
  });
  let next = 1;
  return {
    received, done, end: () => stdin.end(), raw: (line: string) => stdin.write(line + '\n'),
    request: (method: string, params?: unknown) => new Promise<any>((resolve) => { const id = next++; waiting.set(id, resolve); stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); }),
    notify: (method: string, params?: unknown) => stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'),
  };
}

describe('MCP stdio protocol', () => {
  it('initializes, negotiates the protocol version and lists the tools', async () => {
    const { mcp } = await setup(), rpc = client(mcp);
    const init = await rpc.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    expect(init.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'needmark', version: '0.1.0' } });
    expect((await rpc.request('initialize', { protocolVersion: '1999-01-01' })).result.protocolVersion).toBe('2025-11-25');
    rpc.notify('notifications/initialized');
    const tools = await rpc.request('tools/list');
    expect(tools.result.tools.map((tool: { name: string }) => tool.name)).toEqual(MCP_TOOLS.map((tool) => tool.name));
    expect((await rpc.request('ping')).result).toEqual({});
    expect((await rpc.request('resources/list')).error.code).toBe(-32601);
    rpc.raw('{not json');
    rpc.end(); await rpc.done;
    expect(rpc.received).toContainEqual({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    expect(rpc.received.filter((message) => !(message as { id?: unknown }).id && (message as { id?: unknown }).id !== null)).toEqual([]);
  });

  it('answers in-flight calls after input ends but never answers an explicitly cancelled request', async () => {
    const { store, mcp } = await setup(); await store.save(input());
    const rpc = client(mcp);
    rpc.raw(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'needmark_watch', arguments: { timeoutSeconds: 30 } } }));
    rpc.raw(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'needmark_watch', arguments: { timeoutSeconds: 30 } } }));
    rpc.notify('notifications/cancelled', { requestId: 2 });
    rpc.raw(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'needmark_list_feedback', arguments: {} } }));
    rpc.end(); await rpc.done;
    const ids = rpc.received.map((message) => (message as { id: number }).id).sort();
    expect(ids).toEqual([1, 3]);
    expect(JSON.parse((rpc.received.find((message) => (message as { id: number }).id === 1) as { result: { content: { text: string }[] } }).result.content[0]!.text)).toMatchObject({ cancelled: true });
    expect(JSON.parse((rpc.received.find((message) => (message as { id: number }).id === 3) as { result: { content: { text: string }[] } }).result.content[0]!.text).count).toBe(1);
  });

  it('returns tool failures as isError results and keeps serving', async () => {
    const { mcp } = await setup(), rpc = client(mcp);
    const missing = await rpc.request('tools/call', { name: 'needmark_get_feedback', arguments: { id: '00000000-0000-4000-8000-000000000000' } });
    expect(missing.result).toEqual({ content: [{ type: 'text', text: 'Feedback not found' }], isError: true });
    const invalid = await rpc.request('tools/call', { name: 'needmark_get_feedback', arguments: { id: '../etc' } });
    expect(invalid.result).toMatchObject({ isError: true, content: [{ text: 'Invalid feedback ID' }] });
    expect((await rpc.request('tools/call', { name: 'nope', arguments: {} })).result.isError).toBe(true);
    expect((await rpc.request('tools/call', { name: 'needmark_list_feedback', arguments: { extra: 1 } })).result.content[0].text).toBe('Unknown argument: extra');
    expect((await rpc.request('tools/call', { arguments: {} })).error.code).toBe(-32602);
    rpc.end(); await rpc.done;
  });
});

describe('MCP tools', () => {
  it('lists open feedback, excludes references by default and filters by status', async () => {
    const { store, mcp } = await setup();
    const open = await store.save({ ...input(), category: 'fix' });
    const done = await store.save(input()); await store.setStatus(done.id, 'resolved');
    await store.save({ ...input(), intent: 'reference', comment: '', target: { ...input().target, code: codeContext() } });
    const list = json(await mcp.call('needmark_list_feedback'));
    expect(list.count).toBe(1);
    expect(list.feedback[0]).toMatchObject({ id: open.id, status: 'open', category: 'fix', comment: 'Move this button up', target: { selector: '#buy' } });
    expect(list.feedback[0].files.image).toBe(join(store.directory, open.id, 'screenshot.png'));
    expect(json(await mcp.call('needmark_list_feedback', { status: 'resolved' })).feedback.map((item: { id: string }) => item.id)).toEqual([done.id]);
    expect(json(await mcp.call('needmark_list_feedback', { status: 'all', includeReferences: true })).count).toBe(3);
    expect((await mcp.call('needmark_list_feedback', { status: 'later' })).isError).toBe(true);
  });

  it('returns the full record with the screenshot as image content', async () => {
    const { store, mcp } = await setup(), saved = await store.save(input());
    const result = await mcp.call('needmark_get_feedback', { id: saved.id });
    expect(json(result).feedback).toEqual(saved);
    expect(result.content[1]).toEqual({ type: 'image', mimeType: 'image/png', data: input().screenshot!.slice(22) });
    expect((await mcp.call('needmark_get_feedback', { id: saved.id, includeImage: false })).content).toHaveLength(1);
    const plain = await store.save({ ...input(), capture: { method: 'none', width: 0, height: 0 }, screenshot: undefined });
    expect((await mcp.call('needmark_get_feedback', { id: plain.id })).content).toHaveLength(1);
  });

  it('falls back to Agent when the reply author is blank', async () => {
    const { store, mcp } = await setup(), saved = await store.save(input());
    await mcp.call('needmark_reply', { id: saved.id, message: 'Checking', author: '  ' });
    expect((await store.read(saved.id)).replies![0]!.author).toBe('Agent');
  });

  it('replies and resolves with a summary', async () => {
    const { store, mcp } = await setup(), saved = await store.save(input());
    expect(json(await mcp.call('needmark_reply', { id: saved.id, message: 'Should this be 24px?' })).replies).toBe(1);
    const resolved = json(await mcp.call('needmark_resolve', { id: saved.id, summary: 'Set padding to 24px; tests pass.', author: 'Codex' }));
    expect(resolved).toMatchObject({ status: 'resolved', replies: 2 });
    expect((await store.read(saved.id)).replies!.map((reply) => [reply.author, reply.comment])).toEqual([['Agent', 'Should this be 24px?'], ['Codex', 'Set padding to 24px; tests pass.']]);
    expect(textOf(await mcp.call('needmark_reply', { id: saved.id }))).toBe('Missing message');
  });

  it('exports the shared repair prompt for selected or all open feedback', async () => {
    const { store, mcp } = await setup(), first = await store.save({ ...input(), comment: 'First' }), second = await store.save({ ...input(), comment: 'Second' });
    const all = textOf(await mcp.call('needmark_export_prompt', { detail: 'compact' }));
    expect(all).toContain('> First'); expect(all).toContain('> Second');
    const one = textOf(await mcp.call('needmark_export_prompt', { ids: [second.id] }));
    expect(one).toContain('> Second'); expect(one).not.toContain(first.id);
    expect((await mcp.call('needmark_export_prompt', { detail: 'huge' })).isError).toBe(true);
  });

  it('watch returns new open feedback in a batch and times out with an empty batch', async () => {
    const { store, mcp } = await setup(), existing = await store.save({ ...input(), comment: 'Old' });
    const timedOut = json(await mcp.call('needmark_watch', { timeoutSeconds: 1, batchSeconds: 0 }));
    expect(timedOut).toEqual({ timedOut: true, count: 0, feedback: [] });
    const watching = mcp.call('needmark_watch', { timeoutSeconds: 5, batchSeconds: 0.2 });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const first = await store.save({ ...input(), comment: 'New one' });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const second = await store.save({ ...input(), comment: 'New two' });
    await store.setStatus(existing.id, 'resolved');
    const batch = json(await watching);
    expect(batch.timedOut).toBe(false);
    expect(batch.feedback.map((item: { id: string }) => item.id).sort()).toEqual([first.id, second.id].sort());
  });

  it('watch can be cancelled', async () => {
    const { mcp } = await setup(), controller = new AbortController();
    const watching = mcp.call('needmark_watch', { timeoutSeconds: 30 }, controller.signal);
    controller.abort();
    expect(json(await watching)).toMatchObject({ cancelled: true, count: 0 });
  });
});
