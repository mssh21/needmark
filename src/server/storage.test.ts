import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultFeedbackDirectory, FeedbackStore, validateInput } from './storage.js';
import { formatFeedbackPrompt } from '../shared/prompt.js';
import { input, codeContext } from '../../tests/fixtures.js';
import { hasReferenceTarget, isRepairFeedback, type FeedbackStatus, type CodeContext } from '../shared/types.js';

const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true }))); });
async function temporary() { const folder = await mkdtemp(join(tmpdir(), 'needmark-store-')); folders.push(folder); return folder; }

function explicitMultiInput(count: number) {
  const elements: CodeContext['elements'] = Array.from({ length: count }, (_, index) => ({ ...codeContext().elements[0]!,
    selector: `#target-${index + 1}`, text: `Target ${index + 1}`, attributes: { id: `target-${index + 1}` },
    source: { file: `src/Target${index + 1}.tsx`, line: index + 1, column: 3, component: `Target${index + 1}` } }));
  return { ...input(), target: { ...input().target, kind: 'multi' as const, code: { elements, truncated: false } } };
}

describe('saved target references', () => {
  const reference = () => ({ ...input(), intent: 'reference' as const, comment: ' \n\t ', target: { ...input().target, code: codeContext() } });

  it('persists a blank comment and explicit reference intent with portable target/source/image evidence', async () => {
    const directory = await temporary(), store = new FeedbackStore(directory), saved = await store.save(reference());
    expect(saved).toMatchObject({ intent: 'reference', comment: '', status: 'open', image: 'screenshot.png', target: reference().target });
    const fresh = new FeedbackStore(directory);
    expect(await fresh.read(saved.id)).toEqual(saved);
    expect(await fresh.list()).toEqual([saved]);
    expect(await fresh.image(saved.id)).toEqual(Buffer.from(input().screenshot!.slice(22), 'base64'));
    const markdown = await readFile(join(directory, saved.id, 'comment.md'), 'utf8');
    expect(markdown).toContain(`# Target reference ${saved.id}\n\nNo change requested.`);
    expect(markdown).toContain('![Selected spot](./screenshot.png)');
    expect(markdown).toContain('Source (element): src/Buy.tsx:7:3');
    expect(markdown).not.toContain('Move this button up');
    expect(isRepairFeedback(saved)).toBe(false);
  });

  it('preserves references without capture while legacy feedback retains its required comment', async () => {
    const directory = await temporary(), store = new FeedbackStore(directory);
    const saved = await store.save({ ...reference(), screenshot: undefined, capture: { method: 'none', width: 0, height: 0 } });
    expect(saved.image).toBeUndefined();
    expect(await store.read(saved.id)).toEqual(saved);
    await expect(store.image(saved.id)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(directory, saved.id, 'comment.md'), 'utf8')).toContain('Screenshot disabled');
    const legacy = await store.save(input());
    expect(legacy).not.toHaveProperty('intent');
    expect(isRepairFeedback(legacy)).toBe(true);
    expect(() => validateInput({ ...input(), comment: ' ' })).toThrow('Comment is required');
    expect(() => validateInput({ ...reference(), screenshot: undefined })).toThrow('PNG capture required');
  });

  it.each([null, 'feedback', 'repair', 'Reference', false, {}, ['reference']])('rejects unknown intent %j on write and on fresh reads', async (intent) => {
    expect(() => validateInput({ ...input(), intent })).toThrow('Invalid feedback intent');
    const store = new FeedbackStore(await temporary()), saved = await store.save(input());
    await writeFile(join(store.directory, saved.id, 'context.json'), JSON.stringify({ ...saved, intent }));
    await expect(new FeedbackStore(store.directory).read(saved.id)).rejects.toThrow('Invalid feedback intent');
  });

  it('rejects repair text in references without relaxing ordinary validation', () => {
    expect(() => validateInput({ ...reference(), comment: 'Make this larger' })).toThrow('cannot contain a comment');
    expect(() => validateInput({ ...reference(), target: { ...reference().target, code: { elements: [{}], truncated: false } } })).toThrow('Invalid code context');
  });

  it('requires identifiers instead of coordinate, tag, text, accessible name or CSS-only context', () => {
    const { source, sourceRelation, ...base } = codeContext().elements[0]!;
    const element = { ...base, selector: '', attributes: {}, components: [], accessibleName: 'Buy' };
    const target = { ...input().target, selector: '', code: { elements: [element], truncated: false } };
    expect(hasReferenceTarget(target)).toBe(false);
    expect(() => validateInput({ ...reference(), target })).toThrow('recorded identifiers');
    const identifiers: Partial<CodeContext['elements'][number]>[] = [
        { selector: '#buy' }, { source, sourceRelation }, { sourceHint: { file: 'src/Buy.tsx' } },
        { components: ['Buy'] }, { attributes: { 'data-review-key': 'buy' } }, { attributes: { 'aria-label': 'Buy now' } },
      ];
    const identified = [
      { ...target, selector: ' #buy ' },
      ...identifiers.map((patch) => ({ ...target, code: { elements: [{ ...element, ...patch }], truncated: false } })),
    ];
    for (const value of identified) {
      expect(hasReferenceTarget(value)).toBe(true);
      expect(validateInput({ ...reference(), target: value }).intent).toBe('reference');
    }
    const unsafeAttributes: Record<string, string>[] = [{ value: 'private' }, { onclick: 'doSomething()' }, { style: 'color:red' },
      { nonce: 'secret' }, { srcdoc: '<b>html</b>' }, { 'data-needmark-token': 'secret' }, { 'data-needback-id': 'private' }, { id: '  ' }];
    for (const attributes of unsafeAttributes) {
      expect(hasReferenceTarget({ ...target, code: { elements: [{ ...element, attributes }], truncated: false } })).toBe(false);
    }
  });

  it('keeps immutable intent and rejects every reference comment patch while permitting author, status and replies', async () => {
    const store = new FeedbackStore(await temporary()), saved = await store.save(reference()), image = await store.image(saved.id);
    const before = await readFile(join(store.directory, saved.id, 'context.json'));
    for (const patch of [{ comment: '' }, { comment: ' ' }, { comment: 'Change it' }, { comment: null }, { comment: undefined },
      { intent: undefined }, { intent: 'reference' }, { intent: 'feedback' }]) {
      await expect(new FeedbackStore(store.directory).update(saved.id, patch)).rejects.toThrow();
      expect(await readFile(join(store.directory, saved.id, 'context.json'))).toEqual(before);
    }
    await store.update(saved.id, { author: ' New reviewer ', status: 'resolved' });
    const added = await store.addReply(saved.id, { author: 'Reviewer', comment: ' Notes stay in the thread ' });
    const reply = added.replies![0]!;
    await store.updateReply(saved.id, reply.id, { comment: 'Revised notes' });
    expect(await readFile(join(store.directory, saved.id, 'comment.md'), 'utf8')).toContain('> Revised notes');
    await store.setStatus(saved.id, 'resolved');
    await store.setStatus(saved.id, 'open');
    const current = await new FeedbackStore(store.directory).read(saved.id);
    expect(current).toMatchObject({ intent: 'reference', comment: '', author: 'New reviewer', status: 'open',
      target: saved.target, replies: [{ id: reply.id, comment: 'Revised notes' }] });
    expect(isRepairFeedback(current)).toBe(false);
    expect(await store.image(saved.id)).toEqual(image);
    await store.removeReply(saved.id, reply.id);
    expect((await store.read(saved.id)).replies).toEqual([]);
    await store.remove(saved.id);
    expect(await store.list()).toEqual([]);
  });

  it('checks current disk intent inside the mutation lock before accepting a comment patch', async () => {
    const directory = await temporary(), store = new FeedbackStore(directory), saved = await store.save(input());
    const path = join(directory, saved.id, 'context.json'), lock = join(directory, `.lock-${saved.id}`);
    await mkdir(lock);
    const update = store.update(saved.id, { comment: 'A stale repair update' });
    const fresh = { ...saved, intent: 'reference', comment: '' };
    await writeFile(path, JSON.stringify(fresh));
    await rm(lock, { recursive: true });
    await expect(update).rejects.toThrow('Target reference comments cannot be edited');
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(fresh);
    expect((await new FeedbackStore(directory).list())[0]).toMatchObject({ intent: 'reference', comment: '' });
  });

  it('preserves a whole 500-character recorded identifier through save, reread, Markdown and reference updates', async () => {
    const store = new FeedbackStore(await temporary()), value = `key-${'あ'.repeat(496)}`, code = codeContext();
    code.elements[0]!.attributes = { 'data-review-key': value };
    const saved = await store.save({ ...reference(), target: { ...reference().target, code } });
    expect((await new FeedbackStore(store.directory).read(saved.id)).target.code!.elements[0]!.attributes['data-review-key']).toBe(value);
    expect(await readFile(join(store.directory, saved.id, 'comment.md'), 'utf8')).toContain(JSON.stringify(value));
    await store.update(saved.id, { author: 'Reviewer B' });
    expect((await store.read(saved.id)).target.code!.elements[0]!.attributes['data-review-key']).toBe(value);
    code.elements[0]!.attributes['data-review-key'] = value + 'あ';
    expect(() => validateInput({ ...reference(), target: { ...reference().target, code } })).toThrow('Invalid code context');
  });
});


