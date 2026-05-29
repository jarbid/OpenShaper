import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false,
  },
  // Tauri expects a relative base so the bundled assets resolve inside the app.
  base: './',
});
