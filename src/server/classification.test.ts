import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FeedbackStore } from './storage.js';
import { formatFeedbackPrompt } from '../shared/prompt.js';
import { input, codeContext } from '../../tests/fixtures.js';

const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true }))); });
async function store() { const folder = await mkdtemp(join(tmpdir(), 'needmark-class-')); folders.push(folder); return new FeedbackStore(folder); }

describe('feedback classification', () => {
  it('saves an optional category and writes it to readable Markdown', async () => {
    const feedback = await store(), saved = await feedback.save({ ...input(), category: 'discuss' });
    expect(saved).toMatchObject({ category: 'discuss' });
    expect(await feedback.read(saved.id)).toEqual(saved);
    const markdown = await readFile(join(feedback.directory, saved.id, 'comment.md'), 'utf8');
    expect(markdown).toContain('- Category: discuss\n');
    expect(markdown).not.toContain('Severity');
    const plain = await feedback.save(input());
    expect(plain).not.toHaveProperty('category');
  });

  it('rejects unknown and retired categories on writes and classification on target references', async () => {
    const feedback = await store();
    for (const category of ['bug', 'change', 'approve']) await expect(feedback.save({ ...input(), category })).rejects.toThrow('Invalid feedback category');
    await expect(feedback.save({ ...input(), intent: 'reference', comment: '', category: 'fix', target: { ...input().target, code: codeContext() } }))
      .rejects.toThrow('Target references cannot have a category');
    const reference = await feedback.save({ ...input(), intent: 'reference', comment: '', target: { ...input().target, code: codeContext() } });
    await expect(feedback.update(reference.id, { category: 'fix' })).rejects.toThrow('Target references cannot have a category');
  });

  it('patches and clears the category without touching other fields and rejects severity updates', async () => {
    const feedback = await store(), saved = await feedback.save({ ...input(), category: 'fix' });
    const changed = await feedback.update(saved.id, { category: 'question' });
    expect(changed).toMatchObject({ comment: saved.comment, category: 'question' });
    const cleared = await feedback.update(saved.id, { category: null });
    expect(cleared).not.toHaveProperty('category');
    await expect(feedback.update(saved.id, { severity: 'blocking' } as never)).rejects.toThrow('Invalid feedback update');
    expect(await readFile(join(feedback.directory, saved.id, 'comment.md'), 'utf8')).not.toContain('Category:');
  });

  it('loads files with retired categories and severity as fix or discuss without severity, keeping unknown fields', async () => {
    const feedback = await store();
    const legacy = async (fields: Record<string, unknown>) => {
      const saved = await feedback.save(input()), file = join(feedback.directory, saved.id, 'context.json');
      await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), ...fields, futureField: 'kept' }));
      return saved.id;
    };
    const change = await legacy({ category: 'change', severity: 'blocking' }), approve = await legacy({ category: 'approve' }), severe = await legacy({ severity: 'important' });
    expect(await feedback.read(change)).toMatchObject({ category: 'fix', futureField: 'kept' });
    expect(await feedback.read(approve)).toMatchObject({ category: 'discuss' });
    for (const id of [change, severe]) expect(await feedback.read(id)).not.toHaveProperty('severity');
    expect((await feedback.list()).map((item) => item.id).sort()).toEqual([change, approve, severe].sort());
    const replied = await feedback.addReply(change, { author: 'Agent', comment: 'Looking' });
    expect(replied).toMatchObject({ category: 'fix', futureField: 'kept' }); expect(replied).not.toHaveProperty('severity');
  });

  it('prints the category in every prompt detail level and asks for answers without code changes for discuss and question', async () => {
    const feedback = await store();
    const question = await feedback.save({ ...input(), category: 'question' }), discuss = await feedback.save({ ...input(), category: 'discuss' });
    const plain = await feedback.save(input()), fix = await feedback.save({ ...input(), category: 'fix' });
    const rule = 'Items with category discuss or question ask for an answer, not a code change: reply to the comment and leave the code unchanged.';
    for (const detail of ['compact', 'standard', 'detailed', 'forensic'] as const) {
      const prompt = formatFeedbackPrompt([question, discuss, plain], feedback.directory, detail);
      expect(prompt).toContain('Category: question'); expect(prompt).toContain('Category: discuss'); expect(prompt).toContain(rule);
      expect(prompt.match(/Category:/g)).toHaveLength(2);
    }
    expect(formatFeedbackPrompt([plain, fix], feedback.directory)).not.toContain(rule);
    expect(formatFeedbackPrompt([question], feedback.directory, 'standard', 'ja')).toContain('コードは変更しないでください');
  });
});
