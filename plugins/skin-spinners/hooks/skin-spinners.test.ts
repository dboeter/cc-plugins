import { test, expect, mock } from 'claude-code/testing'
import { footerRow, spinnerRow } from './row'
import { THEMES, type Done, type Theme } from './themes'
import { hash, width, type Mode, type Run, type Tick } from './runs'

const SECOND = 1000
const MINUTE = 60 * SECOND
const ELAPSED = [0, SECOND, 25 * SECOND, 45 * SECOND, 65 * SECOND, 5 * MINUTE, 12 * MINUTE, 25 * MINUTE, 50 * MINUTE, 420 * MINUTE]
const MODES: Mode[] = ['requesting', 'responding', 'thinking', 'tool-input', 'tool-use']
const STATS = { tools: 3, added: 10, removed: 2 }

const text = (runs: Run[]) => runs.map(r => r.text).join('')
const theme = (name: string) => THEMES[name] as Theme
const footer = (name: string, word: string, durationMs: number, stats?: { tools: number; added: number; removed: number }) =>
  text(footerRow(theme(name).muted, theme(name).done as Done, word, durationMs, stats))
const tick = (name: string, elapsedMs: number, frame = 0, mode: Mode = 'responding'): Tick => ({ frame, elapsedMs, mode, seed: hash(name) })

for (const [name, th] of Object.entries(THEMES)) {
  test(`${name}: the sprite and the word keep their width, no glyph is an emoji, no run is empty`, () => {
    const problems: string[] = []
    const seen = new Set<string>()
    const widths = new Map<string, number>()
    const note = (what: string, runs: Run[], isFixed: boolean) => {
      const w = width(runs)
      const before = widths.get(what)
      if (isFixed && before === undefined) widths.set(what, w)
      else if (isFixed && before !== w && problems.length < 5) problems.push(`${what} was ${before} wide, then ${w}`)
      for (const run of runs) {
        if (run.text === '' && problems.length < 5) problems.push(`${what} has an empty run`)
        for (const ch of run.text) seen.add(ch)
      }
    }
    for (const mode of MODES) {
      for (let frame = 0; frame <= 240; frame++) {
        for (const e of ELAPSED) {
          const t = tick(name, e, frame, mode)
          note('sprite', th.sprite(t), true)
          for (const word of th.words) note(`word ${word}`, th.word(word, t), true)
          note('clock', th.clock?.(t) ?? [], false)
          note('tag', th.tag?.(t) ?? [], false)
        }
      }
    }
    expect(problems).toEqual([])
    expect([...seen].filter(ch => (ch.codePointAt(0) ?? 0) > 127 && /\p{Emoji}/u.test(ch))).toEqual([])
  })
}

test('there is a theme for each of the 18 skins, 11 of them with a footer', () => {
  expect(Object.keys(THEMES).length).toBe(18)
  expect(Object.values(THEMES).filter(th => th.done !== undefined).length).toBe(11)
})

test('tokyo-night: the tag runs from on time to the last train', () => {
  const tag = (ms: number) => text(theme('tokyo-night').tag?.(tick('tokyo-night', ms)) ?? [])
  expect([tag(30 * SECOND), tag(5 * MINUTE), tag(12 * MINUTE)]).toEqual(['ON TIME', '+5 MIN', 'LAST TRAIN · BOARDING'])
})

test('everforest: the trail tag counts kilometres and metres, then makes camp', () => {
  const tag = (ms: number) => text(theme('everforest').tag?.(tick('everforest', ms)) ?? [])
  expect([tag(7 * MINUTE), tag(20 * MINUTE)]).toEqual(['trail 4.2 km · ↑ 310 m', 'camp before dusk'])
})

test('rose-pine: no clock for 30 s, then the default one', () => {
  const clock = (ms: number) => text(theme('rose-pine').clock?.(tick('rose-pine', ms)) ?? [])
  expect([clock(29 * SECOND), clock(30 * SECOND)]).toEqual(['', '30s'])
})

