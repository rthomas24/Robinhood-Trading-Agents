import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import type { AgentColor, AgentIcon } from '@shared/agents'
import { cn } from '@renderer/lib/format'

/**
 * Procedural ASCII avatars — the whole circle is a living character field
 * (demoscene ASCII-plasma style). Every avatar is a field function
 * f(x, y, t) → brightness 0..1 mapped onto a character ramp; shapes (a face, a
 * skull, a heart, an arrow…) emerge from the field and move inside it.
 * Always animating: slow shimmer while idle, fast + energized while the agent
 * is working (`active`). Rendered by writing textContent into a <pre> on an
 * interval — zero React re-renders per frame.
 */
const RAMP = ' .:-=+*#%@'

interface Cell {
  col: number
  row: number
}
interface Ctx {
  cols: number
  rows: number
  active: boolean
}
type Field = (x: number, y: number, t: number, cell: Cell, ctx: Ctx) => number

const { sin, cos, atan2, hypot, abs, floor, min, max, PI } = Math
const clamp = (v: number): number => max(0, min(1, v))
/** Deterministic per-integer pseudo-random 0..1. */
const hash = (n: number): number => {
  const s = sin(n * 127.1 + 311.7) * 43758.5453
  return s - floor(s)
}
/** 1 while eyes are open, 0 during a periodic quick blink. */
const eyeOpen = (t: number): number => ((t * 0.45) % 1.7 < 0.12 ? 0 : 1)

const plasma: Field = (x, y, t) => {
  const v = sin(3 * x + t) + sin(3 * y + t * 1.3) + sin(3 * (x + y) + t * 0.7) + sin(5 * hypot(x, y) - t * 1.5)
  return clamp(0.5 + v / 4)
}

const ripple: Field = (x, y, t) => {
  const d = hypot(x, y)
  return clamp((0.55 + 0.45 * sin(9 * d - t * 2.4)) * (1.15 - d * 0.55))
}

const vortex: Field = (x, y, t) => {
  const d = hypot(x, y)
  const a = atan2(y, x)
  return clamp(0.5 + 0.5 * sin(a * 3 + 8 * d - t * 2.6)) * clamp(1.25 - d * 0.5)
}

const matrix: Field = (_x, _y, t, cell, ctx) => {
  const speed = 2.4 + hash(cell.col) * 3
  const len = ctx.rows * (0.55 + hash(cell.col * 7) * 0.5)
  const head = (t * speed + hash(cell.col * 13) * ctx.rows * 3) % (ctx.rows + len)
  const dist = head - cell.row
  if (dist < 0 || dist > len) return 0.04
  return dist < 1 ? 1 : clamp(1 - dist / len) * 0.75
}

const face: Field = (x, y, t, cell, ctx) => {
  const bg = plasma(x, y, t * 0.8, cell, ctx) * 0.32
  const open = eyeOpen(t)
  // Eyes wander in a small orbit; they blink shut into slits.
  const ex = 0.07 * cos(t * 0.9)
  const ey = 0.05 * sin(t * 1.3)
  for (const sx of [-0.34, 0.34]) {
    const dx = x - (sx + ex)
    const dy = y - (-0.24 + ey)
    if (open ? hypot(dx, dy) < 0.15 : abs(dy) < 0.05 && abs(dx) < 0.16) return 1
  }
  // Mouth: an arc that talks while working, smiles while idle.
  const mouthY = 0.3
  const width = 0.4
  const openAmt = ctx.active ? 0.1 + 0.09 * abs(sin(t * 3.2)) : 0.05
  const curve = mouthY + 0.16 * (1 - (x / width) ** 2)
  if (abs(x) < width && abs(y - curve) < openAmt) return 0.95
  return bg
}

