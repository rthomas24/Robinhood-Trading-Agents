import { short } from './vendors/shared'

/**
 * Loop guard. A model calling the SAME tool with the SAME arguments over and
 * over is going in circles: the answer never changes and every lap costs the
 * operator tokens. Because our tools run in-process behind the `ToolGate`
 * (rather than inside a vendor CLI), the run can actually be told to stop —
 * first by noting the repetition, then by refusing the call with an advisory
 * the model reads as a tool result.
 *
 * Per run, keyed on tool name + normalized arguments, so the same tool with
 * different symbols is never mistaken for a loop.
 */
export const REPEAT_WARN_AT = 3
export const REPEAT_BLOCK_AT = 6
/** Bound the map: a pathological run must not grow memory without limit. */
const MAX_KEYS = 256

export type RepeatAction = 'allow' | 'warn' | 'block'
export interface RepeatVerdict {
  count: number
  action: RepeatAction
}

/** `name(a=1&b=2)` — key order and whitespace normalized so equal calls collide. */
export function callKey(name: string, input: unknown): string {
  let args = ''
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    args = Object.entries(input as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${short(v, 80)}`)
      .join('&')
  } else if (input !== undefined) {
    args = short(input, 120)
  }
  return `${name}(${args})`
}

export class RepeatDetector {
  private readonly counts = new Map<string, number>()

  note(name: string, input: unknown): RepeatVerdict {
    const key = callKey(name, input)
    const count = (this.counts.get(key) ?? 0) + 1
    if (this.counts.has(key) || this.counts.size < MAX_KEYS) this.counts.set(key, count)
    if (count >= REPEAT_BLOCK_AT) return { count, action: 'block' }
    if (count >= REPEAT_WARN_AT) return { count, action: 'warn' }
    return { count, action: 'allow' }
  }
}

/** What the model is told when the guard closes — an instruction, not just a refusal. */
export function repeatBlockMessage(name: string, count: number): string {
  return `Loop guard: you have called ${name} with identical arguments ${count} times in this run. The result will not change. Use different arguments, a different tool, or finish your turn with what you already know.`
}
