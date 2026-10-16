import { defineConfig } from 'astro/config';
import { needmark } from 'needmark';

export default defineConfig({
  vite: { plugins: [needmark()] },
});