const skull: Field = (x, y, t, cell, ctx) => {
  const bg = ripple(x, y, t * 0.7, cell, ctx) * 0.24
  const jaw = ctx.active ? 0.05 * sin(t * 5) : 0
  // Eye sockets: dark voids with a roaming ember inside.
  for (const sx of [-0.28, 0.28]) {
    const dx = x - sx
    const dy = y - -0.16
    if (hypot(dx, dy) < 0.17) {
      const px = sx + 0.06 * cos(t * 2 + sx * 9)
      const py = -0.16 + 0.05 * sin(t * 2.6)
      return hypot(x - px, y - py) < 0.05 ? 1 : 0.02
    }
  }
  if (abs(x) < 0.05 && abs(y - 0.1) < 0.08) return 0.02 // nose
  if (abs(y - (0.42 + jaw)) < 0.13 && abs(x) < 0.4) return 0.5 + 0.5 * sin(x * 22) // chattering teeth
  if (hypot(x, y + 0.08) < 0.68) return 0.55 + 0.1 * sin(6 * x + t) // dome
  return bg
}

const heart: Field = (x, y, t, cell, ctx) => {
  const rate = ctx.active ? 4.2 : 1.6
  const s = 1 / (1 + 0.14 * max(0, sin(t * rate)) ** 3)
  const hx = x * 1.25 * s
  const hy = (-y + 0.12) * 1.25 * s
  const q = hx * hx + hy * hy - 0.35
  const inside = q * q * q - hx * hx * hy * hy * hy < 0
  if (inside) return clamp(0.75 + 0.25 * sin(t * 5 + hypot(hx, hy) * 8))
  return plasma(x, y, t * 0.6, cell, ctx) * 0.22
}

const diamond: Field = (x, y, t, cell, ctx) => {
  const a = t * 0.9
  const rx = x * cos(a) - y * sin(a)
  const ry = x * sin(a) + y * cos(a)
  if (abs(rx) + abs(ry) < 0.58) return clamp(0.6 + 0.4 * sin(10 * rx * ry + t * 3))
  // Occasional sparkles outside.
  const n = hash(cell.col * 31 + cell.row * 57 + floor(t * 2))
  if (n > 0.985) return 1
  return plasma(x, y, t * 0.5, cell, ctx) * 0.16
}

const arrow: Field = (x, y, t, cell, ctx) => {
  const bg = clamp(0.32 + 0.22 * sin(6 * x - t * 2 + sin(y * 3 + t)))
  const bob = 0.08 * sin(t * (ctx.active ? 3 : 1.2))
  // Rising trend line from bottom-left to upper-right, with an arrowhead.
  const py = -0.55 * x + bob
  const tipX = 0.42
  const dHead = abs(x - tipX) + abs(y - (-0.55 * tipX + bob))
  if (dHead < 0.22 && x > tipX - 0.08) return 1
  if (x < tipX && abs(y - py) < 0.09) return 0.95
  return bg * 0.5
}

const orb: Field = (x, y, t) => {
  let f = 0
  for (let i = 0; i < 3; i++) {
    const px = 0.42 * cos(t * (0.7 + i * 0.35) + i * 2.1)
    const py = 0.42 * sin(t * (0.9 + i * 0.28) + i * 1.4)
    const d = hypot(x - px, y - py)
    f += 0.05 / (d * d + 0.03)
  }
  return clamp(f * 0.42)
}

const sea: Field = (x, y, t, cell) => {
  const surface = -0.05 + 0.16 * sin(3 * x + t * 1.6) + 0.09 * sin(5 * x - t * 1.1)
  if (y > surface) return clamp(0.55 + 0.3 * sin(6 * x + t + y * 5) + 0.12 * sin(11 * x - t * 2))
  const star = hash(cell.col * 17 + cell.row * 29)
  return star > 0.93 ? clamp(0.5 + 0.5 * sin(t * 2 + star * 40)) : 0.05
}

const moire: Field = (x, y, t) => {
  const k = 7 + 4 * sin(t * 0.55)
  return clamp(0.5 + 0.5 * sin(x * k + t) * sin(y * k - t * 0.8) + 0.15 * sin((x + y) * k * 0.5))
}

/* ── 3D avatars: rotating objects rendered with a z-buffer + luminance ──
 * Surface points are sampled, rotated, perspective-projected onto the char
 * grid; the nearest point per cell wins and its light level picks the glyph. */
interface Plot {
  (x: number, y: number, z: number, lum: number): void
}
type Sampler = (t: number, plot: Plot) => void

const LIGHT = { x: 0.35, y: 0.55, z: -0.76 } // normalized-ish key light