test('retro-terminal: only the cursor at 0 ms, the whole word after 90 ms a letter', () => {
  const word = (ms: number) => text(theme('retro-terminal').word('Spooling', tick('retro-terminal', ms)))
  expect(word(0).trim()).toBe('█')
  expect(word(0).length).toBe(9)
  expect(word(90 * 'Spooling'.length)).toBe('Spooling█')
})

// a custom skin's words can hold anything; a wide letter takes two cells, an emoji can be several code points
const WIDE_WORDS = ['猫の手', '🦇 Bats', '❤️ Love', '🇳🇱 Dutch', 'Café']

for (const [name, th] of Object.entries(THEMES)) {
  test(`${name}: a word with wide letters keeps its width`, () => {
    const problems: string[] = []
    for (const word of WIDE_WORDS) {
      const widths = new Set<number>()
      for (let frame = 0; frame <= 120; frame++) for (const e of [0, 90, 400, 1500, 25 * SECOND]) widths.add(width(th.word(word, tick(name, e, frame))))
      if (widths.size > 1) problems.push(`${word} was ${[...widths].join(', ')} wide`)
    }
    expect(problems).toEqual([])
  })
}

test('retro-terminal: the bytes run out after about 40 minutes', () => {
  const tag = (ms: number) => text(theme('retro-terminal').tag?.(tick('retro-terminal', ms)) ?? [])
  expect([tag(0), tag(10 * SECOND), tag(41 * MINUTE)]).toEqual(['38911 BYTES FREE', '38751 BYTES FREE', '?OUT OF MEMORY'])
})

test('retro-terminal: the send light stays dark while the model answers, the receive light while a request goes out', () => {
  const lit = (mode: Mode, i: number) =>
    Array.from({ length: 40 }, (_, frame) => theme('retro-terminal').sprite(tick('retro-terminal', 0, frame, mode)))
      .some(runs => runs.flatMap(r => [...r.text].map(() => r.color))[i] === '#33ff66')
  expect([lit('responding', 2), lit('responding', 3), lit('requesting', 2), lit('requesting', 3)]).toEqual([false, true, true, false])
})

test('dracula: a bat 5 pixels wide crosses the moon', () => {
  // frame 14: wings down, the bat's left edge on column 2, its right wing over the moon's columns 5 and 6
  const cells = theme('dracula').sprite(tick('dracula', 0, 14)).flatMap(r => [...r.text].map(ch => [ch, r.color ?? null, r.bg ?? null]))
  expect(cells.slice(2, 7)).toEqual([
    ['▄', '#6272a4', null],
    ['▄', '#6272a4', null],
    ['▀', '#6272a4', null],
    ['▀', '#8a6ad1', '#282a36'],
    ['▀', '#bd93f9', '#282a36'],
  ])
})

test('dracula: past 3 minutes a colony of bats crosses a blood moon, and no tag says so', () => {
  const sprite = (ms: number) => Array.from({ length: 36 }, (_, frame) => theme('dracula').sprite(tick('dracula', ms, frame)))
  const batCells = (ms: number) => Math.max(...sprite(ms).map(runs => runs.filter(r => r.color === '#6272a4').reduce((n, r) => n + r.text.length, 0)))
  const isBlood = (ms: number) => sprite(ms).some(runs => runs.some(r => r.color === '#ff5555'))
  expect([isBlood(2 * MINUTE), isBlood(3 * MINUTE)]).toEqual([false, true])
  expect(batCells(3 * MINUTE)).toBeGreaterThan(batCells(0))
  expect(theme('dracula').tag).toBeUndefined()
})

