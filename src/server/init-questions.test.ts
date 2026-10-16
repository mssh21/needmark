import { describe, expect, it } from 'vitest';
import { askInitChoices } from './init-questions.js';
import type { Connection } from './connect.js';

function terminal(answers: string[]) {
  const questions: string[] = [];
  return { questions, ask: async (text: string) => { questions.push(text); return answers.shift() ?? ''; } };
}
const vite: Connection = { kind: 'edit', framework: 'Vite', file: 'vite.config.ts', content: '', lines: [] };
const manual: Connection = { kind: 'manual' };

describe('init questions', () => {
  it('offers the recommendation first, including connecting the development server', async () => {
    const { questions, ask } = terminal(['y']);
    expect(await askInitChoices(ask, {}, vite, 'ja')).toEqual({ language: 'ja', share: 'local', capture: 'dom', connect: 'yes' });
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain('Japanese (日本語)');
    expect(questions[0]).toContain('Add needmark() to vite.config.ts');
  });

  it('asks nothing when every choice came from flags', async () => {
    const { questions, ask } = terminal([]);
    expect(await askInitChoices(ask, { language: 'en', share: 'git', capture: 'tab', connect: 'no' }, vite, 'ja')).toEqual({ language: 'en', share: 'git', capture: 'tab', connect: 'no' });
    expect(questions).toHaveLength(0);
  });

  it('does not ask about connecting when there is nothing it can change', async () => {
    const { questions, ask } = terminal(['n', '', '', '']);
    expect(await askInitChoices(ask, {}, manual, 'en')).toEqual({ language: 'en', share: 'local', capture: 'dom', connect: 'no' });
    expect(questions).toHaveLength(4);
    expect(questions[0]).toContain('Not detected');
  });

  it('accepts numbers or flag values and asks again after an unknown answer', async () => {
    const { questions, ask } = terminal(['maybe', 'no', 'fr', '1', 'git', '', '2']);
    expect(await askInitChoices(ask, {}, vite, 'ja')).toEqual({ language: 'en', share: 'git', capture: 'dom', connect: 'no' });
    expect(questions[1]).toContain('Enter y or n.');
    expect(questions[3]).toContain('Enter a number from 1-2.');
    expect(questions[6]).toContain('Undo with `needmark remove`');
    expect(questions).toHaveLength(7);
  });
});