function rot(x: number, y: number, z: number, a: number, b: number): [number, number, number] {
  // Rotate about Y (a) then X (b).
  const x1 = x * cos(a) + z * sin(a)
  const z1 = -x * sin(a) + z * cos(a)
  const y1 = y * cos(b) - z1 * sin(b)
  const z2 = y * sin(b) + z1 * cos(b)
  return [x1, y1, z2]
}

const donutSampler: Sampler = (t, plot) => {
  const R1 = 0.42
  const R2 = 0.95
  for (let th = 0; th < 2 * PI; th += 0.25) {
    const ct = cos(th)
    const st = sin(th)
    for (let ph = 0; ph < 2 * PI; ph += 0.08) {
      const cp = cos(ph)
      const sp = sin(ph)
      const cx0 = R2 + R1 * ct
      const [px, py, pz] = rot(cx0 * cp, R1 * st, cx0 * sp, t, t * 0.55)
      const [nx, ny, nz] = rot(ct * cp, st, ct * sp, t, t * 0.55)
      plot(px * 0.62, py * 0.62, pz * 0.62, nx * LIGHT.x + ny * LIGHT.y + nz * LIGHT.z)
    }
  }
}

const cubeSampler: Sampler = (t, plot) => {
  const faces: Array<[number[], number[]]> = [
    [[0, 0, 1], [0, 0, 1]],
    [[0, 0, -1], [0, 0, -1]],
    [[1, 0, 0], [1, 0, 0]],
    [[-1, 0, 0], [-1, 0, 0]],
    [[0, 1, 0], [0, 1, 0]],
    [[0, -1, 0], [0, -1, 0]]
  ]
  for (const [axis, n] of faces) {
    for (let u = -1; u <= 1; u += 0.09) {
      for (let v = -1; v <= 1; v += 0.09) {
        let x: number
        let y: number
        let z: number
        if (axis[2] !== 0) [x, y, z] = [u, v, axis[2]]
        else if (axis[0] !== 0) [x, y, z] = [axis[0], u, v]
        else [x, y, z] = [u, axis[1], v]
        const s = 0.62
        const [px, py, pz] = rot(x * s, y * s, z * s, t * 0.9, t * 0.6)
        const [nx, ny, nz] = rot(n[0], n[1], n[2], t * 0.9, t * 0.6)
        plot(px, py, pz, nx * LIGHT.x + ny * LIGHT.y + nz * LIGHT.z)
      }
    }
  }
}

const sphereSampler: Sampler = (t, plot) => {
  for (let th = 0.05; th < PI; th += 0.1) {
    const st = sin(th)
    const ct = cos(th)
    for (let ph = 0; ph < 2 * PI; ph += 0.1) {
      const x = st * cos(ph)
      const y = ct
      const z = st * sin(ph)
      const [px, py, pz] = rot(x, y, z, t * 0.8, 0.45)
      const [nx, ny, nz] = [px, py, pz]
      // Longitude bands make the spin visible on a rotation-invariant shape.
      const band = 0.82 + 0.18 * sin(6 * ph + t * 2)
      plot(px * 0.82, py * 0.82, pz * 0.82, (nx * LIGHT.x + ny * LIGHT.y + nz * LIGHT.z) * band)
    }
  }
}

const pyramidSampler: Sampler = (t, plot) => {
  const apex = [0, 0.95, 0]
  const base = [
    [-0.85, -0.6, -0.85],
    [0.85, -0.6, -0.85],
    [0.85, -0.6, 0.85],
    [-0.85, -0.6, 0.85]
  ]
  const emit = (p: number[], n: number[]): void => {
    const [px, py, pz] = rot(p[0], p[1], p[2], t * 0.9, 0.35)
    const [nx, ny, nz] = rot(n[0], n[1], n[2], t * 0.9, 0.35)
    plot(px, py, pz, nx * LIGHT.x + ny * LIGHT.y + nz * LIGHT.z)
  }
  for (let f = 0; f < 4; f++) {
    const a = base[f]
    const b = base[(f + 1) % 4]
    // Face normal from the two edges.
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const e2 = [apex[0] - a[0], apex[1] - a[1], apex[2] - a[2]]
    let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]
    const len = hypot(n[0], hypot(n[1], n[2])) || 1
    n = [n[0] / len, n[1] / len, n[2] / len]
    for (let u = 0; u <= 1; u += 0.05) {
      for (let v = 0; v <= 1 - u; v += 0.05) {
        const w = 1 - u - v
        emit([a[0] * u + b[0] * v + apex[0] * w, a[1] * u + b[1] * v + apex[1] * w, a[2] * u + b[2] * v + apex[2] * w], n)
      }
    }
  }
  for (let u = -0.85; u <= 0.85; u += 0.08) for (let v = -0.85; v <= 0.85; v += 0.08) emit([u, -0.6, v], [0, -1, 0])
}