describe('default feedback directory', () => {
  it('selects the canonical directory for a fresh project without creating files', async () => {
    const root = await temporary();
    expect(defaultFeedbackDirectory(root)).toBe('.needmark/feedback');
    expect(await readdir(root)).toEqual([]);
  });

  it('uses existing legacy feedback until the canonical directory exists without moving or merging saved files', async () => {
    const root = await temporary(), legacy = join(root, '.needback/feedback'), canonical = join(root, '.needmark/feedback');
    const saved = await new FeedbackStore(legacy).save(input()), savedDirectory = join(legacy, saved.id);
    const files = await readdir(savedDirectory), before = await Promise.all(files.map((file) => readFile(join(savedDirectory, file))));
    expect(defaultFeedbackDirectory(root)).toBe('.needback/feedback');
    expect((await new FeedbackStore(join(root, defaultFeedbackDirectory(root))).read(saved.id)).id).toBe(saved.id);
    expect(await readdir(root)).toEqual(['.needback']);
    await mkdir(canonical, { recursive: true });
    expect(defaultFeedbackDirectory(root)).toBe('.needmark/feedback');
    expect(await new FeedbackStore(join(root, defaultFeedbackDirectory(root))).list()).toEqual([]);
    expect(await readdir(savedDirectory)).toEqual(files);
    expect(await Promise.all(files.map((file) => readFile(join(savedDirectory, file))))).toEqual(before);
    expect((await new FeedbackStore(legacy).read(saved.id)).id).toBe(saved.id);
  });
});

