import { afterEach, expect, it, vi } from 'vitest';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReviewApi, validateReviewOptions, type ReviewApiOptions } from './review-api.js';
import { input, codeContext } from '../../tests/fixtures.js';
import { formatFeedbackPrompt } from '../shared/prompt.js';
import { FeedbackStore } from './storage.js';
import type { FeedbackChangeEvent, FeedbackSubmission } from '../shared/types.js';
import type { NeedMarkLanguage } from '../shared/language.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function api(runtimeSource?: ReviewApiOptions['runtimeSource'], options: Partial<ReviewApiOptions> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'needmark-review-api-'))); cleanup.push(() => rm(root, { recursive: true, force: true }));
  let review: ReturnType<typeof createReviewApi>;
  const server = createServer((request, response) => { if (!review.handle(request, response)) { response.writeHead(404); response.end(); } });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  cleanup.push(() => new Promise<void>((done, reject) => { server.closeAllConnections(); server.close((error) => error ? reject(error) : done()); }));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  review = createReviewApi({ root, origins: [origin], runtimeSource, ...options });
  return { ...review, origin, root };
}

it('enables runtime source only for adapters that configure a resolver', async () => {
  const review = await api(); expect(review.scriptAttrs['data-needmark-runtime-source']).toBeUndefined();
  expect((await fetch(`${review.origin}/__needmark/source`, { method: 'POST', headers: { 'x-needmark-token': review.token }, body: '{}' })).status).toBe(404);
});

it('protects optional enrichment with the existing token/origin boundary and a smaller body limit', async () => {
  const resolve = vi.fn(async () => ({ elements: [{ sourceHint: { file: 'src/card.jsx' } }] }));
  const review = await api(resolve), endpoint = `${review.origin}/__needmark/source`, headers = { 'x-needmark-token': review.token };
  expect(review.scriptAttrs['data-needmark-runtime-source']).toBe('true');
  const deniedHeaders: Record<string, string>[] = [{}, { 'x-needmark-token': 'wrong' }, { ...headers, Origin: 'https://evil.example' }, { ...headers, 'sec-fetch-site': 'cross-site' }];
  for (const denied of deniedHeaders) {
    expect((await fetch(endpoint, { method: 'POST', headers: denied, body: '{}' })).status).toBe(403);
  }
  expect(resolve).not.toHaveBeenCalled();
  for (const body of ['invalid JSON', JSON.stringify({ elements: [], padding: 'x'.repeat(128 * 1024) })]) {
    expect((await fetch(endpoint, { method: 'POST', headers, body })).status).toBe(400);
  }
  expect(resolve).not.toHaveBeenCalled();
  const result = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ elements: [] }) });
  expect(result.status).toBe(200); expect(await result.json()).toEqual({ elements: [{ sourceHint: { file: 'src/card.jsx' } }] });
  expect(resolve).toHaveBeenCalledWith({ elements: [] });
  const saved = await fetch(`${review.origin}/__needmark/feedback`, { method: 'POST', headers, body: JSON.stringify({ ...input(), url: review.origin, screenshot: undefined, capture: { method: 'none', width: 0, height: 0 } }) });
  expect(saved.status).toBe(201);
});


const savedInput = (origin: string) => ({ ...input(), url: origin, screenshot: undefined, capture: { method: 'none', width: 0, height: 0 } });

