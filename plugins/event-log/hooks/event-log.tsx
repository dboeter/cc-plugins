import type { EngineInterface, Register, Timer } from 'claude-code'
import { scrub } from './scrub'

// One flat, complete, chronological record of a session: every event that crosses Claude Code, whoever raised it, as an
// enter row before the chain runs and an exit row after. Nested events land between the two, so seq order is the order
// things happened, with no folds. Full payloads go to disk; the pane shows a peek per row.
// Sections, in order (search `// ===`): TEXT, ROWS, STORAGE, HOOKS, PANE

// === TEXT ===
const CAP = 16 * 1024 // chars kept per string in a payload
const PEEK = 160
// scrub: secret-shaped text as ***, from hooks/scrub.ts (a copy of plugins/shared/scrub.ts, as agent-log's is); re-exported for the tests
export { scrub }

// JSON text of any event value: never throws. Cycles are tracked by ancestor stack, so a value shared by two fields is
// written twice, not called a cycle
export function ser(x: unknown): string {
  const stack: object[] = []
  try {
    return JSON.stringify(x, function (this: unknown, _k, v) {
      if (typeof v === 'string') { const s = scrub(v); return s.length > CAP ? `${s.slice(0, CAP)}…(+${s.length - CAP} chars)` : s }
      if (typeof v === 'function') return '[fn]'
      if (typeof v === 'bigint') return String(v)
      if (v && typeof v === 'object') {
        const Sig = (globalThis as any).AbortSignal // not in lib es2023; the plugin runtime has it
        if (Sig && v instanceof Sig) return '[signal]'
        if (v instanceof Uint8Array) return `[bytes ${v.length}]`
        if (v instanceof Error) return { name: v.name, message: scrub(v.message) }
        while (stack.length && stack[stack.length - 1] !== this) stack.pop()
        if (stack.includes(v)) return '[cycle]'
        stack.push(v)
      }
      return v
    }) ?? 'null'
  } catch (err) { return JSON.stringify(`[unserializable: ${err}]`) }
}

// the fields that say most about an event, in the order a peek prefers them
const KEYS = ['prompt', 'text', 'command', 'file_path', 'path', 'pattern', 'url', 'query', 'answer', 'message', 'content', 'args', 'description', 'error', 'deny', 'reason', 'name', 'title', 'id', 'value']
function find(x: unknown, d: number): string | undefined {
  if (typeof x === 'string') return x.trim() || undefined
  if (!x || typeof x !== 'object' || d > 3) return undefined
  if (Array.isArray(x)) { for (const v of x.slice(0, 20)) { const s = find(v, d + 1); if (s) return s } return undefined }
  for (const k of KEYS) if (k in x) { const s = find((x as any)[k], d + 1); if (s) return s }
  return undefined
}
// One line of the most telling string field; '' when there is none, since the row shows the event's name beside it
export function peekOf(x: unknown): string {
  const tool = x && typeof x === 'object' && typeof (x as any).tool === 'string' ? (x as any).tool : ''
  const s = scrub(find(x, 0) ?? '').replace(/\s+/g, ' ').trim()
  return [tool, s].filter(Boolean).join(' ').slice(0, PEEK)
}

// === ROWS ===
export type Origin = { readonly plugin: string; readonly tier: string }
// data: the payload as JSON text (e on enter, the result or error on exit, the counts on tally), spliced into the line raw
// enter: on an exit row, the seq of its enter row. err: the chain threw
export type Row = { seq: number; t: number; ph: 'enter' | 'exit' | 'tally'; ev: string; origin?: Origin; agent?: string; who: string; peek: string; data?: string; enter?: number; ms?: number; err?: true }
export const WHO = ['you', 'claude', 'engine', 'hook', 'plugin'] as const
// prompt origins that are the person: typed (composer), `claude -p` (sdk), remote control (bridge); ui.* events use person
const PERSON = new Set(['person', 'composer', 'sdk', 'bridge'])

