/**
 * Run the behavioural checks in `scripts/checks/`.
 *
 *   npm run check                    # every check
 *   npm run check -- parallel-fills  # only checks whose name contains the filter
 *
 * Each check is a standalone script that prints `ok`/`FAIL` lines and exits
 * non-zero on any failure. They need no credentials, no network and no
 * Electron: they drive the pure modules in `src/shared` and `src/core` (and pin
 * a few source properties by reading files). Each runs in its own process so
 * one check's `process.exit` or module state cannot leak into the next.
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const HERE = import.meta.dirname
const CHECKS = join(HERE, 'checks')
const filter = process.argv.slice(2).join(' ').trim().toLowerCase()

const files = readdirSync(CHECKS)
  .filter((f) => f.startsWith('check-') && f.endsWith('.ts'))
  .filter((f) => !filter || f.toLowerCase().includes(filter))
  .sort()

if (!files.length) {
  console.error(filter ? `no check matches "${filter}"` : 'no checks found')
  process.exit(1)
}

const failed: string[] = []
const started = Date.now()
for (const f of files) {
  const t0 = Date.now()
  const r = spawnSync(process.execPath, ['--import', 'tsx', join(CHECKS, f)], {
    cwd: join(HERE, '..'),
    env: { ...process.env, TSX_TSCONFIG_PATH: join(HERE, 'tsconfig.json') },
    encoding: 'utf8'
  })
  const ok = r.status === 0
  const ms = Date.now() - t0
  console.log(`${ok ? 'pass' : 'FAIL'}  ${f.replace(/^check-|\.ts$/g, '')}  (${ms} ms)`)
  if (!ok) {
    failed.push(f)
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
      .split('\n')
      .filter((l) => /FAIL|Error|error|✗/.test(l))
      .slice(0, 12)
      .join('\n')
    if (out) console.log(out.replace(/^/gm, '      '))
  }
}

const secs = ((Date.now() - started) / 1000).toFixed(1)
console.log(`\n${files.length - failed.length}/${files.length} checks passed in ${secs}s`)
if (failed.length) {
  console.log(`failed: ${failed.join(', ')}`)
  process.exit(1)
}
