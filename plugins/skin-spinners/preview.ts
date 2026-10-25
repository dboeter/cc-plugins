// Draws every theme in the terminal, one row per skin, redrawn every 90 ms until Ctrl-C.
//   bun plugins/skin-spinners/preview.ts [--skin a,b] [--mode <mode>] [--at <seconds>] [--speed <n>] [--frames <n>] [--footer]
import { footerRow, spinnerRow } from './hooks/row'
import { THEMES } from './hooks/themes'
import { FRAME_MS, hash, pick, type Mode, type Run } from './hooks/runs'

const MODES: readonly Mode[] = ['requesting', 'responding', 'thinking', 'tool-input', 'tool-use']
const args = process.argv.slice(2)
const flag = (name: string) => args.includes(`--${name}`)
const value = (name: string) => (flag(name) ? args[args.indexOf(`--${name}`) + 1] : undefined)

const mode = (value('mode') ?? 'responding') as Mode
if (!MODES.includes(mode)) {
  console.error(`--mode is one of ${MODES.join(', ')}`)
  process.exit(1)
}
const only = value('skin')?.split(',')
const skins = Object.keys(THEMES).filter(name => only === undefined || only.includes(name))
const at = Number(value('at') ?? 0) * 1000
const speed = Number(value('speed') ?? 1)
const frames = flag('frames') ? Number(value('frames')) : undefined
const nameWidth = Math.max(...skins.map(name => name.length))

// '#rrggbb' as 24-bit colour, 'ansi256(n)' (the terminal theme) as the terminal's own colour n
const sgr = (layer: 38 | 48, color: string) => {
  const ansi = /^ansi256\((\d+)\)$/.exec(color)
  return ansi ? `${layer};5;${ansi[1]}` : `${layer};2;${[1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16)).join(';')}`
}
const paint = (runs: Run[], isColor: boolean) =>
  runs
    .map(r => {
      if (!isColor) return r.text
      const codes = [r.bold ? '1' : '', r.italic ? '3' : '', r.color ? sgr(38, r.color) : '', r.bg ? sgr(48, r.bg) : ''].filter(Boolean)
      return codes.length === 0 ? r.text : `\x1b[${codes.join(';')}m${r.text}\x1b[0m`
    })
    .join('')

const label = (name: string) => name.padStart(nameWidth)
const STATS = { tools: 3, added: 10, removed: 2 }

const footers = (isColor: boolean) =>
  skins.flatMap(name => {
    const theme = THEMES[name]
    const done = theme?.done
    if (theme === undefined || done === undefined) return []
    const kinds = [['answer', done.words], ['aborted', done.aborted], ['error', done.error]] as const
    return kinds.map(([kind, words]) => `${label(name)}  ${paint(footerRow(theme.muted, done, pick(words, '42000'), 42000, STATS), isColor)}  (${kind})`)
  })

const row = (name: string, frame: number, isColor: boolean) => {
  const theme = THEMES[name]
  if (theme === undefined) return ''
  const t = { frame, elapsedMs: at + frame * FRAME_MS * speed, mode, seed: hash(name) }
  return `${label(name)}  ${paint(spinnerRow(theme, t, pick(theme.words, name), '…'), isColor)}`
}

if (frames !== undefined) {
  const isColor = false
  for (const name of skins) {
    for (let frame = 0; frame < frames; frame++) console.log(row(name, frame, isColor))
  }
  if (flag('footer')) for (const line of footers(isColor)) console.log(line)
} else {
  const still = flag('footer') ? footers(true) : []
  let frame = 0
  let drawn = 0
  const draw = () => {
    const lines = [...skins.map(name => row(name, frame, true)), ...still]
    frame++
    process.stdout.write(`${drawn > 0 ? `\x1b[${drawn}A` : '\x1b[?25l'}${lines.map(line => `${line}\x1b[K\n`).join('')}`)
    drawn = lines.length
  }
  const timer = setInterval(draw, FRAME_MS)
  process.on('SIGINT', () => {
    clearInterval(timer)
    process.stdout.write('\x1b[?25h')
    process.exit(0)
  })
  draw()
}
