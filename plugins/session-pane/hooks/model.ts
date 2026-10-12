// The session as the pane reads it: one mutable SessionModel, folded from every event the `*` hook sees (reduce), plus
// the pure readings the views draw from it (statusOf, checksOf, contextLabel, segmentsOf). No $ calls here: the hooks
// module owns those, so everything below runs in a test as plain data.
// Sections, in order (search `// ===`): TEXT, WHO, CHECKS, TOOLS, MODEL, REDUCE, READINGS, RESTORE

import type { Est, FileChange, Goal, Hunk, SessionModel, Source, SourceNote, Todo } from '../types'
export type { Est, FileChange, Goal, Hunk, SessionModel, Source, SourceNote, Todo }

// === TEXT ===
// best-effort secret scrub, not a guarantee: anything the pane shows or stores passes through it
export const scrub = (s: string) => s.replace(/(bearer\s+|\b\w*(token|secret|password|passwd|api[_-]?key)\w*[=:]\s*|--?(password|token|api-key)[= ]|:\/\/[^:\/\s]+:)[^\s@'"]+/gi, '$1***')
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g
export const base = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p
const clip = (s: string, n: number) => s.length > n ? `${s.slice(0, n - 1)}…` : s
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

// The goal's title until the small model answers, and when it can't: the prompt's first sentence, cut at a word
export function titleOf(text: string, words = 6): string {
  const s = oneLine(text).split(/(?<=[.!?])\s/)[0]!.replace(/[.!?]+$/, '')
  const w = s.split(' ')
  return w.length > words ? `${w.slice(0, words).join(' ')}…` : s
}

// === WHO ===
export type Origin = { readonly plugin: string; readonly tier: string }
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

// Never folded: the screen's own events and the composer's keystrokes. session.measure is kept: it is the context fill
const NOISE = new Set(['prompt.edit', 'prompt.autocomplete', 'prompt.suggest'])
export const isNoise = (ev: string) => NOISE.has(ev) || ev.startsWith('ui.') || ev.startsWith('clock.') || ev.endsWith('.describe')
// Read-only queries: another plugin polling them (from its render hook or a timer) must never redraw this pane, else each
// redraw that makes one makes the next
const QUERY = new Set(['ui.panes', 'session.id', 'session.cwd', 'session.root', 'session.repo', 'session.version', 'session.model', 'session.usage', 'session.surfaces', 'session.messages'])
export const isQuery = (ev: string) => QUERY.has(ev) || /\.(get|list|keys|read|exists|stat)$/.test(ev)

// === CHECKS ===
// A Bash call's output read for a verdict: its exit code and the one to three lines that say what failed
const OUTPUT_NOISE = /^\s*(npm (ERR!|error)\s*$|npm (ERR!|error) (code|path|errno|syscall|signal|command|cwd|A complete log|Lifecycle)|at .*(node_modules|node:internal)|[\d.]+%|.*[█░▓▒]{3}|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏])/i
const ERRLINE = /(error|exception)\b|\b(fatal|fail(ed|ure)?|panic|denied|rejected|conflict|not found|no such file|cannot|unable)\b|TS\d{4}/i // no \b before error: KeyError, TypeError
const WRAP = new Set(['sudo', 'npx', 'bunx', 'exec', 'time', 'env', 'nice', 'timeout'])
const noCd = (s: string) => s.replace(/^\s*cd\s+\S+\s*(&&|;)\s*/, '') // a Bash command minus its leading `cd <dir> &&` / `;`
export const progOf = (seg: string) => { // `FOO=1 timeout 30 npx tsc -p .` -> tsc; `npm run test` -> npm test
  const w = seg.trim().split(/\s+/).filter(t => t && !/^\w+=/.test(t))
  while (w.length > 1 && (WRAP.has(w[0]!) || /^\d+[smh]?$/.test(w[0]!))) w.shift()
  const p = (w[0] ?? '').split('/').pop() ?? ''
  if (/^(npm|pnpm|yarn|bun)$/.test(p) && w[1] && !w[1].startsWith('-')) return `${p} ${w[1] === 'run' ? w[2] ?? 'run' : w[1]}`
  if (p === 'claude' && w[1] === 'plugin' && w[2]) return `claude plugin ${w[2]}` // a plugin's own test and validate
  if ((p === 'cargo' || p === 'go') && w[1]) return `${p} ${w[1]}`
  return p
}
const progsOf = (cmd: string) => noCd(cmd).split(/&&|\|\||[;|\n]/).map(progOf).filter(Boolean)
export function insightOf(cmd: string | undefined, raw: string): { exit?: number; text: string } {
  const m = raw.match(/^Exit code (\d+)/m) // the Bash tool's error text leads with it
  const exit = m ? Number(m[1]) : undefined
  const lines = raw.replace(ANSI, '').split('\n').map(l => l.trimEnd()).filter(l => l.trim() && !/^Exit code \d+$/.test(l.trim()) && !OUTPUT_NOISE.test(l))
  const progs = cmd ? progsOf(cmd) : []
  const last = progs.at(-1)
  const known = progs.find(p => /^(vue-tsc|tsc|vitest|jest|pytest|git|cargo|go|eslint)\b|test$/.test(p)) ?? last ?? ''
  let head = known
  let pick: string[] = []
  const ts = lines.filter(l => /error TS\d+/.test(l))
  if (ts.length) {
    const files = new Set(ts.map(l => l.split('(')[0]))
    head = `${known || 'tsc'} · ${ts.length} error${ts.length > 1 ? 's' : ''} in ${files.size} file${files.size > 1 ? 's' : ''}`
    pick = ts.map(l => l.replace(/^[^(]*\//, '').replace(/:\s*error (TS\d+):\s*/, '  $1 ')) // `src/x.ts(4,7): error TS2322: msg` -> `x.ts(4,7)  TS2322 msg`
  } else if (/test|vitest|jest|pytest/.test(known)) pick = lines.filter(l => /^\s*(FAIL|FAILED|✗|×|●)\s|\b\d+ failed\b|^\(fail\)/.test(l))
  else if (known === 'git') pick = lines.filter(l => /^(fatal|error):|\[rejected\]|^CONFLICT/.test(l))
  if (!pick.length) pick = lines.filter(l => ERRLINE.test(l))
  if (!pick.length) pick = lines.slice(-3) // errors land at the end more often than at the start
  return { exit, text: scrub([head, ...pick.slice(0, 3).map(l => l.trim())].filter(Boolean).join('\n')).slice(0, 300) }
}

// Which commands count as a check, under which plain name, and which output line says one failed. Matched per program of
// the command, first hit wins; a command that is none of these (a build, a git call) is not a check
const CHECK: [RegExp, string, RegExp][] = [
  [/^(tsc|vue-tsc|mypy|pyright|cargo check|go vet|(npm|pnpm|yarn|bun) (typecheck|type-check|check-types|tsc))$/, 'Type check', /error TS\d+|^error(\[E\d+\])?:|\b[1-9]\d* errors?\b/],
  [/^(eslint|ruff|biome|shellcheck|cargo clippy|claude plugin validate|(npm|pnpm|yarn|bun) lint)$/, 'Lint', /\b[1-9]\d* errors?\b/],
  [/^(vitest|jest|pytest|mocha|playwright|cargo test|go test|claude plugin test|(npm|pnpm|yarn|bun) (test|t|test:\S+))$/, 'Tests', /^\s*(FAIL|FAILED)\b|^\s*[✗×]\s|\b[1-9]\d* (failed|failing|fail)\b|^\(fail\)/],
]
// isLast: the check is the command's last program, so the command's exit code is the check's own
function checkIn(cmd: string): { name: string; fail: RegExp; isLast: boolean } | undefined {
  const progs = progsOf(cmd)
  for (const [i, p] of progs.entries()) for (const [re, name, fail] of CHECK) if (re.test(p)) return { name, fail, isLast: i === progs.length - 1 }
  return undefined
}
export const checkOf = (cmd: string): string | undefined => checkIn(cmd)?.name

// === TOOLS ===
// What kind of effect a tool call has: Look feeds "Files and references", Change adds to the changes, the rest are results
const KIND: [RegExp, string][] = [
  [/^(Bash|PowerShell)$/, 'Shell'], [/^(Read|Grep|Glob|LS|LSP|NotebookRead)$/, 'Look'], [/^(Edit|Write|NotebookEdit)$/, 'Change'],
  [/^Web/, 'Web'], [/^(Agent|SendMessage|ListAgents|SubagentHandback|Task\w*)$/, 'Agent'], [/^Skill$/, 'Skill'], [/^mcp__/, 'MCP'],
  [/^(EnterWorktree|ExitWorktree|ToolSearch|TodoWrite|EnterPlanMode|ExitPlanMode|AskUserQuestion|SendUserMessage|Monitor|Cron\w*|ScheduleWakeup|RemoteTrigger|ReadNotifications|PushNotification)$/, 'Control'],
]
export const kindOf = (tool: string) => KIND.find(([re]) => re.test(tool))?.[1] ?? 'Tool'
const pathOf = (i: any): string => String(i?.file_path ?? i?.notebook_path ?? i?.path ?? '')

// The activity line: what a tool call is doing, in words, present tense. A Bash call's own description says it best
export function doingOf(tool: string, i: any): string {
  const s = (x: unknown) => scrub(oneLine(String(x ?? '')))
  switch (tool) {
    case 'Read': return `Reading ${base(pathOf(i))}`
    case 'Edit': case 'NotebookEdit': return `Editing ${base(pathOf(i))}`
    case 'Write': return `Writing ${base(pathOf(i))}`
    case 'Grep': return `Searching for "${clip(s(i?.pattern), 40)}"`
    case 'Glob': return 'Looking for files'
    case 'Bash': {
      const cmd = String(i?.command ?? '')
      const c = checkOf(cmd)
      return i?.description ? clip(s(i.description), 80) : c ? `Running ${c.toLowerCase()}` : `Running ${progsOf(cmd).at(-1) ?? 'a command'}`
    }
    case 'WebFetch': return `Reading ${s(i?.url).replace(/^https?:\/\//, '').split('/')[0]}`
    case 'WebSearch': return `Searching the web for "${clip(s(i?.query), 40)}"`
    case 'Agent': return `Working with a helper: ${clip(s(i?.description) || 'a task', 60)}`
    case 'Skill': return `Using the ${s(i?.skill)} skill`
    case 'AskUserQuestion': return 'Asking you a question'
    case 'TodoWrite': return 'Updating its plan'
  }
  if (tool.startsWith('mcp__')) { const [, server, name] = tool.split('__'); return `Using ${server}: ${name ?? ''}`.trim() }
  return `Using ${tool}`
}

// === MODEL ===
export const empty = (): SessionModel => ({ prompts: 0, running: false, waits: {}, asking: {}, todos: [], files: [], checks: [], lastEdit: 0, context: {}, est: { conversation: 0, files: 0, results: 0 }, sources: [], compactions: 0, onPlan: false })

const MAX_FILES = 50
const MAX_SOURCES = 40
const MAX_HUNK_LINES = 400 // per file: the diff view shows the change, not a whole generated file

// === REDUCE ===
// One event as the `*` hook saw it. enter: before the chain ran (r undefined); exit: after, with its result
export type Seen = { ev: string; ph: 'enter' | 'exit'; who: string; e: any; r?: any; t: number }

function addSource(m: SessionModel, s: Source) {
  m.sources = [s, ...m.sources.filter(x => x.key !== s.key)].slice(0, MAX_SOURCES)
}
function addFile(m: SessionModel, f: FileChange) {
  const was = m.files.find(x => x.path === f.path)
  const isNew = was ? was.isNew : f.isNew // a file this session created stays New through later edits
  let n = 0
  const hunks = [...(was?.hunks ?? []), ...(f.hunks ?? [])].filter(h => (n += h.lines.length) <= MAX_HUNK_LINES)
  const byShell = f.byShell && (!was || was.byShell) // a tool edit's diff outranks a shell's mention
  m.files = [{ path: f.path, isNew, t: f.t, ...(hunks.length ? { hunks } : {}), ...(byShell ? { byShell: true as const } : {}) }, ...m.files.filter(x => x.path !== f.path)].slice(0, MAX_FILES)
}
const hunksOf = (r: any): Hunk[] => Array.isArray(r?.structuredPatch) ? r.structuredPatch.map((h: any) => ({ oldStart: h.oldStart, newStart: h.newStart, lines: (h.lines ?? []).map((l: string) => scrub(String(l))) })) : []

// The question an AskUserQuestion call puts, with its choices; the dialog stays the only place to answer
export function questionOf(i: any): string {
  const q = Array.isArray(i?.questions) ? i.questions[0] : undefined
  if (!q) return 'Claude has a question for you'
  const opts = Array.isArray(q.options) ? q.options.map((o: any) => o?.label).filter(Boolean) : []
  return scrub(oneLine(`${q.question ?? ''}${opts.length ? ` (${opts.join(' / ')})` : ''}`))
}

// Folds one event into m. Returns whether anything the pane draws changed. Subagent calls (agentId) add changes and
// checks but never move the activity line: that line is the main conversation's
export function reduce(m: SessionModel, x: Seen): boolean {
  const { ev, ph, e, r, t } = x
  if (ev === 'prompt.submit' && ph === 'exit' && x.who === 'you') {
    const text = String(e?.text ?? '').trim()
    if (!text || text.startsWith('/')) return false // a slash command is not a statement of the goal
    m.prompts++
    m.lastPrompt = scrub(text).slice(0, 2000)
    if (!m.goal) m.goal = { title: titleOf(m.lastPrompt), keep: [], from: 'Your opening message', text: m.lastPrompt, isDraft: true }
    m.est.conversation += text.length
    return true
  }
  if (ev === 'turn.start' && ph === 'enter') { m.running = true; m.ended = undefined; m.activity = undefined; return true }
  if (ev === 'turn.complete' && ph === 'enter') {
    if (e?.agentId) return false
    m.running = false; m.waits = {}; m.asking = {}; m.activity = undefined
    m.ended = e?.isAborted ? 'aborted' : e?.reason
    m.est.conversation += String(e?.answer ?? '').length
    return true
  }
  if (ev === 'tool.check' && ph === 'exit' && r?.decision === 'ask' && e?.tool_use_id) {
    m.asking = { ...m.asking, [e.tool_use_id]: { tool: String(e.tool), input: JSON.stringify(e.input), text: `Allow: ${doingOf(String(e.tool), e.input)}?` } }
    return false // nothing drawn yet: the classifier may answer it
  }
  // a permission request no settings hook answered: the dialog opens next. It names the tool and input, not the call,
  // so it matches the asking call with the same input, else the only one asking for that tool
  if (ev === 'classic.PermissionRequest' && ph === 'exit' && !r?.decision && !r?.block) {
    const asks = Object.entries(m.asking)
    const same = asks.filter(([, a]) => a.tool === e?.tool_name)
    const hit = same.find(([, a]) => a.input === JSON.stringify(e?.tool_input)) ?? (same.length === 1 ? same[0] : undefined)
    if (!hit) return false
    const { [hit[0]]: _, ...rest } = m.asking
    m.asking = rest
    m.waits = { ...m.waits, [hit[0]]: hit[1].text }
    return true
  }
  if (ev === 'tool.call') return toolCall(m, x)
  if (ev === 'prompt.context' && ph === 'exit') {
    const files: any[] = r?.instructionFiles ?? e?.instructionFiles ?? []
    for (const f of files) addSource(m, { key: `i:${f.path}`, group: 'instructions', label: String(f.path).split('/').slice(-2).join('/'), note: 'loaded', t })
    return files.length > 0
  }
  if (ev === 'prompt.attachment' && ph === 'exit' && !e?.agentId) return attachment(m, String(e?.type ?? ''), r ? r.text : e?.text, t)
  if (ev === 'session.measure' && ph === 'enter') {
    const c = e?.context ?? {}
    m.context = { percent: c.percent, window: c.window, tokens: c.tokens }
    m.onPlan = Array.isArray(e?.rateLimits) && e.rateLimits.length > 0
    if (typeof e?.cost?.usd === 'number') m.cost = e.cost.usd
    return true
  }
  if (ev === 'session.compact' && ph === 'exit' && !e?.agentId && r && !r.skip && Array.isArray(r.messages) && e?.trigger !== 'precompute') {
    m.compactions++
    // the summary is the first message of what the compaction leaves; there is no separate summary string
    m.summary = scrub(String(r.messages[0]?.text ?? '')).slice(0, 4000) || undefined
    m.est = { conversation: r.messages.reduce((s: number, msg: any) => s + String(msg?.text ?? '').length, 0), files: 0, results: 0 }
    m.sources = m.sources.filter(s => s.key !== 'summary').map(s => s.group === 'files' ? { ...s, note: 'earlier' as const } : s)
    addSource(m, { key: 'summary', group: 'conversation', label: 'Earlier conversation summary', note: 'summary', t })
    return true
  }
  return false
}

function toolCall(m: SessionModel, { ph, who, e, r, t }: Seen): boolean {
  const tool = String(e?.tool ?? '')
  const id = String(e?.tool_use_id ?? '')
  // Claude's own call in the main conversation: only its result is in the context, only it moves the activity line.
  // A subagent's call (agentId) or another plugin's $.tool.call still adds changes and checks
  const main = !e?.agentId && who === 'claude'
  if (ph === 'enter') {
    if (tool === 'AskUserQuestion') m.waits = { ...m.waits, [id]: questionOf(e) }
    if (!main) return tool === 'AskUserQuestion'
    if (tool === 'TodoWrite' && Array.isArray(e?.todos)) m.todos = e.todos.map((d: any) => ({ content: scrub(String(d.content ?? '')), status: d.status, activeForm: scrub(String(d.activeForm ?? '')) }))
    m.activity = doingOf(tool, e)
    return true
  }
  let changed = false
  if (id in m.waits) { const { [id]: _, ...rest } = m.waits; m.waits = rest; changed = true }
  if (id in m.asking) { const { [id]: _, ...rest } = m.asking; m.asking = rest }
  if (!r || r.deny) return changed
  const text = String(r.text ?? '')
  const kind = kindOf(tool)
  if (main && kind === 'Look') m.est.files += text.length
  else if (main) m.est.results += text.length
  if (kind === 'Change' && !r.isError && !r.result?.staged) {
    const path = String(r.result?.filePath ?? pathOf(e))
    if (path) {
      addFile(m, { path, isNew: tool === 'Write' && r.result?.type === 'create', t, hunks: hunksOf(r.result) })
      m.lastEdit = t
      if (main) {
        m.est.files += String(e?.content ?? e?.new_string ?? e?.new_source ?? '').length // what Claude wrote is in the window too
        addSource(m, { key: `f:${path}`, group: 'files', label: path, note: 'full', t })
      }
    }
  }
  if (main && tool === 'Read' && !r.isError) {
    const path = pathOf(e)
    if (path) addSource(m, { key: `f:${path}`, group: 'files', label: path, note: e?.offset != null || e?.limit != null ? 'excerpt' : 'full', t })
  }
  if (tool === 'Bash') {
    const cmd = String(e?.command ?? '')
    const c = checkIn(cmd)
    if (c) {
      const i = insightOf(cmd, text)
      // a pipeline or a `;` list exits with its last program's code: a check piped into tail, or followed by another
      // command, is judged by what its output says instead
      const ok = c.isLast ? !r.isError && !(i.exit && i.exit > 0) : !text.replace(ANSI, '').split('\n').some(l => c.fail.test(l))
      m.checks = [{ name: c.name, ok, line: ok ? '' : i.text, t, cmd: scrub(cmd).slice(0, 200) }, ...m.checks.filter(x => x.name !== c.name)]
    }
  }
  return true
}

// Engine notes about one file, named in their first line: what they say about that file's place in the context
const FILE_NOTE: Record<string, [SourceNote, RegExp]> = {
  edited_text_file: ['changed', /^Note: (.+?) changed on disk/],
  compact_file_reference: ['unrestored', /^Note: (.+?) was read before/],
  read_truncation_notice: ['excerpt', /(\/\S+)/], // the first absolute path the notice names
  file: ['full', /"file_path":"([^"]+)"/],
}
// text undefined: the chain left it out of the request, so it never entered the context
function attachment(m: SessionModel, type: string, text: string | undefined, t: number): boolean {
  if (!text) return false
  if (type === 'nested_memory') {
    m.est.files += text.length
    const p = text.match(/^Contents of (.+?):?$/m)?.[1]
    if (p) addSource(m, { key: `i:${p}`, group: 'instructions', label: p.split('/').slice(-2).join('/'), note: 'loaded', t })
    return !!p
  }
  const n = FILE_NOTE[type]
  if (!n) { m.est.conversation += text.length; return false } // reminders and listings: counted, not listed
  m.est.files += text.length
  const p = text.match(n[1])?.[1]
  if (!p) return false
  addSource(m, { key: `f:${p}`, group: 'files', label: p, note: n[0], t })
  return true
}

// Files a shell command changed, from a list of absolute paths written outside the engine; merged as Edited, since a
// command's edits carry no diff and no create flag. Returns whether any were new to the list
export function mergeShellEdits(m: SessionModel, paths: string[], t: number): boolean {
  let added = false
  for (const p of paths.map(s => s.trim()).filter(s => s.startsWith('/'))) {
    if (m.files.some(f => f.path === p)) continue
    addFile(m, { path: p, isNew: false, t, byShell: true })
    m.lastEdit = Math.max(m.lastEdit, t)
    added = true
  }
  return added
}

// === READINGS ===
export type Status = { kind: 'new' | 'working' | 'input' | 'failed' | 'review' | 'idle'; label: string; detail?: string; next?: string }
const failing = (m: SessionModel) => m.checks.find(c => !c.ok && c.t >= m.lastEdit)

export function statusOf(m: SessionModel): Status {
  const ask = Object.values(m.waits).at(-1)
  if (ask) return { kind: 'input', label: 'Needs your input', detail: ask }
  const doing = m.todos.find(d => d.status === 'in_progress')?.activeForm || m.activity
  const next = m.todos.find(d => d.status === 'pending')?.content // no todo list, no Next: never invent one
  const bad = failing(m)
  if (m.running) return bad ? { kind: 'failed', label: `${bad.name} failed · Claude is investigating`, detail: doing ?? bad.line, next } : { kind: 'working', label: 'Working', detail: doing ?? 'Thinking', next }
  if (!m.prompts && !m.files.length) return { kind: 'new', label: 'Ready when you are' }
  if (bad) return { kind: 'failed', label: `${bad.name} failed · needs your input`, detail: bad.line }
  if (m.ended === 'aborted') return { kind: 'idle', label: 'Stopped', detail: 'You interrupted the last response' }
  if (m.ended === 'error') return { kind: 'idle', label: 'Stopped by an error', detail: 'The last response ended with an error' }
  if (m.ended === 'refusal') return { kind: 'idle', label: 'Stopped', detail: 'Claude declined the last request' }
  // never "Done": a finished turn with changes is work waiting for your review
  if (m.files.length) return { kind: 'review', label: 'Ready for your review', detail: 'Review changes' }
  return { kind: 'idle', label: 'Waiting for you' }
}

// Checks as words: never a blank checkmark
export function checksOf(m: SessionModel): { line: string; stale: boolean } {
  if (!m.checks.length) return { line: m.files.length ? "Checks haven't run yet" : '', stale: false }
  const fresh = m.checks.filter(c => c.t >= m.lastEdit)
  if (!fresh.length) return { line: "Checks haven't run since the last change", stale: true }
  const bad = fresh.filter(c => !c.ok)
  if (bad.length) return { line: `${bad.map(c => c.name).join(', ')} failed`, stale: false }
  return { line: `${fresh.map(c => c.name).join(', ')} passed${fresh.length < m.checks.length ? ' · others not rerun since the last change' : ''}`, stale: false }
}

// Nearly full: past this the pane offers a recap. Set below the point where the engine compacts on its own, so there is
// room to review a recap before a summary happens anyway
export const NEARLY_FULL = 85
export function contextLabel(percent?: number): { label: string; text: string } {
  if (percent == null) return { label: 'Room to begin', text: 'Nothing measured yet: the first response fills this in.' }
  if (percent >= NEARLY_FULL) return { label: 'Nearly full', text: 'Older details will soon be summarised. A recap lets you choose what carries forward.' }
  if (percent >= 50) return { label: 'Filling up', text: 'The conversation and material Claude can use right now.' }
  return { label: 'Plenty of room', text: 'The conversation and material Claude can use right now.' }
}

// The four groups of the expanded bar. Instructions come from the engine's own rows (everything in use but Messages);
// Messages is split by this pane's estimate, then scaled so the three sum to the engine's figure. The gap between the
// unscaled estimate and the engine's Messages row is the confidence shown beside it
export type Segment = { name: string; tokens: number; color: string; isEstimate: boolean }
export const CHARS_PER_TOKEN = 4 // rough for English prose and code; only used to split, never shown as a count
export const CLOSE_ENOUGH = 0.25 // estimate within 25% of the engine's Messages figure reads as "close"
export function segmentsOf(est: Est, rows: readonly { name: string; tokens: number; kind: string }[] | undefined): { segments: Segment[]; confidence: 'close' | 'rough' | 'none'; gap?: number } {
  const used = (rows ?? []).filter(r => r.kind === 'used')
  const msgRow = used.find(r => r.name === 'Messages')
  const instructions = used.filter(r => r !== msgRow).reduce((s, r) => s + r.tokens, 0)
  const raw = [est.conversation, est.files, est.results].map(c => c / CHARS_PER_TOKEN)
  const rawSum = raw.reduce((s, x) => s + x, 0)
  const engine = msgRow?.tokens
  const scale = engine != null && rawSum > 0 ? engine / rawSum : 1
  const [conversation = 0, files = 0, results = 0] = raw.map(x => Math.round(x * scale))
  const segments: Segment[] = [
    { name: 'Instructions', tokens: instructions, color: 'permission', isEstimate: false },
    { name: 'Conversation', tokens: conversation, color: 'claude', isEstimate: true },
    { name: 'Files and references', tokens: files, color: 'suggestion', isEstimate: true },
    { name: 'Tool results', tokens: results, color: 'warning', isEstimate: true },
  ]
  if (!engine) return { segments, confidence: 'none' }
  const gap = Math.abs(rawSum - engine) / engine
  return { segments, confidence: gap <= CLOSE_ENOUGH ? 'close' : 'rough', gap }
}

// === RESTORE ===
// What $.store keeps per session: the model less its diffs (the store is small; a diff is the transcript's to keep)
export const snapshotOf = (m: SessionModel): SessionModel => ({ ...m, files: m.files.map(({ hunks, ...f }) => f), running: false, waits: {}, asking: {}, activity: undefined })

// A resumed session with no snapshot: rebuilt from the transcript. Prompts, tool calls and their stored results, in order;
// what the transcript does not hold (the context fill, permission waits) stays empty until the next event
export function replay(m: SessionModel, msgs: readonly { role: string; text: string; toolUses?: readonly any[]; toolResults?: readonly unknown[] }[]): void {
  let t = 1
  for (const msg of msgs) {
    // a user row that opens with a tag is the engine's (a command's output, a reminder), not something you typed
    if (msg.role === 'user' && !msg.toolResults?.length && msg.text && !/^\s*</.test(msg.text)) reduce(m, { ev: 'prompt.submit', ph: 'exit', who: 'you', e: { text: msg.text }, t: t++ })
    if (msg.role !== 'assistant') continue
    m.est.conversation += msg.text.length
    for (const u of msg.toolUses ?? []) {
      const e = { ...u.input, tool: u.tool, tool_use_id: u.tool_use_id }
      if (u.tool === 'TodoWrite') reduce(m, { ev: 'tool.call', ph: 'enter', who: 'claude', e, t: t++ })
      if (u.text != null || u.result != null) reduce(m, { ev: 'tool.call', ph: 'exit', who: 'claude', e, r: { result: u.result, text: u.text, ...(u.isError ? { isError: true } : {}) }, t: t++ })
    }
  }
  m.activity = undefined
}

// === GOAL ===
// One small-model call per prompt of yours that may set or change the goal. It answers JSON; anything else leaves the
// goal as it was (the first-sentence draft, or the last good answer)
export const GOAL_SYSTEM = `You keep a one-line statement of what a person is trying to get done in a coding session with an AI assistant.
Answer with JSON only: {"changed": boolean, "title": string, "keep": string[], "done": string}.
- changed: true when this message sets the goal or replaces it; false when it only continues, answers a question, or adds detail.
- title: the goal in at most 6 words, sentence case, no full stop. When changed is false, repeat the current title.
- keep: constraints or preferences stated in THIS message only (e.g. "No new dependencies"), each under 8 words; [] if none.
- done: one short sentence saying what finished looks like; "" if unclear.`

export function goalPrompt(m: SessionModel, text: string): string {
  const now = m.goal && !m.goal.isDraft ? `Current goal: ${m.goal.title}\n` : m.goal && m.prompts > 1 ? `Current goal (draft): ${m.goal.title}\n` : 'There is no goal yet: this is the opening message.\n'
  return `${now}\nThe person's message:\n<message>\n${text.slice(0, 4000)}\n</message>`
}

// Folds the small model's reply into the goal. from: which message it was ("Your opening message", "Your message 3").
// Returns whether the goal changed
export function applyGoal(m: SessionModel, reply: string, text: string, from: string): boolean {
  let j: any
  try { j = JSON.parse(reply.match(/\{[\s\S]*\}/)?.[0] ?? '') } catch { return false }
  if (!j || typeof j.title !== 'string' || !j.title.trim()) return false
  const keep = (Array.isArray(j.keep) ? j.keep : []).filter((k: unknown) => typeof k === 'string' && k.trim()).map((k: string) => ({ text: scrub(clip(k.trim(), 80)), from }))
  const title = scrub(clip(j.title.trim().replace(/\.$/, ''), 60))
  const done = typeof j.done === 'string' && j.done.trim() ? scrub(clip(j.done.trim(), 200)) : undefined
  if (!m.goal || m.goal.isDraft || j.changed === true) {
    const opening = !m.goal || m.goal.isDraft
    m.goal = { title, keep: [...(opening ? [] : m.goal?.keep ?? []), ...keep], done: done ?? m.goal?.done, from: opening ? m.goal?.from ?? from : from, text: opening ? m.goal?.text ?? text : scrub(text).slice(0, 2000), isDraft: false }
    return true
  }
  if (!keep.length) return false
  m.goal = { ...m.goal, keep: [...m.goal.keep, ...keep.filter((k: { text: string }) => !m.goal!.keep.some(x => x.text.toLowerCase() === k.text.toLowerCase()))] }
  return true
}

// What the pane holds that a summary can drop: the goal and the files changed, folded from events, so a recap drafted
// after an earlier compaction still names them. '' when there is nothing yet
export function recapNotes(m: SessionModel): string {
  const g = m.goal
  return [
    ...(g ? [`Goal: ${g.title}`, ...g.keep.map(k => `Keep in mind: ${k.text}`), ...(g.done ? [`Done when: ${g.done}`] : [])] : []),
    ...(m.files.length ? ['Files changed:', ...m.files.map(f => `- ${f.path}${f.isNew ? ' (new)' : ''}`)] : []),
  ].join('\n')
}
