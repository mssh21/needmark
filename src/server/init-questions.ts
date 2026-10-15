import type { InitOptions } from './init.js';
import type { Connection } from './connect.js';
import type { NeedMarkLanguage } from '../shared/language.js';

export type InitChoices = InitOptions & { connect: 'yes' | 'no' };
type Choice = keyof InitChoices;
interface Option { value: string; label: string; detail?: string }
type Question = { title: string; options: Option[] };

// Each choice is described by what the reviewer will notice, because names such as "dom" or "tab" only make sense after reading the architecture notes.
// 「dom」「tab」のような名前は仕組みを知らないと伝わらないため、各選択肢はレビューする人に見える違いで説明する。
const questions: Record<Exclude<Choice, 'connect'>, Question> = {
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

export function describeConnection(connection: Connection): string {
  if (connection.kind === 'connected') return `Already connected (${connection.file})`;
  if (connection.kind === 'manual') return 'Not detected; see the steps after setup';
  return connection.framework === 'Next.js' ? 'Start `next dev` through NeedMark (package.json)' : `Add needmark() to ${connection.file}`;
}
// Consent is asked only when there is an edit to make; the question names the file and the effect on the team because the change is committed with the project.
// 書き換えるものがあるときだけ同意を求める。変更はプロジェクトと一緒にコミットされるため、質問ではファイルとチームへの影響を示す。
function connectQuestion(connection: Connection): Question {
  const detail = connection.kind === 'edit' && connection.framework === 'Next.js'
    ? 'Your usual dev command and port keep working: NeedMark takes the port and runs Next.js behind it. Everyone who runs dev gets the toolbar; NEEDMARK=off skips it. Undo with `needmark remove`.'
    : 'Your usual dev command then shows the toolbar. It never enters production builds. Everyone who runs dev gets it; NEEDMARK=off skips it. Undo with `needmark remove`.';
  return { title: 'Connect NeedMark to the development server', options: [
    { value: 'yes', label: describeConnection(connection), detail },
    { value: 'no', label: 'Not now', detail: 'Change no files; the steps to do it by hand are shown after setup.' },
  ] };
}
const questionFor = (choice: Choice, connection: Connection) => choice === 'connect' ? connectQuestion(connection) : questions[choice];

// The terminal's locale is the best guess at the reviewer's language before any project setting exists.
// プロジェクトの設定がまだない段階では、ターミナルのロケールがレビューする人の言語の最もよい推測になるため。
export function systemLanguage(): NeedMarkLanguage {
  return new Intl.Locale(Intl.DateTimeFormat().resolvedOptions().locale).language === 'ja' ? 'ja' : 'en';
}

export function describeInit(options: InitChoices, connection: Connection): string {
  const rows: [string, string][] = (['language', 'share', 'capture'] as const).map((choice) => [questions[choice].title,
    questions[choice].options.find((option) => option.value === options[choice])?.label ?? String(options[choice])]);
  rows.push(['Development server', connection.kind === 'edit' && options.connect === 'no' ? 'Not connected' : describeConnection(connection)]);
  const width = Math.max(...rows.map(([title]) => title.length));
  return rows.map(([title, value]) => `  ${title.padEnd(width)}  ${value}`).join('\n');
}

async function choose(ask: (text: string) => Promise<string>, { title, options }: Question, fallback: string): Promise<string> {
  const range = `1-${options.length}`;
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

export const askConnection = (ask: (text: string) => Promise<string>, connection: Connection) => choose(ask, connectQuestion(connection), 'yes') as Promise<'yes' | 'no'>;

export async function askInitChoices(ask: (text: string) => Promise<string>, given: Partial<InitChoices>, connection: Connection, language = systemLanguage()): Promise<InitChoices> {
  const recommended: InitChoices = { language, share: 'local', capture: 'dom', connect: connection.kind === 'edit' ? 'yes' : 'no', ...given };
  const order: Choice[] = ['language', 'share', 'capture', ...(connection.kind === 'edit' ? ['connect' as const] : [])];
  if (order.every((choice) => given[choice] !== undefined)) return recommended;
  let retry = '';
  for (;;) {
    const answer = (await ask(`${retry ? '' : `NeedMark setup\n\nRecommended settings:\n${describeInit(recommended, connection)}\n\n`}${retry}Use the recommended settings? [Y/n]: `)).trim().toLowerCase();
    if (['', 'y', 'yes'].includes(answer)) return recommended;
    if (['n', 'no'].includes(answer)) break;
    retry = 'Enter y or n.\n';
  }
  const chosen: Partial<InitChoices> = { ...given };
  for (const choice of order) if (chosen[choice] === undefined) Object.assign(chosen, { [choice]: await choose(ask, questionFor(choice, connection), recommended[choice]!) });
  return { ...recommended, ...chosen };
}