test('overdrive: the word keeps its letters at any heat, sparks more letters bold as the turn runs, and strobes at full heat', () => {
  const runs = (ms: number, frame: number) => theme('nord').word('Keeping watch', tick('nord', ms, frame))
  const bold = (ms: number) =>
    Array.from({ length: 200 }, (_, frame) => runs(ms, frame).filter(r => r.bold).reduce((n, r) => n + r.text.length, 0)).reduce((a, b) => a + b, 0)
  for (const ms of [0, MINUTE, 3 * MINUTE]) for (let frame = 0; frame < 40; frame++) expect(text(runs(ms, frame))).toBe('Keeping watch')
  expect(bold(0)).toBeLessThan(bold(MINUTE))
  expect(runs(3 * MINUTE, 0).filter(r => r.text.trim() !== '').every(r => r.bold)).toBe(true)
})

test('cyberpunk-neon and space-gray: a gauge fills over 3 minutes, then pulses in place, never turning to words', () => {
  const tag = (name: string, ms: number) => theme(name).tag?.(tick(name, ms)) ?? []
  const colors = (name: string, ms: number) => new Set(Array.from({ length: 30 }, (_, i) => tag(name, ms + 100 * i)[1]?.color))
  expect([0, 90 * SECOND, 3 * MINUTE, 10 * MINUTE].map(ms => text(tag('cyberpunk-neon', ms)))).toEqual(['TRACE ▱▱▱▱▱▱', 'TRACE ▰▰▰▱▱▱', 'TRACE ▰▰▰▰▰▰', 'TRACE ▰▰▰▰▰▰'])
  expect([0, 3 * MINUTE].map(ms => text(tag('space-gray', ms)))).toEqual(['ΔV ▱▱▱▱▱▱', 'ΔV ▰▰▰▰▰▰'])
  expect([colors('cyberpunk-neon', 2 * MINUTE).size, colors('cyberpunk-neon', 3 * MINUTE).size > 5]).toEqual([1, true])
})

test('rose-pine: from 3 minutes, in full bloom fades in once and holds still', () => {
  const tag = (ms: number, frame = 0) => theme('rose-pine').tag?.(tick('rose-pine', ms, frame)) ?? []
  expect(text(tag(179 * SECOND))).toBe('')
  expect([tag(3 * MINUTE)[0]?.color, tag(3 * MINUTE + 2 * SECOND)[0]?.color, tag(5 * MINUTE, 7)[0]?.color]).toEqual(['#6e6a86', '#eb6f92', '#eb6f92'])
  expect(text(tag(5 * MINUTE, 4))).toBe('in full bloom')
})

test('dracula: the clock counts down to sunrise', () => {
  const clock = (ms: number) => text(theme('dracula').clock?.(tick('dracula', ms)) ?? [])
  expect([clock(0), clock(7 * 60 * MINUTE)]).toEqual(['sunrise in 6h 12m 00s', 'sunrise'])
})

test('kanagawa: no tag at 19 s, Fuji does not move at 65 s', () => {
  const tag = (ms: number) => text(theme('kanagawa').tag?.(tick('kanagawa', ms)) ?? [])
  expect([tag(19 * SECOND), tag(65 * SECOND)]).toEqual(['', 'fuji does not move'])
})

test('gruvbox: the tape turns over to side B at 45 minutes', () => {
  const clock = (ms: number) => text(theme('gruvbox').clock?.(tick('gruvbox', ms)) ?? [])
  expect([clock(44 * MINUTE + 59 * SECOND), clock(45 * MINUTE)]).toEqual(['44:59 · side A', '45:00 · side B'])
})

test('cyberpunk-neon and space-gray: the clocks read in hex and in T+', () => {
  expect(text(theme('cyberpunk-neon').clock?.(tick('cyberpunk-neon', 12 * SECOND)) ?? [])).toBe('t+0x0c')
  expect(text(theme('space-gray').clock?.(tick('space-gray', 42 * SECOND)) ?? [])).toBe('T+00:42')
})

