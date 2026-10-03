import { BrowserWindow, Notification } from 'electron'
import type { AgentEvent } from '@shared/ipc'
import { DEFAULT_NOTIFY_PREFS, notificationFor, type NotifyPrefs } from '@shared/notifications'
import { agentStore } from './store/agentStore'
import { focusMainWindow } from './window'

/**
 * Desktop notifications. The RULE — which messages are worth interrupting the
 * operator for and how they read — is `shared/notifications.ts notificationFor()`.
 * This file only owns delivery: silent while the window is focused (the thread
 * shows it live), click focuses.
 */
const prefs: NotifyPrefs = DEFAULT_NOTIFY_PREFS

function windowFocused(): boolean {
  const win = BrowserWindow.getAllWindows()[0]
  return Boolean(win && !win.isDestroyed() && win.isFocused())
}

export function routeNotification(e: AgentEvent): void {
  if (e.type !== 'message:new') return
  const name = agentStore.getConfig(e.message.agentId)?.name ?? 'Agent'
  const n = notificationFor(e.message, name, prefs)
  if (!n || !Notification.isSupported() || windowFocused()) return
  const toast = new Notification({ title: n.title, body: n.body.slice(0, 200), silent: false, urgency: n.priority === 'high' ? 'critical' : 'normal' })
  toast.on('click', () => focusMainWindow())
  toast.show()
}
