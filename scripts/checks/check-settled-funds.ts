/**
 * Settled funds (2026-09-07): sale proceeds settle T+1, and in a CASH account
 * they cannot buy anything until they do.
 *
 *   Ledger.unsettled        lots appended by every sell in `applyFill`, pruned as they mature
 *   settledCash             cash − unsettled, the number a cash-account buy is sized against
 *   settlementModeFor       live follows the broker's account type; else guardrails.settlement; absent = off
 *   settle.unsettled        the guardrail (buys only)
 *   cap.dayTrades           RETIRED — the PDT rule ended 2026-06-04; a fourth day trade is no longer refused
 *
 * Run: `npm run check -- settled-funds`
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DEFAULT_GUARDRAILS, DEFAULT_MODEL, clampGuardrails, emptyLedger, entryDefaultsFor, fillEconomics, guardrailDiff, initialState, type AgentConfig, type AgentState, type Guardrails, type Ledger } from '@shared/agents'
import { configFromCreateRequest } from '@shared/createAgent'
import { etDateTime } from '@shared/marketTime'
import { brokerSettlementMode, describeSettlesOn, describeUnsettled, settledCash, settlementModeFor, settlesOn, unsettledCash } from '@shared/settlement'
import { applyFill } from '@core/broker/paper'
import { checkGuardrails } from '@core/broker/guardrails'
import { entryRuleLines, ledgerBlock } from '@core/runner/prompts'
import { RULE_LABEL } from '@shared/decisionSummary'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const AT = (date: string, hhmm: string): Date => etDateTime(date, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)))
const money = (n: number): string => `$${n.toFixed(2)}`

console.log('— settlement dates (T+1, trading days) —')
check('a Monday sale settles Tuesday', settlesOn(AT('2026-09-14', '10:00')) === '2026-09-15')
check('a Friday sale settles Monday', settlesOn(AT('2026-09-11', '15:59')) === '2026-09-14')
check('a Friday after-hours sale still settles Monday (trade date is the ET date)', settlesOn(AT('2026-09-11', '19:30')) === '2026-09-14')
check('the day before Thanksgiving (2026-11-25) settles Friday, skipping the holiday', settlesOn(AT('2026-11-25', '11:00')) === '2026-11-27')
check('describeSettlesOn reads as a day', describeSettlesOn('2026-09-15') === 'Tue, Sep 15', describeSettlesOn('2026-09-15'))

console.log('\n— the ledger tracks lots on its own —')
const mon = AT('2026-09-14', '10:00').toISOString()
let book: Ledger = emptyLedger(500)
book = applyFill(book, { symbol: 'MU', side: 'buy', qty: 2, price: 100, ts: mon }).ledger
check('a buy records no lot', (book.unsettled ?? []).length === 0 && book.cash === 300)
book = applyFill(book, { symbol: 'MU', side: 'sell', qty: 2, price: 100, ts: AT('2026-09-14', '11:00').toISOString() }).ledger
check('a sell appends its proceeds as a lot settling T+1', book.unsettled?.length === 1 && book.unsettled[0].amount === 200 && book.unsettled[0].settlesOn === '2026-09-15', JSON.stringify(book.unsettled))
check('cash is back to $500, of which $300 is settled today', book.cash === 500 && settledCash(book, '2026-09-14') === 300 && unsettledCash(book, '2026-09-14') === 200)
check('tomorrow every dollar is settled', settledCash(book, '2026-09-15') === 500)
const spent = applyFill(book, { symbol: 'AMD', side: 'buy', qty: 3, price: 100, ts: AT('2026-09-14', '11:30').toISOString() }).ledger
check('a buy spends SETTLED cash first: $200 cash left, all of it unsettled → settled $0', spent.cash === 200 && settledCash(spent, '2026-09-14') === 0)
const later = applyFill(spent, { symbol: 'AMD', side: 'sell', qty: 1, price: 100, ts: AT('2026-09-15', '10:00').toISOString() }).ledger
check('a fill on T+1 prunes the matured lot and keeps the new one', later.unsettled?.length === 1 && later.unsettled[0].settlesOn === '2026-09-16', JSON.stringify(later.unsettled))
check('a book written before this field existed reads as nothing unsettled', settledCash({ cash: 123, unsettled: undefined }, '2026-09-14') === 123)
check('describeUnsettled groups by day', describeUnsettled(later, '2026-09-15', money) === '$100.00 settles Wed, Sep 16', describeUnsettled(later, '2026-09-15', money))
const econ = fillEconomics(spent, later, later.fills[later.fills.length - 1])
check('the sell card carries settlesOn', econ.settlesOn === '2026-09-16')

console.log('\n— which rule governs —')
const cfg = (mode: 'paper' | 'live', g: Partial<Guardrails>): AgentConfig =>
  ({ id: 'ag', mode, allocationUsd: 500, liveArmedAt: mode === 'live' ? 'x' : null, schedule: { kind: 'manual' }, guardrails: { ...DEFAULT_GUARDRAILS, maxOrderNotional: 10_000, maxPositionNotional: 10_000, ...g }, createdAt: 'x', updatedAt: 'x', task: 't' }) as AgentConfig
check('paper, no setting → not simulated (an old agent keeps behaving)', settlementModeFor(cfg('paper', {}), 'cash') === null)
check("paper 'cash' → cash, whatever the broker says", settlementModeFor(cfg('paper', { settlement: 'cash' }), 'margin') === 'cash')
check("live + broker 'margin' → margin even if the agent says cash", settlementModeFor(cfg('live', { settlement: 'cash' }), 'margin') === 'margin')
check("live + broker 'cash' → cash even with no setting", settlementModeFor(cfg('live', {}), 'cash') === 'cash')
check('live + unknown broker type → the setting', settlementModeFor(cfg('live', { settlement: 'margin' }), undefined) === 'margin' && settlementModeFor(cfg('live', {}), null) === null)
check('the broker type is read by shape', brokerSettlementMode('margin') === 'margin' && brokerSettlementMode('cash') === 'cash' && brokerSettlementMode('individual') === null)

console.log('\n— the guardrail —')
const stateWith = (mode: 'paper' | 'live', ledger: Ledger): AgentState => ({ ...initialState({ allocationUsd: 500 }), ...(mode === 'live' ? { live: ledger } : { paper: ledger }) })
const buy = (notional: number) => ({ side: 'buy', symbol: 'AMD', notional, type: 'market', tif: 'day', reason: 'x' })
const guard = (mode: 'paper' | 'live', g: Partial<Guardrails>, ledger: Ledger, notional: number, brokerAccountType?: string | null) =>
  checkGuardrails({ config: cfg(mode, g), state: stateWith(mode, ledger), intent: buy(notional) as never, refPrice: 100, now: AT('2026-09-14', '12:00'), brokerAccountType })
const v = guard('paper', { settlement: 'cash' }, book, 400)
check('cash mode: a $400 buy against $300 settled is refused', v.rule === 'settle.unsettled')
check('the refusal names the settled figure, the pending amount and the day', /Only \$300\.00 of your \$500\.00 cash is SETTLED/.test(v.reason ?? '') && /\$200\.00 settles Tue, Sep 15/.test(v.reason ?? ''), v.reason)
check('the refusal tells a PAPER agent where the switch is', /Settings → Settlement/.test(v.reason ?? ''))
check('a $300 buy passes', guard('paper', { settlement: 'cash' }, book, 300).ok)
check('margin mode: $400 passes', guard('paper', { settlement: 'margin' }, book, 400).ok)
check('no setting: $400 passes (not simulated)', guard('paper', {}, book, 400).ok)
check('tomorrow the same buy passes', checkGuardrails({ config: cfg('paper', { settlement: 'cash' }), state: stateWith('paper', book), intent: buy(400) as never, refPrice: 100, now: AT('2026-09-15', '10:00') }).ok)
const sell = checkGuardrails({ config: cfg('paper', { settlement: 'cash' }), state: stateWith('paper', spent), intent: { side: 'sell', symbol: 'AMD', qty: 3, type: 'market', tif: 'day', reason: 'x' } as never, refPrice: 100, now: AT('2026-09-14', '12:00') })
check('selling is never held by settlement', sell.ok)
check('allocation is still checked first ($600 > $500 cash)', guard('paper', { settlement: 'cash' }, book, 600).rule === 'cap.allocation')
const lv = guard('live', {}, book, 400, 'cash')
check("live + broker 'cash': refused with no setting at all", lv.rule === 'settle.unsettled')
check('the live refusal points at the Robinhood upgrade, not our settings', /limited margin in Robinhood/.test(lv.reason ?? ''), lv.reason)
check("live + broker 'margin': passes", guard('live', { settlement: 'cash' }, book, 400, 'margin').ok)

console.log('\n— PDT is retired —')
const dayTrader: Ledger = { ...emptyLedger(500), positions: [{ symbol: 'MU', qty: 1, avgCost: 100 }], fills: ['2026-09-08', '2026-09-09', '2026-09-10', '2026-09-14'].flatMap((d) => [{ id: `b${d}`, ts: AT(d, '10:00').toISOString(), symbol: 'MU', side: 'buy' as const, qty: 1, price: 100, realized: 0 }, ...(d === '2026-09-14' ? [] : [{ id: `s${d}`, ts: AT(d, '11:00').toISOString(), symbol: 'MU', side: 'sell' as const, qty: 1, price: 101, realized: 1 }])]) }
const fourth = checkGuardrails({ config: cfg('live', {}), state: stateWith('live', dayTrader), intent: { side: 'sell', symbol: 'MU', qty: 1, type: 'market', tif: 'day', reason: 'x' } as never, refPrice: 101, now: AT('2026-09-14', '12:00'), brokerAccountType: 'margin' })
check('a fourth day trade in five days on a small live account is allowed', fourth.ok, fourth.reason)
check('the retired key still reads as a sentence for old rows', /retired/.test(RULE_LABEL['cap.dayTrades']))
const guardSrc = readFileSync(resolve(import.meta.dirname, '../../src/core/broker/guardrails.ts'), 'utf8')
check('nothing records cap.dayTrades any more', !/rule: 'cap\.dayTrades'/.test(guardSrc))
check("the settlement rule's label exists", RULE_LABEL['settle.unsettled'].length > 0)

console.log('\n— defaults, clamp, diff, prompt, settings, tool —')
check("a new agent is 'cash' (the Agentic default)", entryDefaultsFor({ kind: 'manual' }).settlement === 'cash' && configFromCreateRequest({ name: '', task: 't', allocationUsd: 500, mode: 'paper' } as never, DEFAULT_MODEL).guardrails.settlement === 'cash')
check('clamp keeps a valid mode and drops junk', clampGuardrails({ settlement: 'margin' }, 500).settlement === 'margin' && clampGuardrails({ settlement: 'weekly' as never }, 500).settlement === undefined)
const d1 = guardrailDiff({ ...DEFAULT_GUARDRAILS, settlement: 'cash' }, { settlement: 'margin' })
check('cash → margin reads as looser', d1.length === 1 && d1[0].looser && d1[0].from === 'cash' && d1[0].to === 'margin')
const d2 = guardrailDiff({ ...DEFAULT_GUARDRAILS, settlement: 'cash' }, { settlement: undefined })
check('cash → off (null) reads as looser', d2.length === 1 && d2[0].looser && d2[0].to === 'off')
check('margin → cash reads as tighter', guardrailDiff({ ...DEFAULT_GUARDRAILS, settlement: 'margin' }, { settlement: 'cash' })[0]?.looser === false)
check('unchanged → no diff', guardrailDiff({ ...DEFAULT_GUARDRAILS, settlement: 'cash' }, { maxOrdersPerDay: 10 }).length === 0)
const blk = ledgerBlock(book, [], 'paper', { mode: 'cash', etDate: '2026-09-14' })
check('YOUR BOOK states settled cash as the number to size against', /SETTLED cash \(what you can spend on buys today\): \$300\.00 · unsettled \$200\.00 \(\$200\.00 settles Tue, Sep 15\)/.test(blk), blk)
check('in margin mode the book says the proceeds are spendable now', /spendable now under limited margin/.test(ledgerBlock(book, [], 'paper', { mode: 'margin', etDate: '2026-09-14' })))
check('with no mode the book says settlement is not simulated', /not simulated/.test(ledgerBlock(book, [], 'paper', { mode: null, etDate: '2026-09-14' })))
check('a fully settled book says so', /nothing unsettled/.test(ledgerBlock(book, [], 'paper', { mode: 'cash', etDate: '2026-09-15' })))
check('a caller that predates the parameter gets the old block', !/settle/i.test(ledgerBlock(book, [], 'paper')))
const rules = entryRuleLines(cfg('paper', { settlement: 'cash' }), book, AT('2026-09-14', '12:00'), 'cash')
check('HEADROOM states the T+1 rule before the agent tries', rules.some((l) => /SETTLEMENT \(T\+1, cash account\)/.test(l)))
check('no settlement → no rule line', !entryRuleLines(cfg('paper', {}), book, AT('2026-09-14', '12:00'), null).some((l) => /SETTLEMENT/.test(l)))
const sheet = readFileSync(resolve(import.meta.dirname, '../../src/renderer/src/components/sheets/AgentSettingsSheet.tsx'), 'utf8')
check('the settings sheet edits it', /settlement:/.test(sheet) && /SETTLEMENT_LABEL/.test(sheet))
const tools = readFileSync(resolve(import.meta.dirname, '../../src/core/runner/agentTools.ts'), 'utf8')
check('change_plan exposes it (nullable = remove)', /settlement: z[\s\S]{0,80}\.enum\(\['cash', 'margin'\]\)[\s\S]{0,40}\.nullable\(\)/.test(tools))
const prompts = readFileSync(resolve(import.meta.dirname, '../../src/core/runner/prompts.ts'), 'utf8')
check('the PDT prompt block is gone', !/PATTERN DAY TRADER/.test(prompts) && !/pdtBlock/.test(prompts))

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
