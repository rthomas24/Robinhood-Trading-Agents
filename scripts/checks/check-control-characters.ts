/**
 * No source file contains an invisible control character.
 *
 * This exists because it has happened twice, both times inside a regular
 * expression, and both times the corruption was invisible to every tool anyone
 * would reach for:
 *
 *   `core/redact.ts` — a literal BACKSPACE (0x08) sat where `\b` was intended,
 *   so the secret-redaction pattern silently did not match what it claimed to.
 *   Found only because the redactor was tested against a real leaked token and
 *   failed.
 *
 *   `shared/createAgent.ts` — the same byte, twice, in the ticker pattern. It
 *   would have matched "AMAZON" as the ticker "AMAZO", naming an agent after a
 *   truncation. Found only because a `.replace()` mysteriously did not fire.
 *
 * WHY NOTHING ELSE CATCHES IT. `grep` prints the byte as nothing, so the line
 * looks correct in every search result. A terminal renders it by moving the
 * cursor back, so `cat` and `sed -n` also show a clean line. TypeScript is
 * happy: `/\x08/` is a valid regex, it just matches a character no source file
 * contains. A reviewer reading the diff sees exactly what the author intended
 * to write. The only signal is behavioural, and only if the behaviour happens
 * to be tested.
 *
 * WHERE THEY COME FROM. Writing files through a shell heredoc: `\b` in a
 * double-quoted or unquoted context is interpreted as an escape long before it
 * reaches the file, and the same happens to `\a`, `\f`, `\v` and `\0`. The
 * mistake is invisible at the moment it is made, which is why it needs a check
 * rather than care.
 *
 * TAB, NEWLINE and CARRIAGE RETURN are allowed — they are legitimate whitespace
 * and the repo has CRLF files. Everything else in C0, plus DEL, is refused.
 *
 * Run: `npm run check -- control-characters`
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const REPO = join(import.meta.dirname, '..', '..')

/** Roots worth sweeping: everything a human or a model edits by hand. */
const ROOTS = [
  join(REPO, 'src'),
  join(REPO, 'scripts'),
  join(REPO, 'docs')
]

const EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.md', '.json', '.css', '.html']
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', 'coverage'])

/** Tab, LF, CR are legitimate. Everything else below 0x20, plus DEL, is not. */
const ALLOWED = new Set([0x09, 0x0a, 0x0d])
const isBad = (code: number): boolean => (code < 0x20 && !ALLOWED.has(code)) || code === 0x7f

const NAMES: Record<number, string> = {
  0x00: 'NUL',
  0x07: 'BEL',
  0x08: 'BACKSPACE (this is the one that bit us — almost certainly a mangled \\b)',
  0x0b: 'VERTICAL TAB (a mangled \\v)',
  0x0c: 'FORM FEED (a mangled \\f)',
  0x1b: 'ESC',
  0x7f: 'DEL'
}

const walk = (dir: string): string[] => {
  let out: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out // a root that does not exist is not a failure
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e)) continue
    const p = join(dir, e)
    let s
    try {
      s = statSync(p)
    } catch {
      continue
    }
    if (s.isDirectory()) out = out.concat(walk(p))
    else if (EXTENSIONS.some((x) => p.endsWith(x))) out.push(p)
  }
  return out
}

const offenders: string[] = []
let scanned = 0

for (const root of ROOTS) {
  for (const file of walk(root)) {
    scanned++
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    // Cheap reject first: most files have none, and scanning char-by-char over
    // the whole tree otherwise costs more than the check is worth.
    if (![...text].some((c) => isBad(c.charCodeAt(0)))) continue

    const lines = text.split('\n')
    lines.forEach((line, i) => {
      for (let col = 0; col < line.length; col++) {
        const code = line.charCodeAt(col)
        if (!isBad(code)) continue
        const where = `${relative(REPO, file).replace(/\\/g, '/')}:${i + 1}:${col + 1}`
        offenders.push(`${where} — 0x${code.toString(16).padStart(2, '0')} ${NAMES[code] ?? 'control character'}`)
      }
    })
  }
}

check(`scanned ${scanned} source files`, scanned > 0, 'no files found means the roots are wrong, not that the tree is clean')
check('no source file contains an invisible control character', offenders.length === 0, offenders.join('\n       '))

// The check has to be able to SEE one, or it is decoration. A green sweep over
// a tree that happens to be clean proves nothing about the detector itself.
const planted = `const re = /\\$?${String.fromCharCode(8)}([A-Z]{2,5})${String.fromCharCode(8)}/`
const found = [...planted].filter((c) => isBad(c.charCodeAt(0)))
check('the detector actually detects one', found.length === 2, `found ${found.length} in a deliberately corrupted line`)
check('…and does not flag tab, newline or carriage return', !['\t', '\n', '\r'].some((c) => isBad(c.charCodeAt(0))))

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
if (failures) process.exit(1)
