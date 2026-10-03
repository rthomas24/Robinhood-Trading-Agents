/**
 * "Is the Local GPU set up?" must have ONE answer.
 *
 * Three surfaces ask it: the provider picker's readiness dot (status bar, New
 * agent, Agent settings), the Local models page's "default" pill, and that
 * page's enable toggle. They each computed it, and they drifted:
 *
 *   pill    settings.localModel.modelId ?? local.defaultModelId
 *   toggle  settings.localModel.modelId
 *   picker  settings.localModel.modelId
 *
 * STARTING a model makes it the default — `local/engine.ts` does
 * `if (cur.modelId !== modelId) settingsStore.save({ localModel: { ...cur, modelId } })`.
 * So main's settings change without the renderer asking. `refreshLocal()` re-read
 * `LocalStatus` and not settings, leaving `local.defaultModelId` fresh and
 * `settings.localModel.modelId` stale-null.
 *
 * The result was a model wearing a "default" pill, beside a disabled toggle
 * telling the operator to pick a default, beside a picker offering "Set up" for
 * a GPU that was already running one. And the IPC gate in main read MAIN's
 * settings, which were right all along — so the provider genuinely worked and
 * only the UI insisted it did not. Nothing was broken and every surface said it
 * was, which is the hardest version to diagnose from a screenshot.
 *
 * Two things hold it shut, and this asserts both, because either alone leaves
 * the bug reachable:
 *   1. one accessor, so the three cannot disagree even while stale
 *   2. `refreshLocal` re-reads settings, so they do not go stale in the first place
 *
 * Run: `npm run check -- local-default-model`
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { localDefaultModelId } from '../../src/renderer/src/lib/vendor'
import type { AppSettings } from '@shared/ipc'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const R = join(import.meta.dirname, '..', '..', 'src', 'renderer', 'src')
const code = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
const read = (...p: string[]): string => code(readFileSync(join(R, ...p), 'utf8'))

const settings = (modelId: string | null): AppSettings => ({ localModel: { enabled: false, folder: null, modelId } }) as AppSettings

// ------------------------------------------------------------- the accessor

check('the live engine value wins when settings are stale', localDefaultModelId(settings(null), { defaultModelId: 'qwen' }) === 'qwen', 'this IS the reported bug: starting a model set it in main, the renderer had not re-read')
check('settings answer before the first refreshLocal', localDefaultModelId(settings('qwen'), null) === 'qwen')
check('neither set means genuinely not set up', localDefaultModelId(settings(null), { defaultModelId: null }) === null)
check('undefined inputs do not throw', localDefaultModelId(undefined, undefined) === null)
check('a stale settings value never masks a cleared engine default', localDefaultModelId(settings('old'), { defaultModelId: null }) === null, 'the engine clears modelId when the folder changes; settings must not resurrect it')

// -------------------------------------------------- all three read the same

const picker = read('components', 'common', 'ProviderPicker.tsx')
const section = read('components', 'account', 'LocalModelsSection.tsx')

check('the picker uses the shared accessor', /localDefaultModelId\(settings, local\)/.test(picker))
check('the Local models page uses it', /localDefaultModelId\(settings, local\)/.test(section))
check('the enable toggle uses the same value as the pill', /disabled=\{!enabled && !defaultId\}/.test(section), 'it read settings directly, so it stayed disabled beside a model already marked default')

for (const [name, src] of [
  ['ProviderPicker', picker],
  ['LocalModelsSection', section]
] as const) {
  check(`${name} reads no private copy of the default`, !/settings\?\.localModel\?\.modelId/.test(src), 'one accessor or three answers — there is no third option')
}

// ------------------------------------------- and they do not go stale at all

const store = read('store', 'appStore.ts')
const body = store.slice(store.indexOf('async refreshLocal'), store.indexOf('async refreshLocal') + 400)
check('refreshLocal also re-reads settings', /refreshSettings\(\)/.test(body), 'the engine writes settings behind the renderer; reading only LocalStatus is what let them diverge')

// The engine really does write it — if that ever stops being true, the whole
// premise of this check changes and someone should know.
const engine = code(readFileSync(join(import.meta.dirname, '..', '..', 'src', 'main', 'local', 'engine.ts'), 'utf8'))
check('starting a model still writes the default in main', /cur\.modelId !== modelId.*settingsStore\.save/s.test(engine), 'if this stops, refreshLocal no longer needs the settings read')

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
if (failures) process.exit(1)
