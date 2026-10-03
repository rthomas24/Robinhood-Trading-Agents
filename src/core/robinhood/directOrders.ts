import type { TradeIntent } from '@shared/agents'

/**
 * Helpers for the (operator-enabled) direct Robinhood order tools: map the raw
 * `place_equity_order` arguments onto our TradeIntent so the same guardrails
 * apply, and pull the order id/state back out of whatever shape the MCP tool
 * result arrives in (hook payloads vary by vendor).
 */
function num(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined
  const n = typeof v === 'number' ? v : Number(String(v))
  return Number.isFinite(n) ? n : undefined
}

export function intentFromDirectOrder(input: Record<string, unknown>): TradeIntent {
  return {
    side: input.side === 'sell' ? 'sell' : 'buy',
    symbol: String(input.symbol ?? '').toUpperCase(),
    qty: num(input.quantity ?? input.qty),
    notional: num(input.dollar_amount ?? input.dollarAmount ?? input.notional),
    type: input.type === 'limit' ? 'limit' : 'market',
    limitPrice: num(input.limit_price ?? input.limitPrice),
    tif: input.time_in_force === 'gtc' ? 'gtc' : 'day',
    reason: 'Placed directly via Robinhood MCP (place_equity_order)'
  }
}

export function orderFromToolResponse(resp: unknown): { orderId?: string; state?: string } {
  const texts: string[] = []
  const walk = (v: unknown): void => {
    if (typeof v === 'string') texts.push(v)
    else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      if (typeof o.text === 'string') texts.push(o.text)
      if (o.content) walk(o.content)
      if (o.order || o.id || o.order_id) texts.push(JSON.stringify(o))
    }
  }
  walk(resp)
  for (const t of texts) {
    try {
      const j = JSON.parse(t) as Record<string, unknown>
      const inner = ((j.data as Record<string, unknown> | undefined) ?? j) as Record<string, unknown>
      const o = ((inner.order as Record<string, unknown> | undefined) ?? inner) as { id?: string; order_id?: string; state?: string; status?: string }
      const orderId = o.id ?? o.order_id
      if (orderId) return { orderId: String(orderId), state: o.state ?? o.status }
    } catch {
      /* not json */
    }
  }
  return {}
}
