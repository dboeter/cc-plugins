import { FRAME_MS, cycle, merge, mix, pixels, rand, ramp, type Pixel, type Run, type Tick } from './runs'

export type Word = (word: string, t: Tick) => Run[]
export type Sprite = (t: Tick) => Run[]
type Style = Partial<Run>

// A word letter by letter. The callback gives a colour, or a style that can also swap the letter.
export const paint = (word: string, style: (letter: string, i: number) => Style | string): Run[] =>
  merge([...word].map((letter, i) => {
    const s = style(letter, i)
    return typeof s === 'string' ? { text: letter, color: s } : { text: letter, ...s }
  }))

// The slot of `period` frames this frame is in, when it falls in the `length` frames that start at a jittered point of that slot; else undefined.
// `salt` keeps two effects of one theme from firing together.
export const pulse = (t: Tick, period: number, length: number, salt: number): number | undefined => {
  const slot = Math.floor(t.frame / period)
  const start = Math.floor(rand(t.seed, slot, salt) * (period - length + 1))
  const at = t.frame - slot * period
  return at >= start && at < start + length ? slot : undefined
}

// one of `n` things, chosen by the slot a pulse fired in
const chosen = (t: Tick, slot: number, salt: number, n: number) => Math.floor(rand(t.seed, slot, salt) * n)

const lettersOf = (word: string) => [...word].length

// Words

export const flat = (color: string): Word => word => paint(word, () => color)

// skins' shimmer: the head letter in one colour, the letters within `reach` of it in a second, the rest in a base colour
export const band = (c: { head: string; near: string; base: string }, reach = 1, step = 1): Word => (word, t) => {
  const head = (Math.floor(t.frame / step) % (lettersOf(word) + 8)) - 4
  return paint(word, (_, i) => {
    const d = Math.abs(i - head)
    return d === 0 ? c.head : d <= reach ? c.near : c.base
  })
}

// a gradient that scrolls one letter per 3 frames, mirrored so it has no seam
export const mirrored = (stops: readonly string[]): Word => (word, t) => {
  const len = lettersOf(word)
  const shift = Math.floor(t.frame / 3)
  return paint(word, (_, i) => {
    const q = (i + shift) % (2 * len)
    return ramp(stops, (q <= len ? q : 2 * len - q) / len)
  })
}

export const typewriter = (ink: string, dim: string): Word => (word, t) => {
  const len = lettersOf(word)
  const typed = Math.min(len, Math.floor(t.elapsedMs / FRAME_MS))
  const isCursorOn = t.elapsedMs < len * FRAME_MS || Math.floor((t.elapsedMs - len * FRAME_MS) / 530) % 2 === 0
  return merge([
    { text: [...word].slice(0, typed).join(''), color: pulse(t, 44, 2, 1) === undefined ? ink : dim },
    { text: isCursorOn ? '█' : ' ', color: ink },
    { text: ' '.repeat(len - typed) },
  ])
}

const GLITCH = [...'▓▒░#%&$§¥']

export const hexDecode = (c: { done: string; hex: string; glitch: string }): Word => (word, t) => {
  const decoded = [...word].flatMap((letter, i) => (letter !== ' ' && t.elapsedMs >= 180 * (i + 1) ? [i] : []))
  const slot = pulse(t, 33, 1, 2)
  const glitched = slot === undefined || decoded.length === 0 ? -1 : (decoded[chosen(t, slot, 3, decoded.length)] ?? -1)
  return paint(word, (letter, i) => {
    if (letter === ' ') return {}
    if (i === glitched) return { text: cycle(GLITCH, chosen(t, slot ?? 0, 4, GLITCH.length)), color: c.glitch }
    if (t.elapsedMs >= 180 * (i + 1)) return c.done
    const code = (letter.codePointAt(0) ?? 0).toString(16).padStart(2, '0')
    return { text: t.frame % 2 === 0 ? code.slice(0, 1) : code.slice(-1), color: c.hex }
  })
}

// a drop-out is rare most of the time and common in a short burst about every 4.5 s; denser than this, the word stops reading as a word
export const signal = (ink: string, lost: string): Word => (word, t) => {
  const p = pulse(t, 50, 4, 6) === undefined ? 0.015 : 0.35
  return paint(word, (letter, i) => (letter !== ' ' && rand(t.seed, t.frame, i) < p ? { text: '·', color: lost } : ink))
}

