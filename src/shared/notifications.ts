import { isOpenQuestion, WATCH_FIRED_PREFIX, type Message } from './agents'
import { formatEt } from './marketTime'

/**
 * One rule set for "is this message worth interrupting the operator?" — used
 * by the desktop's OS notifications (main/notify.ts). The agent's thread shows
 * everything; notifications are only for the moments that need a human or
 * that a human asked for.
 */
export interface NotifyPrefs {
  /** Always true — a question with a deadline is the one thing that must reach the operator. */
  questions: true
  /** Agent replies to the operator and explicit `tell_operator` heads-ups. */
  conversation: boolean
  /** Fills: real-money only, every fill (incl. paper), or none. Protective exits always notify. */
  trades: 'live' | 'all' | 'none'
  /** Run errors, retirements, fired price watches. */
  errors: boolean
}

export const DEFAULT_NOTIFY_PREFS: NotifyPrefs = { questions: true, conversation: true, trades: 'live', errors: true }

export interface Notification {
  title: string
  body: string
  /** `high` is urgent (questions, real fills, errors); `normal` is a quiet update. */
  priority: 'high' | 'normal'
}

const clip = (s: string, n = 200): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/**
 * The notification for a thread message, or null when it should stay in the
 * thread. `agentName` is the thread's display name. Question fields beyond the
 * base type (`stakes`, `fallback`, `deadline`) and the agent `notify` flag are
 * read optionally so older rows still route correctly.
 */
export function notificationFor(m: Message, agentName: string, prefs: NotifyPrefs = DEFAULT_NOTIFY_PREFS): Notification | null {
  switch (m.role) {
    case 'approval': {
      // Not a preference: the agent is stopped until this is answered, and an
      // unnoticed card is an agent that quietly does nothing all day.
      if (m.status !== 'pending') return null
      return { title: `${agentName} needs your OK`, body: clip([m.action.summary, m.action.reason].filter(Boolean).join(' — '), 240), priority: 'high' }
    }
    case 'question': {
      if (!isOpenQuestion(m)) return null
      // ET, never the host's locale: the deadline is a market-clock promise.
      const when = m.deadline ? ` · answer by ${formatEt(m.deadline)}` : ''
      const body = [m.stakes, m.text, m.fallback ? `If you don't answer: ${m.fallback}` : ''].filter(Boolean).join(' — ')
      return { title: `${agentName} needs a decision${when}`, body: clip(body, 240), priority: 'high' }
    }
    case 'agent': {
      // `important` (tell_operator) notifies like a question; `fyi` (replies, heads-ups) respects the pref.
      if (!m.notify) return null
      if (m.notify === 'important') return { title: `${agentName} · heads-up`, body: clip(m.text), priority: 'high' }
      if (!prefs.conversation) return null
      return { title: agentName, body: clip(m.text), priority: 'normal' }
    }
    case 'action': {
      const a = m.action
      const protective = /^(Protective|Profit)/.test(a.reason)
      if (a.status === 'filled') {
        if (!(protective || prefs.trades === 'all' || (prefs.trades === 'live' && a.mode === 'live'))) return null
        return {
          title: `${agentName} · ${a.side.toUpperCase()} ${a.fillQty ?? a.qty} ${a.symbol}`,
          body: `${protective ? a.reason : `Filled @ $${a.fillPrice?.toFixed(2)}`} (${a.mode})`,
          priority: a.mode === 'live' || protective ? 'high' : 'normal'
        }
      }
      if (a.status === 'rejected' && a.mode === 'live' && prefs.trades !== 'none') return { title: `${agentName} · order rejected`, body: clip(a.error ?? `${a.side} ${a.symbol}`), priority: 'high' }
      return null
    }
    case 'system':
      // The sender's flag outranks the preferences: an agent the ENGINE stopped
      // (broker needs reconnecting, a retirement that could not flatten) is the
      // one case where saying nothing looks exactly like the app quietly
      // breaking. An operator-initiated pause carries no flag and stays quiet.
      if (m.notify === 'important') return { title: `${agentName} stopped`, body: clip(m.text), priority: 'high' }
      if (!prefs.errors) return null
      if (m.kind === 'error') return { title: `${agentName} · error`, body: clip(m.text), priority: 'high' }
      if (m.kind === 'retired') return { title: `${agentName} retired`, body: clip(m.text), priority: 'normal' }
      if (m.text.startsWith(WATCH_FIRED_PREFIX)) return { title: `${agentName} · watch fired`, body: clip(m.text.slice(WATCH_FIRED_PREFIX.length)), priority: 'normal' }
      return null
    default:
      return null
  }
}
