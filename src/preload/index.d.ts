import type { AuthEvent, TbApi } from '@shared/ipc'

declare global {
  interface Window {
    tb: TbApi & { onAuthEvent(cb: (e: AuthEvent) => void): () => void }
  }
}

export {}
