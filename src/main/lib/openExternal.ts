import { shell } from 'electron'
import { safeExternalUrl } from '@shared/externalUrl'

/**
 * `shell.openExternal` for safe URLs only — absolute http(s) or mailto
 * (`shared/externalUrl.ts`). Every call in the main process goes through here,
 * including URLs that arrive from the network (an OAuth provider's authorize
 * endpoint, a device-code verification page). Returns whether it opened.
 */
export async function openExternalSafely(url: unknown): Promise<boolean> {
  const safe = safeExternalUrl(url)
  if (!safe) return false
  await shell.openExternal(safe)
  return true
}