it('saves and lists target references and emits mutation hooks while refusing conversion or comment editing', async () => {
  const onFeedbackChange = vi.fn(), review = await api(undefined, { onFeedbackChange }), headers = { 'x-needmark-token': review.token };
  const endpoint = `${review.origin}/__needmark/feedback`, store = new FeedbackStore(join(review.root, '.needmark/feedback'));
  const created = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ ...savedInput(review.origin), intent: 'reference', comment: ' ' }) });
  expect(created.status).toBe(201);
  const reference = await created.json();
  expect(reference).toMatchObject({ intent: 'reference', comment: '', status: 'open' });
  await vi.waitFor(() => expect(onFeedbackChange).toHaveBeenCalledTimes(1));
  expect(onFeedbackChange.mock.calls[0]![0]).toMatchObject({ type: 'created', feedback: { id: reference.id, intent: 'reference', comment: '' } });
  expect((await (await fetch(endpoint, { headers })).json()).feedback).toEqual([reference]);
  for (const patch of [{ comment: 'Change the target' }, { comment: '' }, { intent: undefined, comment: 'Convert it' }, { intent: 'feedback' }]) {
    expect((await fetch(`${endpoint}/${reference.id}`, { method: 'PATCH', headers, body: JSON.stringify(patch) })).status).toBe(400);
  }
  expect(onFeedbackChange).toHaveBeenCalledTimes(1);
  expect(await store.read(reference.id)).toEqual(reference);
  const changed = await fetch(`${endpoint}/${reference.id}`, { method: 'PATCH', headers, body: JSON.stringify({ author: 'Another reviewer', status: 'resolved' }) });
  expect(changed.status).toBe(200);
  const threaded = await fetch(`${endpoint}/${reference.id}/replies`, { method: 'POST', headers, body: JSON.stringify({ author: 'Reviewer', comment: 'Keep this selector' }) });
  expect(threaded.status).toBe(201);
  await vi.waitFor(() => expect(onFeedbackChange).toHaveBeenCalledTimes(3));
  expect(onFeedbackChange.mock.calls[2]![0]).toMatchObject({ type: 'updated', feedback: { intent: 'reference', comment: '', replies: [{ comment: 'Keep this selector' }] } });
  expect((await store.read(reference.id)).intent).toBe('reference');
});

it.each(['en', 'ja'] as const)('skips current disk references in %s handoff and keeps their images, threads and statuses intact', async (language) => {
  const onSubmit = vi.fn(), review = await api(undefined, { onSubmit, language }), headers = { 'x-needmark-token': review.token };
  const store = new FeedbackStore(join(review.root, '.needmark/feedback'));
  const repair = await store.save({ ...input(), url: review.origin }), externallyChanged = await store.save({ ...input(), url: review.origin });
  const reference = await store.save({ ...input(), url: review.origin, intent: 'reference', comment: '', target: { ...input().target, selector: '#saved-reference' } });
  await store.addReply(reference.id, { author: 'Reviewer', comment: 'Reference reply only' });
  await store.setStatus(reference.id, 'resolved');
  const changedPath = join(store.directory, externallyChanged.id, 'context.json');
  await writeFile(changedPath, JSON.stringify({ ...externallyChanged, intent: 'reference', comment: '' }));
  const files = [reference.id, externallyChanged.id].flatMap((id) => ['context.json', 'comment.md', 'screenshot.png'].map((file) => join(store.directory, id, file)));
  const before = await Promise.all(files.map((file) => readFile(file)));
  const response = await fetch(`${review.origin}/__needmark/submit`, { method: 'POST', headers,
    body: JSON.stringify({ ids: [reference.id, repair.id, externallyChanged.id], detail: 'forensic', language }) });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ submitted: [repair.id], skipped: [reference.id, externallyChanged.id] });
  expect(onSubmit).toHaveBeenCalledTimes(1);
  const payload = onSubmit.mock.calls[0]![0];
  expect(payload.feedback).toEqual([repair]);
  expect(payload.prompt).toBe(formatFeedbackPrompt([repair], review.directory, 'forensic', language));
  expect(payload.prompt).not.toContain(reference.id);
  expect(payload.prompt).not.toContain(externallyChanged.id);
  expect(payload.prompt).not.toContain('Reference reply only');
  expect(await Promise.all(files.map((file) => readFile(file)))).toEqual(before);
  expect((await store.read(reference.id)).status).toBe('resolved');
});

