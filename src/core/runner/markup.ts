/**
 * Tool-call markup that leaks into a reply as TEXT.
 *
 * Some models sometimes write their function call in the prose channel
 * — `<tool_call>…<arg_key>…</arg_key><arg_value>…</arg_value></tool_call>`,
 * `<invoke name="mcp__tb__report">`, or a replayed `<function_results>` block —
 * and the thread then shows the operator a page of pseudo-XML under the
 * agent's name (measured at about 2% of agent messages on one model). The
 * call itself never ran (the vendor only executes calls from the
 * tool channel), so nothing here is an action; it is noise in the answer.
 *
 * Matched elements go whole — their content is the call or its result, never
 * the answer. A dangling tag goes alone, so a reply that opens a tag and never
 * closes it keeps its words. The raw text stays in the trace for debugging;
 * only the message the operator reads is cleaned.
 */
const LEAK_TAGS = ['function_calls', 'function_results', 'invoke', 'tool_call', 'tool_calls', 'arg_key', 'arg_value', 'parameter']
const QUICK = new RegExp(`</?(?:${LEAK_TAGS.join('|')})[\\s>]`)
const ELEMENT = new RegExp(`<(${LEAK_TAGS.join('|')})(?:\\s[^>]*)?>[\\s\\S]*?</\\1\\s*>`, 'g')
const TAG = new RegExp(`</?(?:${LEAK_TAGS.join('|')})(?:\\s[^>]*)?>`, 'g')

export interface StrippedText {
  text: string
  /** True when anything was removed. */
  leaked: boolean
  /** Characters removed. */
  removed: number
}

export function stripLeakedMarkup(text: string): StrippedText {
  if (!QUICK.test(text)) return { text, leaked: false, removed: 0 }
  const out = text.replace(ELEMENT, '').replace(TAG, '').replace(/\n{3,}/g, '\n\n')
  return { text: out, leaked: out.length !== text.length, removed: text.length - out.length }
}
