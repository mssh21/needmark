import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { needmark } from '../dist/index.js';

const port = Number(process.env.NEEDMARK_DEMO_PORT ?? 4190);
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  server: { host: '127.0.0.1', port, strictPort: true },
  build: { rollupOptions: { input: ['index.html', 'react.html', 'embed.html'].map((page) => fileURLToPath(new URL(page, import.meta.url))) } },
  plugins: [react(), needmark({
    outputDir: process.env.NEEDMARK_OUTPUT_DIR ?? '.needmark/feedback',
    contextAttributes: ['data-feature', 'data-ticket'],
    editor: 'vscode',
    // E2E specs select controls by the Japanese default captions; manual demos follow the English demo content.
    // E2Eは日本語の既定表記で操作を選ぶため、手動のデモだけ英語のデモ内容に合わせる。
    language: process.env.NEEDMARK_DEMO_LANGUAGE === 'ja' ? 'ja' : 'en',
  })],
});