it('rejects a reference-only submission without invoking onSubmit or changing its saved evidence', async () => {
  const onSubmit = vi.fn(), review = await api(undefined, { onSubmit }), headers = { 'x-needmark-token': review.token };
  const store = new FeedbackStore(join(review.root, '.needmark/feedback'));
  const reference = await store.save({ ...input(), url: review.origin, intent: 'reference', comment: '' });
  const files = ['context.json', 'comment.md', 'screenshot.png'].map((file) => join(store.directory, reference.id, file));
  const before = await Promise.all(files.map((file) => readFile(file)));
  const response = await fetch(`${review.origin}/__needmark/submit`, { method: 'POST', headers,
    body: JSON.stringify({ ids: [reference.id], detail: 'standard' }) });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: 'No repair requests selected' });
  expect(onSubmit).not.toHaveBeenCalled();
  expect(await Promise.all(files.map((file) => readFile(file)))).toEqual(before);
});

it('validates every selected reference on disk before filtering instead of silently ignoring corrupt records', async () => {
  const onSubmit = vi.fn(), review = await api(undefined, { onSubmit, logger: { error: vi.fn() } }), headers = { 'x-needmark-token': review.token };
  const store = new FeedbackStore(join(review.root, '.needmark/feedback'));
  const repair = await store.save(savedInput(review.origin));
  const reference = await store.save({ ...savedInput(review.origin), intent: 'reference', comment: '' });
  const path = join(store.directory, reference.id, 'context.json');
  const send = (ids: string[]) => fetch(`${review.origin}/__needmark/submit`, { method: 'POST', headers, body: JSON.stringify({ ids, detail: 'compact' }) });
  await writeFile(path, JSON.stringify({ ...reference, comment: 'An invalid repair hidden in a reference' }));
  expect((await send([repair.id, reference.id])).status).toBe(400);
  expect((await send([reference.id])).status).toBe(400);
  await writeFile(path, '{');
  expect((await send([repair.id, reference.id])).status).toBe(500);
  await writeFile(path, JSON.stringify({ ...reference, intent: 'unknown' }));
  expect((await send([repair.id, reference.id])).status).toBe(400);
  expect(onSubmit).not.toHaveBeenCalled();
  expect(await store.read(repair.id)).toEqual(repair);
});

it.each(['en', 'ja'] as const)('passes configured %s language through the protected widget script without changing saved feedback', async (language) => {
  const review = await api(undefined, { language });
  expect(review.scriptAttrs['data-needmark-language']).toBe(language);
  const response = await fetch(`${review.origin}/__needmark/feedback`, { method: 'POST', headers: { 'x-needmark-token': review.token }, body: JSON.stringify(savedInput(review.origin)) });
  expect(response.status).toBe(201);
  const feedback = await response.json();
  expect(feedback.comment).toBe(input().comment.trim());
  expect(feedback).not.toHaveProperty('language');
});

it('keeps missing-language configurations on Japanese and rejects values outside the exact supported languages', async () => {
  const review = await api();
  expect(review.scriptAttrs['data-needmark-language']).toBe('ja');
  expect(validateReviewOptions({ origins: [review.origin] })).toMatchObject({ language: 'ja' });
  for (const language of ['EN', 'fr', ' ja', 'en-US', '', null, true, ['en']]) {
    expect(() => createReviewApi({ root: review.root, origins: [review.origin], language } as unknown as ReviewApiOptions)).toThrow('Invalid NeedMark language');
  }
});

it('keeps submission absent without a configured handler and rejects invalid callback options', async () => {
  const review = await api();
  expect(review.scriptAttrs['data-needmark-submit']).toBeUndefined();
  expect((await fetch(`${review.origin}/__needmark/submit`, { method: 'POST', headers: { 'x-needmark-token': review.token }, body: '{}' })).status).toBe(404);
  for (const name of ['onSubmit', 'onFeedbackChange']) {
    expect(() => createReviewApi({ root: review.root, origins: [review.origin], [name]: true } as unknown as ReviewApiOptions)).toThrow(`Invalid NeedMark ${name} callback`);
  }
});

