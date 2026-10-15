import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { needmark } from 'needmark';

export default defineConfig({
  server: { host: '127.0.0.1', port: 4310, strictPort: true },
  plugins: [needmark(), react()],
});