export function whoOf(ev: string, origin: Origin, e: any, ph: 'enter' | 'exit' = 'enter'): string {
  if (ev.startsWith('classic.')) return 'hook' // the settings hooks' events
  if (origin.plugin !== 'engine') return `plugin:${origin.plugin}` // its $ call raised it
  if (PERSON.has(e?.origin?.kind)) return 'you'
  const m = e?.message
  if ((ev === 'turn.step' && ph === 'exit') || ev === 'tool.call' || (ev === 'session.append' && (m?.type === 'assistant' || m?.role === 'assistant'))) return 'claude'
  return 'engine'
}

// counted, not stored: a tally row per flush says how many
// ui.*: the screen, not the session. ui.fault stays a row: a plugin's pane broke
const NOISE = new Set(['prompt.edit', 'prompt.autocomplete', 'prompt.suggest', 'session.measure'])
export const isNoise = (ev: string) => NOISE.has(ev) || (ev.startsWith('ui.') && ev !== 'ui.fault') || ev.startsWith('clock.') || ev.endsWith('.describe')

// Read-only queries never redraw the pane: other plugins make them from their own render hooks (skins' state.get) and
// polls (agent-log's ui.panes, agent.list), so redrawing for them redraws every 2 s while idle, forever. A plugin's are
// counted, not stored (enter): they were 60-70% of a log's bytes, skins re-reading the same state ~10×/s while idle
const QUERY = new Set(['ui.panes', 'session.id', 'session.cwd', 'session.root', 'session.repo', 'session.version', 'session.model', 'session.usage', 'session.surfaces'])
export const isQuery = (ev: string) => QUERY.has(ev) || /\.(get|list|keys|read|exists|stat)$/.test(ev)

const PANE = 'event-log'
const ROW_CAP = 256 * 1024 // one row's data; past it the line keeps a head, so one huge event cannot fill a chunk
let n = 0 // seq of the last row made, before base is added (flush)
let pending: Row[] = [] // rows made since the last flush
const counts = new Map<string, number>()

export function enter(ev: string, origin: Origin, e: any): Row | undefined {
  // our own $ calls: the engine skips only the calling hook's frame, so the timer's fs.write would reach this hook and
  // log itself every flush, forever
  if (origin.plugin === PANE) return undefined
  const plugin = origin.plugin !== 'engine'
  if (isNoise(ev) || (plugin && isQuery(ev))) {
    if (e?.requestId === PANE) return undefined // this pane's own redraws and scrolls: tallying them would redraw it again, forever
    const k = plugin ? `${ev} (${origin.plugin})` : ev // per plugin, so a poller still stands out in the tally
    counts.set(k, (counts.get(k) ?? 0) + 1)
    return undefined
  }
  const agent = typeof e?.agentId === 'string' ? e.agentId : undefined
  const r: Row = { seq: ++n, t: Date.now(), ph: 'enter', ev, origin, ...(agent ? { agent } : {}), who: whoOf(ev, origin, e), peek: peekOf(e), data: ser(e) }
  pending.push(r)
  return r
}

export function exit(s: Row, e: any, r: unknown, err?: unknown): Row {
  const x: Row = { seq: ++n, t: Date.now(), ph: 'exit', ev: s.ev, origin: s.origin, ...(s.agent ? { agent: s.agent } : {}), who: whoOf(s.ev, s.origin!, e, 'exit'), peek: peekOf(err ?? r), data: ser(err !== undefined ? { error: err } : r), enter: s.seq, ms: Date.now() - s.t, ...(err !== undefined ? { err: true as const } : {}) }
  pending.push(x)
  return x
}

export function tally(): Row | undefined {
  if (!counts.size) return undefined
  const c = Object.fromEntries([...counts].sort((a, b) => b[1] - a[1]))
  counts.clear()
  // the peek is the total only: the breakdown is the data, which the inspector shows
  return { seq: ++n, t: Date.now(), ph: 'tally', ev: 'tally', who: 'tally', peek: `${Object.values(c).reduce((a, b) => a + b, 0)} counted`, data: JSON.stringify(c) }
}

// one JSONL line; data is already JSON text, spliced in rather than parsed and written again
export function lineOf(r: Row): string {
  const { data, ...rest } = r
  let d = data ?? 'null'
  if (d.length > ROW_CAP) d = JSON.stringify({ truncated: d.length, head: d.slice(0, ROW_CAP) })
  return `${JSON.stringify(rest).slice(0, -1)},"data":${d}}\n`
}

