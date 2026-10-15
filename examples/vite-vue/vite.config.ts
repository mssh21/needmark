import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { needmark } from 'needmark';

export default defineConfig({
  server: { host: '127.0.0.1', port: 4320, strictPort: true },
  plugins: [needmark(), vue()],
});
