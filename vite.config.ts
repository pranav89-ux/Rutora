import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiTarget = `http://127.0.0.1:${process.env.API_PORT || 8000}`;

export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': apiTarget } },
  preview: { proxy: { '/api': apiTarget } },
});
