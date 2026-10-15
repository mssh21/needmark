import { describe, expect, it } from 'vitest';
import { askInitChoices } from './init-questions.js';

function terminal(answers: string[]) {
  const questions: string[] = [];
  return { questions, ask: async (text: string) => { questions.push(text); return answers.shift() ?? ''; } };
}

describe('init questions', () => {
  it('offers the recommendation first and uses the detected language for it', async () => {
    const { questions, ask } = terminal(['y']);
    expect(await askInitChoices(ask, {}, 'ja')).toEqual({ language: 'ja', share: 'local', capture: 'dom' });
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain('Japanese (日本語)');
    expect(questions[0]).toContain('This computer only');
  });

  it('asks nothing when every choice came from flags', async () => {
    const { questions, ask } = terminal([]);
    expect(await askInitChoices(ask, { language: 'en', share: 'git', capture: 'tab' }, 'ja')).toEqual({ language: 'en', share: 'git', capture: 'tab' });
    expect(questions).toHaveLength(0);
  });

  it('accepts numbers or flag values and asks again after an unknown answer', async () => {
    const { questions, ask } = terminal(['maybe', 'no', 'fr', '1', 'git', '']);
    expect(await askInitChoices(ask, {}, 'ja')).toEqual({ language: 'en', share: 'git', capture: 'dom' });
    expect(questions[1]).toContain('Enter y or n.');
    expect(questions[3]).toContain('Enter a number from 1-2.');
    expect(questions).toHaveLength(6);
  });
});