it('emits committed changes for comments, replies, deletion and partial clear without exposing mutable API objects', async () => {
  const observed: FeedbackChangeEvent[] = [];
  const onFeedbackChange = vi.fn((event: FeedbackChangeEvent) => {
    observed.push(structuredClone(event));
    if (event.type === 'created' || event.type === 'updated') event.feedback.comment = 'Mutation by consumer';
  });
  const review = await api(undefined, { onFeedbackChange });
  const endpoint = `${review.origin}/__needmark/feedback`, headers = { 'x-needmark-token': review.token };
  const store = new FeedbackStore(join(review.root, '.needmark/feedback'));
  const created = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(savedInput(review.origin)) });
  expect(created.status).toBe(201);
  const item = await created.json();
  expect(item.comment).toBe(input().comment.trim());
  expect((await store.read(item.id)).comment).toBe(input().comment.trim());
  await vi.waitFor(() => expect(observed[0]).toMatchObject({ type: 'created', directory: review.directory, feedback: { id: item.id, comment: input().comment.trim() } }));
  const patch = await fetch(`${endpoint}/${item.id}`, { method: 'PATCH', headers, body: JSON.stringify({ status: 'resolved' }) });
  expect(patch.status).toBe(200); expect((await patch.json()).comment).toBe(input().comment.trim());
  const added = await (await fetch(`${endpoint}/${item.id}/replies`, { method: 'POST', headers, body: JSON.stringify({ author: 'AI', comment: 'Fixed' }) })).json();
  const reply = added.replies[0].id;
  expect((await fetch(`${endpoint}/${item.id}/replies/${reply}`, { method: 'PATCH', headers, body: JSON.stringify({ comment: 'Verified' }) })).status).toBe(200);
  expect((await fetch(`${endpoint}/${item.id}/replies/${reply}`, { method: 'DELETE', headers })).status).toBe(200);
  expect((await fetch(`${endpoint}/${item.id}`, { method: 'DELETE', headers })).status).toBe(200);
  const good = await store.save(savedInput(review.origin)), broken = await store.save(savedInput(review.origin));
  await rm(join(store.directory, broken.id, 'context.json'));
  const cleared = await fetch(endpoint, { method: 'DELETE', headers, body: JSON.stringify({ scope: 'all' }) });
  expect(cleared.status).toBe(207);
  const result = await cleared.json();
  await vi.waitFor(() => expect(observed).toHaveLength(7));
  expect(observed.map((event) => event.type)).toEqual(['created', 'updated', 'updated', 'updated', 'updated', 'deleted', 'cleared']);
  expect(observed[2]).toMatchObject({ type: 'updated', feedback: { replies: [{ comment: 'Fixed' }] } });
  expect(observed[3]).toMatchObject({ type: 'updated', feedback: { replies: [{ comment: 'Verified' }] } });
  expect(observed[4]).toMatchObject({ type: 'updated', feedback: { replies: [] } });
  expect(observed[5]).toEqual({ type: 'deleted', directory: review.directory, id: item.id });
  expect(observed[6]).toEqual({ type: 'cleared', directory: review.directory, result });
  expect(result).toMatchObject({ deleted: [good.id], failed: [{ id: broken.id, error: expect.any(String) }] });
  expect(onFeedbackChange).toHaveBeenCalledTimes(7); // Direct CLI/store changes do not invoke configured API hooks.
});