test('a row is the sprite, the word, the suffix, then the clock and the tag, each part only when it draws', () => {
  const row = (name: string, ms: number) => text(spinnerRow(theme(name), tick(name, ms), 'Rising', '…'))
  expect(row('mono', 5 * SECOND)).toMatch(/^\S Rising…  5s$/)
  expect(row('rose-pine', 5 * SECOND)).toMatch(/^░▲▒▲░▲▒ Rising⁓$/)
  expect(row('tokyo-night', 5 * SECOND)).toMatch(/ Rising…  5s  ON TIME$/)
})

test('the footer: tools, then lines added and removed; none of either leaves them out', () => {
  const row = (stats?: { tools: number; added: number; removed: number }) => footer('nord', 'Frozen', 42 * SECOND, stats)
  expect(row(STATS)).toBe('◆ Frozen in 42s  ·  3 tools  ·  +10 −2')
  expect(row({ ...STATS, tools: 1 })).toBe('◆ Frozen in 42s  ·  1 tool  ·  +10 −2')
  expect(row({ tools: 0, added: 0, removed: 0 })).toBe('◆ Frozen in 42s')
  expect(row()).toBe('◆ Frozen in 42s')
  expect(footer('space-gray', 'Splashdown', 42 * SECOND)).toBe('◆ Splashdown · T+00:42')
})

// The engine beneath: skins' state is answered by a state.get hook of the test's, and what is drawn when this mod passes is a marker.
const SPINNER = { word: 'Sauteing', message: null, suffix: '…', mode: 'responding' as Mode }
const mountSpinner = ($: any, surface: 'terminal' | 'desktop' = 'terminal', props: object = SPINNER) =>
  $.ui.mount({ plugin: 'skin-spinners', surface, component: 'Spinner', props })
const mountFooter = ($: any, durationMs: number) =>
  $.ui.mount({ plugin: 'skin-spinners', surface: 'terminal', component: 'TurnDuration', props: { word: 'Baked', durationMs } })