const helixSampler: Sampler = (t, plot) => {
  for (let strand = 0; strand < 2; strand++) {
    for (let i = 0; i <= 260; i++) {
      const a = i * 0.09 + t * 1.2 + strand * PI
      const y = (i / 260) * 1.9 - 0.95
      const x = cos(a) * 0.62
      const z = sin(a) * 0.62
      // Depth-shaded strand; rungs every ~20 steps connect the strands.
      plot(x, y, z, 0.55 - z * 0.45)
      if (strand === 0 && i % 20 === 0) {
        for (let k = -1; k <= 1; k += 0.14) plot(x * k, y, z * k, 0.35 - z * k * 0.3)
      }
    }
  }
}

const OBJECTS3D: Partial<Record<AgentIcon, Sampler>> = { donut: donutSampler, cube: cubeSampler, sphere: sphereSampler, pyramid: pyramidSampler, helix: helixSampler }

const K_DIST = 3.2 // camera distance for perspective

// Scratch buffers reused across frames/instances (JS is single-threaded; render3D is synchronous).
const scratch = new Map<number, { z: Float32Array; l: Float32Array }>()

function render3D(sampler: Sampler, t: number, cols: number, rows: number): string {
  const key = cols * 1000 + rows
  let buf = scratch.get(key)
  if (!buf) {
    buf = { z: new Float32Array(cols * rows), l: new Float32Array(cols * rows) }
    scratch.set(key, buf)
  }
  const zbuf = buf.z.fill(0)
  const lum = buf.l.fill(-2)
  sampler(t, (x, y, z, L) => {
    const ooz = 1 / (z + K_DIST)
    const sx = x * ooz * K_DIST * 0.78
    const sy = y * ooz * K_DIST * 0.78
    const col = floor(((sx + 1) / 2) * cols)
    const row = floor(((1 - (sy + 1) / 2) * rows))
    if (col < 0 || col >= cols || row < 0 || row >= rows) return
    const i = row * cols + col
    if (ooz > zbuf[i]) {
      zbuf[i] = ooz
      lum[i] = L
    }
  })
  let out = ''
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const L = lum[row * cols + col]
      out += L < -1 ? ' ' : RAMP[min(RAMP.length - 1, max(1, floor(clamp(0.5 + L * 0.5) * RAMP.length)))]
    }
    if (row < rows - 1) out += '\n'
  }
  return out
}

export const FIELDS: Partial<Record<AgentIcon, Field>> = {
  plasma,
  ripple,
  vortex,
  matrix,
  face,
  skull,
  heart,
  diamond,
  arrow,
  orb,
  sea,
  moire
}

/** Dark circle per hue; bright glyphs on top (terminal-plasma look). `swatch` is the bright picker chip. */
export const COLORS: Record<AgentColor, { fg: string; bg: string; swatch: string }> = {
  blue: { fg: '#7cc0ff', bg: 'radial-gradient(circle at 32% 28%, #14335e, #0a1830)', swatch: 'linear-gradient(135deg,#3b82f6,#1d4ed8)' },
  green: { fg: '#7dedaa', bg: 'radial-gradient(circle at 32% 28%, #0e4426, #071f12)', swatch: 'linear-gradient(135deg,#22c55e,#15803d)' },
  violet: { fg: '#c4a8ff', bg: 'radial-gradient(circle at 32% 28%, #322058, #170e2e)', swatch: 'linear-gradient(135deg,#8b5cf6,#6d28d9)' },
  orange: { fg: '#ffb26b', bg: 'radial-gradient(circle at 32% 28%, #55290e, #291204)', swatch: 'linear-gradient(135deg,#f97316,#c2410c)' },
  pink: { fg: '#ff9ecb', bg: 'radial-gradient(circle at 32% 28%, #55123a, #2b071d)', swatch: 'linear-gradient(135deg,#ec4899,#be185d)' },
  teal: { fg: '#6ee7d8', bg: 'radial-gradient(circle at 32% 28%, #0c4440, #052220)', swatch: 'linear-gradient(135deg,#14b8a6,#0f766e)' },
  slate: { fg: '#c3cbd6', bg: 'radial-gradient(circle at 32% 28%, #333e4e, #171c24)', swatch: 'linear-gradient(135deg,#64748b,#334155)' }
}

