import type { PortfolioSnapshot } from '@shared/portfolio'
import { buildPortfolioSnapshot, resolveAccountNumber } from '@core/robinhood/portfolio'
import { rhCreds } from './credStore'
import { symbolsToMark } from '@shared/agents'
import { agentStore } from '../store/agentStore'

/**
 * The operator's Robinhood account (balances, positions marked at the latest
 * quote, quotes, optional sparklines), for the portfolio IPC handler and the
 * live-allocation gate; the account number is cached in the credential store
 * after first resolution. `sparks`: null = fetch, object = reuse, false = skip.
 */
export async function fetchPortfolioSnapshot(opts: { sparks: Record<string, number[]> | null | false }): Promise<PortfolioSnapshot> {
  const rh = rhCreds.client()
  if (!rh) throw new Error('Robinhood not connected')
  const creds = rhCreds.get()!
  let acct = creds.accountNumber
  if (!acct) {
    acct = (await resolveAccountNumber(rh)) ?? undefined
    if (acct) rhCreds.save({ ...creds, accountNumber: acct })
  }
  if (!acct) throw new Error('No Robinhood account found')
  // Every agent's holdings too, so a PAPER position is priced — it holds
  // nothing at the broker, so on the broker's symbols alone its mark is
  // absent and its day P&L silently collapses to cost basis (0.00%).
  const extraSymbols = symbolsToMark(agentStore.list().map((s) => ({ config: s.config, state: s.state })))
  return buildPortfolioSnapshot(rh, acct, { sparks: opts.sparks, source: 'desktop', extraSymbols })
}