// === STORAGE ===
// ~/.claude/event-log/<sessionId>/0001.jsonl, 0002.jsonl, … $.fs.write writes whole files and caps them at 4 MiB, so the
// current chunk's text lives here and is rewritten on each flush. ROTATE counts UTF-16 units: at most 3 UTF-8 bytes each,
// so a chunk stays under 3 MiB. These writes are $ calls other plugins' hooks see (redact, context-mode); ours skip them
const ROTATE = 1024 * 1024
const KEEP = 2000 // rows the pane holds
export type Chunks = { n: number; buf: string }
const chunks: Chunks = { n: 1, buf: '' }
let dir: string | undefined // undefined: no HOME, rows stay in memory
let base = 0 // the last seq on disk when this module loaded; a hot reload continues the count from there
let tail: Row[] = [] // the newest flushed rows, for the pane
let ready: Promise<void> | undefined

// appends lines to the current chunk; returns the chunks filled on the way, each to be written one last time
export function pack(c: Chunks, lines: string[], limit = ROTATE): { n: number; text: string }[] {
  const done: { n: number; text: string }[] = []
  for (const l of lines) {
    if (c.buf && c.buf.length + l.length > limit) { done.push({ n: c.n, text: c.buf }); c.n++; c.buf = '' }
    c.buf += l
  }
  return done
}

const file = (k: number) => `${dir}/${String(k).padStart(4, '0')}.jsonl`
const parse = (text: string): Row[] => text.split('\n').flatMap(l => { try { const o = JSON.parse(l); return [{ ...o, data: JSON.stringify(o.data) }] } catch { return [] } })

// A hot reload wipes module memory: the last chunk on disk gives back its text, the pane's rows and seq. Rows made in the
// ≤2 s since the last flush before the reload are lost
async function restore($: EngineInterface): Promise<void> {
  const home = await $.env.get('HOME').catch(() => undefined)
  if (!home) return
  dir = `${home}/.claude/event-log/${await $.session.id()}`
  try {
    const last = (await $.fs.list(dir)).map(f => f.name).filter(x => /^\d{4}\.jsonl$/.test(x)).sort().at(-1)
    if (!last) return
    const text = await $.fs.read(`${dir}/${last}`)
    if (typeof text !== 'string') return
    const rows = parse(text)
    chunks.n = Number(last.slice(0, 4)); chunks.buf = text
    tail = rows.slice(-KEEP); base = rows.at(-1)?.seq ?? 0
  } catch {} // no folder yet: a new session
}

let flushing: Promise<void> | undefined
let shown = false // the pane is open: only then does a flush redraw it
async function flushOnce($: EngineInterface): Promise<void> {
  await (ready ??= restore($).catch(() => { ready = undefined })) // failed (session.id rejected): the next flush tries again
  const t = tally()
  if (t) pending.push(t)
  if (!pending.length) return
  // copies, not in place: capture still holds a pending enter row across its await, and its exit's enter must stay local
  const rows = pending.map(r => ({ ...r, seq: r.seq + base, ...(r.enter !== undefined ? { enter: r.enter + base } : {}) })); pending = []
  tail = [...tail, ...rows].slice(-KEEP)
  const done = pack(chunks, rows.map(lineOf))
  if (dir && !full) {
    // the cap: a plugin looping on $ calls (skins' state.get on every redraw) wrote ~250 KB/s; past maxMB the session
    // stops writing for good, its rows only in the pane. Every chunk before the current one holds ≤ROTATE chars
    for (const c of done) if (c.n * ROTATE <= cap) await $.fs.write(file(c.n), c.text)
    if ((chunks.n - 1) * ROTATE + chunks.buf.length > cap) full = true
    else await $.fs.write(file(chunks.n), chunks.buf)
  }
  // Never from inside the * hook, never for a tally alone (a redraw raises ui.render, which tallies), and only for what the
  // engine raised: a plugin's $ calls (skins' state.set from its render hook, agent-log's poll) never redraw, else each
  // redraw that makes them makes the next. They show on the next redraw
  if (shown && rows.some(r => r.ph !== 'tally' && r.origin?.plugin === 'engine' && !isQuery(r.ev))) $.ui.invalidate('ui.render')
}
let full = false // the cap was reached: nothing more is written this session
let cap = 50 * 1024 * 1024 // chars per session (≈ bytes for ASCII JSON); the maxMB option
export const flush = ($: EngineInterface) => flushing ??= flushOnce($).finally(() => { flushing = undefined })