it.each(['throw', 'reject', 'pending'] as const)('isolates a %s mutation hook from local saving and the successful response', async (failure) => {
  const logger = { error: vi.fn(() => { throw new Error('Logger failure'); }) };
  const onFeedbackChange = vi.fn(() => {
    if (failure === 'throw') throw new Error('secret hook failure');
    return failure === 'reject' ? Promise.reject(new Error('secret hook failure')) : new Promise<void>(() => {});
  });
  const review = await api(undefined, { onFeedbackChange, logger }), headers = { 'x-needmark-token': review.token };
  const response = await fetch(`${review.origin}/__needmark/feedback`, { method: 'POST', headers, body: JSON.stringify(savedInput(review.origin)) });
  expect(response.status).toBe(201);
  const saved = await response.json();
  expect(saved.comment).toBe(input().comment.trim());
  expect((await new FeedbackStore(join(review.root, '.needmark/feedback')).read(saved.id)).comment).toBe(input().comment.trim());
  await vi.waitFor(() => expect(onFeedbackChange).toHaveBeenCalledTimes(1));
  if (failure !== 'pending') await vi.waitFor(() => expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('secret hook failure')));
  expect(JSON.stringify(saved)).not.toContain('secret hook failure');
});

it('does not notify mutation hooks after invalid writes or failed deletions', async () => {
  const onFeedbackChange = vi.fn(), review = await api(undefined, { onFeedbackChange }), headers = { 'x-needmark-token': review.token };
  const endpoint = `${review.origin}/__needmark/feedback`;
  expect((await fetch(endpoint, { method: 'POST', headers, body: '{}' })).status).toBe(400);
  expect((await fetch(`${endpoint}/10000000-0000-0000-0000-000000000000`, { method: 'DELETE', headers })).status).toBe(404);
  expect(onFeedbackChange).not.toHaveBeenCalled();
});

it('protects handoff and rejects malformed IDs, detail, forged payloads and oversized requests before invoking it', async () => {
  const onSubmit = vi.fn(), review = await api(undefined, { onSubmit }), endpoint = `${review.origin}/__needmark/submit`, headers = { 'x-needmark-token': review.token };
  expect(review.scriptAttrs['data-needmark-submit']).toBe('true');
  const deniedHeaders: Record<string, string>[] = [{}, { 'x-needmark-token': 'wrong' }, { ...headers, Origin: 'https://evil.example' }, { ...headers, 'sec-fetch-site': 'cross-site' }];
  for (const denied of deniedHeaders) expect((await fetch(endpoint, { method: 'POST', headers: denied, body: '{}' })).status).toBe(403);
  const id = '10000000-0000-0000-0000-000000000000';
  for (const body of [null, [], {}, { ids: [], detail: 'standard' }, { ids: [id], detail: ['standard'] }, { ids: [id], detail: { value: 'standard' } }, { ids: [id], detail: 'brief' }, { ids: [id] },
    { ids: [id, id], detail: 'standard' }, { ids: ['../context.json'], detail: 'standard' }, { ids: Array(1001).fill(id), detail: 'standard' },
    { ids: [id], detail: 'standard', prompt: 'forged' }, { ids: [id], detail: 'standard', directory: '/secret' }, { ids: [id], detail: 'standard', destination: 'https://evil.example' },
    { ids: [id], detail: 'standard', padding: 'x'.repeat(64 * 1024) }]) {
    expect((await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) })).status).toBe(400);
  }
  expect(onSubmit).not.toHaveBeenCalled();
});

it.each([
  { config: undefined, selected: undefined, expected: 'en' },
  { config: 'en', selected: undefined, expected: 'en' },
  { config: 'ja', selected: undefined, expected: 'ja' },
  { config: undefined, selected: 'ja', expected: 'ja' },
  { config: 'ja', selected: 'en', expected: 'en' },
  { config: 'en', selected: 'ja', expected: 'ja' },
] as { config?: NeedMarkLanguage; selected?: NeedMarkLanguage; expected: NeedMarkLanguage }[])('formats handoff language $expected from config $config and browser $selected without editing saved evidence', async ({ config, selected, expected }) => {
  const onSubmit = vi.fn(async (_submission: FeedbackSubmission) => {}), review = await api(undefined, { language: config, onSubmit });
  const store = new FeedbackStore(join(review.root, '.needmark/feedback')), saved = await store.save({ ...input(), url: review.origin });
  const files = ['context.json', 'comment.md', 'screenshot.png'].map((file) => join(store.directory, saved.id, file));
  const before = await Promise.all(files.map((file) => readFile(file)));
  const body = { ids: [saved.id], detail: 'standard', ...(selected ? { language: selected } : {}) };
  const response = await fetch(`${review.origin}/__needmark/submit`, { method: 'POST', headers: { 'x-needmark-token': review.token }, body: JSON.stringify(body) });
  expect(response.status).toBe(200);
  expect(onSubmit).toHaveBeenCalledTimes(1);
  const payload = onSubmit.mock.calls[0]![0];
  expect(payload.prompt).toBe(formatFeedbackPrompt([saved], review.directory, 'standard', expected));
  if (selected || config) expect(payload.language).toBe(expected);
  else expect(payload).not.toHaveProperty('language');
  expect(await Promise.all(files.map((file) => readFile(file)))).toEqual(before);
});