const FLAP = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789']

export const splitFlap = (c: { landed: string; spinning: string; flicker: string }): Word => (word, t) => {
  const tick = Math.floor(t.elapsedMs / FRAME_MS)
  const slot = pulse(t, 55, 1, 5)
  const flicker = slot === undefined ? -1 : chosen(t, slot, 6, lettersOf(word))
  return paint(word, (letter, i) => {
    if (letter === ' ') return {}
    if (tick < 2 + 2 * i) return { text: cycle(FLAP, Math.floor(rand(t.seed, tick, i) * FLAP.length)), color: c.spinning }
    return i === flicker ? c.flicker : c.landed
  })
}

// all letters one colour, warming over the first 2 minutes, with one letter glinting about every 1.5 s
export const glint = (from: string, to: string, spark: string): Word => (word, t) => {
  const warm = mix(from, to, t.elapsedMs / 120000)
  const slot = pulse(t, 16, 1, 7)
  const at = slot === undefined ? -1 : chosen(t, slot, 8, lettersOf(word))
  return paint(word, (_, i) => (i === at ? { color: spark, bold: true } : warm))
}

// a band moving right with a lopsided crest: the head, two letters rising ahead of it, two of foam behind
export const crest = (c: { head: string; rising: string; foam: string; sea: string }): Word => (word, t) => {
  const head = (t.frame % (lettersOf(word) + 8)) - 4
  return paint(word, (_, i) => {
    const d = i - head
    return d === 0 ? c.head : d === 1 || d === 2 ? c.rising : d === -1 || d === -2 ? c.foam : c.sea
  })
}

// a gradient with a highlight that sways back and forth, one letter per 2 frames
export const sunlit = (from: string, to: string, light: string): Word => (word, t) => {
  const len = lettersOf(word)
  const period = 2 * (len - 1)
  const q = period > 0 ? Math.floor(t.frame / 2) % period : 0
  const at = q < len ? q : period - q
  return paint(word, (_, i) => (i === at ? light : ramp([from, to], len > 1 ? i / (len - 1) : 0)))
}

// 0 to 1 and back over 4 s
export const breath = (ms: number) => (1 - Math.cos((2 * Math.PI * ms) / 4000)) / 2

export const breathing = (from: string, to: string): Word => (word, t) => flat(mix(from, to, breath(t.elapsedMs)))(word, t)

export const blinds = (a: string, b: string): Word => (word, t) =>
  paint(word, (_, i) => (Math.floor((i + Math.floor(t.frame / 3)) / 2) % 2 === 0 ? a : b))

// Sprites

export const spin = (frames: string, color: string, every = 1): Sprite => t => [{ text: cycle([...frames], Math.floor(t.frame / every)), color }]

// shut for 3 frames about every 4 s
export const blinker = (open: Run[], shut: Run[]): Sprite => t => (pulse(t, 44, 3, 9) === undefined ? open : shut)

export const packet = (c: { trace: string; packet: string; flash: string }): Sprite => t => {
  const step = Math.floor(t.frame / 2) % 5
  if (step === 4) return merge([{ text: '────', color: c.trace }, { text: '◆', color: c.flash }])
  return merge([
    { text: '─'.repeat(step), color: c.trace },
    { text: '●', color: c.packet },
    { text: '─'.repeat(3 - step), color: c.trace },
    { text: '┤', color: c.trace },
  ])
}

// a planet, a path with a pulse on it, and a moon that orbits a body in four phases
export const orbit = (c: { planet: string; path: string; body: string; moon: string; pulse: string }): Sprite => t => {
  const phase = Math.floor(t.frame / 4) % 4
  const reach = Math.floor(t.frame / 2) % 4
  const at = t.mode === 'requesting' ? 1 + reach : t.mode === 'responding' ? 4 - reach : 0
  const slot = (isMoon: boolean): Run => (isMoon ? { text: '•', color: c.moon } : { text: ' ' })
  return merge([
    { text: '⊕', color: c.planet },
    ...[1, 2, 3, 4].map((i): Run => (i === at ? { text: '•', color: c.pulse } : { text: '·', color: c.path })),
    slot(phase === 0),
    { text: phase === 3 ? '⊙' : '⊖', color: c.body },
    slot(phase === 2),
  ])
}

