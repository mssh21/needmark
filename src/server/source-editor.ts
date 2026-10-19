import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { defaultFeedbackDirectory, InputError } from './storage.js';

export interface SourceEditorOptions {
  root: string;
  /** Vite records source paths from the process directory while the proxy uses its project root. / Viteはプロセスの作業ディレクトリ、プロキシはプロジェクトルートを基準にソースパスを記録するため。 */
  sourceRoot?: string;
  outputDir?: string;
  editor: 'vscode' | 'cursor';
}

const maxSource = 1024 * 1024;
const denied = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'secrets', 'private']);
const within = (root: string, file: string) => { const path = relative(root, file); return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path); };
const restricted = (path: string) => path.split(sep).some((part) => part.startsWith('.') || denied.has(part.toLowerCase()));

/** Returning a URL lets the browser and OS ask the user before opening an editor; spawning one from the server would turn request data into a command. / URLを返せば、エディターを開く前にブラウザとOSが利用者に確認できる。サーバーから起動すると要求データをコマンドに変えてしまう。 */
export async function sourceEditorUrl(options: SourceEditorOptions, input: unknown): Promise<string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InputError('Invalid editor location');
  const { file, line, column } = input as { file?: unknown; line?: unknown; column?: unknown };
  if (Object.keys(input).length !== 3 || typeof file !== 'string' || !file.trim() || file.length > 1024 || /[\\\u0000-\u001f\u007f]/.test(file)
    || !Number.isSafeInteger(line) || Number(line) < 1 || Number(line) > 1_000_000
    || !Number.isSafeInteger(column) || Number(column) < 1 || Number(column) > 1_000_000) throw new InputError('Invalid editor location');
  if (!['vscode', 'cursor'].includes(options.editor)) throw new Error('Invalid NeedMark editor.');
  const configuredRoot = resolve(options.root), root = await realpath(configuredRoot);
  const candidate = resolve(options.sourceRoot ?? configuredRoot, file);
  // The project root itself may be a symlink (macOS /var -> /private/var), so check lexically first, then again after realpath.
  // プロジェクトルート自体がシンボリックリンクの場合があるため（macOSの/var -> /private/varなど）、字面で確認した後にrealpath後も確認する。
  const lexicalRoot = within(configuredRoot, candidate) ? configuredRoot : root;
  if (!within(lexicalRoot, candidate) || restricted(relative(lexicalRoot, candidate))) throw new InputError('Source file is not allowed');
  const absolute = await realpath(candidate), name = relative(root, absolute);
  if (!within(root, absolute) || restricted(name) || !/\.(?:[cm]?[jt]s|[jt]sx|html?|css|vue|svelte|astro)$/i.test(name)) throw new InputError('Source file is not allowed');
  const output = resolve(configuredRoot, options.outputDir ?? defaultFeedbackDirectory(configuredRoot));
  const privateOutput = await realpath(output).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return output; throw error; });
  if (candidate === output || within(output, candidate) || absolute === privateOutput || within(privateOutput, absolute)) throw new InputError('Source file is not allowed');
  // O_NOFOLLOW blocks a symlink swapped in after realpath, and O_NONBLOCK keeps a FIFO from hanging the request.
  // O_NOFOLLOWでrealpath後に差し替えられたリンクを拒否し、O_NONBLOCKでFIFOによって要求が止まるのを防ぐ。
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let code: string;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxSource) throw new InputError('Source file is not allowed');
    const buffer = Buffer.alloc(maxSource + 1); let size = 0;
    while (size <= maxSource) { const result = await handle.read(buffer, size, buffer.length - size); if (!result.bytesRead) break; size += result.bytesRead; }
    if (size > maxSource) throw new InputError('Source file exceeds size limit');
    code = buffer.subarray(0, size).toString('utf8');
  } finally { await handle.close(); }
  const lines = code.split(/\r\n|\r|\n/), current = lines[Number(line) - 1];
  if (current === undefined || Number(column) > current.length + 1) throw new InputError('Source location is outside the current file');
  const encoded = absolute.split(sep).map((part) => encodeURIComponent(part).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
  return `${options.editor}://file${encoded.startsWith('/') ? '' : '/'}${encoded}:${line}:${column}`;
}
