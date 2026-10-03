import { app, BrowserWindow } from 'electron'
import { openExternalSafely } from './lib/openExternal'
import { isSameAppDocument } from '@shared/externalUrl'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerIpc } from './ipc/register'
import { engine } from './engine/Engine'
import { realtimeEngine } from './realtime/RealtimeEngine'
import { loadStoredTokenIntoEnv } from './claude/tokenStore'
import { settingsStore } from './store/settingsStore'
import { themeById } from '@shared/themes'
import { focusMainWindow } from './window'
import { routeNotification } from './notify'
import { usageService } from './claude/usage'
import { localEngine } from './local/engine'

/** Native title-bar chrome follows the saved theme's rail/text tokens. */
const chromeFor = (theme: string): { background: string; symbol: string } => {
  const th = themeById(theme)
  return { background: th.tokens.rail, symbol: th.tokens.text }
}

// One instance at a time: two engines would run the same agents twice.
if (!app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', () => focusMainWindow())

// Every web contents shows only the app. A new window becomes the operator's
// browser (safe URLs only); a navigation away is refused, because the preload
// bridge would follow the main frame to whatever page it loaded; webviews are
// never attached. Registered for every contents, so a window added later is
// guarded without remembering to.
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler((d) => {
    void openExternalSafely(d.url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (e, url) => {
    if (!isSameAppDocument(url, contents.getURL())) e.preventDefault()
  })
  contents.on('will-attach-webview', (e) => e.preventDefault())
})

function createWindow(): void {
  const chrome = chromeFor(settingsStore.load().theme)
  // The packaged app takes its icon from build/icon.png via electron-builder;
  // this is what the window and the taskbar show while developing, and what
  // Linux uses at runtime. Guarded so a missing file is never fatal.
  const iconPath = join(__dirname, '../../resources/icon.png')
  const window = new BrowserWindow({
    ...(existsSync(iconPath) ? { icon: iconPath } : {}),
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: chrome.background,
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 16, y: 16 } } : {}),
    titleBarOverlay: { color: chrome.background, symbolColor: chrome.symbol, height: 40 },
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false, contextIsolation: true }
  })
  const dispose = registerIpc(window)
  window.on('closed', dispose)
  window.on('ready-to-show', () => window.show())
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) void window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else void window.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('org.robinhood-trading-agents.app')
  loadStoredTokenIntoEnv()
  if (process.env.ANTHROPIC_API_KEY) {
    console.warn('[robinhood-trading-agents] WARNING: ANTHROPIC_API_KEY is set. It overrides your Claude subscription and bills per token.')
  }
  app.on('browser-window-created', (_, win) => optimizer.watchWindowShortcuts(win))
  try {
    await engine.init()
    engine.onEvent(routeNotification)
    // Real-time paper agents (System One model); sleeps until the open.
    realtimeEngine.init()
  } catch (err) {
    console.error('[robinhood-trading-agents] engine init failed', err)
  }
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Quit stops everything this app started. llama-server is a child process, and
// on Windows a child outlives its parent — left running it would keep the GPU's
// memory and its port, so the next launch could not start a model. The stop is
// awaited once, bounded so a hung engine can never keep the app from quitting.
let shutdown: 'running' | 'stopping' | 'done' = 'running'
app.on('before-quit', (e) => {
  if (shutdown === 'done') return
  e.preventDefault()
  if (shutdown === 'stopping') return
  shutdown = 'stopping'
  engine.disposeAll()
  realtimeEngine.disposeAll()
  usageService.stop()
  void Promise.race([localEngine.close(), new Promise<void>((resolve) => setTimeout(resolve, 5_000))]).finally(() => {
    shutdown = 'done'
    app.quit()
  })
})
