import { tmpdir } from 'node:os';
import { join } from 'node:path';

// macOS reports /tmp through the /private symlink while saved source paths are compared as real paths, so specs use the real directory there and the OS default elsewhere.
// macOSの/tmpは/privateへのシンボリックリンクで、保存されるソースのパスは実パスで比べるため、macOSでは実ディレクトリを、それ以外ではOSの既定を使う。
export const tempRoot = process.platform === 'darwin' ? '/private/tmp' : tmpdir();

// The demo server started by playwright.config.ts writes every spec's feedback here.
// playwright.config.tsが起動するデモサーバーは、すべてのspecのフィードバックをここへ保存する。
export const output = join(tempRoot, 'needmark-e2e-feedback');
