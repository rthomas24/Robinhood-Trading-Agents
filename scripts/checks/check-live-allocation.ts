/**
 * A live allocation fits inside what the OTHER live agents leave of the
 * account (`shared/liveAllocation.ts`).
 *
 *   liveRoom               buying power − Σ other non-retired live agents' undeployed cash
 *   liveAllocationVerdict  the refusal, with the numbers and what would fit
 *   wiring                 New agent + Agent settings + the IPC gate
 *
 * Run: `npm run check -- live-allocation`
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { emptyLedger, initialState, type AgentConfig, type AgentState } from '@shared/agents'
import { liveAllocationVerdict, liveRoom, liveRoomLabel } from '@shared/liveAllocation'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const src = (rel: string): string => readFileSync(resolve(import.meta.dirname, '..', '..', rel), 'utf8').replace(/\r\n/g, '\n')
const agent = (id: string, mode: 'paper' | 'live', allocationUsd: number, o: { status?: AgentState['status']; liveCash?: number } = {}) => ({
  config: { id, mode, allocationUsd } as AgentConfig,
  state: { ...initialState({ allocationUsd }), status: o.status ?? 'scheduled', live: { ...emptyLedger(o.liveCash ?? allocationUsd) } } as AgentState
})

console.log('— the room —')
const agents = [agent('a', 'live', 500), agent('b', 'paper', 5000), agent('c', 'live', 250, { status: 'retired' }), agent('d', 'live', 200, { status: 'paused' })]
const room = liveRoom(800, agents)
check('$500 + $200 live agents on an $800 account leave $100', room.available === 100 && room.claimed === 700 && room.claimedBy === 2, JSON.stringify(room))
check('paper agents claim nothing', liveRoom(800, [agent('p', 'paper', 9999)]).available === 800)
check('a retired live agent claims nothing', liveRoom(800, [agent('c', 'live', 250, { status: 'retired' })]).available === 800)
check('a paused live agent still claims its cash', liveRoom(800, [agent('d', 'live', 200, { status: 'paused' })]).claimed === 200)
check('a live agent that DEPLOYED $350 of $500 claims only the $150 it still holds', liveRoom(400, [agent('a', 'live', 500, { liveCash: 150 })]).available === 250)
check('the agent being re-sized is not its own competitor', liveRoom(800, agents, { exceptAgentId: 'a' }).available === 600)
check('the room never goes negative', liveRoom(50, agents).available === 0)

console.log('\n— the verdict —')
check('inside the room passes', liveAllocationVerdict(room, 100).ok)
const over = liveAllocationVerdict(room, 500)
check('over the room is refused with the free amount, the claim and who holds it', !over.ok && /Only \$100\.00 of your \$800 buying power is left to allocate — \$700\.00 is already held by 2 other live agents/.test(over.reason), over.ok ? '' : over.reason)
const alone = liveAllocationVerdict(liveRoom(800, []), 1000)
check('with no other live agent the sentence is about the account itself', !alone.ok && /more than the \$800 of buying power/.test(alone.reason))
check('zero is refused', !liveAllocationVerdict(room, 0).ok)
check('the field label says what is free and who holds the rest', /\$100\.00 free of \$800\.00 buying power · \$700\.00 held by 2 other live agents/.test(liveRoomLabel(room)), liveRoomLabel(room))

console.log('\n— wiring —')
const sheet = src('src/renderer/src/components/sheets/NewAgentSheet.tsx')
check('New agent measures the room against every agent and blocks Create on it', /liveRoom\(acct\.buyingPower, Object\.values\(agents\)\)/.test(sheet) && /if \(liveVerdict && !liveVerdict\.ok\) return liveVerdict\.reason/.test(sheet))
check('its Max preset is the room, not raw buying power', /const available = room\?\.available \?\? null/.test(sheet))
const settings = src('src/renderer/src/components/sheets/AgentSettingsSheet.tsx')
check('Agent settings measures the room excluding the agent itself and refuses on save', /exceptAgentId: agentId/.test(settings) && /setAllocErr\(liveVerdict\.reason\)/.test(settings))
const ipc = src('src/main/ipc/register.ts')
check('the IPC gate checks create, a move to live, and a bigger live allocation', /await requireLiveRoom\(cfg\)/.test(ipc) && /patch\.mode === 'live' \|\| \(cur\.mode === 'live' && patch\.allocationUsd !== undefined && patch\.allocationUsd > cur\.allocationUsd\)/.test(ipc))
check('the gate lets the write through when the account cannot be read (never refuse on a guess)', /live allocation not checked — account unreadable/.test(ipc))

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