it.each(['fr', 'EN', '', null, ['en'], { value: 'en' }].map((language) => ({ language })))('rejects malformed handoff language $language before invoking the configured callback', async ({ language }) => {
  const onSubmit = vi.fn(), review = await api(undefined, { onSubmit }), store = new FeedbackStore(join(review.root, '.needmark/feedback'));
  const saved = await store.save(savedInput(review.origin));
  const response = await fetch(`${review.origin}/__needmark/submit`, { method: 'POST', headers: { 'x-needmark-token': review.token },
    body: JSON.stringify({ ids: [saved.id], detail: 'standard', language }) });
  expect(response.status).toBe(400);
  expect(onSubmit).not.toHaveBeenCalled();
  expect(await store.read(saved.id)).toEqual(saved);
});

it('reads current disk feedback and statuses, waits for handoff, and preserves comments/images after completion', async () => {
  let complete!: () => void;
  const pending = new Promise<void>((done) => { complete = done; });
  const onSubmit = vi.fn((submission: FeedbackSubmission) => { submission.feedback[0]!.comment = 'Mutation by handler'; return pending; });
  const review = await api(undefined, { onSubmit }), headers = { 'x-needmark-token': review.token };
  const store = new FeedbackStore(join(review.root, '.needmark/feedback'));
  const open = await store.save({ ...input(), url: review.origin }), working = await store.save(savedInput(review.origin)), resolved = await store.save(savedInput(review.origin));
  await store.setStatus(resolved.id, 'resolved');
  const before = JSON.parse(await readFile(join(store.directory, open.id, 'context.json'), 'utf8'));
  before.comment = 'Current comment from Git';
  await writeFile(join(store.directory, open.id, 'context.json'), JSON.stringify(before));
  const selected = [resolved.id, open.id, working.id];
  let finished = false;
  const response = fetch(`${review.origin}/__needmark/submit`, { method: 'POST', headers, body: JSON.stringify({ ids: selected, detail: 'detailed' }) }).then((value) => { finished = true; return value; });
  await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
  expect(finished).toBe(false);
  const payload = onSubmit.mock.calls[0]![0];
  expect(payload.feedback.map((item) => item.id)).toEqual([open.id, working.id]);
  expect(payload.prompt).toContain('> Current comment from Git');
  expect(payload.prompt).toContain(`${review.directory}/${open.id}/screenshot.png`);
  expect(payload).toMatchObject({ directory: review.directory, detail: 'detailed' });
  complete();
  const sent = await response; expect(sent.status).toBe(200);
  expect(await sent.json()).toEqual({ submitted: [open.id, working.id], skipped: [resolved.id] });
  expect((await store.read(open.id)).comment).toBe('Current comment from Git');
  expect((await store.read(open.id)).status).toBe('open'); expect((await store.image(open.id)).length).toBeGreaterThan(0);
  expect((await store.read(working.id)).status).toBe('open');
});

