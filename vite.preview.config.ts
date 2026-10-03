import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * Renderer-only preview for design work: `npx vite --config vite.preview.config.ts`.
 *
 * Serves the React app in an ordinary browser with NO Electron, no preload and
 * no engine — `src/renderer/src/dev/mockTb.ts` stands in for the IPC bridge
 * with fixture agents. Mirrors the renderer half of electron.vite.config.ts;
 * keep the aliases in step.
 */
export default defineConfig({
  root: resolve('src/renderer'),
  resolve: { alias: { '@renderer': resolve('src/renderer/src'), '@shared': resolve('src/shared') } },
  plugins: [react(), tailwindcss()],
  server: { port: 5173, strictPort: true }
})