// === HOOKS ===
let timer: Timer | undefined
let filter: string | undefined // a WHO entry; undefined shows every row
let back = 0 // lines between the window's end and the newest line; 0 follows
let maxBack = 0
let inspect: Row[] | undefined

async function openPane($: EngineInterface, focus: boolean) {
  await $.ui.open({ id: PANE, title: 'Event log', ...(focus ? { focus: true as const } : {}) })
  shown = true
}

// The * hook: an enter row, the chain, an exit row. It never changes e or the result, and a failure of its own never
// reaches the chain. Declared at the top level: the loader only takes a hook it can see declared there
async function capture($: EngineInterface, e: unknown, next: any) {
  if (next.is('engine.create', e)) return next(e) // $ is the empty table there
  let s: Row | undefined
  try { s = enter(next.event, next.origin, e) } catch {}
  if (!s) return next(e)
  try {
    const r = await next(e)
    try { exit(s, e, r) } catch {}
    return r
  } catch (err) {
    try { exit(s, e, undefined, err) } catch {}
    throw err
  }
}

export const register: Register = (on, options) => {
  cap = Math.max(0.001, Number(options.maxMB) || 50) * 1024 * 1024
  on('*', capture)
  // `*` skips telemetry; the anthropic stream is for built-in plugins, so this sees only an OpenTelemetry collector's
  on('telemetry.*', { to: 'collector' }, capture as any)

  on('session.start', async ($, e, next) => {
    try { await $.command.register({ name: 'eventlog', description: 'Toggle the event log pane; "you|claude|engine|hook|plugin" filters it by who raised the event, "all" clears the filter.', argumentHint: '[you|claude|engine|hook|plugin|all]' }) } catch {} // throws on hot reload: no session bound yet
    timer ??= $.clock.every(2000, () => { flush($).catch(() => {}) })
    // the pane never opens on its own: /eventlog opens it
    await (ready ??= restore($).catch(() => { ready = undefined }))
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    timer?.cancel(); timer = undefined
    try { await flush($); await flush($) } catch {} // the second takes rows made while an in-flight flush was writing
    return next(e)
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) shown = false
    return next(e)
  })

  // /eventlog stays out of the conversation: its reply is a toast, and prompt.submit drops its line
  on('command.run', { command: 'eventlog' }, async ($, e) => {
    const a = e.args.trim()
    const r = await (async () => {
    if (a) {
      if (a !== 'all' && !(WHO as readonly string[]).includes(a)) return { text: `usage: /eventlog [${WHO.join('|')}|all]` } // a typo must not toggle the pane shut
      filter = a === 'all' ? undefined : a; back = 0; inspect = undefined
      if (shown) $.ui.invalidate('ui.render') // a closed pane stays closed: the filter waits for the next /eventlog
      return { text: `event log: ${a}${shown ? '' : ' (pane hidden; /eventlog shows it)'}` }
    }
    const up = (await $.ui.panes()).some(p => p.id === PANE)
    if (up) { await $.ui.close({ id: PANE }); shown = false } else await openPane($, true)
    return { text: up ? 'event log hidden' : 'event log shown' }
    })()
    try { $.ui.toast(r.text) } catch {}
    return {}
  })
  on('prompt.submit', async ($, e, next) => e.command?.name === 'eventlog' ? { drop: 'eventlog: kept out of the conversation' } : next(e))

  // the window is the log's own, so the header stays put; the inspector's wrapped text the engine scrolls
  on('ui.scroll', { requestId: PANE }, async ($, e, next) => {
    if (inspect || e.origin.kind !== 'person') return next(e)
    back = Math.max(0, Math.min(maxBack, back - e.by))
    $.ui.invalidate('ui.render')
    return {}
  })

  // === PANE ===
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const cols = e.props.bodyColumns ?? 80
    const bodyRows = e.props.scroll?.bodyRows ?? 24
    if (inspect) {
      const rs = inspect
      const text = rs.map(r => { let d: unknown = r.data; try { d = JSON.parse(r.data ?? 'null') } catch {} return JSON.stringify({ ...r, data: d }, null, 2) }).join('\n\n')
      return (
        <Box flexDirection="column" width={cols}>
          <Button key="back" label="← back (b)" hotkey="b" onPress={() => { inspect = undefined; $.ui.invalidate('ui.render'); $.ui.scroll({ in: PANE, to: 'start' }).catch(() => {}) }} />
          <Text key="data" wrap="wrap">{text.length > 64 * 1024 ? `${text.slice(0, 64 * 1024)}\n…(+${text.length - 64 * 1024} chars, full row on disk)` : text}</Text>
        </Box>
      )
    }
    const lines = linesOf(tail, filter)
    const room = Math.max(1, bodyRows - 1)
    maxBack = Math.max(0, lines.length - room)
    back = Math.min(back, maxBack)
    const shownLines = lines.slice(Math.max(0, lines.length - room - back), lines.length - back)
    const head = `${filter ?? 'all'} · ${lines.length} rows${back ? ` · ${back} newer below` : ''} · ${!dir ? 'not on disk' : full ? `log full at ${+(cap / 1048576).toFixed(3)} MB, no longer writing: ${dir}` : dir}`
    return (
      <Box flexDirection="column">
        <Text key="head" dimColor wrap="truncate-end">{head}</Text>
        {!lines.length && <Text key="empty" dimColor>No events yet.</Text>}
        {shownLines.map(l => <Button key={l.key} label={l.text.length > cols - 1 ? `${l.text.slice(0, Math.max(1, cols - 2))}…` : l.text} plain onPress={() => { inspect = l.rows; $.ui.invalidate('ui.render'); $.ui.scroll({ in: PANE, to: 'start' }).catch(() => {}) }} />)}
      </Box>
    )
  })
}