const prefs = (skin: string, more: object = {}) => ({ skin, icons: 'unicode', words: 'skin', calm: null, ...more })
const world = (on: any, skins: Record<string, unknown>) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('state.get', (_: any, e: any, next: any) => (e.plugin === 'skins' ? { value: { value: skins[e.key], version: 1 } } : next(e)))
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, null, 'marker')
  })
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('turn.start', (_: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  return clock
}
const rowOf = async (m: any) => String((await m.find({ type: 'Text' }))?.text)
const START = { cwd: '/', surface: 'terminal', isInteractive: true } as const

test('with no skins prefs the other drawing stays', async ($, on) => {
  world(on, {})
  const m = await mountSpinner($)
  expect(await m.find({ text: /marker/ })).toBeDefined()
  await m.unmount()
})

test('the terminal spinner of nord holds a nord word', async ($, on) => {
  world(on, { prefs: prefs('nord'), isLight: false })
  const m = await mountSpinner($)
  expect(await m.find({ text: /marker/ })).toBe(undefined)
  expect(await rowOf(m)).toMatch(new RegExp(theme('nord').words.join('|')))
  await m.unmount()
})

test('words claude keeps Claude Code\'s own word', async ($, on) => {
  world(on, { prefs: prefs('nord', { words: 'claude' }) })
  const m = await mountSpinner($)
  expect(await rowOf(m)).toContain('Sauteing…')
  await m.unmount()
})

test('a custom skin\'s own words join the theme\'s', async ($, on) => {
  const words = ['Zzzzz']
  world(on, { prefs: prefs('mono'), custom: { mono: { name: 'mono', label: 'Mono', base: 'mono', palette: {}, spinner: words, done: [] } } })
  const seen = new Set<string>()
  for (let i = 0; i < 60; i++) {
    const m = await mountSpinner($, 'terminal', { ...SPINNER, word: `w${i}` })
    seen.add((await rowOf(m)).replace(/^\S /, '').replace(/….*/, ''))
    await m.unmount()
  }
  expect([...seen].every(word => [...theme('mono').words, ...words].includes(word))).toBe(true)
  expect(seen.has('Zzzzz')).toBe(true)
})

test('a custom skin\'s own done words join the theme\'s', async ($, on) => {
  world(on, { prefs: prefs('retro-terminal'), custom: { 'retro-terminal': { name: 'retro-terminal', label: 'Retro', base: 'mono', palette: {}, spinner: [], done: ['Zapped'] } } })
  const seen = new Set<string>()
  for (let i = 0; i < 40; i++) {
    const m = await mountFooter($, 1000 * (i + 1))
    seen.add((await rowOf(m)).replace(/^READY\. /, '').replace(/ in .*/, ''))
    await m.unmount()
  }
  expect(seen.has('Zapped')).toBe(true)
})

test('the desktop, calm, ascii icons, a light palette, a message and an unknown skin keep the other drawing', async ($, on) => {
  const state: Record<string, unknown> = { prefs: prefs('nord'), isLight: false }
  world(on, state)
  const marked = async (surface: 'terminal' | 'desktop', props?: object) => {
    const m = await mountSpinner($, surface, props)
    const isMarked = (await m.find({ text: /marker/ })) !== undefined
    await m.unmount()
    return isMarked
  }
  expect(await marked('desktop')).toBe(true)
  expect(await marked('terminal', { ...SPINNER, message: 'Compacting' })).toBe(true)
  state.prefs = prefs('nord', { calm: { shimmer: true, rail: true, quiet: false } })
  expect(await marked('terminal')).toBe(true)
  state.prefs = prefs('nord', { icons: 'ascii' })
  expect(await marked('terminal')).toBe(true)
  state.prefs = prefs('nord', { skin: 'off' })
  expect(await marked('terminal')).toBe(true)
  state.prefs = prefs('nord')
  state.isLight = true
  expect(await marked('terminal')).toBe(true)
  state.isLight = false
  state.prefs = prefs('some-custom-skin')
  expect(await marked('terminal')).toBe(true)
  state.prefs = prefs('constructor')
  expect(await marked('terminal')).toBe(true)
  state.prefs = prefs('nord')
  expect(await marked('terminal')).toBe(false)
})

test('the row keeps moving for as long as the spinner is up, well past the idle second', async ($, on) => {
  const clock = world(on, { prefs: prefs('mono') })
  await $.session.start(START)
  const m = await mountSpinner($)
  await clock.advance(2000)
  const rows = new Set<string>()
  for (let i = 0; i < 8; i++) {
    await clock.advance(90)
    rows.add(await rowOf(m))
  }
  expect(rows.size).toBeGreaterThan(1)
  await m.unmount()
})

test('a subagent\'s turns and a prompt typed during the turn leave the clock alone, and so does the turn\'s end', async ($, on) => {
  const clock = world(on, { prefs: prefs('mono') })
  await $.session.start(START)
  await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } } as any).catch(() => {})
  await clock.advance(2000)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await clock.advance(3000)
  await $.turn.start({ text: 'task', turnId: 'a1', agentId: 'agent-1' } as any)
  await $.turn.complete({ answer: '', durationMs: 100, isAborted: false, turnId: 'a1', reason: 'answer', agentId: 'agent-1' } as any)
  await $.prompt.submit({ text: 'also this', wait: false, origin: { kind: 'composer' }, turnId: 't1' } as any).catch(() => {})
  const m = await mountSpinner($)
  await clock.advance(1000)
  expect(await rowOf(m)).toMatch(/ 6s$/)
  await $.turn.complete({ answer: 'ok', durationMs: 6000, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(await rowOf(m)).toMatch(/ 6s$/)
  await m.unmount()
})

