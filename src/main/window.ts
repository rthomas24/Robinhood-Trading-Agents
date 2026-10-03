import { app, BrowserWindow } from 'electron'

/**
 * Bring the window forward after the user returns from the browser (OAuth).
 * Windows focus-stealing prevention downgrades a bare focus() to a taskbar flash,
 * so pulse always-on-top briefly, with flashFrame as a fallback.
 */
let clearFlash: (() => void) | undefined

export function focusMainWindow(): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win || win.isDestroyed()) return
  if (win.isFocused() && !win.isMinimized()) return
  if (win.isMinimized()) win.restore()
  win.setAlwaysOnTop(true)
  win.show()
  win.focus()
  win.moveTop()
  if (process.platform === 'darwin') app.focus({ steal: true })
  setTimeout(() => {
    if (!win.isDestroyed()) win.setAlwaysOnTop(false)
  }, 300)
  if (process.platform === 'win32') {
    if (clearFlash) win.removeListener('focus', clearFlash)
    setTimeout(() => {
      if (!win.isDestroyed() && !win.isFocused()) win.flashFrame(true)
    }, 350)
    clearFlash = () => {
      if (!win.isDestroyed()) win.flashFrame(false)
    }
    win.once('focus', clearFlash)
  }
}