describe('feedback files', () => {
  it('persists portable text, image and context; a fresh store reads them and changes status', async () => {
    const directory = join(await temporary(), 'feedback');
    const saved = await new FeedbackStore(directory).save(input());
    const fresh = new FeedbackStore(directory);
    expect((await fresh.list())[0]).toMatchObject({ id: saved.id, comment: 'Move this button up', author: 'Reviewer', status: 'open' });
    const markdown = await readFile(join(directory, saved.id, 'comment.md'), 'utf8');
    expect(markdown).toContain('![Selected spot](./screenshot.png)');
    expect(markdown).not.toContain(directory);
    expect((await fresh.image(saved.id)).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    await fresh.setStatus(saved.id, 'resolved');
    expect((await new FeedbackStore(directory).list())[0]!.status).toBe('resolved');
    expect(await readFile(join(directory, saved.id, 'comment.md'), 'utf8')).toBe(markdown);
    await fresh.setStatus(saved.id, 'open');
    expect((await fresh.read(saved.id)).status).toBe('open');
  });

  it('preserves source evidence in JSON and Markdown while old feedback stays readable', async () => {
    const directory = await temporary();
    const store = new FeedbackStore(directory);
    const saved = await store.save({ ...input(), target: { ...input().target, code: codeContext() } });
    expect((await new FeedbackStore(directory).read(saved.id)).target.code).toEqual(codeContext());
    const markdown = await readFile(join(directory, saved.id, 'comment.md'), 'utf8');
    expect(markdown).toContain('Source (element): src/Buy.tsx:7:3');
    expect(markdown).toContain('App > Buy');
    const old = await store.save(input());
    expect((await store.read(old.id)).target.code).toBeUndefined();
  });

  it('preserves verified runtime positions and labels them separately from compile-time annotations', async () => {
    const directory = await temporary();
    const store = new FeedbackStore(directory);
    const code = codeContext();
    code.elements[0]!.sourceOrigin = 'runtime';
    const saved = await store.save({ ...input(), target: { ...input().target, code } });
    expect((await new FeedbackStore(directory).read(saved.id)).target.code!.elements[0]).toMatchObject({
      sourceOrigin: 'runtime', sourceRelation: 'self', source: { file: 'src/Buy.tsx', line: 7, column: 3 },
    });
    expect(await readFile(join(directory, saved.id, 'comment.md'), 'utf8')).toContain('Source (runtime; current JSX verified by identifiers): src/Buy.tsx:7:3');
    expect((await store.update(saved.id, { comment: 'Please keep the same target' })).target.code!.elements[0]!.sourceOrigin).toBe('runtime');
    const compile = await store.save({ ...input(), target: { ...input().target, code: codeContext() } });
    expect((await store.read(compile.id)).target.code!.elements[0]!.sourceOrigin).toBeUndefined();
    expect(await readFile(join(directory, compile.id, 'comment.md'), 'utf8')).toContain('Source (element): src/Buy.tsx:7:3');
  });

  it('stores file candidates without invented positions and removes transient frames from persisted metadata', async () => {
    const directory = await temporary();
    const store = new FeedbackStore(directory);
    const { source, sourceRelation, ...element } = codeContext().elements[0]!;
    const frames = [{ url: 'webpack-internal://private-development-frame', line: 99, column: 8 }];
    const saved = await store.save({ ...input(), frames, viewport: { ...input().viewport, frames }, capture: { ...input().capture, frames },
      target: { ...input().target, frames, rect: { ...input().target.rect, frames }, code: { truncated: false, frames,
        elements: [{ ...element, frames, sourceHint: { file: 'app/page.tsx', component: 'ProductCard', line: 99, frames } }] } } });
    const selected = saved.target.code!.elements[0]!;
    expect(selected.source).toBeUndefined();
    expect(selected.sourceOrigin).toBeUndefined();
    expect(selected.sourceHint).toEqual({ file: 'app/page.tsx', component: 'ProductCard' });
    const json = await readFile(join(directory, saved.id, 'context.json'), 'utf8');
    expect(json).not.toContain('private-development-frame');
    expect(json).not.toContain('"frames"');
    expect(selected.sourceHint).not.toHaveProperty('line');
    const markdown = await readFile(join(directory, saved.id, 'comment.md'), 'utf8');
    expect(markdown).toContain('Source file search hint: "app/page.tsx"; component "ProductCard"');
    expect(markdown).not.toContain('app/page.tsx:99');
    const imported = JSON.parse(json);
    imported.target.code.frames = frames;
    imported.target.code.elements[0].frames = frames;
    imported.target.code.elements[0].sourceHint.line = 99;
    await writeFile(join(directory, saved.id, 'context.json'), JSON.stringify(imported));
    const updated = await store.update(saved.id, { comment: 'Keep this file candidate' });
    expect(updated.target.code!.elements[0]!.sourceHint).toEqual({ file: 'app/page.tsx', component: 'ProductCard' });
    expect(await readFile(join(directory, saved.id, 'context.json'), 'utf8')).not.toContain('private-development-frame');
    expect(await readFile(join(directory, saved.id, 'context.json'), 'utf8')).not.toContain('"frames"');
  });

  it.each([
    { sourceOrigin: 'stack' }, { sourceOrigin: 'runtime', source: undefined }, { sourceOrigin: 'runtime', sourceRelation: 'ancestor' },
    { sourceHint: null }, { sourceHint: { file: '' } }, { sourceHint: { file: ' ' } },
    { sourceHint: { file: 'x'.repeat(1025) } }, { sourceHint: { file: 'app/page.tsx', component: 'x'.repeat(101) } },
  ])('rejects invalid runtime source metadata: %j', (patch) => {
    const code = { elements: [{ ...codeContext().elements[0], ...patch }], truncated: false };
    expect(() => validateInput({ ...input(), target: { ...input().target, code } })).toThrow('Invalid code context');
  });

  it.each([null, { elements: Array(13).fill({}), truncated: false }, { ...codeContext(), truncated: 'yes' },
    { elements: [{ ...codeContext().elements[0], source: { file: 'a', line: -1, column: 1 } }], truncated: false }])('rejects invalid code context: %j', (code) => {
    expect(() => validateInput({ ...input(), target: { ...input().target, code } })).toThrow('Invalid code context');
  });

  it.each([13, 20])('keeps all %i explicitly selected targets through saving, fresh reads, edits and every agent export', async (count) => {
    const directory = await temporary(), store = new FeedbackStore(directory), value = explicitMultiInput(count);
    value.target.code.truncated = true;
    const saved = await store.save(value), image = await store.image(saved.id);
    expect(saved.target.code).toEqual(value.target.code);
    expect((await new FeedbackStore(directory).read(saved.id)).target.code).toEqual(value.target.code);
    const changed = await store.update(saved.id, { comment: 'Check every selected target', status: 'open' });
    expect(changed.target.code).toEqual(value.target.code); expect(await store.image(saved.id)).toEqual(image);
    expect((await new FeedbackStore(directory).list())[0]!.target.code).toEqual(value.target.code);
    const markdown = await readFile(join(directory, saved.id, 'comment.md'), 'utf8');
    expect(markdown).toContain('Target discovery is incomplete or the context is a bounded sample.');
    expect(markdown).not.toContain('Only a sample of the selected area');
    for (const element of value.target.code.elements) {
      expect(markdown).toContain(element.selector); expect(markdown).toContain(element.source!.file);
      for (const detail of ['compact', 'standard', 'detailed', 'forensic'] as const) {
        const prompt = formatFeedbackPrompt([changed], directory, detail);
        expect(prompt).toContain(JSON.stringify(element.selector)); expect(prompt).toContain(element.source!.file);
        expect(prompt).toContain(`${saved.id}/context.json`); expect(prompt).toContain(`${saved.id}/screenshot.png`);
      }
    }
  });

  it.each(['element', 'area', 'text'] as const)('still rejects thirteen automatic %s context samples', (kind) => {
    const value = explicitMultiInput(13);
    expect(() => validateInput({ ...value, target: { ...value.target, kind } })).toThrow('Invalid code context');
    const bounded = explicitMultiInput(12);
    expect(validateInput({ ...bounded, target: { ...bounded.target, kind } }).target.code!.elements).toHaveLength(12);
  });

  it.each([
    { text: 'x'.repeat(501) }, { attributes: { id: 'x'.repeat(501) } }, { styles: { padding: 'x'.repeat(101) } },
    { source: { file: 'src/Twentieth.tsx', line: 0, column: 1 } }, { rect: { x: 0, y: 0, width: Infinity, height: 20 } },
    { rootPath: ['iframe: #preview'], frameUrls: ['javascript:alert(1)'] },
  ])('still validates malformed evidence after the twelfth explicit target: %j', (patch) => {
    const value = explicitMultiInput(20);
    value.target.code.elements[19] = { ...value.target.code.elements[19]!, ...patch };
    expect(() => validateInput(value)).toThrow('Invalid code context');
  });

  it('strips late transient evidence and rejects a corrupt twentieth target before any imported-file mutation', async () => {
    const directory = await temporary(), store = new FeedbackStore(directory), value = explicitMultiInput(20);
    const code = { ...value.target.code, frames: ['private-twentieth-frame'], elements: value.target.code.elements.map((element) => ({ ...element, frames: ['private-twentieth-frame'] })) };
    const saved = await store.save({ ...value, target: { ...value.target, code } }), path = join(directory, saved.id, 'context.json');
    expect(await readFile(path, 'utf8')).not.toContain('private-twentieth-frame');
    expect(saved.target.code!.elements).toHaveLength(20);
    const imported = JSON.parse(await readFile(path, 'utf8'));
    imported.target.code.elements[19].source.line = -1;
    const invalid = JSON.stringify(imported); await writeFile(path, invalid);
    await expect(new FeedbackStore(directory).read(saved.id)).rejects.toThrow('Invalid code context');
    await expect(store.update(saved.id, { comment: 'Do not overwrite the invalid target' })).rejects.toThrow('Invalid code context');
    expect(await readFile(path, 'utf8')).toBe(invalid);
  });

  it('keeps legacy version-one multiple comments readable without inventing target or frame metadata', async () => {
    const directory = await temporary(), store = new FeedbackStore(directory), value = explicitMultiInput(12);
    const saved = await store.save(value), path = join(directory, saved.id, 'context.json');
    const legacy = JSON.parse(await readFile(path, 'utf8')); delete legacy.updatedAt; delete legacy.replies;
    await writeFile(path, JSON.stringify(legacy));
    const read = await new FeedbackStore(directory).read(saved.id);
    expect(read.version).toBe(1); expect(read.target.code).toEqual(value.target.code);
    expect(read.target.code!.elements.every((element) => element.frameUrls === undefined)).toBe(true);
    expect((await store.setStatus(saved.id, 'resolved')).target.code).toEqual(value.target.code);
  });

  it('rejects unsupported status without changing saved files', async () => {
    const directory = await temporary();
    const store = new FeedbackStore(directory);
    const saved = await store.save(input());
    for (const status of ['invalid', 'in_progress', 'dismissed']) await expect(store.setStatus(saved.id, status as FeedbackStatus)).rejects.toThrow('Invalid status');
    await expect(store.update(saved.id, { status: 'resolved', reason: 'Retired field' })).rejects.toThrow('Invalid feedback update');
    expect((await new FeedbackStore(directory).read(saved.id)).status).toBe('open');
  });

  it('saves optional-image feedback without manufacturing an image and preserves its target', async () => {
    const directory = await temporary();
    const store = new FeedbackStore(directory);
    const saved = await store.save({ ...input(), screenshot: undefined,
      capture: { method: 'none', width: 0, height: 0 }, target: { ...input().target, kind: 'text' },
      replies: [{ comment: 'forged' }], image: 'forged.png' });
    expect(saved.image).toBeUndefined();
    expect(saved.replies).toBeUndefined();
    expect(await readdir(join(directory, saved.id))).toEqual(['comment.md', 'context.json']);
    expect((await new FeedbackStore(directory).read(saved.id)).target.kind).toBe('text');
    expect(await readFile(join(directory, saved.id, 'comment.md'), 'utf8')).not.toContain('![Selected spot]');
    await expect(store.image(saved.id)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(() => validateInput({ ...input(), screenshot: undefined })).toThrow('PNG capture required');
    expect(() => validateInput({ ...input(), capture: { method: 'none', width: 0, height: 0 } })).toThrow('Image must be omitted');
    expect(() => validateInput({ ...input(), screenshot: undefined, capture: { method: 'none', width: 1, height: 1 } })).toThrow('Invalid capture dimensions');
  });

  it('edits comment and author while retaining captured evidence and updates readable feedback', async () => {
    const directory = await temporary();
    const store = new FeedbackStore(directory);
    const saved = await store.save(input());
    const originalImage = await store.image(saved.id);
    const changed = await store.update(saved.id, { comment: ' New request\nwith a second line ', author: ' New reviewer ', status: 'resolved' });
    expect(changed).toMatchObject({ id: saved.id, comment: 'New request\nwith a second line', author: 'New reviewer',
      status: 'resolved', capturedAt: saved.capturedAt, createdAt: saved.createdAt, target: saved.target });
    expect(Number.isFinite(Date.parse(changed.updatedAt!))).toBe(true);
    expect(await store.image(saved.id)).toEqual(originalImage);
    const markdown = await readFile(join(directory, saved.id, 'comment.md'), 'utf8');
    expect(markdown).toContain('> New request\n> with a second line');
    expect(markdown).not.toContain('Move this button up');
    expect((await new FeedbackStore(directory).read(saved.id)).comment).toBe(changed.comment);
    for (const patch of [{}, { comment: ' ' }, { comment: null }, { author: 'x'.repeat(101) }, { status: undefined }, { image: 'secret' }]) {
      await expect(store.update(saved.id, patch)).rejects.toThrow();
      expect((await store.read(saved.id)).comment).toBe(changed.comment);
    }
  });

  it('persists threads, serializes simultaneous replies, edits and deletes individual replies', async () => {
    const directory = await temporary();
    const store = new FeedbackStore(directory);
    const saved = await store.save(input());
    await Promise.all([store.addReply(saved.id, { comment: ' First reply ', author: ' Alice ' }),
      new FeedbackStore(directory).addReply(saved.id, { comment: 'Second reply', author: 'Agent' })]);
    const threaded = await new FeedbackStore(directory).read(saved.id);
    expect(threaded.replies).toHaveLength(2);
    expect(threaded.replies).toEqual(expect.arrayContaining([expect.objectContaining({ comment: 'First reply', author: 'Alice' })]));
    expect(threaded.replies![0]!.id).not.toBe(threaded.replies![1]!.id);
    const first = threaded.replies!.find((reply) => reply.author === 'Alice')!;
    await expect(store.updateReply(saved.id, first.id, { comment: 'Updated reply', author: 'Bob' })).rejects.toThrow('Invalid reply update');
    const edited = await store.updateReply(saved.id, first.id, { comment: ' Updated reply ' });
    expect(edited.replies!.find((reply) => reply.id === first.id)).toMatchObject({ id: first.id, createdAt: first.createdAt, author: 'Alice', comment: 'Updated reply', updatedAt: expect.any(String) });
    expect(await readFile(join(directory, saved.id, 'comment.md'), 'utf8')).toContain('> Updated reply');
    expect((await store.removeReply(saved.id, first.id)).replies).toHaveLength(1);
    expect(await readFile(join(directory, saved.id, 'comment.md'), 'utf8')).not.toContain('Updated reply');
    await expect(store.removeReply(saved.id, first.id)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(store.addReply(saved.id, { comment: ' ', author: 'AI' })).rejects.toThrow('Reply is required');
    await expect(store.updateReply(saved.id, '../escape', { comment: 'Changed' })).rejects.toThrow('Invalid reply ID');
    await expect(store.updateReply(saved.id, first.id, { comment: ' ' })).rejects.toThrow('Reply is required');
  });

  it('reads version-one feedback without new lifecycle fields and deletes the entire local item', async () => {
    const directory = await temporary();
    const store = new FeedbackStore(directory);
    const saved = await store.save(input());
    const legacy = { ...saved };
    delete legacy.updatedAt; delete legacy.replies;
    await writeFile(join(directory, saved.id, 'context.json'), JSON.stringify(legacy));
    expect((await new FeedbackStore(directory).read(saved.id)).id).toBe(saved.id);
    await store.remove(saved.id);
    expect(await store.list()).toEqual([]);
    expect(await readdir(directory)).toEqual([]);
    await expect(store.read(saved.id)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(store.remove('../escape')).rejects.toThrow('Invalid feedback ID');
  });

  it('clears only the exact normalized URL, including all its files and replies, and then can clear all states', async () => {
    const directory = await temporary();
    const store = new FeedbackStore(directory);
    const currentUrl = 'http://localhost:5173/products?view=one#details';
    const current = await store.save({ ...input(), url: currentUrl });
    await store.addReply(current.id, { author: 'AI', comment: 'Please check' });
    const otherQuery = await store.save({ ...input(), url: 'http://localhost:5173/products?view=two#details' });
    const otherHash = await store.save({ ...input(), url: 'http://localhost:5173/products?view=one#other' });
    await store.setStatus(otherQuery.id, 'resolved');
    await store.setStatus(otherHash.id, 'resolved');
    for (const scope of [null, {}, { scope: 'page' }, { scope: 'all', url: currentUrl },
      { scope: 'url' }, { scope: 'url', url: 'javascript:alert(1)' }, { scope: 'url', url: currentUrl, extra: true }]) {
      await expect(store.clear(scope)).rejects.toThrow();
      expect(await store.list()).toHaveLength(3);
    }
    expect(await store.clear({ scope: 'url', url: currentUrl })).toEqual({ scope: 'url', url: currentUrl, deleted: [current.id], failed: [] });
    await expect(readdir(join(directory, current.id))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await store.list()).map((item) => item.id).sort()).toEqual([otherQuery.id, otherHash.id].sort());
    const all = await store.clear({ scope: 'all' });
    expect(all.failed).toEqual([]);
    expect(all.deleted.sort()).toEqual([otherQuery.id, otherHash.id].sort());
    expect(await readdir(directory)).toEqual([]);
  });

  it('reports failed items without falsely declaring an orphaned image deleted and still clears valid items', async () => {
    const directory = await temporary();
    const store = new FeedbackStore(directory);
    const good = await store.save(input());
    const broken = await store.save(input());
    await rm(join(directory, broken.id, 'context.json'));
    const result = await store.clear({ scope: 'all' });
    expect(result.deleted).toEqual([good.id]);
    expect(result.failed).toEqual([{ id: broken.id, error: expect.any(String) }]);
    expect(await readdir(join(directory, broken.id))).toContain('screenshot.png');
    await expect(store.read(good.id)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps simultaneous submissions in separate directories', async () => {
    const store = new FeedbackStore(await temporary());
    const saved = await Promise.all([store.save(input()), store.save({ ...input(), comment: 'Second reviewer' })]);
    expect(saved[0]!.id).not.toBe(saved[1]!.id);
    expect(await store.list()).toHaveLength(2);
  });

  it('rejects path traversal and symlinked images', async () => {
    const directory = await temporary();
    const store = new FeedbackStore(directory);
    await expect(store.read('../secrets')).rejects.toThrow('Invalid feedback ID');
    const saved = await store.save(input());
    const image = join(directory, saved.id, 'screenshot.png');
    await rm(image);
    await symlink(join(directory, saved.id, 'comment.md'), image);
    await expect(store.image(saved.id)).rejects.toThrow('Invalid image file');
  });

  it.each([
    { comment: ' ' }, { url: 'javascript:alert(1)' }, { author: 'a'.repeat(101) },
    { screenshot: 'data:image/png;base64,bad' }, { capture: { method: 'tab', width: 200, height: 100 } },
    { target: { ...input().target, rect: { x: 0, y: 0, width: 0, height: 40 } } },
  ])('rejects invalid feedback before persisting: %j', (patch) => {
    expect(() => validateInput({ ...input(), ...patch })).toThrow();
  });
});


it('drops a layout field from older clients instead of persisting a proposal the product no longer reads', async () => {
  const directory = await temporary(), store = new FeedbackStore(directory);
  const saved = await store.save({ ...input(), target: { ...input().target, layout: { action: 'place', component: 'button', after: input().target.rect } } });
  expect(saved.target).not.toHaveProperty('layout');
  expect(await readFile(join(directory, saved.id, 'context.json'), 'utf8')).not.toContain('"layout"');
});

describe('saved iframe page evidence', () => {
  const framedInput = (frameUrls: unknown, rootPath = ['iframe: #preview']) => ({ ...input(), target: { ...input().target,
    code: { elements: [{ ...codeContext().elements[0], rootPath, frameUrls }], truncated: false } } });

  it.each(['http://localhost:5173/embedded?item=2#buy', 'https://preview.example.test/item', 'about:blank', 'about:srcdoc',
    'about:blank#item', 'about:srcdoc?review=1#item', 'blob:http://localhost:5173/known-object'])('accepts absolute frame page metadata without changing the exact URL: %s', (url) => {
    expect(validateInput(framedInput([url])).target.code!.elements[0]!.frameUrls).toEqual([url]);
  });

  it('counts only iframe roots, accepts eight frame URLs and permits explicit empty evidence without frame roots', () => {
    const roots = ['shadow: #outer', 'iframe: #first', 'shadow: #inner', 'iframe: #second'];
    expect(validateInput(framedInput(['http://localhost:5173/first', 'about:srcdoc#second'], roots)).target.code!.elements[0]!.frameUrls).toHaveLength(2);
    expect(validateInput(framedInput(Array(8).fill('about:blank'), Array(8).fill('iframe: #nested'))).target.code!.elements[0]!.frameUrls).toHaveLength(8);
    expect(validateInput(framedInput([], ['shadow: #only'])).target.code!.elements[0]!.frameUrls).toEqual([]);
    const secure = framedInput(['blob:https://preview.example.test/known-object']); secure.url = 'https://preview.example.test/project';
    expect(validateInput(secure).target.code!.elements[0]!.frameUrls).toEqual(['blob:https://preview.example.test/known-object']);
    const longest = 'https://example.test/' + 'x'.repeat(4096 - 'https://example.test/'.length);
    expect(validateInput(framedInput([longest])).target.code!.elements[0]!.frameUrls).toEqual([longest]);
  });

  it.each([null, {}, 'http://localhost:5173/embedded', [], Array(2).fill('about:blank'), Array(9).fill('about:blank'),
    Array(1), [null], [42], [''], ['relative/page'], ['//localhost:5173/page'], ['not a URL'],
    ['https://example.test/' + 'x'.repeat(4097 - 'https://example.test/'.length)], ['javascript:alert(1)'], ['data:text/html,hello'],
    ['file:///private/project/index.html'], ['about:config'], ['about:blank/other'], ['about:javascript'], ['about:data'],
    ['blob:https://other.example.test/object'], ['blob:null/object'], ['blob:file:///private/project/object']])('rejects malformed, mismatched or unsafe iframe URL metadata: %j', (urls) => {
    expect(() => validateInput(framedInput(urls))).toThrow('Invalid code context');
  });

  it('preserves frame routes through save/read/edit while stripping transient fields', async () => {
    const directory = await temporary(), store = new FeedbackStore(directory), top = codeContext();
    const topPages = ['http://localhost:5173/outer?item=1#top', 'about:srcdoc?review=1#inner'];
    top.elements[0]!.rootPath = ['iframe: #outer', 'shadow: #inside', 'iframe: #inner']; top.elements[0]!.frameUrls = [...topPages];
    const value = { ...input(), target: { ...input().target, code: top } }, expected = structuredClone(value.target);
    const unsafe = JSON.parse(JSON.stringify(value));
    unsafe.target.code.elements[0].pendingFrameLookup = 'private-transient-frame';
    const saved = await store.save(unsafe), image = await store.image(saved.id), path = join(directory, saved.id, 'context.json');
    expect(saved.target).toEqual(expected);
    unsafe.target.code.elements[0].frameUrls[0] = 'http://localhost:5173/changed-input';
    expect(saved.target.code!.elements[0]!.frameUrls).toEqual(topPages);
    expect((await new FeedbackStore(directory).read(saved.id)).target).toEqual(expected);
    expect(await readFile(path, 'utf8')).not.toContain('private-transient-frame');
    const imported = JSON.parse(await readFile(path, 'utf8'));
    imported.target.code.elements[0].pendingFrameLookup = 'private-transient-frame';
    await writeFile(path, JSON.stringify(imported));
    expect((await store.update(saved.id, { comment: 'Review the saved child pages', status: 'resolved' })).target).toEqual(expected);
    expect(await store.image(saved.id)).toEqual(image);
    expect(await readFile(path, 'utf8')).not.toContain('private-transient-frame');
    const markdown = await readFile(join(directory, saved.id, 'comment.md'), 'utf8');
    expect(markdown).toContain(`- Frame pages: ${JSON.stringify(topPages)}`);
  });

  it('reads version-one frame context without invented URLs and rejects corrupt route evidence before mutation', async () => {
    const directory = await temporary(), store = new FeedbackStore(directory);
    const saved = await store.save(framedInput(undefined)), path = join(directory, saved.id, 'context.json');
    expect(saved.version).toBe(1);
    expect((await new FeedbackStore(directory).read(saved.id)).target.code!.elements[0]!.frameUrls).toBeUndefined();
    expect((await store.update(saved.id, { status: 'resolved' })).target.code!.elements[0]!.frameUrls).toBeUndefined();
    const imported = JSON.parse(await readFile(path, 'utf8')); imported.target.code.elements[0].frameUrls = ['javascript:alert(1)'];
    const invalid = JSON.stringify(imported); await writeFile(path, invalid);
    await expect(new FeedbackStore(directory).read(saved.id)).rejects.toThrow('Invalid code context');
    await expect(store.update(saved.id, { comment: 'Must not overwrite corrupt context' })).rejects.toThrow('Invalid code context');
    expect(await readFile(path, 'utf8')).toBe(invalid);
  });
});