test('a turn that starts a minute after the last idle prompt counts from its own start', async ($, on) => {
  const clock = world(on, { prefs: prefs('mono') })
  await $.session.start(START)
  await $.prompt.submit({ text: '/skin nord', wait: false, origin: { kind: 'composer' } } as any).catch(() => {})
  await clock.advance(61_000)
  await $.turn.start({ text: '', turnId: 't1' })
  const m = await mountSpinner($)
  await clock.advance(2000)
  expect(await rowOf(m)).toMatch(/ 2s$/)
  await m.unmount()
})

test('the clock counts from the turn start', async ($, on) => {
  const clock = world(on, { prefs: prefs('mono') })
  await $.session.start(START)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  const m = await mountSpinner($)
  await clock.advance(5000)
  expect(await rowOf(m)).toMatch(/ 5s$/)
  await m.unmount()
})

test('the clock counts from the prompt, through the seconds its hooks take before the turn starts', async ($, on) => {
  const clock = world(on, { prefs: prefs('mono') })
  await $.session.start(START)
  await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } } as any).catch(() => {})
  await clock.advance(4000)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  const m = await mountSpinner($)
  await clock.advance(1000)
  expect(await rowOf(m)).toMatch(/ 5s$/)
  await m.unmount()
})

test('the footer: an aborted turn draws an aborted word, a refused one an error word, an answer a done word', async ($, on) => {
  world(on, { prefs: prefs('nord'), turns: { '2500': STATS } })
  await $.session.start(START)
  await $.turn.complete({ answer: '', durationMs: 1500, isAborted: true, turnId: 't1', reason: 'aborted' })
  await $.turn.complete({ answer: '', durationMs: 2000, isAborted: false, turnId: 't2', reason: 'refusal', refusal: { category: null, explanation: null } })
  await $.turn.complete({ answer: 'ok', durationMs: 2500, isAborted: false, turnId: 't3', reason: 'answer' })
  const row = async (ms: number) => {
    const m = await mountFooter($, ms)
    const t = await rowOf(m)
    await m.unmount()
    return t
  }
  expect(await row(1500)).toBe('◆ Fog bound in 2s')
  expect(await row(2000)).toBe('◆ Ran aground in 2s')
  expect(await row(2500)).toMatch(new RegExp(`^◆ (${theme('nord').done?.words.join('|')}) in 3s  ·  3 tools  ·  \\+10 −2$`))
})

test('the footer of a skin with no banner stays skins\'', async ($, on) => {
  world(on, { prefs: prefs('mono') })
  const m = await mountFooter($, 3000)
  expect(await m.find({ text: /marker/ })).toBeDefined()
  await m.unmount()
})

test('only the newest 20 outcomes are kept, however short the newest turn is', async ($, on) => {
  world(on, { prefs: prefs('nord') })
  await $.session.start(START)
  for (let i = 0; i < 25; i++) await $.turn.complete({ answer: 'ok', durationMs: 10_000 + i, isAborted: false, turnId: `t${i}`, reason: 'answer' })
  await $.turn.complete({ answer: '', durationMs: 500, isAborted: true, turnId: 'last', reason: 'aborted' })
  const m = await mountFooter($, 500)
  expect(await rowOf(m)).toBe('◆ Fog bound in 1s')
  await m.unmount()
})

test('an outcome older than the newest 20 is dropped, and its footer reads as an answer', async ($, on) => {
  world(on, { prefs: prefs('nord') })
  await $.session.start(START)
  await $.turn.complete({ answer: '', durationMs: 500, isAborted: true, turnId: 'first', reason: 'aborted' })
  for (let i = 0; i < 20; i++) await $.turn.complete({ answer: 'ok', durationMs: 10_000 + i, isAborted: false, turnId: `t${i}`, reason: 'answer' })
  const m = await mountFooter($, 500)
  expect(await rowOf(m)).toMatch(new RegExp(`^◆ (${theme('nord').done?.words.join('|')}) in 1s$`))
  await m.unmount()
})