const pad = (x: number, w = 2) => String(x).padStart(w, '0')
const hms = (t: number) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` }
const done = (x: Row) => `${x.ms}ms ${x.err ? 'threw' : 'ok'}`
const tag = (who: string) => who.replace(/^plugin:/, '').padEnd(10).slice(0, 10)

// One line per event. An exit merges into its enter when only rows of the same event came between: a concurrent batch,
// the engine raising all of a burst's enters (113 prompt.attachment on a reload) before any exit. An exit with other
// events nested before it points back with ↳
export type Line = { key: string; rows: Row[]; text: string }
export function linesOf(rows: Row[], filter?: string): Line[] {
  const rs = filter ? rows.filter(r => filter === 'plugin' ? r.who.startsWith('plugin:') : r.who === filter) : rows
  const out: Line[] = []
  const merged = new Set<number>() // seqs of exits already shown on their enter's line
  for (let i = 0; i < rs.length; i++) {
    const a = rs[i]!
    if (merged.has(a.seq)) continue
    let j = i + 1
    if (a.ph === 'enter') while (j < rs.length && rs[j]!.ev === a.ev && rs[j]!.enter !== a.seq) j++
    const b = rs[j]
    if (a.ph === 'enter' && b?.ph === 'exit' && b.enter === a.seq) {
      out.push({ key: `r${a.seq}`, rows: [a, b], text: `${hms(a.t)}  ${tag(b.who)}  ${a.ev}  ${a.peek || b.peek} · ${done(b)}` })
      merged.add(b.seq)
    } else if (a.ph === 'exit') out.push({ key: `r${a.seq}`, rows: [a], text: `${hms(a.t)}  ${tag(a.who)}  ↳ ${a.ev} ${done(a)}  ${a.peek}` })
    else out.push({ key: `r${a.seq}`, rows: [a], text: `${hms(a.t)}  ${tag(a.who)}  ${a.ev}  ${a.peek}` })
  }
  return out
}
