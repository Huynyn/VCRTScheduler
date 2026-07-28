import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Local dev server for the VCRT scheduler.
// Run `npm run dev` then open the printed http://localhost:5173 URL.
//
// `base: './'` (relative) is used for production builds so the app works when
// served from a subpath such as GitHub Pages (https://user.github.io/<repo>/)
// without hardcoding the repo name. Dev keeps the normal root base.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? './' : '/',
  plugins: [react()],
  server: {
    port: 5173,
    open: true,
  },
}));
