import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import { applyCalm, applyTheme } from './lib/theme'
import { readCalm } from './store/appStore'

// Design preview: served by plain Vite (`electron-vite dev --rendererOnly`)
// there is no preload and so no `window.tb`. Install the fixture bridge so the
// whole UI can be looked at in a browser. Dev-only and dead code in a build.
if (import.meta.env.DEV && !('tb' in window)) await import('./dev/mockTb')

// Paint the saved theme AND the calm setting before the first frame (settings
// arrive a tick later). A figure that flashes green and then greys is worse
// than one that never coloured.
applyTheme(localStorage.getItem('tb:theme'))
applyCalm(readCalm())

window.addEventListener('unhandledrejection', (e) => console.error('[unhandledrejection]', e.reason))

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