const IDLE_MS = 110
const ACTIVE_MS = 55
const IDLE_DT = 0.09
const ACTIVE_DT = 0.24

/**
 * The tile's corner, from the system radius ladder rather than a proportion of
 * its own size — so a 26px avatar in the icon picker and a 44px one in a berth
 * are recognisably the same object, cornered like every other surface in the
 * app. The character field itself is still masked to a circle by the field
 * functions, which reads as a lens set into the tile.
 */
function tileRadius(size: number): string {
  if (size < 26) return 'var(--radius-xs)'
  if (size < 36) return 'var(--radius-sm)'
  if (size < 52) return 'var(--radius-md)'
  return 'var(--radius-lg)'
}

export function AgentAvatar({
  icon,
  color,
  size = 40,
  active = false,
  mode,
  armed = false,
  local = false,
  className
}: {
  icon: AgentIcon
  color: AgentColor
  size?: number
  /** True while the agent is working → fast, energized animation. */
  active?: boolean
  /**
   * Real money or simulated. A live agent is ringed in brass — the identity
   * colour `--color-live` carries everywhere real money is at stake — so the
   * distinction survives even where there is no room for a mode pill.
   */
  mode?: 'paper' | 'live'
  /**
   * Live AND armed: the operator has said yes to real orders. Drawn as a red
   * pennant in the corner on top of the brass ring, because this is the one
   * state in the whole product that is allowed to shout (the design system: "one red in
   * the chrome"), and it must be legible at 28px in a row someone is scanning.
   */
  armed?: boolean
  /** Thinking on this computer's own GPU — the local identity glow, only while `active`. */
  local?: boolean
  className?: string
}): JSX.Element {
  const pre = useRef<HTMLPreElement>(null)
  const tRef = useRef(Math.random() * 100) // desync instances

  const rows = max(9, min(26, Math.round(size / 3.4)))
  const cols = Math.round(rows * 1.66)
  /**
   * The field is typeset at a comfortable size and SCALED to the tile, never
   * set in a 3px font. A 34px tile wants ten rows of 3.4px text, and Chromium
   * can refuse a font that small (its minimum-font-size floor, which the
   * desktop app's renderer enforces and a plain browser tab may not): the text
   * came back at 6px, the field grew to twice the tile, and every icon in the
   * New-agent picker spilled over its box. A transform is applied
   * after layout and after that floor, so the drawn size is exactly `size`
   * whatever the renderer's minimum. Width follows the mono advance (0.6em for
   * the bundled JetBrains Mono); a fallback font that runs a little wider only
   * trims the blank corners the circular mask leaves anyway.
   */
  const BASE_PX = 8
  const scale = size / (rows * BASE_PX)
  const preW = cols * BASE_PX * 0.6
  const preH = rows * BASE_PX

  useEffect(() => {
    const field = FIELDS[icon]
    const obj = OBJECTS3D[icon]
    const ctx: Ctx = { cols, rows, active }
    const render = (): void => {
      if (document.hidden) return // no frames for a hidden window
      const t = tRef.current
      if (obj) {
        if (pre.current) pre.current.textContent = render3D(obj, t, cols, rows)
        return
      }
      if (!field) return
      let out = ''
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const x = ((col + 0.5) / cols) * 2 - 1
          const y = ((row + 0.5) / rows) * 2 - 1
          if (x * x + y * y > 1.08) {
            out += ' '
            continue
          }
          const v = field(x, y, t, { col, row }, ctx)
          out += RAMP[min(RAMP.length - 1, floor(clamp(v) * RAMP.length))]
        }
        if (row < rows - 1) out += '\n'
      }
      if (pre.current) pre.current.textContent = out
    }
    render()
    const timer = setInterval(() => {
      tRef.current += active ? ACTIVE_DT : IDLE_DT
      render()
    }, active ? ACTIVE_MS : IDLE_MS)
    return () => clearInterval(timer)
  }, [icon, active, cols, rows])

  /**
   * Fall back rather than dereference blindly. `AgentColor` is a closed enum, so
   * within one build this cannot miss — but the config arrives as JSON from
   * disk, possibly written by a different build. A newer build that adds a
   * colour token produces configs an older one has never heard of, and
   * `COLORS[unknown].bg` throws.
   *
   * The blast radius is what makes it worth a line: this avatar renders in EVERY
   * sidebar row, so one agent with an unknown colour would take out the entire
   * list rather than its own row. The icon lookups below already degrade (an
   * unknown icon renders blank); this one did not.
   */
  const c = COLORS[color] ?? COLORS.blue
  /**
   * Rings, innermost first. They stack rather than replace each other because
   * the states are independent: an armed live agent thinking on a local GPU is
   * a real configuration, and each fact has to survive the other two. Every
   * colour is a token — a hard-coded hex here would be the one avatar in the
   * app that ignores the operator's theme.
   */
  const rings: string[] = []
  if (armed) rings.push('0 0 0 1.5px var(--color-armed)')
  else if (mode === 'live') rings.push('0 0 0 1.5px color-mix(in oklab, var(--color-live) 70%, transparent)')
  if (local && active) {
    if (rings.length === 0) rings.push('0 0 0 2px color-mix(in oklab, var(--color-local) 45%, transparent)')
    rings.push(`0 0 ${max(10, size * 0.4)}px color-mix(in oklab, var(--color-local) 35%, transparent)`)
  }
  const pennant = max(7, Math.round(size * 0.26))
  /**
   * DECORATIVE, deliberately — the whole tile is `aria-hidden`, and it takes no
   * accessible name.
   *
   * Every place this is drawn, the agent is already named in text a screen
   * reader reaches: the sidebar row, the thread header, the stats sheet and the
   * template cards all print the name beside it, and the collapsed rail puts an
   * `aria-label` on the button that wraps it. A name here would be that name
   * read twice, and an animating character field described as an image is noise
   * either way.
   *
   * The one thing the tile says that no neighbour repeats is the armed pennant
   * in a sidebar row (the row's pill says "Live", never "Armed"). That is the
   * ROW's sentence to add, not this canvas's — putting it here would make a
   * decorative field the carrier of a safety fact.
   */
  return (
    <div
      aria-hidden
      className={cn('relative shrink-0 flex items-center justify-center overflow-hidden select-none', className)}
      style={{ width: size, height: size, background: c.bg, borderRadius: tileRadius(size), boxShadow: rings.length ? rings.join(', ') : undefined }}
    >
      <pre
        ref={pre}
        aria-hidden
        style={{
          margin: 0,
          // Fixed box + no wrapping: the field's size is decided here, not by
          // the font the renderer happens to use.
          width: preW,
          height: preH,
          flexShrink: 0,
          overflow: 'hidden',
          whiteSpace: 'pre',
          fontFamily: 'var(--font-mono)',
          fontSize: `${BASE_PX}px`,
          lineHeight: 1,
          fontWeight: 700,
          letterSpacing: 0,
          color: c.fg,
          textShadow: `0 0 ${max(2, (size * 0.06) / scale)}px ${c.fg}66`,
          transform: `scale(${scale})`,
          transformOrigin: 'center'
        }}
      />
      {armed && (
        <span
          aria-hidden
          style={{
            position: 'absolute',
            top: 0,
            right: 0,
            width: pennant,
            height: pennant,
            background: 'var(--color-armed)',
            clipPath: 'polygon(100% 0, 100% 100%, 0 0)'
          }}
        />
      )}
    </div>
  )
}
