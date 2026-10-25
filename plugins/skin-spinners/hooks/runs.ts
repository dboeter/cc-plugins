export type Mode = 'requesting' | 'responding' | 'thinking' | 'tool-input' | 'tool-use'
export type Outcome = 'answer' | 'aborted' | 'refusal' | 'error'
export type Run = { text: string; color?: string; bg?: string; bold?: boolean; italic?: boolean }
// Time enters the pure modules only here: the mod's own 90 ms frame, the turn's elapsed time, and a seed that keeps one turn's randomness the same
export type Tick = { frame: number; elapsedMs: number; mode: Mode; seed: number }
export type Pixel = string | null

export const FRAME_MS = 90

export const clamp = (n: number) => Math.min(1, Math.max(0, n))
export const wrap = (n: number, m: number) => ((n % m) + m) % m
// the item at i, wrapped round; the cast is for noUncheckedIndexedAccess, the lists are never empty
export const cycle = <T>(items: readonly T[], i: number): T => items[wrap(i, items.length)] as T
export const pad2 = (n: number) => String(n).padStart(2, '0')
export const mmss = (ms: number) => {
  const s = Math.floor(ms / 1000)
  return `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`
}

// djb2, as skins' pick hashes its seed
export const hash = (seed: string): number => {
  let h = 5381
  for (let i = 0; i < seed.length; i++) h = (h * 33 + seed.charCodeAt(i)) >>> 0
  return h
}

// the same seed always picks the same item, so a row keeps its word when it redraws
export const pick = <T>(items: readonly T[], seed: string): T => cycle(items, hash(seed))

// a deterministic hash of the seed and the numbers, in [0, 1)
export const rand = (seed: number, ...ns: number[]): number => {
  let h = seed | 0
  for (const n of ns) {
    h = Math.imul(h ^ (n | 0), 0x9e3779b1)
    h ^= h >>> 15
    h = Math.imul(h, 0x85ebca6b)
    h ^= h >>> 13
  }
  return (h >>> 0) / 4294967296
}

// Cached, as a word effect mixes the same few colours for every letter of every frame; blends are rounded, so the set stays small.
const parsed = new Map<string, number[]>()
const rgb = (color: string) => {
  let out = parsed.get(color)
  if (out === undefined) {
    if (parsed.size > 4000) parsed.clear()
    out = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16))
    parsed.set(color, out)
  }
  return out
}

export const mix = (a: string, b: string, t: number): string => {
  const [from, to] = [rgb(a), rgb(b)]
  const k = clamp(t)
  return `#${from.map((v, i) => Math.round(v + ((to[i] ?? 0) - v) * k).toString(16).padStart(2, '0')).join('')}`
}

// a colour along stops spread evenly over [0, 1]
export const ramp = (stops: readonly string[], p: number): string => {
  const x = clamp(p) * (stops.length - 1)
  const i = Math.max(0, Math.min(Math.floor(x), stops.length - 2))
  return mix(cycle(stops, i), cycle(stops, i + 1), x - i)
}

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 1) return '<1s'
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

export const timer = (ms: number, color: string): Run[] => [{ text: formatDuration(ms), color }]

const graphemes = new Intl.Segmenter()

// what a person reads as one letter: an emoji with its modifiers, or a letter with its accents, is one, however many code points it has
// Cached, as every frame splits the same few words again; the cache starts over past 1000 texts, so a long session's words do not pile up.
const split = new Map<string, readonly string[]>()
export const letters = (text: string): string[] => {
  let out = split.get(text)
  if (out === undefined) {
    if (split.size > 1000) split.clear()
    out = Array.from(graphemes.segment(text), s => s.segment)
    split.set(text, out)
  }
  return [...out]
}

// East Asian wide and fullwidth letters, and emoji drawn as emoji, take two terminal cells
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{20000}-\u{3fffd}]|\p{Emoji_Presentation}|\p{Regional_Indicator}|️/u

export const cells = (text: string): number => letters(text).reduce((n, letter) => n + (WIDE.test(letter) ? 2 : 1), 0)

export const width = (runs: readonly Run[]) => runs.reduce((n, r) => n + cells(r.text), 0)

const same = (a: Run, b: Run) => a.color === b.color && a.bg === b.bg && a.bold === b.bold && a.italic === b.italic

// joins neighbours that look the same and drops empty ones
export const merge = (runs: readonly Run[]): Run[] => {
  const out: Run[] = []
  for (const run of runs) {
    if (run.text === '') continue
    const last = out.at(-1)
    if (last !== undefined && same(last, run)) out[out.length - 1] = { ...last, text: last.text + run.text }
    else out.push(run)
  }
  return out
}

// Two rows of N pixels as N cells of half blocks. Claude Code does not paint the terminal's background, so an empty pixel stays null:
// filling it with a theme's background would draw a dark box on the person's terminal.
export const pixels = (grid: readonly [readonly Pixel[], readonly Pixel[]]): Run[] => {
  const [top, bottom] = grid
  return top.map((upper, i): Run => {
    const lower = bottom[i] ?? null
    if (upper === null && lower === null) return { text: ' ' }
    if (lower === null) return { text: '▀', color: upper ?? undefined }
    if (upper === null) return { text: '▄', color: lower }
    return { text: '▀', color: upper, bg: lower }
  })
}