it('submits compact output from the shared formatter without changing persisted context, images or statuses', async () => {
  const submissions: FeedbackSubmission[] = [];
  const onSubmit = vi.fn((payload: FeedbackSubmission) => { submissions.push(structuredClone(payload)); });
  const review = await api(undefined, { onSubmit }), headers = { 'x-needmark-token': review.token };
  const store = new FeedbackStore(join(review.root, '.needmark/feedback'));
  const selected = await store.save({ ...input(), url: review.origin, target: { ...input().target, code: codeContext() } });
  const working = await store.setStatus(selected.id, 'open');
  const closed = await store.save(savedInput(review.origin)); await store.setStatus(closed.id, 'resolved');
  const files = ['context.json', 'comment.md', 'screenshot.png'].map((file) => join(store.directory, selected.id, file));
  files.push(join(store.directory, closed.id, 'context.json'), join(store.directory, closed.id, 'comment.md'));
  const before = await Promise.all(files.map((file) => readFile(file)));
  const response = await fetch(`${review.origin}/__needmark/submit`, { method: 'POST', headers,
    body: JSON.stringify({ ids: [selected.id, closed.id], detail: 'compact' }) });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ submitted: [selected.id], skipped: [closed.id] });
  expect(onSubmit).toHaveBeenCalledTimes(1);
  const payload = submissions[0]!;
  expect(payload).toMatchObject({ directory: review.directory, detail: 'compact', feedback: [working] });
  expect(payload.prompt).toBe(formatFeedbackPrompt([working], review.directory, 'compact'));
  expect(payload.prompt).toContain(`> ${working.comment}`);
  expect(payload.prompt).toContain(`${review.directory}/${selected.id}/context.json`);
  expect(payload.prompt).toContain(`${review.directory}/${selected.id}/screenshot.png`);
  expect(await Promise.all(files.map((file) => readFile(file)))).toEqual(before);
  expect((await store.read(selected.id)).status).toBe('open');
});

it('validates every selected disk item before any handoff and rejects a closed-only selection', async () => {
  const onSubmit = vi.fn(), logger = { error: vi.fn() }, review = await api(undefined, { onSubmit, logger }), headers = { 'x-needmark-token': review.token };
  const store = new FeedbackStore(join(review.root, '.needmark/feedback')), good = await store.save(savedInput(review.origin)), broken = await store.save(savedInput(review.origin));
  const submit = (ids: string[]) => fetch(`${review.origin}/__needmark/submit`, { method: 'POST', headers, body: JSON.stringify({ ids, detail: 'standard' }) });
  expect((await submit([good.id, '10000000-0000-0000-0000-000000000000'])).status).toBe(404);
  await writeFile(join(store.directory, broken.id, 'context.json'), '{');
  expect((await submit([good.id, broken.id])).status).toBe(500);
  await store.setStatus(good.id, 'resolved');
  expect((await submit([good.id])).status).toBe(400);
  expect(onSubmit).not.toHaveBeenCalled();
});

it.each(['throw', 'reject'] as const)('retains all saved evidence when a handoff handler fails by %s and returns only a generic error', async (failure) => {
  const logger = { error: vi.fn() }, onSubmit = vi.fn(() => {
    if (failure === 'throw') throw new Error('Bearer secret-token failed');
    return Promise.reject(new Error('Bearer secret-token failed'));
  });
  const review = await api(undefined, { onSubmit, logger }), headers = { 'x-needmark-token': review.token };
  const store = new FeedbackStore(join(review.root, '.needmark/feedback')), saved = await store.save({ ...input(), url: review.origin });
  const files = ['context.json', 'comment.md', 'screenshot.png'];
  const before = await Promise.all(files.map((file) => readFile(join(store.directory, saved.id, file))));
  const result = await fetch(`${review.origin}/__needmark/submit`, { method: 'POST', headers, body: JSON.stringify({ ids: [saved.id], detail: 'forensic' }) });
  expect(result.status).toBe(502);
  const message = await result.text(); expect(message).toContain('Saved feedback is unchanged'); expect(message).not.toContain('secret-token');
  expect(await Promise.all(files.map((file) => readFile(join(store.directory, saved.id, file))))).toEqual(before);
  expect(onSubmit).toHaveBeenCalledTimes(1); expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('secret-token'));
});


