import type { InitOptions } from './init.js';
import type { NeedMarkLanguage } from '../shared/language.js';

type Choice = 'language' | 'share' | 'capture';
interface Option { value: string; label: string; detail?: string }

// Each choice is described by what the reviewer will notice, because names such as "dom" or "tab" only make sense after reading the architecture notes.
// 「dom」「tab」のような名前は仕組みを知らないと伝わらないため、各選択肢はレビューする人に見える違いで説明する。
const questions: Record<Choice, { title: string; options: Option[] }> = {
  language: { title: 'Review screen language', options: [{ value: 'en', label: 'English' }, { value: 'ja', label: 'Japanese (日本語)' }] },
  share: { title: 'Where to keep feedback', options: [
    { value: 'local', label: 'This computer only', detail: 'Git ignores the feedback files.' },
    { value: 'git', label: 'Share through Git', detail: 'Feedback files can be committed so teammates see them.' },
  ] },
  capture: { title: 'How to take screenshots', options: [
    { value: 'dom', label: 'Redraw the page', detail: 'Works right away with no permission prompt. Videos, embedded sites and some effects may look different.' },
    { value: 'tab', label: 'Record this browser tab', detail: 'Exact pixels. The browser asks once for permission to share the tab.' },
    { value: 'none', label: 'No screenshots', detail: 'Saves the comment and target details only.' },
  ] },
};
const order: Choice[] = ['language', 'share', 'capture'];
const labelOf = (choice: Choice, value: string) => questions[choice].options.find((option) => option.value === value)?.label ?? value;

// The terminal's locale is the best guess at the reviewer's language before any project setting exists.
// プロジェクトの設定がまだない段階では、ターミナルのロケールがレビューする人の言語の最もよい推測になるため。
export function systemLanguage(): NeedMarkLanguage {
  return new Intl.Locale(Intl.DateTimeFormat().resolvedOptions().locale).language === 'ja' ? 'ja' : 'en';
}

export function describeInit(options: InitOptions): string {
  const width = Math.max(...order.map((choice) => questions[choice].title.length));
  return order.map((choice) => `  ${questions[choice].title.padEnd(width)}  ${labelOf(choice, String(options[choice]))}`).join('\n');
}

async function choose(ask: (text: string) => Promise<string>, choice: Choice, fallback: string): Promise<string> {
  const { title, options } = questions[choice], range = `1-${options.length}`;
  const menu = `\n${title}\n${options.map((option, index) => `  ${index + 1}) ${option.label}${option.detail ? `\n     ${option.detail}` : ''}`).join('\n')}\n`;
  let retry = '';
  for (;;) {
    const answer = (await ask(`${menu}${retry}Choose ${range} [${options.findIndex((option) => option.value === fallback) + 1}]: `)).trim().toLowerCase();
    if (!answer) return fallback;
    // Numbers are what the menu shows; the flag values are still accepted for people who know them.
    // 画面に出すのは番号だが、フラグの値を知っている人のためにその値も受け付ける。
    const option = /^\d+$/.test(answer) ? options[Number(answer) - 1] : options.find((item) => item.value === answer);
    if (option) return option.value;
    retry = `Enter a number from ${range}.\n`;
  }
}

export async function askInitChoices(ask: (text: string) => Promise<string>, given: Partial<InitOptions>, language = systemLanguage()): Promise<InitOptions> {
  const recommended: InitOptions = { language, share: 'local', capture: 'dom', ...given };
  if (order.every((choice) => given[choice] !== undefined)) return recommended;
  let retry = '';
  for (;;) {
    const answer = (await ask(`${retry ? '' : `NeedMark setup\n\nRecommended settings:\n${describeInit(recommended)}\n\n`}${retry}Use the recommended settings? [Y/n]: `)).trim().toLowerCase();
    if (['', 'y', 'yes'].includes(answer)) return recommended;
    if (['n', 'no'].includes(answer)) break;
    retry = 'Enter y or n.\n';
  }
  const chosen: Partial<InitOptions> = { ...given };
  for (const choice of order) if (chosen[choice] === undefined) Object.assign(chosen, { [choice]: await choose(ask, choice, recommended[choice]!) });
  return chosen as InitOptions;
}