export const skyline = (c: { heights: readonly number[]; mast: number; wall: string; lit: string; antenna: string; rain: string }): Sprite => t => {
  const roll = Math.floor(t.frame / 22)
  const isFlash = t.elapsedMs % 1000 < 200
  const cell = (x: number, y: number): Pixel => {
    if (y < 2 - (c.heights[x] ?? 0)) return (Math.floor(t.frame / 2) + x * 5) % 6 === y ? c.rain : null
    if (x === c.mast && y === 0 && isFlash) return c.antenna
    return rand(t.seed, roll, x, y) < 0.3 ? c.lit : c.wall
  }
  const row = (y: number) => c.heights.map((_, x) => cell(x, y))
  return pixels([row(0), row(1)])
}

// a moon, and a bat that flaps across it and leaves a silhouette where it passes
export const batMoon = (c: { moon: string; shade: string; bat: string; cut: string }): Sprite => t => {
  const wings = Math.floor(t.frame / 2) % 2 === 0 ? ['#.#', '.#.'] : ['.#.', '#.#']
  const left = (Math.floor(t.frame / 2) % 13) - 3
  const row = (y: number): Pixel[] =>
    Array.from({ length: 9 }, (_, x) => {
      const moon = x === 4 ? c.moon : x === 3 || x === 5 ? c.shade : null
      return wings[y]?.[x - left] === '#' ? (moon === null ? c.bat : c.cut) : moon
    })
  return pixels([row(0), row(1)])
}

export const sunrise = (c: { from: string; to: string; water: string }): Sprite => t => {
  const level = Math.min(7, Math.floor(t.elapsedMs / 4000))
  const ripple = (phase: number): Run => ({ text: Math.floor(t.frame / 4) % 2 === phase ? '~' : '-', color: c.water })
  return [ripple(0), { text: cycle([...'▁▂▃▄▅▆▇█'], level), color: mix(c.from, c.to, level / 7) }, ripple(1)]
}

// a tape reel and its button, by what the turn is doing
export const tape = (c: { reel: string; button: string }): Sprite => t => {
  const [button, turn]: [string, number] =
    t.mode === 'tool-use' ? ['⏵⏵', t.frame]
    : t.mode === 'requesting' ? ['⏴⏴', -t.frame]
    : t.mode === 'thinking' ? ['▮▮', 0]
    : ['⏵ ', Math.floor(t.frame / 2)]
  return [{ text: cycle([...'◴◷◶◵'], turn), color: c.reel }, { text: ' ' }, { text: button, color: c.button }]
}

export const waves = (c: { sea: string; crest: string; mountain: string }): Sprite => t => {
  const shift = Math.floor(t.frame / 2)
  return merge([
    ...Array.from({ length: 7 }, (_, x): Run => {
      const text = cycle([...'▁▂▃▅▆▅▃▂'], x - shift)
      return { text, color: text === '▆' ? c.crest : c.sea }
    }),
    { text: '▲', color: c.mountain },
  ])
}

export const harbour = (c: { dark: string; tower: string; flake: string; flash: string }): Sprite => t => {
  const isFlash = t.elapsedMs % 10000 < 400
  const flakes = [0, 1, 2].map((j): Run => {
    const text = cycle([...'▀▄  '], Math.floor(t.frame / 3) - j)
    return text === ' ' ? { text } : { text, color: isFlash ? c.flash : c.flake }
  })
  return merge([{ text: '▀', color: isFlash ? c.flash : c.dark, bg: c.tower }, ...flakes])
}

export const grove = (c: { shade: string; glow: string; pine: string; leaf: string }): Sprite => t => {
  const b = breath(t.elapsedMs)
  const shade = mix(c.shade, c.glow, 0.35 + 0.65 * b)
  return merge([{ text: '░▒', color: shade }, { text: '▲', color: mix(c.pine, c.leaf, b) }, { text: '▒░', color: shade }])
}

// each flower blooms over 18 frames, a third of a bloom behind its neighbour
export const flowers = (c: { sprout: string; bud: string; blooms: readonly string[] }): Sprite => t =>
  [0, 1, 2].map((j): Run => {
    const n = t.frame + 6 * j
    const phase = n % 18
    if (phase < 4) return { text: '.', color: c.sprout }
    if (phase < 8) return { text: '∘', color: c.bud }
    return { text: '✿', color: cycle(c.blooms, Math.floor(n / 18)) }
  })