it('only advertises an editor when configured and rejects invalid startup editor/context preferences', async () => {
  const review = await api();
  expect(review.scriptAttrs['data-needmark-editor']).toBeUndefined(); expect(review.scriptAttrs['data-needmark-context-attributes']).toBeUndefined();
  expect((await fetch(`${review.origin}/__needmark/editor`, { method: 'POST', headers: { 'x-needmark-token': review.token }, body: '{}' })).status).toBe(404);
  expect(() => createReviewApi({ root: review.root, origins: [review.origin], editor: 'terminal' } as unknown as ReviewApiOptions)).toThrow('Invalid NeedMark editor');
  expect(() => createReviewApi({ root: review.root, origins: [review.origin], contextAttributes: ['onclick'] })).toThrow('unsupported attribute');
  const configured = await api(undefined, { editor: 'vscode', contextAttributes: ['id', 'data-review-key', 'data-review-key'] });
  expect(configured.scriptAttrs['data-needmark-editor']).toBe('vscode');
  expect(configured.scriptAttrs['data-needmark-context-attributes']).toBe('["data-review-key"]');
});

it('protects editor URLs with the token/origin boundary, strict small request shape and current file bounds', async () => {
  const review = await api(undefined, { editor: 'cursor' }), headers = { 'x-needmark-token': review.token }, endpoint = `${review.origin}/__needmark/editor`;
  await writeFile(join(review.root, 'Card.tsx'), '<button />');
  const body = JSON.stringify({ file: 'Card.tsx', line: 1, column: 4 });
  const deniedHeaders: Record<string, string>[] = [{}, { 'x-needmark-token': 'wrong' }, { ...headers, Origin: 'https://evil.example' }, { ...headers, 'sec-fetch-site': 'cross-site' }];
  for (const denied of deniedHeaders) {
    expect((await fetch(endpoint, { method: 'POST', headers: denied, body })).status).toBe(403);
  }
  // Fetch replaces Host; use raw HTTP to exercise the server's host boundary.
  const wrongHost = await new Promise<number>((done, reject) => {
    const request = httpRequest(endpoint, { method: 'POST', headers: { ...headers, Host: 'evil.example' } }, (response) => { response.resume(); response.on('end', () => done(response.statusCode!)); });
    request.on('error', reject); request.end(body);
  });
  expect(wrongHost).toBe(403);
  for (const malformed of [null, {}, { file: 'Card.tsx', line: 1, column: 4, editor: 'vscode' }, { file: 'Card.tsx', line: 2, column: 1 }, { file: '../outside.tsx', line: 1, column: 1 },
    { file: 'Card.tsx', line: 1, column: 4, padding: 'x'.repeat(8 * 1024) }]) {
    expect((await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(malformed) })).status).toBe(400);
  }
  expect((await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ file: 'missing.tsx', line: 1, column: 1 }) })).status).toBe(404);
  const result = await fetch(endpoint, { method: 'POST', headers, body }); expect(result.status).toBe(200);
  expect(await result.json()).toEqual({ url: `cursor://file${join(review.root, 'Card.tsx')}:1:4` });
});

it('honors the internal source base for Vite annotations without widening the allowed project root', async () => {
  const review = await api(undefined, { editor: 'vscode', sourceRoot: process.cwd() });
  await mkdir(join(review.root, 'src')); await writeFile(join(review.root, 'src', 'Card.tsx'), '<button />');
  const file = (await import('node:path')).relative(process.cwd(), join(review.root, 'src', 'Card.tsx'));
  const result = await fetch(`${review.origin}/__needmark/editor`, { method: 'POST', headers: { 'x-needmark-token': review.token }, body: JSON.stringify({ file, line: 1, column: 1 }) });
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({ url: `vscode://file${join(review.root, 'src', 'Card.tsx')}:1:1` });
});


