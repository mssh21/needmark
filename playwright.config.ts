import { defineConfig } from '@playwright/test';
import { output } from './tests/support/paths.js';

export default defineConfig({
  testDir: './tests', fullyParallel: false, workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:4192', viewport: { width: 1200, height: 850 },
    headless: false, trace: 'retain-on-failure',
  },
  projects: [
    // Overlay scrollbars keep the viewport the full 1200 px wide on Linux and Windows, where Chromium otherwise reserves a classic scrollbar, so pixel and geometry checks match the macOS default.
    // LinuxやWindowsのChromiumは従来型スクロールバーの幅を確保するため、オーバーレイ表示にして表示領域を1200pxに保ち、ピクセルと座標の検証をmacOSの既定に揃える。
    { name: 'chromium', use: { browserName: 'chromium', channel: 'chromium',
      launchOptions: { args: ['--auto-select-tab-capture-source-by-title=NeedMark', '--allow-http-screen-capture', '--enable-features=OverlayScrollbar'] } } },
    // Chromium runs every spec. WebKit repeats only tests tagged @cross-engine, whose outcome depends on engine behaviour (rendering and capture, hit testing, carets and ranges, frames, stacks, pointer and keyboard events); see docs/testing.md.
    // Chromiumはすべてのspecを実行する。WebKitでは、結果がエンジンの挙動（描画と撮影、ヒットテスト、キャレットと範囲、フレーム、スタック、ポインターとキーボード）に左右される@cross-engineのテストだけを繰り返す。docs/testing.mdを参照。
    { name: 'webkit', grep: /@cross-engine/, use: { browserName: 'webkit', headless: true } },
  ],
  webServer: {
    command: 'pnpm demo', port: 4192, reuseExistingServer: false,
    env: { NEEDMARK_DEMO_PORT: '4192', NEEDMARK_OUTPUT_DIR: output, NEEDMARK_DEMO_LANGUAGE: 'ja' },
  },
});
