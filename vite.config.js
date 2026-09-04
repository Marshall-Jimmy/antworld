import { defineConfig } from 'vite';

export default defineConfig({
  // 5173 落在 Windows 保留端口段(5141-5240)内会 EACCES, 改用 5300
  server: { host: true, port: 5300, open: false },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
});