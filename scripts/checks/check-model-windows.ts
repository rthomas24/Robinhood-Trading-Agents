/**
 * Every model the product offers must have a context-window entry.
 *
 * `claude-opus-5` works on the Claude subscription and was simply missing from
 * `WINDOWS`. It therefore took `UNKNOWN_MODEL_WINDOW` (128k) and got a
 * transcript budget of 22,400 chars against Sonnet 5's 280,000 — **12× smaller,
 * on the most capable model available.** Its threads would have been
 * aggressively truncated, silently, forever.
 *
 * The defect is not the missing row. It is that **the conservative default is
 * exactly what hides the omission**: a model we forgot to add is
 * indistinguishable from one we have never seen, and it degrades in the
 * safe-looking direction, which is the direction nobody investigates.
 *
 * So this check is bound to the thing that can drift — the pickers — rather
 * than to a list someone must remember to update. Add a model to
 * `CLAUDE_MODELS` (or any other catalogue) without adding its window and the
 * build fails here instead of quietly budgeting it at a twelfth of its size.
 * Same move as `check-transcript-injection.ts` deriving its prefixes from
 * `transcriptBlock` rather than restating them.
 *
 * `local` is exempt by design: its id is a placeholder for whatever GGUF the
 * operator loaded, the real window is unknowable from here, and the
 * conservative floor is the correct answer rather than a gap.
 *
 * Run: `npm run check -- model-windows`
 */
import {
  CHATGPT_MODELS,
  CLAUDE_MODELS,
  DEFAULT_CHATGPT_MODEL,
  DEFAULT_LOCAL_MODEL,
  DEFAULT_MODEL,
  DEFAULT_OPENROUTER_MODEL,
  LOCAL_MODELS,
  OPENROUTER_MODELS,
  type ModelOption
} from '@shared/agents'
import { contextWindowFor, hasKnownWindow, UNKNOWN_MODEL_WINDOW } from '@core/runner/contextWindow'
import { transcriptBudgetFor } from '@core/runner/prompts'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/** Ids a placeholder by design, where the floor is the right answer. */
const EXEMPT = new Set([...LOCAL_MODELS.map((m: ModelOption) => m.id), DEFAULT_LOCAL_MODEL.id])

// Every catalogue the UI can offer from, plus every default a new agent can be
// seeded with. Collected from the exported lists so a new catalogue that nobody
// adds here is the only way to slip past — and adding one is a deliberate act.
const offered = [
  ...CLAUDE_MODELS.map((m) => m.id),
  ...CHATGPT_MODELS.map((m) => m.id),
  ...OPENROUTER_MODELS.map((m) => m.id),
  ...LOCAL_MODELS.map((m) => m.id),
  DEFAULT_MODEL.id,
  DEFAULT_CHATGPT_MODEL.id,
  DEFAULT_OPENROUTER_MODEL.id,
  DEFAULT_LOCAL_MODEL.id
]

for (const id of [...new Set(offered)].filter((id) => !EXEMPT.has(id)))
  // Detail only on failure — a passing line that reads "falls back to the floor"
  // says the opposite of what it means, and a check nobody can read at a glance
  // is one people stop reading.
  check(`'${id}' has a context-window entry`, hasKnownWindow({ id }), hasKnownWindow({ id }) ? '' : `MISSING — falls back to the ${UNKNOWN_MODEL_WINDOW} floor, giving a ${transcriptBudgetFor({ id })} char budget instead of its real one`)

// ⚠️ THE LOOP ABOVE ONLY COVERS MODELS WE OFFER. That is worth stating even
// now that `claude-opus-5` is in `CLAUDE_MODELS` and therefore covered by it:
// at the moment the defect was found it was NOT in the picker, so the generic
// guard would not have caught it. A stored config can carry an id no catalogue
// lists, and any such id is protected only by a named assertion.
//
// The assertions below are consequently redundant with the loop today — kept
// deliberately, because they are what holds the line if Opus 5 is ever removed
// from the picker while configs still reference it, and because a regression
// named after the thing that caused it is easier to read than one line in a
// derived list.
check("'claude-opus-5' is in the table", hasKnownWindow({ id: 'claude-opus-5' }))
check("...at the same window as the other Claude 5s", contextWindowFor({ id: 'claude-opus-5' }) === contextWindowFor({ id: 'claude-sonnet-5' }), `${contextWindowFor({ id: 'claude-opus-5' })} vs ${contextWindowFor({ id: 'claude-sonnet-5' })}`)
check('...so its transcript budget matches too', transcriptBudgetFor({ id: 'claude-opus-5' }) === transcriptBudgetFor({ id: 'claude-sonnet-5' }))

// `hasKnownWindow` exists because the sentinel comparison it replaced could not
// tell "absent" from "genuinely 128k". Assert the distinction it was added for.
check('an unheard-of id is reported as unknown', !hasKnownWindow({ id: 'not-a-real-model' }))
check('...and still gets the conservative floor, not a crash', contextWindowFor({ id: 'not-a-real-model' }) === UNKNOWN_MODEL_WINDOW)
check('local is exempt and takes the floor deliberately', !hasKnownWindow({ id: 'local' }) && contextWindowFor({ id: 'local' }) === UNKNOWN_MODEL_WINDOW)

// A known model must never be budgeted as though it were unknown — the failure
// the whole check exists to prevent, stated as a property rather than a list.
for (const id of [...new Set(offered)].filter((id) => !EXEMPT.has(id)))
  check(`'${id}' is budgeted from its real window`, transcriptBudgetFor({ id }) > transcriptBudgetFor({ id: 'not-a-real-model' }), `${transcriptBudgetFor({ id })} chars`)

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
