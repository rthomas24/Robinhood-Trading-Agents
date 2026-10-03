import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// ESM-only SDKs (and the Claude Agent SDK's per-platform CLI binary, resolved
// via `import.meta.url`) must stay external — never bundled — and are loaded
// through a dynamic `import()` (src/main/claude/sdk.ts, src/main/openrouter/sdk.ts).
const KEEP_EXTERNAL = ['@anthropic-ai/claude-agent-sdk', '@openrouter/agent', '@openrouter/agent/mcp', '@openrouter/sdk', '@modelcontextprotocol/client', '@elyxndra/engine', '@elyxndra/agent']

export default defineConfig(() => {
  const alias = { '@shared': resolve('src/shared'), '@core': resolve('src/core') }
  return {
    main: {
      resolve: { alias },
      plugins: [externalizeDepsPlugin()],
      build: { rollupOptions: { external: KEEP_EXTERNAL } }
    },
    preload: {
      resolve: { alias },
      plugins: [externalizeDepsPlugin()]
    },
    renderer: {
      resolve: { alias: { '@renderer': resolve('src/renderer/src'), '@shared': resolve('src/shared') } },
      plugins: [react(), tailwindcss()]
    }
  }
})
