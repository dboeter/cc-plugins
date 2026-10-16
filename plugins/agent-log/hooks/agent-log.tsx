import type { AgentInfo, ModelUsage, Register, Timer, ToolInfo, TurnStepResult } from 'claude-code'

// Deliberately single-file: every hook and the pane read and mutate the module-level state (entries, seen, owed, chain, the
// view and expansion state), so a split would pass that state across modules. Sections, in order (search `// ===`):
// ENTRIES AND TEXT, HOOK NAMES, ROWS, STATE AND STORE, HOOKS, PANE

// === ENTRIES AND TEXT ===
type Src = 'engine' | 'hook' | 'plugin' // who authored injected text: the engine's own framing, a settings hook, or a plugin chain; only engine entries fold
// agent: the loop's agentId, absent on main. bytes: injected size (kept, not shown for now). ms: tool run time, minus its wait.
// wait/waitFor: on a tool row, the time between tool.check's verdict and the engine's decision, and what it waited on
// type: the engine's attachment kind or context-block name, kept beside the readable `name`. origin: the settings hook event that produced the text or, on a hook row, ran the hook (its trigger; `name` is then the hook's own name).
// cmd: a Bash call's full scrubbed command, shown in the inspector while the row shows its description.
// check/rule: tool.check's verdict on a tool call and the settings rule that decided it, as written (`Bash(git push:*)`); no rule = a mode, hook or the tool's own check
// via: who settled the call, as the collector's tool_decision names it (`config`, `hook`, `user_temporary`, `user_reject`); only with OTEL export on
// peek: the first PEEK chars of the injected text, error, or deny/block reason, secret-scrubbed; never the person's typed prompt
// turn: the number of your prompt the entry followed (`#N` = since your Nth prompt; 0 = before your first, drawn `start`); a subagent's entries carry the same number. Absent on entries from before turns were counted
// status: a tool call's result as data, so views and folds never parse the `outcome` label; entries from before it derive one (stat).
// exit/insight: a failed call's exit code and its output boiled down (insightOf)
// child: on an Agent row, the id of the agent it spawned; that agent's rows fold under it (rootOf)
// use: the tool_use_id of the call a row belongs to: on a tool row, and on its PreToolUse/PostToolUse hook rows and their text, which fold under it
// again: hook text the session already logged word for word (a plugin's tip on every call), or a cwd change back to where the session began: ranked info
type Status = 'ok' | 'failed' | 'denied' | 'blocked' | 'feedback' | 'stopped' | 'aborted' | 'nomatch'
// fork: a plugin's $.model.fork, logged under main; name is the plugin, outcome its token cost, peek its reply or why it has none
// step: one model request (turn.step); name is the model the request named, peek the start of its reply. step: on a step row its
// own key, on a tool row the request that asked for the call. effort as requested; ttft: ms to the first streamed thinking, text
// or call; think: ms spent thinking; stop: the API's stop reason; tok: [uncached in, cache read, cache write, out]; asked: the
// tools it called; server: the calls the API ran itself (the advisor) and their ms; thought: its thinking's first line;
// cost/req: the collector's price and request id for it, when OTEL export is on
// split: on main's turn row, where its time went as splitOf counts it, kept so evicting the turn's rows does not lose it
// out: on a tool row, the place outside the session's project root the call reached (outsideOf), `~`-shortened; absent inside it
// event: something the engine reports happening (eventOf, harnessOf): name is what (`model switch`, `API error`), detail and outcome
// its particulars. side: a model request outside the turns: the engine's own (src engine, name its query source: a title, a
// prompt suggestion, compaction) or a plugin's $.model.complete (src plugin, name the plugin); detail is the model
type Entry = { t: number; turn?: number; kind: 'tool' | 'hook' | 'session' | 'prompt' | 'turn' | 'fork' | 'step' | 'event' | 'side'; name: string; detail: string; outcome: string; status?: Status; src?: Src; bytes?: number; agent?: string; ms?: number; type?: string; origin?: string; peek?: string; cmd?: string; check?: 'allow' | 'ask' | 'deny'; rule?: string; exit?: number; insight?: string; child?: string; use?: string; wait?: number; waitFor?: string; again?: boolean
  via?: string; step?: string; effort?: string | number; ttft?: number; think?: number; stop?: string; tok?: number[]; asked?: string[]; server?: [string, number | null][]; thought?: string; cost?: number; req?: string; split?: number[]; out?: string }

const PANE = 'agent-log'
// a block after the fact refuses nothing: PostToolUse's tool already ran and Stop's turn already ended, so the hook's text is
// feedback the model reads next (lint-feedback's lint errors), not a refusal
const FEEDBACK = new Set(['PostToolUse', 'PostToolUseFailure', 'PostToolBatch', 'Stop', 'SubagentStop'])
const stat = (x: Entry): Status => x.status ?? (x.outcome === 'deny' ? 'denied' : x.outcome === 'error' ? 'failed' : x.outcome.startsWith('block') ? (FEEDBACK.has(x.origin ?? '') ? 'feedback' : 'blocked') : x.outcome === 'stop' ? 'stopped' : x.outcome === 'aborted' ? 'aborted' : 'ok')
const BAD = new Set<Status>(['failed', 'denied', 'blocked', 'stopped']) // shown red and ranked error (lvl)
const loud = (x: Entry) => BAD.has(stat(x)) || stat(x) === 'feedback' // a hook row that refused its call or answered it
const num = (t: number) => t < 1000 ? String(t) : `${(t / 1000).toFixed(1)}k`
const toks = (t: number) => `${num(t)} tok`
// a loop's token cost. input_tokens is only the uncached tail: a fork re-sends main's whole transcript, mostly from the cache
export const costOf = (u?: ModelUsage) => u ? `${toks(u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens)} in · ${toks(u.output_tokens)} out` : ''
const tok = (n: number) => toks(Math.round(n / 4)) // ponytail: chars/4, no tokenizer in the plugin API; ±20% on prose
const kb = (n: number) => `~${tok(n)}`
const scrub = (s: string) => s.replace(/(bearer\s+|\b\w*(token|secret|password|passwd|api[_-]?key)\w*[=:]\s*|--?(password|token|api-key)[= ]|:\/\/[^:\/\s]+:)[^\s@'"]+/gi, '$1***') // ponytail: best-effort secret scrub, not a guarantee
const SESSIONS = 10 // was 20 before step rows: a step row runs to ~800 bytes (reply peek, thought, tokens), so 10 x 300 rows stays under the store's 4 MiB cap
const PEEK = 300 // chars of text kept per entry
const peek = (s: unknown): string | undefined => typeof s === 'string' && s.trim() ? scrub(s.trim()).slice(0, PEEK) : undefined
const noCd = (s: string) => s.replace(/^\s*cd\s+\S+\s*(&&|;)\s*/, '') // a Bash command minus its leading `cd <dir> &&` / `;`
const first = (s?: string) => (s ?? '').split('\n').find(l => l.trim())?.trim() ?? ''
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// a hook's text minus its own name, which the row already shows: most hooks print it, as a header line
// (`Preflight (preflight-context hook):`) or a prefix (`install-check: 1 problem`), and hookName picks names that way
// The engine's framing goes first (`PreToolUse:Bash hook error: [$HOME/…/guard.sh]: `), and lines that are only an XML tag
// (`<context_guidance>`): neither says anything. Nothing left -> '', and the row reads by the hook's name alone
const FRAME = /^\w+(:\S+)? hook [^:\n]*:\s*(\[[^\]\n]*\]:\s*)?/
const said = (x: Entry): string => {
  const names = x.name.split(', ')
  const ls = (x.peek ?? '').split('\n').map(l => l.trim().replace(FRAME, '').trim()).filter(l => l && !/^<\/?[\w-]+>$/.test(l))
  const top = ls[0] ?? ''
  if (ls.length > 1 && top.endsWith(':') && names.some(n => top.toLowerCase().includes(n.toLowerCase()))) ls.shift()
  return names.reduce((s, n) => s.replace(new RegExp(`^${esc(n)}\\s*:\\s*`, 'i'), ''), ls[0] ?? '')
}

// A failed call's output boiled down before the PEEK cap: the program, its error count, the lines that say what broke.
// tool.call sees the whole text, so this beats the raw first 300 chars, which are often a command echo or a progress bar
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g
const NOISE = /^\s*(npm (ERR!|error)\s*$|npm (ERR!|error) (code|path|errno|syscall|signal|command|cwd|A complete log|Lifecycle)|at .*(node_modules|node:internal)|[\d.]+%|.*[█░▓▒]{3}|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏])/i
const ERRLINE = /(error|exception)\b|\b(fatal|fail(ed|ure)?|panic|denied|rejected|conflict|not found|no such file|cannot|unable)\b|TS\d{4}/i // no \b before error: KeyError, TypeError
const QUIET = new Set(['grep', 'rg', 'diff', 'cmp', 'test', '[']) // exit 1 from these means "no match" or "differs", not broke
const WRAP = new Set(['sudo', 'npx', 'bunx', 'exec', 'time', 'env', 'nice', 'timeout'])
const progOf = (seg: string) => { // `FOO=1 timeout 30 npx tsc -p .` -> tsc; `npm run test` -> npm test
  const w = seg.trim().split(/\s+/).filter(t => t && !/^\w+=/.test(t))
  while (w.length > 1 && (WRAP.has(w[0]!) || /^\d+[smh]?$/.test(w[0]!))) w.shift()
  const p = (w[0] ?? '').split('/').pop() ?? ''
  return /^(npm|pnpm|yarn|bun)$/.test(p) && w[1] && !w[1].startsWith('-') ? `${p} ${w[1] === 'run' ? w[2] ?? 'run' : w[1]}` : p
}
function insightOf(cmd: string | undefined, raw: string): { exit?: number; quiet: boolean; text: string } {
  const m = raw.match(/^Exit code (\d+)/m) // the Bash tool's error text leads with it
  const exit = m ? Number(m[1]) : undefined
  const lines = raw.replace(ANSI, '').split('\n').map(l => l.trimEnd()).filter(l => l.trim() && !/^Exit code \d+$/.test(l.trim()) && !NOISE.test(l))
  const progs = cmd ? noCd(cmd).split(/&&|\|\||[;|\n]/).map(progOf).filter(Boolean) : []
  const last = progs.at(-1) // a pipeline exits with its last command's code
  const quiet = exit === 1 && !!last && QUIET.has(last) && !lines.some(l => ERRLINE.test(l))
  const known = progs.find(p => /^(vue-tsc|tsc|vitest|jest|pytest|git|cargo|go|eslint)$|test$/.test(p)) ?? last ?? ''
  let head = known
  let pick: string[] = []
  const ts = lines.filter(l => /error TS\d+/.test(l))
  if (ts.length) {
    const files = new Set(ts.map(l => l.split('(')[0]))
    head = `${known || 'tsc'} · ${ts.length} error${ts.length > 1 ? 's' : ''} in ${files.size} file${files.size > 1 ? 's' : ''}`
    pick = ts.map(l => l.replace(/^[^(]*\//, '').replace(/:\s*error (TS\d+):\s*/, '  $1 ')) // `src/x.ts(4,7): error TS2322: msg` -> `x.ts(4,7)  TS2322 msg`
  } else if (/test|vitest|jest|pytest/.test(known)) pick = lines.filter(l => /^\s*(FAIL|FAILED|✗|×|●)\s|\b\d+ failed\b/.test(l))
  else if (known === 'git') pick = lines.filter(l => /^(fatal|error):|\[rejected\]|^CONFLICT/.test(l))
  if (!pick.length) pick = lines.filter(l => ERRLINE.test(l))
  if (!pick.length) pick = lines.slice(-3) // errors land at the end more often than at the start
  return { exit, quiet, text: scrub([head, ...pick.slice(0, 3).map(l => l.trim())].filter(Boolean).join('\n')).slice(0, PEEK) }
}

// === HOOK NAMES ===
// A hook's name, from settings and the enabled plugins' hooks.json: the engine says which event ran but merges every hook on it,
// so the name is inferred. Candidates are the event's hooks whose matcher fits the target. With no text, every candidate ran and
// said nothing, so all are named. A settings hook names itself in its text's first line (hooks/CLAUDE.md), a plugin's hook maybe
// anywhere; text is credited to the candidates it names that way. Text naming none is a plugin hook's, or with one candidate that
// one's. Else the event's, as a guess
type HookCfg = Record<string, { matcher: string; name: string; plugin?: boolean }[]>
let hookCfg: HookCfg | undefined
let enabled: string[] = [] // the plugins settings enable (`name@marketplace`): the setup's plugin list where no plugin_loaded record came
const scriptName = (h: any): string => {
  const cmd = String(h?.command ?? '')
  return cmd.match(/([\w.-]+)\.(sh|py|js|mjs|ts|rb|pl)\b/)?.[1] ?? cmd.split(/\s+/)[0]?.split('/').pop() ?? String(h?.type ?? 'hook')
}
async function hooksOf($: any): Promise<HookCfg> {
  if (hookCfg) return hookCfg
  const cfg: HookCfg = {}
  const add = (hooks: any, plugin?: string) => {
    for (const [ev, groups] of Object.entries<any>(hooks ?? {})) for (const g of Array.isArray(groups) ? groups : []) for (const h of g?.hooks ?? []) (cfg[ev] ??= []).push({ matcher: String(g?.matcher ?? ''), name: plugin ?? scriptName(h), plugin: !!plugin })
  }
  let s: any
  try { s = await $.settings.read(); add(s?.hooks); enabled = Object.entries(s?.enabledPlugins ?? {}).filter(([, on]) => on).map(([id]) => id) } catch {}
  // a plugin's command hooks run in the same classic chain; named by the plugin (`context-mode`), not their scripts (`pretooluse`)
  try {
    const installed = JSON.parse(await $.fs.read(`${await $.env.get('HOME')}/.claude/plugins/installed_plugins.json`))?.plugins ?? {}
    for (const [id, on] of Object.entries(s?.enabledPlugins ?? {})) if (on) for (const i of installed[id] ?? []) try { add(JSON.parse(await $.fs.read(`${i.installPath}/hooks/hooks.json`))?.hooks, id.split('@')[0]) } catch {}
  } catch {}
  return hookCfg = cfg
}
const fits = (matcher: string, target?: string) => {
  if (!matcher || matcher === '*' || target == null) return true
  try { return new RegExp(`^(?:${matcher})$`).test(target) } catch { return true }
}
// '' = no hook fits: the event ran its chain, but no hook of yours or a plugin's
export const hookName = (cfg: HookCfg, event: string, target?: string, text?: string): string => {
  const fit = (cfg[event] ?? []).filter(h => fits(h.matcher, target))
  const names = (hs: typeof fit) => [...new Set(hs.map(h => h.name))]
  if (!text?.trim()) return names(fit).join(', ')
  const has = (s: string) => (n: string) => new RegExp(`(^|[^\\w-])${esc(n)}([^\\w-]|$)`).test(s) // whole name: `guard` must not match `contract-guard`
  // the first line past the engine's framing (`SessionStart:clear hook success: `), its paths cut to file names: test-gate's
  // `[…/hooks/guard/test-gate.sh]: test-gate: …` (pre-2026-10 layout) must not name guard. Lines below can quote other hooks (a file list, a summary)
  const head = first(text.trim().replace(FRAME, '')).replace(/\S*\//g, '')
  const own = names(fit.filter(h => !h.plugin)).filter(has(head))
  if (own.length) return own.join(', ')
  const plugins = names(fit.filter(h => h.plugin))
  const said = plugins.filter(has(text))
  if (said.length) return said.join(', ')
  // `PostToolUse hook modified <file> after your edit`: the engine's own notice, framed as the event's hook
  const plugin = head.startsWith(`${event} hook `) ? [] : plugins
  return (plugin.length ? plugin : names(fit).length === 1 ? names(fit) : [`${event} hook`]).join(', ')
}

// === ROWS ===
// readable names for the engine's attachment kinds; an unknown kind shows with its underscores turned to spaces
const LABEL: Record<string, string> = {
  hook_success: 'output', hook_additional_context: 'context', hook_system_message: 'message', hook_blocking_error: 'block', // the ⚑ icon says hook
  skill_listing: 'skill list', deferred_tools_delta: 'tool list', deferred_tools_record: 'tool list', agent_listing_delta: 'agent list', mcp_instructions_delta: 'MCP instructions',
  // claudeMd/instructions carry every CLAUDE.md, rules/*.md, @import and MEMORY.md together, not one file
  claudeMd: 'memory files', instructions: 'memory files', nested_memory: 'nested CLAUDE.md', queued_command: 'queued prompt', edited_text_file: 'file changed on disk', file: 'mentioned file',
  total_tokens_reminder: 'token budget', output_style: 'style reminder', output_style_instructions: 'output style', plan_mode: 'plan mode', plan_mode_exit: 'plan mode exit', auto_mode: 'auto mode',
  todo_reminder: 'todo reminder', date: 'date', environment: 'environment', sandbox_instructions: 'sandbox rules', session_context: 'user context', // not the session-context hook: the engine's email and git status
  plan_file_reference: 'plan file', invoked_skills: 'earlier skills',
  currentDate: 'date', userEmail: 'email', attachedProject: 'project', // first-message block keys, camelCase
}
const label = (type: string) => LABEL[type] ?? type.replace(/_/g, ' ')
// per-turn chatter that drowned the log (>half of all entries): ranked debug (lvl), so hidden at the default level
const DEBUG_ATTACHMENTS = new Set(['total_tokens_reminder', 'output_style', 'silent_turn_reminder'])
// first-message blocks the engine sends as attachments, not as themselves (read from 2.1.296): email and project inside
// `session_context` (beside git status, which has no block), the date as `date`. The attachment row carries the size
const SENT_AS_ATTACHMENT = new Set(['userEmail', 'attachedProject', 'currentDate'])
const STATUS: Record<string, [string, string?]> = { running: ['●', 'yellow'], completed: ['✓', 'green'], failed: ['✗', 'red'], killed: ['■'] } // no color = dim
const TEAM = 'team' as const // pseudo node: header over main's direct teammate children
const SLOW = 1000 // ms: a classic hook this slow logs even when it changed nothing
// slow enough to flag ⚠. SessionStart is exempt: its hooks set the session up once and take seconds every time (context-mode's
// 1.7-2.9 s), so a ⚠ on every session's first rows would teach you to read past the ⚠ on a slow ConfigChange
const slow = (x: Entry, ms = x.ms) => x.kind === 'hook' && ms != null && ms >= SLOW && x.origin !== 'SessionStart'
const ago = (ms: number) => { const s = Math.floor(ms / 1000); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${Math.floor(s / 3600)}h${String(Math.floor(s / 60) % 60).padStart(2, '0')}m` }

let keep = 300
let entries: Entry[] = []
let turnNo = 0 // your prompts so far (0: the session's start, before your first): only your own submissions count, not notifications, peers, schedules or plugins
let pending = 0 // prompts typed while a turn ran: counted when that turn ends, so its last rows keep their number
const OWN = new Set(['composer', 'bridge', 'sdk']) // PromptOrigin kinds that are the person's own prompt
let key = '' // this session's store key; one per session so concurrent sessions never clobber each other
let inspect: Entry | undefined // the entry shown in full; set, the pane draws it in place of the log (a second pane cannot take the keys from this one)
let page: 'setup' | undefined // the setup page, drawn in place of the log as the inspector is
let pageBack = false // the inspector opened from the setup page: back returns to the page, not the log
// The session's setup as the hooks saw it, for the setup row and page, in memory only: the engine's version and tools (asked at
// session.start), the main loop's last model and effort (its steps), the permission mode (every classic event carries it), usage
// (session.measure), and from the collector, with OTEL export on: the plugins the engine loaded and the MCP servers it connected
// (records at startup), and per hook event the settings hooks' runs, the silent ones included (hook_execution_complete). bg: the
// background tasks and crons still in flight when main's last turn ended (Stop): TaskCreated/Completed rows log their lives
type Setup = { version?: string; model?: string; effort?: string | number; mode?: string; cost?: number; limits: { kind: string; percentUsed: number; resetsAt?: string }[]
  bg?: { tasks: { type: string; status: string; description: string; command?: string }[]; crons: { schedule: string; recurring: boolean; prompt: string }[] }
  context?: { tokens?: number; window: number; percent?: number }; tools?: ToolInfo[]; asked?: boolean
  plugins: Map<string, { version?: string; scope?: string; hooks?: boolean; mcp?: boolean }>; mcp: Map<string, { status: string; ms?: number; transport?: string; error?: string }>
  runs: Map<string, { n: number; ms: number; errors: number; cancelled: number }>; runsOf?: string } // runsOf: the session id the runs count for
const setup: Setup = { limits: [], plugins: new Map(), mcp: new Map(), runs: new Map() }
// what the API alone answers: asked once at session.start (a reload's included), and by the first draw where none ran
async function refreshSetup($: any): Promise<void> {
  setup.asked = true
  try { setup.version = (await $.session.version())?.version } catch {}
  try { setup.model ??= await $.session.model() } catch {}
  try { setup.tools = await $.tool.list() } catch {}
  try { await hooksOf($) } catch {}
}
let homeDir: string | undefined // HOME, kept once an answer came: the `~` of the places calls reach
const homeOf = async ($: any): Promise<string | undefined> => homeDir ??= await $.env.get('HOME').catch(() => undefined)
// a row's id, stable while its entry lives: an index into the log shifts each time a full log evicts its oldest row
const ids = new WeakMap<Entry, number>()
let seq = 0
const idOf = (x: Entry) => ids.get(x) ?? (ids.set(x, ++seq), seq)
let expanded = new Set<number>() // expanded groups, keyed by the id of their first entry; kept across views, levels and filters
let backTo: Entry | undefined // the entry whose row opened the inspector: back scrolls to that row rather than to the end
let showDone = false // finished agents drawn in the tree rather than counted
let legend = false
let busy = false // main's turn is running: the header counts its time up
// The pane scrolls its own rows under a header that never moves: the engine's window stays at the top (ui.scroll) and the log
// draws rows win..win+avail. winMax is the last render's, for the scroll hook; backKey is the row back centres on
let win = 0, winMax = 0
let backKey: string | undefined
// a row that opened or closed a fold, and its line in the window: the next draw keeps it on that line rather than pinning the end
let anchor: { k: string; off: number } | undefined
let follow = true // auto-scroll to the newest entry; off once the person scrolls up, on again at the bottom or via the jump button
let fresh = 0 // entries logged while not following: the jump button's "N new events"; the render zeroes it once following again
let chain: Promise<void> = Promise.resolve() // all store mutations run one after another, so no write lands a stale snapshot
let only: string | undefined // agent filter: an agent id, 'main', or undefined for every loop
// A row reads: disclosure, action, tool (muted), then one right cell (fixed width, so the action truncates first): the time.
// A flag rides in front of the time in its color: red ✗ = refused or broke, cyan ↩ = a hook's feedback, amber ⚠ = slow or
// aborted, muted ∅ = found nothing (grep/diff exit 1). No time (a denied call never ran) -> the status word stands in for it.
// Derived at draw time so stored entries relabel too. Injected text shows no size for now (`+N tok` was a chars/4 guess)
const cell = (x: Entry, ms = x.ms): [string, string?] => {
  const s = stat(x), time = ms == null ? undefined : secs(ms)
  return BAD.has(s) ? [`✗ ${time ?? s}`, 'red'] : s === 'feedback' ? [`↩ ${time ?? s}`, 'cyan'] : s === 'aborted' ? [`⚠ ${time ?? s}`, 'yellow'] : s === 'nomatch' ? [`∅ ${time ?? 'no match'}`]
    : slow(x, ms) ? [`⚠ ${time}`, 'yellow']
    : [time ?? (x.kind === 'tool' || x.kind === 'hook' ? '—' : '')]
}
const secs = (ms?: number) => ms == null ? '—' : `${(ms / 1000).toFixed(1)} s` // one unit everywhere; unknown is —, never a guess
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
// `claude-opus-5-5[1m]` -> `Opus 5.5`, `claude-opus-4-20250514` -> `Opus 4`, `claude-3-5-sonnet-20241022` -> `Sonnet 3.5`;
// an id of no known shape (a gateway's alias) as named. (?!\d): a date suffix is no minor version
export const modelName = (id: string) => {
  const m = id.match(/claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?!\d)/)
  if (m) return `${cap(m[1]!)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
  const o = id.match(/claude-(\d+)(?:-(\d))?-([a-z]+)/)
  return o ? `${cap(o[3]!)} ${o[1]}${o[2] ? `.${o[2]}` : ''}` : id
}
// a step's result: cut off at the output limit reads ⚠ like an interrupt; a refusal, a full context window or no response at all, ✗
const stepStatus = (stop: string | null | undefined): Status => stop === 'max_tokens' ? 'aborted' : stop === 'refusal' ? 'denied' : stop === 'model_context_window_exceeded' || stop == null ? 'failed' : 'ok'
const STOPPED: Record<string, string> = { max_tokens: 'Cut off at the output limit', refusal: 'Refused', model_context_window_exceeded: 'Context window full' }
// the engine's own requests by query source; the frequent ones rank debug: a prompt suggestion after most turns, a running agent's progress summary
const SIDE: Record<string, string> = { prompt_suggestion: 'prompt suggestion', agent_summary: 'agent progress summary', generate_session_title: 'session title', web_search_tool: 'web search', side_question: 'side question', compact: 'compaction' }
const CHATTER = new Set(['prompt_suggestion', 'agent_summary', 'generate_session_title'])
// an `ask` settled, by the collector's decision source
const VIA: Record<string, string> = { user_temporary: 'you allowed it once', user_permanent: 'you allowed it from now on', user_reject: 'you rejected it', user_abort: 'you interrupted it', hook: 'a PermissionRequest hook decided', config: 'your settings decided', classifier: 'the auto-mode classifier decided' }
// auto mode's classifier refusing a call: the error result the model reads instead of the call's output
const CLASSIFIED = /^Permission for this action was denied by the Claude Code auto mode classifier/
// the error results a refused call returns: a denied permission prompt (or one no one could answer, headless), you rejecting it,
// the classifier, the guard on the session's working directories. Read from the text too: without OTEL export no decision record
// comes, and a refusal's record can come late
const DENIED = /^(Permission to use \S+ has been denied|The user doesn't want to proceed with this tool use|Permission for this action was denied|\S+ in '[^']*' was blocked\. For security)/
// why it was refused: the first sentence (past it, advice to the model); the guard's, with the rule it applied but not the directories
const deniedWhy = (s: string) => /was blocked\. For security/.test(s) ? s.replace(/:\s*'[\s\S]*$/, '') : s.split(/(?<=\.)\s/)[0]!
const classifierWhy = (s: string) => { const m = /Reason: (?:\[([^\]\n]+)\]|([^.\n]+))/.exec(s); return `the auto-mode classifier refused it${m ? `: ${(m[1] ?? m[2])!.trim()}` : ''}` }
// what an event row means, for its inspector
const EVENT_WHAT: Record<string, string> = {
  'model switch': 'The session\'s model changed. Unless the prompt cache was warm, the next request writes it again', 'turn failed': 'The API ended the turn with an error',
  compacted: 'The conversation was summarized to free context; the time is from PreCompact to PostCompact', 'settings changed': 'A settings file changed while the session ran',
  'directory added': 'A directory joined the session\'s working directories', 'worktree created': 'A git worktree was created', 'worktree removed': 'A git worktree was removed',
  'MCP question': 'An MCP server asked you for input', 'MCP answer': 'Your answer to an MCP server\'s question', command: 'A slash command expanded into the prompt',
  'task created': 'A task joined the team\'s list', 'task completed': 'A task on the team\'s list was completed', 'teammate idle': 'A teammate is waiting for work',
  notification: 'Claude Code notified you', 'file changed': 'A file a hook watches changed', setup: 'Claude Code ran its setup', mode: 'The permission mode changed',
  'MCP connected': 'An MCP server connected; the time is how long it took', 'MCP failed': 'An MCP server failed to connect', 'MCP disconnected': 'An MCP server closed its connection: at the session\'s end, or a server that stopped', 'API error': 'A model request failed; the engine may have retried it',
}
const QUIET_EVENTS = new Set(['notification']) // Claude Code telling you it waits: the call's wait line and the turn's end already say so
// The collector's records that report what no hook sees: a permission mode change, an MCP server connecting or failing, a failed
// API request, the engine's own model requests outside the turns. A record of main's or a subagent's request belongs to its step
// (turn.step) and is not repeated; `sdk` is a headless session's main loop
export const harnessOf = (event: string, a: Record<string, any>): Omit<Entry, 't'> | undefined => {
  if (event === 'permission_mode_changed') return { kind: 'event', name: 'mode', detail: `${a.from_mode} → ${a.to_mode}`, outcome: String(a.trigger ?? '') }
  if (event === 'mcp_server_connection') {
    // `disconnected`: a server closing, at the session's end or mid-session; its duration is how long it was connected, not a wait
    if (a.status === 'disconnected') return { kind: 'event', name: 'MCP disconnected', detail: String(a.server_name ?? ''), outcome: String(a.transport_type ?? ''), status: 'ok', peek: Number(a.duration_ms) ? `connected for ${secs(Number(a.duration_ms))}` : undefined }
    const ok = a.status === 'connected'
    return { kind: 'event', name: ok ? 'MCP connected' : 'MCP failed', detail: String(a.server_name ?? ''), outcome: String(a.transport_type ?? ''), status: ok ? 'ok' : 'failed', ms: Number(a.duration_ms) || undefined, peek: ok ? undefined : peek(String(a.error ?? a.status ?? '')) }
  }
  if (event === 'api_error') return { kind: 'event', name: 'API error', detail: [a.status_code, a.error].filter(v => v != null && v !== '').join(' '), outcome: a.attempt ? `attempt ${a.attempt}` : '', status: 'failed', ms: Number(a.duration_ms) || undefined, peek: peek(String(a.error ?? '')) }
  const q = String(a.query_source ?? '').replace(/:.*/, '')
  if (event === 'api_request' && q && q !== 'repl_main_thread' && q !== 'agent' && q !== 'sdk') return { kind: 'side', name: q, src: 'engine', detail: String(a.model ?? ''), outcome: '', status: 'ok', ms: Number(a.duration_ms) || undefined,
    tok: [a.input_tokens, a.cache_read_tokens, a.cache_creation_tokens, a.output_tokens].map(n => Number(n) || 0), cost: Number(a.cost_usd) || undefined, req: typeof a.request_id === 'string' ? a.request_id : undefined }
  return undefined
}
const counted = (ns: string[]) => [...new Set(ns)].map(n => { const k = ns.filter(m => m === n).length; return k > 1 ? `${n} ×${k}` : n }).join(', ') // `Read ×3, Bash`
// `9.1k in (9.0k cached, 0.1k written) · 50 out`: in counts every input token, as costOf does
const tokLine = ([i = 0, r = 0, w = 0, o = 0]: number[]) => `${num(i + r + w)} in (${num(r)} cached, ${num(w)} written) · ${num(o)} out`
// items of these widths, two cells apart, into rows of at most `room`, in order: each row the items' indexes. One too wide for
// any row gets a row of its own
export const pack = (ws: number[], room: number): number[][] => {
  const out: number[][] = []
  let used = 0
  ws.forEach((n, i) => { if (out.length && used + 2 + n <= room) { out[out.length - 1]!.push(i); used += 2 + n } else { out.push([i]); used = n } })
  return out
}
const base = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p
// a path made absolute against cwd, ~ and $HOME expanded, . and .. folded; undefined where another variable, or ~ and no home, is left
const absOf = (p: string, cwd: string, home?: string): string | undefined => {
  let s = p.replace(/^(["'])(.*)\1$/, '$2')
  const h = /^(~|\$HOME|\$\{HOME\})(?=\/|$)/.exec(s)
  if (h) { if (!home) return undefined; s = home + s.slice(h[0].length) }
  if (s.includes('$')) return undefined
  const parts: string[] = []
  for (const x of (s.startsWith('/') ? s : `${cwd}/${s}`).split('/')) if (x === '..') parts.pop(); else if (x && x !== '.') parts.push(x)
  return '/' + parts.join('/')
}
const under = (p: string, dir: string) => { const d = dir.replace(/\/+$/, ''); return p === d || p.startsWith(d + '/') }
const tilde = (p: string, home?: string) => home && under(p, home) ? '~' + p.slice(home.replace(/\/+$/, '').length) : p
const CD = /^\s*cd\s+("[^"]*"|'[^']*'|\S+)\s*(?:&&|;|$)/ // a Bash command's leading `cd <dir>`, alone or before `&&` / `;`
const PATHS = /(?:^|[\s"'=(])((?:~|\$HOME|\$\{HOME\})?\/[^\s"'|;&<>()`]+)/g // the absolute and home paths a command names
// Where a call reached outside the session's project root, `~`-shortened: a file tool's folder (Grep's and Glob's path as given,
// else the loop's cwd); for Bash its leading `cd`'s folder, else the cwd, else the first path its command names under your home.
// From a command's words only paths under home count: /tmp, /usr and /dev are scratch and system files, not work elsewhere, and
// a word need not be a path. undefined: inside the root, or not known (no path, a variable left in it)
export const outsideOf = (tool: string, a: { path?: string; cmd?: string }, root: string, cwd: string, home?: string): string | undefined => {
  const away = (p?: string) => p && !under(p, root) ? tilde(p, home) : undefined
  if (/^(Read|Edit|Write|NotebookEdit)$/.test(tool)) { const p = a.path ? absOf(a.path, cwd, home) : undefined; return away(p && (p.replace(/\/[^/]*$/, '') || '/')) }
  if (/^(Grep|Glob)$/.test(tool)) return away(a.path ? absOf(a.path, cwd, home) : cwd)
  if (tool !== 'Bash' || !a.cmd) return undefined
  const cd = CD.exec(a.cmd)?.[1], at = cd ? absOf(cd, cwd, home) : cwd
  if (!at) return undefined
  const there = away(at)
  if (there || !home) return there
  for (const m of a.cmd.matchAll(PATHS)) { const p = absOf(m[1]!, at, home); if (p && under(p, home) && !under(p, root)) return tilde(p, home) }
  return undefined
}
// a cwd change or another mid-session edit of the environment block; the first message's block reads `# Environment`
const envUpdate = (x: Entry) => x.type === 'environment' && (x.peek ?? '').startsWith('# Environment update')
// engine notes about one file, named by it: the kind, and where its first line holds the path
const ABOUT: Record<string, [string, RegExp]> = {
  edited_text_file: ['changed', /^Note: (.+?) changed on disk/], compact_file_reference: ['not restored', /^Note: (.+?) was read before/],
  file: ['mentioned', /"file_path":"([^"]+)"/], nested_memory: ['memory', /^Contents of (.+?):?$/],
}
// Engine context named at draw time from its type and stored text, so rows logged under an older name read the current one.
// kind: what folds and tallies count by (`changed ×3`); tail: what this row is about, with its own glue (` → agent-log`, `: x.md`).
// A hook's or plugin's row keeps its stored name: the hook's, which its attachment kind (`output`) would hide
export const ctxOf = (x: Entry): [string, string?] => {
  if (x.kind !== 'prompt' || (x.src && x.src !== 'engine')) return [x.name]
  const p = x.peek ?? '', l = first(p), t = x.type ?? ''
  const about = ABOUT[t] && l.match(ABOUT[t][1])?.[1]
  if (about) return [ABOUT[t]![0], `: ${t === 'nested_memory' ? about.split('/').slice(-2).join('/') : base(about)}`] // a CLAUDE.md is told apart by its folder
  if (envUpdate(x)) { const d = p.match(/Primary working directory: (.+?)(?: \(was .*)?$/m)?.[1]; return d ? ['CWD', ` → ${base(d)}`] : ['env change'] } // no `)` needed: the PEEK cap can cut a long `(was …`
  if (t === 'date' && l.startsWith('The date has changed')) return ['date change'] // else the date at session start
  // a delta's first one is the full list; later ones add or remove
  const gone = /no longer available|have disconnected/.test(l)
  if (t === 'deferred_tools_delta' && gone) return ['tools removed']
  if (t === 'agent_listing_delta') return [gone ? 'agents removed' : l.startsWith('New ') ? 'agents added' : 'agent list']
  if (t === 'mcp_instructions_delta' && gone) return ['MCP disconnected']
  return [Object.hasOwn(LABEL, t) ? LABEL[t]! : x.name] // no label: as logged, e.g. `skill code-review`
}
// what made the engine send it, for a context fold: a loop starting, a change in what the model can call, files, a mode, your
// own input, or the reminders it sends with every request. Unknown kinds: `other`. By kind alone, so a kind always lands in one
// bucket: the first tool/agent/MCP/skill lists and auto mode, sent with a loop's start, still read as capabilities and mode
const BUCKET: Record<string, string> = {
  system_prompt: 'setup', claudeMd: 'setup', instructions: 'setup', model: 'setup', session_context: 'setup', output_style_instructions: 'setup',
  advisor_tool: 'setup', userEmail: 'setup', currentDate: 'setup', attachedProject: 'setup', environment: 'setup', date: 'setup',
  deferred_tools_delta: 'capabilities', agent_listing_delta: 'capabilities', mcp_instructions_delta: 'capabilities', skill_listing: 'capabilities',
  edited_text_file: 'files', nested_memory: 'files', compact_file_reference: 'files', read_truncation_notice: 'files',
  plan_mode: 'mode', plan_mode_exit: 'mode', plan_mode_reentry: 'mode', plan_file_reference: 'mode', auto_mode: 'mode', remote_session_change: 'mode',
  queued_command: 'your input', file: 'your input', skill_mention: 'your input', skill_prompt: 'your input', invoked_skills: 'your input',
  total_tokens_reminder: 'reminders', output_style: 'reminders', silent_turn_reminder: 'reminders', task_reminder: 'reminders', todo_reminder: 'reminders',
}
// A context fold's entries split by bucket, in order of first appearance. name: the bucket as the fold's row lists it
// (`session start ×6 · capabilities ×4`); head: what its own row reads (`files: x.ts, CLAUDE.md`)
export const bucketsOf = (xs: Entry[]): { name: string; head: string; xs: Entry[] }[] => {
  const of = (x: Entry) => { const k = ctxOf(x)[0]; return k === 'date change' ? 'reminders' : BUCKET[x.type ?? ''] ?? 'other' }
  const by = new Map<string, Entry[]>()
  for (const x of xs) { const b = of(x); by.set(b, [...by.get(b) ?? [], x]) }
  const uniq = (ss: string[]) => [...new Set(ss)]
  return [...by].map(([b, ys]) => {
    const name = b === 'setup' ? 'session start' : b // a subagent's too: the engine starts its session the same way
    const head = b === 'files' ? `files: ${uniq(ys.map(y => ctxOf(y)[1]?.slice(2) ?? ctxOf(y)[0])).join(', ')}`
      : b === 'mode' ? uniq(ys.map(y => ctxOf(y)[0])).join(' → ')
      : b === 'capabilities' || b === 'your input' || b === 'other' ? uniq(ys.map(y => ctxOf(y).join(''))).join(', ')
      : name
    return { name, head, xs: ys }
  })
}
// what happened, action first in sentence case; the tool column names the tool, so the action never repeats it
const action = (x: Entry): string => {
  const d = x.detail
  if (x.kind === 'tool') switch (x.name) {
    case 'Bash': { // noCd: entries stored before the strip hold the raw command
      const s = noCd(d).replace(/^bash\b[:\s-]*/i, '')
      // no description: the detail is the command itself, an identifier like a hook's name, so `wc -l` never reads `Wc -l`
      return (x.cmd && noCd(x.cmd).replace(/\s+/g, ' ').startsWith(s) ? s : cap(s)) || 'Run a command'
    }
    case 'Read': case 'Edit': case 'Write': case 'NotebookEdit': return `${x.name} ${base(d)}`
    case 'Grep': return `Search ${base(d) || 'files'}`
    case 'Glob': return `Find files in ${base(d) || '.'}`
    case 'Skill': return `Run skill ${d}`
    case 'WebFetch': return `Fetch ${d.replace(/^https?:\/\//, '')}`
    case 'WebSearch': return `Search the web for ${d}`
    case 'ToolSearch': return `Load tools: ${d}`
    case 'SubagentHandback': return 'Hand back' // a subagent delivering its report to its parent
    case 'Agent': return d || x.name // `type: task`: the type is an identifier, as named
    default: return (x.name.startsWith('mcp__') ? d : cap(d)) || x.name // mcp `tool: arg` stays as named, an identifier
  }
  if (x.kind === 'hook') // several silent hooks read by name, `config-change-guard, unicode-scan on ConfigChange`. name = origin: a row stored before no-hook events were skipped
    return x.origin && said(x) ? `${x.name}: ${said(x)}` : `${x.name === x.origin ? 'No hook' : x.name} on ${x.origin ?? 'event'}${d ? ` ${d}` : ''}`
  if (x.kind === 'prompt') {
    if (x.src && x.src !== 'engine') return x.name + (said(x) ? `: ${said(x)}` : '') // a hook or plugin name is an identifier: never recased
    const [k, tail = ''] = ctxOf(x)
    return cap(k) + tail
  }
  if (x.kind === 'session') return x.name === 'reload' ? 'Plugin reloaded' : `Session init${d ? ` in ${base(d)}` : ''}` // `init`: `session start` is the engine context it sent
  if (x.kind === 'fork') return `Fork by ${x.name}: ${first(x.peek) || stat(x)}`
  // a request reads what it said first, else what it thought, else the calls it made, else why it stopped
  if (x.kind === 'step') return first(x.peek) || (x.thought ? `Thought: ${x.thought}` : '') || (x.asked?.length ? `Calls ${counted(x.asked)}` : '') || STOPPED[x.stop ?? ''] || (stat(x) === 'aborted' ? 'Interrupted' : 'No response')
  if (x.kind === 'event') return x.name === 'model switch' ? `Model: ${x.detail.split(' → ').map(modelName).join(' → ')}${x.outcome ? ` (${x.outcome})` : ''}`
    : `${cap(x.name)}${x.detail ? `: ${x.detail}` : ''}${x.outcome ? ` (${x.outcome})` : ''}`
  if (x.kind === 'side') return x.src === 'plugin' ? `${x.name}: ${first(x.peek) || stat(x)}` : cap(SIDE[x.name] ?? x.name.replace(/_/g, ' '))
  return 'Turn ended'
}
// What kind of effect a row had, not which tool: the action already names the tool (Read x, ExitWorktree, Search y), and the
// inspector keeps the real name. Unknown tools read `Tool`. Engine-injected text reads `Context`: where the text went
const KIND: [RegExp, string][] = [
  [/^(Bash|PowerShell)$/, 'Shell'], [/^(Read|Grep|Glob|LS|LSP|NotebookRead)$/, 'Look'], [/^(Edit|Write|MultiEdit|NotebookEdit)$/, 'Change'],
  [/^Web/, 'Web'], [/^(Agent|SendMessage|ListAgents|SubagentHandback|Task\w*)$/, 'Agent'], [/^Skill$/, 'Skill'], [/^mcp__/, 'MCP'],
  [/^(EnterWorktree|ExitWorktree|ToolSearch|TodoWrite|EnterPlanMode|ExitPlanMode|AskUserQuestion|SendUserMessage|Monitor|Cron\w*|ScheduleWakeup|RemoteTrigger|ReadNotifications|PushNotification)$/, 'Control'],
]
const toolOf = (x: Entry) => x.kind === 'tool' ? KIND.find(([re]) => re.test(x.name))?.[1] ?? 'Tool' : x.kind === 'prompt' ? (x.src === 'engine' || !x.src ? 'Engine' : cap(x.src)) : x.kind === 'step' ? modelName(x.name) : x.kind === 'side' ? modelName(x.detail) : x.kind === 'event' ? (x.name.startsWith('MCP') ? 'MCP' : x.name === 'model switch' ? 'Model' : x.name === 'mode' ? 'Mode' : 'Engine') : cap(x.kind)
// Engine context is out of the log for now, its view hidden: it is still logged (the replay counts need it, and the view can come
// back), but only rows that report something happening show. A cwd change, a file changed on disk or not restored, a nested
// CLAUDE.md, a date change, IDE diagnostics, a list losing tools, agents or an MCP server, or gaining agents
const EVENT_CTX = new Set(['CWD', 'env change', 'changed', 'not restored', 'memory', 'date change', 'diagnostics', 'tools removed', 'agents added', 'agents removed', 'MCP disconnected'])
const hiddenCtx = (x: Entry) => x.kind === 'prompt' && (!x.src || x.src === 'engine') && !EVENT_CTX.has(ctxOf(x)[0])
// preset views: one predicate over stored entries, applied alongside the agent filter and the level
const VIEWS = {
  all: (x: Entry) => !hiddenCtx(x),
  agent: (x: Entry) => x.kind === 'tool' || x.kind === 'turn' || x.kind === 'fork' || x.kind === 'step', // what the model did: its requests, calls and turns, and what it answered a plugin's fork
  harness: (x: Entry) => x.kind === 'hook' || x.kind === 'fork' || x.kind === 'event' || x.kind === 'side' || (x.kind === 'prompt' && !hiddenCtx(x)) || (x.kind === 'tool' && (x.rule != null || x.check === 'deny')), // what your setup and the engine did: hooks, the text they injected, plugins' forks and model calls, rule decisions, the engine's own requests and what it reported happening
  context: (x: Entry) => x.bytes != null && x.kind !== 'hook', // hidden for now: no button, no command. Prompt blocks and attachments, everything with an injected size
  // where the session went beyond its project root: the calls that reached outside it, the directories and worktrees it gained or lost, its cwd changes
  outside: (x: Entry) => !!x.out || (x.kind === 'event' && /^(directory added|worktree created|worktree removed)$/.test(x.name)) || (x.kind === 'prompt' && ctxOf(x)[0] === 'CWD'),
} satisfies Record<string, (x: Entry) => boolean>
type View = keyof typeof VIEWS
const SHOWN: View[] = ['all', 'agent', 'harness', 'outside'] // the views the controls and /agentlog offer
let view: View = 'all'
// How much a row matters, derived at draw time like stat so stored entries rank too and the rules can change. The pane shows
// rows at `level` or above. error: refused or broke. notice: changed or decided something (shell, edits, agents, web, a rule's
// verdict, hook text, a slow hook, an aborted turn, a cwd change). info: routine (lookups, control tools, engine context). debug: chatter (SendUserMessage, ToolSearch's schema loads)
const LEVELS = ['debug', 'info', 'notice', 'error'] as const
let level = 1 // info: what the log showed before levels existed
const lvl = (x: Entry): number => {
  if (BAD.has(stat(x))) return 3
  if (x.kind === 'tool') return /^(SendUserMessage|ToolSearch)$/.test(x.name) ? 0 : x.rule != null || /^(Shell|Change|Agent|Web|MCP|Skill|Tool)$/.test(toolOf(x)) ? 2 : 1
  if (x.kind === 'hook') return stat(x) === 'feedback' || slow(x) ? 2 : 0 // a fast hook that changed nothing, or added context its attachment row already carries
  if (x.kind === 'prompt') return DEBUG_ATTACHMENTS.has(x.type ?? '') ? 0 : !x.again && (envUpdate(x) || x.src === 'hook' || x.src === 'plugin') ? 2 : 1
  if (x.kind === 'session') return x.name === 'reload' ? 0 : 2
  // a request that wrote no text ranks debug: the calls it made follow as rows of their own (a step between every two lookups would
  // break each Explore fold), and its time stays in the turn header's split and in its calls' inspector
  if (x.kind === 'step') return stat(x) === 'aborted' ? 2 : first(x.peek) ? 1 : 0
  if (x.kind === 'event') return QUIET_EVENTS.has(x.name) || x.name === 'MCP connected' ? 0 : /^(MCP disconnected|file changed|command|task |teammate|setup)/.test(x.name) ? 1 : 2
  if (x.kind === 'side') return x.src === 'plugin' || !CHATTER.has(x.name) ? (x.name === 'compact' ? 2 : 1) : 0
  return stat(x) === 'aborted' ? 2 : 1
}

// === STATE AND STORE ===
const started = new Map<string, number>() // agent id -> spawn time; AgentInfo has no timestamp. Teammates raise no agent.spawn, so they have none
// agent id -> the name a row shows when $.agent.list() does not hold the loop: a spawned agent's type once the engine drops it, a
// fork's plugin. Stored with the entries, so old turns keep their names. A fork has no agent.spawn and its SubagentStop's agent_type
// is '' (probed on 2.1.294), so it is named `fork` there and by its plugin once that plugin's $.model.fork resolves (the model.fork hook)
let names: Record<string, string> = {}
// PostToolUse context to come, per call, in the order its hooks ran: its attachment names only the tool (`PostToolUse:Read hook …`),
// and parallel calls of one tool run their hooks in turn, so the first waiting call of that tool is the one it belongs to
let postCtx: { use: string; tool: string; agent?: string; n: number }[] = []
const takePost = (tool: string | undefined, agent: string | undefined): string | undefined => {
  const w = postCtx.find(c => c.tool === tool && c.agent === agent)
  if (w && !--w.n) postCtx = postCtx.filter(c => c !== w)
  return w?.use
}
let stops: { id: string; t: number; text?: string }[] = [] // SubagentStops of loops no agent.spawn started, not yet tied to a fork
// agent.spawn's Agent call -> the agent it started, until that call's tool.call takes it. Capped: a plugin's own $.agent.spawn
// raises agent.spawn but no Agent tool.call, so its pair is never taken
let spawned: { use: string; id: string }[] = []
// the Agent row a loop's rows fold under: the top-most, so a grandchild's rows fold with its parent's. None for main, a plugin's
// fork or spawn, and loops logged before rows stored their child. Depth-capped: a cycle in a damaged store must not hang the draw
export const rootOf = (xs: Entry[]) => {
  const spawn = new Map<string, Entry>()
  for (const x of xs) if (x.child) spawn.set(x.child, x)
  return (x: Entry): Entry | undefined => {
    let top: Entry | undefined, a = x.agent
    for (let n = 0; a && n < 8; n++) { const s = spawn.get(a); if (!s) break; top = s; a = s.agent }
    return top
  }
}
// Where a turn's time went, each instant counted once, by what held it, in this order where they overlap (a read-only call runs
// while the model still writes; a call's hooks run inside the call): you answering a permission prompt, a permission decision
// the engine took its time over (a headless `ask` sat 19 s before its `config` decision), hooks, a compaction, agents, other
// tools, the model.
// A wait on the model's message is the model's. Over main's rows alone: a foreground subagent's time sits inside its Agent call.
// [from, to] is the turn; what none of them held is the engine's and plugins' own work between steps: other = to - from - the sum
export const SPLIT = ['you', 'permission', 'hooks', 'compact', 'agents', 'tools', 'model'] as const
export const ASKED = 'you to answer the permission prompt' // a wait's waitFor when the person decided it
export const STREAMING = 'the model to finish its message' // a wait's waitFor when the call was decided as main's message ended
export const splitOf = (xs: Entry[], from: number, to: number): number[] => {
  const pts: [number, number, number][] = []
  const span = (a: number, b: number, c: number) => { const p = Math.max(a, from), q = Math.min(b, to); if (q > p) pts.push([p, 1, c], [q, -1, c]) }
  for (const x of xs) {
    if (x.agent) continue
    if (x.kind === 'tool' && x.wait && x.waitFor !== STREAMING) span(x.t, x.t + x.wait, x.waitFor === ASKED ? 0 : 1) // a call's t is its start, its wait before its run; a refused call has a wait and no run
    if (x.ms == null) continue
    if (x.kind === 'step') span(x.t, x.t + x.ms, 6)
    else if (x.kind === 'tool') span(x.t + (x.wait ?? 0), x.t + (x.wait ?? 0) + x.ms, x.name === 'Agent' ? 4 : 5)
    else if (x.kind === 'hook') span(x.t - x.ms, x.t, 2) // a hook row's t is its end
    else if (x.kind === 'event' && x.name === 'compacted') span(x.t, x.t + x.ms, 3) // pushed at its start
  }
  pts.sort((p, q) => p[0] - q[0])
  const on = SPLIT.map(() => 0), out = SPLIT.map(() => 0)
  let at = from
  for (const [t, d, c] of pts) { const top = on.findIndex(n => n > 0); if (top >= 0) out[top]! += t - at; at = t; on[c]! += d }
  return out
}
// a spawned agent's name: the second and later of a type read `type #2`, `#3`, so two general-purpose agents tell apart in row
// prefixes, the tree and the filter. counted: the loops already numbered, so not this one or a parallel spawn whose SubagentStart
// named it before its agent.spawn resumed. One past the highest, not the count: saved() drops the names of loops evicted from the
// log, and `#2` may outlive the bare first
export const tagOf = (names: Record<string, string>, type: string, counted: (id: string) => boolean = () => true) => {
  const ns = Object.entries(names).filter(([id, v]) => counted(id) && (v === type || v.startsWith(`${type} #`))).map(([, v]) => v === type ? 1 : Number(v.slice(type.length + 2)) || 1)
  return ns.length ? `${type} #${Math.max(...ns) + 1}` : type
}
// a loop an Agent row started: in memory since its spawn, or in the log once a reload emptied started
const linked = (id: string) => started.has(id) || entries.some(x => x.child === id)
let memBytes: number | undefined // size of the claudeMd block just logged; the engine repeats it once as an `instructions` attachment
let lastSig = '' // poll's change detector
const checks = new Map<string, { check: Entry['check']; rule?: string; reason?: string }>() // tool_use_id -> tool.check verdict, taken by the tool.call that raised it
const blockedUse = new Set<string>() // tool_use_ids a PreToolUse hook blocked: the call reads `isError`, not `deny`, so tool.call learns it here
// tool_use_id -> when tool.check returned its verdict, and when the engine's collector record `tool_decision` settled it. The gap
// is not the tool's: a call that starts while the model still streams its message is decided once that message ends (probed on
// 2.1.296: an `ask` settled `source: config` 1.1 s after the check, its `tool_decision` 6 ms before main's `api_request` record,
// with no classifier request). Only with OTEL export on does the engine raise collector records; without them no wait is logged
const checkedAt = new Map<string, number>()
const decided = new Map<string, { t: number; source?: string; decision?: string }>()
let streamEnd = 0 // when main's last model request closed (collector `api_request`)
const WAIT = 100 // ms: a shorter gap is the engine's own step from check to decision (1-2 ms when nothing streams), not a wait
const preCtx = new Map<string, number>() // tool_use_id -> context entries its PreToolUse hooks returned, taken by the tool.call that raised them
// tool_use_id -> the loop making the call, while it runs: classic.PreToolUse's envelope is the bare call (ToolCallEnvelope), which
// names no loop, so its hook rows take the loop from here
const loopOf = new Map<string, string | undefined>()
// tool_use_id -> the step that asked for the call: its `tool` chunk streams before the engine runs the call, whose row takes it
const stepOf = new Map<string, string>()
// The collector's `api_request` records not yet paired with a step, and steps not yet paired with one: whichever comes second
// pairs them by the four token counts, which the record repeats exactly. Either may land first. Records of the engine's side
// requests (titles, prompt suggestions) pair with nothing and age out
let bills: { t: number; sig: string; cost?: number; req?: string }[] = []
let unbilled: { t: number; sig: string; key: string }[] = []
// what streams or runs right now, for the pane's ● lines: a loop's model request (its phase, and the first line it wrote or thought
// so far) or a tool call. Gone at its end, when its row is logged. In memory only: a reload starts it empty
// asking: a call whose permission prompt is up (PermissionRequest), until its decision lands (the collector's tool_decision)
type Live = { t: number; loop?: string; model?: string; phase?: 'waiting' | 'thinking' | 'writing' | 'calling'; said?: string; tool?: string; row?: Omit<Entry, 't'>; asking?: boolean }
const liveNow = new Map<string, Live>()
const compactAt = new Map<string, number>() // loop -> when its PreCompact fired: PostCompact's row takes the time
// the collector's last hook_execution_complete: the settings hooks a classic event just ran, how many failed and how many the engine
// cancelled (a timeout). It lands inside that event's next, so classic.* reads it right after
let lastRun: { t: number; event: string; errors: number; cancelled: number } | undefined
let turnAt: number | undefined // when main's running turn began: your prompt's submit
// a tool row -> PreToolUse context attachments still to come for it. The engine sends a PreToolUse hook's context with the request
// after the call, so its attachment arrives once the call's row is logged; push files it just above that row, in call order
const ahead = new WeakMap<Entry, number>()
const composed = new Set<string>() // system prompt shapes logged this session; a set, since main and subagents render different prompts in turn. A hot reload empties it, so each logs once more then
let timer: Timer | undefined // lives while the pane is open
async function tick($: any): Promise<void> {
  try {
    if (!(await $.ui.panes()).some((p: any) => p.id === PANE)) { timer?.cancel(); timer = undefined; return } // closed by Esc / ctrl+x x, which bypasses command.run
    const agents: AgentInfo[] = await $.agent.list()
    const sig = agents.map(a => a.id + a.status).join()
    // redraw on any status change (incl. kills and failures, which raise no turn.complete), and while something runs so its elapsed cell counts up
    // started empties on a hot reload; an Agent row's child still counts up on its row
    if (sig !== lastSig || busy || liveNow.size || agents.some(a => a.status === 'running' && linked(a.id))) { lastSig = sig; $.ui.invalidate('ui.render') }
  } catch {}
}

// ponytail: 2s poll while pane open, replace if an agent-status event lands in the API
const startPoll = ($: any) => { timer ??= $.clock.every(2000, () => { tick($) }) }

// The engine caches prompt.attachment answers per plugin instance (d.ts: "asked again on resume"), so a fresh
// instance, from a resume or a hot reload of this plugin, is asked again for every attachment in the history on
// its first request (seen: the away summary right after a reload), and prompt.context re-reads the first message's
// blocks. No per-attachment replay flag exists, so `seen` counts how often each signature entered the context this
// session, stored beside the entries. A fresh instance owes those counts back: until a loop's first tool call or
// turn end, an ask that matches an owed copy is a replay and is skipped; one past the count is new and is logged
let seen: Record<string, number> = {}
let owed: Record<string, number> | undefined // undefined: not joining a conversation with history
let blind = false // a resume whose store is gone (pruned): nothing to match against, so the window logs nothing
const closed = new Set<string>() // loops ('main' or an agent id) whose first request since the instance began is over
// A fork re-reads its parent's history on its first request: every attachment main already logged comes back under the fork's id
// (seen: an engine fork between turns logging ~10k tok of environment, skill list and old hook output). Forks are Agent-tool spawns
// with `fork` and the engine's own (memory, compaction), which raise no agent.spawn and carry ids no list names. While a fork's
// first request lasts, an attachment matching one main logged is a copy, taken from the fork's own tally of main's counts.
// A plain subagent starts fresh: its skill list and memory files are its own cost and still log
const forks = new Set<string>()
const inherited = new Map<string, Record<string, number>>() // fork id -> main's counts not yet matched
async function copied($: any, agent: string | undefined, type: string, origin: string | undefined, bytes: number): Promise<boolean> {
  if (!agent || closed.has(agent)) return false
  if (!forks.has(agent) && (started.has(agent) || ((await $.agent.list().catch(() => [])) as AgentInfo[]).some(a => a.id === agent))) return false
  let left = inherited.get(agent)
  if (!left) { left = {}; for (const [g, c] of Object.entries(seen)) if (g.split('|')[2] === '') left[g] = c; inherited.set(agent, left) }
  const g = sigOf(type, origin, undefined, bytes)
  if (!left[g]) return false
  left[g]--
  return true
}
// type + author + loop + size: different texts of one kind and length (a date change) still count apart per copy,
// since a replay asks each past copy once and anything past the count is new
const sigOf = (type: string, origin: string | undefined, agent: string | undefined, bytes: number) => `${type}|${origin ?? ''}|${agent ?? ''}|${bytes}`
// stores written before `seen` hold entries alone; seed from them (only logged rows, so noisy kinds start at zero)
const seed = (xs: Entry[]) => { const s: Record<string, number> = {}; for (const x of xs) if (x.kind === 'prompt' && x.type && x.bytes != null) { const g = sigOf(x.type, x.origin, x.agent, x.bytes); s[g] = (s[g] ?? 0) + 1 } return s }
// names only for loops the kept entries still show: a session forks several times a turn, and the store has a size cap
const saved = () => ({ entries, seen, turn: turnNo, names: Object.fromEntries(Object.entries(names).filter(([id]) => entries.some(x => x.agent === id))) })

// session id changes on /clear and resume; a failed load is retried next call
async function load($: any): Promise<void> {
  const id = await $.session.id()
  const k = `r:${id}` // r: = redacted format (scrubbed, PEEK-capped text only); older s: keys hold unredacted text and prune() deletes them
  if (k === key) return
  if (dirty && key) await $.store.set(key, saved()) // the old session's unflushed tail, before its key is dropped
  dirty = false
  const v = await $.store.get(k)
  if (key) { stepOf.clear(); bills = []; unbilled = [] } // the old session's requests; not on the first load, which a step's push can trigger after its pairing was queued
  if (setup.runsOf !== id) { setup.runs.clear(); setup.runsOf = id } // the old session's hook runs; ones the new session's records counted before this load stay
  key = k
  entries = Array.isArray(v) ? v : Array.isArray(v?.entries) ? v.entries : []
  turnNo = typeof v?.turn === 'number' ? v.turn : Math.max(0, ...entries.map(x => x.turn ?? 0)) // stores from before turns hold none: start at 0
  seen = v?.seen && !Array.isArray(v) ? v.seen : seed(entries)
  names = { ...(v?.names && !Array.isArray(v) ? v.names : {}), ...names } // merged: a fresh instance can name a loop before its first load. Ids are unique, and saved() drops the ones no entry shows
  owed = entries.length || Object.keys(seen).length ? { ...seen } : undefined // /clear's empty session owes nothing
  blind = false; closed.clear(); composed.clear(); checks.clear(); inherited.clear(); postCtx = [] // the old session's calls
}
const ready = ($: any) => key ? Promise.resolve() : mutate(() => load($)).catch(() => {}) // a fresh instance loads before the replay window is read

function mutate(fn: () => Promise<void>): Promise<void> {
  const run = chain.then(fn)
  chain = run.catch(() => {})
  return run
}

// The store is one JSON file for all sessions (~1 MB), so a write per entry made a burst (a resume re-asks
// every past attachment) take seconds, and hooks awaiting it ran past their budget. Entries now land in
// memory and flush at most once a second; a hot reload loses at most that last second.
let dirty = false
let flushTimer: Timer | undefined
function flush($: any): Promise<void> {
  flushTimer?.cancel(); flushTimer = undefined
  return mutate(async () => { if (dirty && key) { dirty = false; await $.store.set(key, saved()) } })
}
const touch = ($: any) => { dirty = true; flushTimer ??= $.clock.after(1000, () => { flushTimer = undefined; flush($).catch(() => {}) }) }

// true when this ask re-reads history already counted (see `seen`); otherwise counts it. Call after ready()
function replayed($: any, sig: string, agent?: string): boolean {
  if (owed && !closed.has(agent ?? 'main')) {
    if (blind) return true
    if (owed[sig]) { owed[sig]--; return true }
  }
  seen[sig] = (seen[sig] ?? 0) + 1
  touch($)
  return false
}

// hook text logged before, word for word: every copy of x's text after the first in the log's order is `again`. Over the whole log,
// not just x: x may have gone in above a copy logged earlier (push's `above`), which then is the repeat
export const markAgain = (xs: Entry[], x: Entry) => {
  let seen = false
  for (const y of xs) if (y.kind === 'prompt' && y.name === x.name && y.bytes === x.bytes && first(y.peek) === first(x.peek)) { y.again = seen || undefined; seen = true }
}

// fire-and-forget: callers never await the log, so logging cannot cost a hook its budget
// opt.ahead: on a tool row, its PreToolUse context attachments to come. opt.above: on such an attachment, the tool it goes with.
// opt.after: on a PostToolUse attachment, the tool it followed (its newest call of that name in the loop, by start)
// opt.start: on a tool row, when its call began
function push($: any, e: Omit<Entry, 't'>, opt: { ahead?: number; above?: string; after?: string; start?: number } = {}): void {
  const t = opt.start ?? Date.now() // when it happened, not when the chain gets to it: rows are placed by it
  mutate(async () => {
    await load($)
    const x: Entry = { t, turn: turnNo, ...e }
    // A call's row is pushed once the call is over, after everything that happened while it ran: its own hooks (they run inside
    // it), parallel calls that finished first, a foreground agent's whole run. So it goes in where it began: before the first
    // row logged after its start, but never between another call and that call's hook rows, and in front of its own first row
    // even when they share a millisecond. Its PreToolUse context, which comes after it, goes in behind that call's PreToolUse hook rows
    const call = x.kind === 'tool' && x.use ? entries.findIndex(y => y.use === x.use) : -1
    let at = opt.start != null ? entries.findLastIndex(y => y.t <= x.t) + 1 : -1
    while (at > 0 && at < entries.length && entries[at]!.use && entries[at]!.use === entries[at - 1]!.use) at++
    if (call >= 0 && (at < 0 || call < at)) at = call
    const i = opt.above ? entries.findIndex(y => (ahead.get(y) ?? 0) > 0 && y.name === opt.above && y.agent === x.agent) : -1
    if (call >= 0) x.turn = entries[call]!.turn // the turn its hooks ran in, the one it began in
    if (at >= 0 && at < entries.length) entries.splice(at, 0, x)
    else if (i >= 0) {
      const y = entries[i]!; ahead.set(y, ahead.get(y)! - 1); x.t = y.t; x.turn = y.turn; x.use = y.use // the row's time and turn, so the log stays in time order
      const j = y.use ? entries.findLastIndex(z => z.use === y.use && z.origin === 'PreToolUse') : -1
      entries.splice(Math.max(i, j) + 1, 0, x)
    } else {
      if (opt.after && !x.use) x.use = entries.findLast(y => y.kind === 'tool' && y.name === opt.after && y.agent === x.agent)?.use // no hook seen: a reload lost the queue
      entries.push(x)
    }
    if (opt.ahead) ahead.set(x, opt.ahead)
    // the same hook text once more, or the engine putting the cwd back where the session began after a `cd`: nothing new, so info
    if (x.kind === 'prompt' && (x.src === 'hook' || x.src === 'plugin')) markAgain(entries, x)
    else if (envUpdate(x)) { const home = entries.findLast(y => y.kind === 'session' && y.name !== 'reload')?.detail; x.again = (!!home && ctxOf(x)[1] === ` → ${base(home)}`) || undefined }
    // over `keep`, the oldest hidden or debug row goes first: chatter only fills slots the rest leaves free, so the store bound is unchanged
    // an evicted first copy of a hook text hands that role to the next copy, which then ranks notice again (markAgain)
    while (entries.length > keep) { const d = entries.findIndex(y => hiddenCtx(y) || lvl(y) === 0); const gone = entries.splice(Math.max(0, d), 1)[0]!; if (gone.kind === 'prompt' && !gone.again && (gone.src === 'hook' || gone.src === 'plugin')) markAgain(entries, gone) }
    touch($)
    $.ui.invalidate('ui.render') // a hidden row still redraws: its turn's hidden count changed
    if (lvl(x) < level) return // no "N new" for a row nobody sees
    if (!follow) fresh++ // following, the redraw pins the window to the end
  }).catch(() => {})
}

async function prune($: any): Promise<void> {
  await load($)
  // keep the SESSIONS - 1 other sessions whose newest entry is newest. Insertion order pruned live sessions: every hot reload
  // prunes in every running session, and a long-lived session's key is the oldest. A session idle behind 9 busier ones still goes
  const others: string[] = (await $.store.keys()).filter((k: string) => k !== key)
  const redacted = others.filter(k => k.startsWith('r:'))
  const last = new Map<string, number>()
  for (const k of redacted) { const v = await $.store.get(k); const es = Array.isArray(v) ? v : v?.entries; last.set(k, Array.isArray(es) ? es.at(-1)?.t ?? 0 : 0) }
  const stale = [...others.filter(k => !k.startsWith('r:')), ...redacted.sort((a, b) => last.get(b)! - last.get(a)!).slice(SESSIONS - 1)]
  for (const k of stale) await $.store.delete(k)
}

// What broke this session, for the setup row: settings hook runs that failed or were cancelled (the collector's counts, else the red
// hook rows), API errors, turns the API failed, MCP servers that did not connect
const problemsOf = (xs: Entry[]): string[] => {
  const n = (f: (x: Entry) => boolean) => xs.filter(f).length
  const many = (k: number, one: string, more = `${one}s`) => k ? `${k} ${k > 1 ? more : one}` : ''
  const runs = [...setup.runs.values()].reduce((a, r) => a + r.errors + r.cancelled, 0)
  return [
    many(runs || n(x => x.kind === 'hook' && stat(x) === 'failed'), 'hook run failed', 'hook runs failed'),
    many(n(x => x.kind === 'event' && x.name === 'API error'), 'API error'),
    many(n(x => x.kind === 'event' && x.name === 'turn failed'), 'turn failed', 'turns failed'),
    many([...setup.mcp.values()].filter(m => m.status !== 'connected' && m.status !== 'disconnected').length || n(x => x.kind === 'event' && x.name === 'MCP failed'), 'MCP server down', 'MCP servers down'),
  ].filter(Boolean)
}

// === HOOKS ===
export const register: Register = (on, options) => {
  keep = Math.min(300, Math.max(1, Number(options.keep) || 300)) // store cap is 4 MiB total: 300 entries x SESSIONS (10) x at most ~800 bytes stays under it

  // what identifies a call: the scrubbed Bash command, a file target, or a short handle (agent type and task, skill, query, URL).
  // Prompts, file contents and edit bodies stay out of the store
  const RESERVED = new Set(['tool', 'tool_use_id', 'consent', 'agentId']) // tool.call keys that are not the tool's arguments
  // `tool: arg`. The server is dropped: the column already reads MCP, and the inspector keeps the full name. A handle key
  // (url, query, path, command) beats the first string, which is often a mode flag (ctx_execute's language)
  const HANDLES = ['url', 'query', 'queries', 'path', 'file_path', 'command']
  const mcpDetail = (e: any): string => {
    const tool = String(e.tool).split('__').slice(2).join('__')
    const pick = (v: unknown) => [v].flat().filter(s => typeof s === 'string').join(', ') // queries is a string array
    const arg = HANDLES.map(k => pick(e[k])).find(Boolean) ?? pick(Object.entries(e).find(([k, v]) => !RESERVED.has(k) && typeof v === 'string')?.[1])
    return arg ? `${tool}: ${scrub(arg)}` : tool
  }
  const detailOf = (e: any): string =>
    e.tool === 'Bash' ? e.description || noCd(scrub(e.command ?? '')) // the model's own label; else the command minus a leading cd
    : /^(Read|Edit|Write|NotebookEdit|Grep|Glob)$/.test(e.tool) ? e.file_path ?? e.notebook_path ?? e.path ?? ''
    : e.tool === 'Agent' ? `${e.subagent_type ?? 'general-purpose'}: ${e.description ?? ''}`
    : e.tool === 'Skill' ? `${e.skill ?? ''}${e.args ? ` ${scrub(e.args)}` : ''}`
    : e.tool === 'WebFetch' ? scrub(e.url ?? '')
    : /^(WebSearch|ToolSearch)$/.test(e.tool) ? e.query ?? ''
    : String(e.tool).startsWith('mcp__') ? mcpDetail(e)
    : ''

  // the verdict and the rule behind it; tool.call reads it after its next, inside which this fires
  on('tool.check', async ($, e, next) => {
    const r = await next(e)
    if (e.tool_use_id) { checks.set(e.tool_use_id, { check: r.decision, rule: r.rule, reason: r.reason }); checkedAt.set(e.tool_use_id, Date.now()) }
    return r
  })

  // read-only: when a call was decided, and when main's model request closed, for the wait tool.call logs; each request's price
  on('telemetry.log', { to: 'collector' }, async ($, e: any, next) => {
    const a = e.attributes ?? {}
    // a refusal no one waited on (a headless session's prompt) is recorded just after its call ended: its row is in, or queued ahead
    // of this on the chain, so the decision is written onto it
    if (e.event === 'tool_decision' && typeof a.tool_use_id === 'string' && !loopOf.has(a.tool_use_id)) mutate(async () => {
      const y = entries.findLast(y => y.kind === 'tool' && y.use === a.tool_use_id)
      decided.delete(a.tool_use_id)
      if (!y || y.via) return
      y.via = a.source
      if (a.decision === 'reject') { y.status = 'denied'; y.outcome = 'deny'; y.insight = undefined; y.exit = undefined }
      touch($)
    }).catch(() => {})
    else if (e.event === 'tool_decision' && typeof a.tool_use_id === 'string') { decided.set(a.tool_use_id, { t: Date.now(), source: a.source, decision: a.decision }); const l = liveNow.get(`t${a.tool_use_id}`); if (l?.asking) { l.asking = false; $.ui.invalidate('ui.render') } }
    if (e.event === 'hook_execution_complete') {
      const run = lastRun = { t: Date.now(), event: String(a.hook_event ?? ''), errors: Number(a.num_non_blocking_error) || 0, cancelled: Number(a.num_cancelled) || 0 }
      // the count is this session's: /clear and resume start it over, here and at load(). A record can land before the new session's
      // first load (its SessionStart hooks run first), so it asks the id itself. The plugins and MCP servers stay: the process loaded them once
      try { const sid = await $.session.id(); if (sid !== setup.runsOf) { setup.runs.clear(); setup.runsOf = sid } } catch {}
      const r = setup.runs.get(run.event) ?? { n: 0, ms: 0, errors: 0, cancelled: 0 }
      setup.runs.set(run.event, { n: r.n + 1, ms: r.ms + (Number(a.total_duration_ms) || 0), errors: r.errors + run.errors, cancelled: r.cancelled + run.cancelled })
    }
    if (e.event === 'plugin_loaded' && a['plugin.name']) setup.plugins.set(String(a['plugin.name']), { version: a['plugin.version'], scope: a['plugin.scope'], hooks: a.has_hooks === true || a.has_hooks === 'true', mcp: a.has_mcp === true || a.has_mcp === 'true' })
    if (e.event === 'mcp_server_connection' && a.server_name) { // a close keeps the time it took to connect: its own duration is the connection's life
      const was = setup.mcp.get(String(a.server_name))
      setup.mcp.set(String(a.server_name), { status: String(a.status ?? ''), ms: a.status === 'disconnected' ? was?.ms : Number(a.duration_ms) || undefined, transport: a.transport_type, error: a.error })
    }
    if (e.event === 'permission_mode_changed' && a.to_mode) setup.mode = String(a.to_mode)
    try { const x = harnessOf(e.event, a); if (x) push($, x, { start: x.ms != null ? Date.now() - x.ms : undefined }) } catch {}
    if (e.event === 'api_request' && String(a.query_source ?? '').startsWith('repl_main_thread')) streamEnd = Date.now()
    if (e.event === 'api_request') try {
      const sig = [a.input_tokens, a.cache_read_tokens, a.cache_creation_tokens, a.output_tokens].map(Number).join()
      const bill = { t: Date.now(), sig, cost: Number(a.cost_usd) || undefined, req: typeof a.request_id === 'string' ? a.request_id : undefined }
      const s = unbilled.find(u => u.sig === sig)
      if (!s) bills = [...bills.filter(b => bill.t - b.t < 60000).slice(-19), bill]
      else { // the step's row is in, or queued ahead of this on the chain
        unbilled = unbilled.filter(u => u !== s)
        mutate(async () => { const y = entries.findLast(y => y.kind === 'step' && y.step === s.key); if (y) { y.cost = bill.cost; y.req = bill.req; touch($) } }).catch(() => {})
      }
    } catch {}
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const began = Date.now() // before ready: a fresh instance's first load can take longer than the gap to a parallel call
    await ready($)
    closed.add(e.agentId ?? 'main')
    const detail = String(detailOf(e)).replace(/\s+/g, ' ').slice(0, 400)
    const cmd = e.tool === 'Bash' && e.command ? scrub(e.command).slice(0, 400) : undefined // newlines kept so heredocs stay readable in the inspector; 400 = the old detail cap, keeping the store budget
    const t0 = Date.now()
    const step = e.tool_use_id ? stepOf.get(e.tool_use_id) : undefined
    if (e.tool_use_id) { loopOf.set(e.tool_use_id, e.agentId); stepOf.delete(e.tool_use_id) }
    const now = `t${e.tool_use_id ?? t0}`
    liveNow.set(now, { t: began, loop: e.agentId, row: { kind: 'tool', name: e.tool, detail, outcome: '', cmd, agent: e.agentId } })
    $.ui.invalidate('ui.render')
    // where the call runs: asked before it runs (a Bash `cd` moves the cwd) and in this hook (a subagent's own cwd), not awaited
    // ahead of it. Unanswered, the row is not tagged
    const place = Promise.all([$.session.root(), $.session.cwd(), homeOf($)]).catch(() => undefined)
    const r = await next(e).finally(() => { if (e.tool_use_id) loopOf.delete(e.tool_use_id); liveNow.delete(now) })
    const v = e.tool_use_id ? checks.get(e.tool_use_id) : undefined
    const pre = e.tool_use_id ? preCtx.get(e.tool_use_id) : undefined // classic.PreToolUse ran inside next
    const hookBlocked = !!e.tool_use_id && blockedUse.delete(e.tool_use_id)
    const at = e.tool_use_id ? checkedAt.get(e.tool_use_id) : undefined, d = e.tool_use_id ? decided.get(e.tool_use_id) : undefined
    if (e.tool_use_id) { checks.delete(e.tool_use_id); preCtx.delete(e.tool_use_id); checkedAt.delete(e.tool_use_id); decided.delete(e.tool_use_id) }
    const wait = at != null && d && d.t - at >= WAIT ? d.t - at : undefined
    // main's message closed between the check and the call's end: the decision waited for it. Not up to the decision: the engine
    // records the request a few ms after deciding. Main's next request starts only once its calls end, so none closes in between
    // by chance. Anything else is named by the decision's source alone: `user_temporary`, `user_reject` and their kin are the person
    // Auto mode's classifier answers as `config`, as a rule does, but a rule takes a millisecond and the classifier a model request:
    // a config decision that waited, in auto mode, is the classifier's. Its refusal names it in the error result
    const text = typeof r.text === 'string' ? r.text : '', refused = d?.decision === 'reject' || (!!r.isError && DENIED.test(text))
    const classified = CLASSIFIED.test(text) || (d?.source === 'config' && wait != null && setup.mode === 'auto')
    const waitFor = wait == null ? undefined : !e.agentId && streamEnd >= at! && streamEnd <= Date.now() ? STREAMING
      : d?.source?.startsWith('user') ? ASKED : classified ? 'the auto-mode classifier' : `the permission decision${d?.source ? ` (${d.source})` : ''}`
    const sp = e.tool === 'Agent' ? spawned.find(s => s.use === e.tool_use_id) : undefined // the spawn ran inside next
    if (sp) spawned = spawned.filter(s => s !== sp)
    // a rejected decision is a refusal, whether it reaches the call as a deny or as the error result the model reads
    const outcome = r.deny || refused ? 'deny' : r.isError ? 'error' : 'ok'
    const why = CLASSIFIED.test(text) ? classifierWhy(text) : refused && DENIED.test(text) ? deniedWhy(text)
      : r.deny ? peek(r.deny) ?? peek(v?.reason) : r.isError ? peek(r.text) : undefined // only failures keep text: an ok result can be a whole file
    const ins = r.isError && !r.deny && !refused && !hookBlocked && text ? insightOf(cmd, text) : undefined // refused: it never ran, so no output to boil down
    const status: Status = r.deny || refused || hookBlocked ? 'denied' : ins?.quiet ? 'nomatch' : r.isError ? 'failed' : 'ok'
    const pl = await place, a = e as any
    const out = pl ? outsideOf(e.tool, { path: a.file_path ?? a.notebook_path ?? a.path, cmd }, ...pl) : undefined
    try { push($, { kind: 'tool', name: e.tool, detail, outcome, status, agent: e.agentId, ms: r.deny ? undefined : Date.now() - t0 - (wait ?? 0), wait, waitFor, peek: why, cmd, check: v?.check, rule: v?.rule, exit: ins?.exit, insight: ins?.text || undefined, child: sp?.id, use: e.tool_use_id, step, via: classified ? 'classifier' : d?.source, out }, { ahead: pre, start: began }) } catch {} // logger never breaks the call
    return r
  })

  // Each model request as it streams: when the first thinking, text or call arrived, how long it thought, the start of what it
  // wrote and thought, the calls it asked for. One `step` row at its end, placed at its start. Chunks pass on untouched, and a
  // chunk costs a kind check and a timestamp (the hook's budget counts its own code, not the stream it waits on). A stream closed
  // before its end is an interrupt (the event log holds steps that entered and never exited); one that threw, a failure
  on('turn.step', async function* ($, e, next) {
    const t0 = Date.now(), key = `${e.turnId.slice(0, 8)}:${e.index}`, me = `s${key}`
    const now: Live = { t: t0, loop: e.agentId, model: e.model, phase: 'waiting' }
    liveNow.set(me, now)
    $.ui.invalidate('ui.render')
    let ttft: number | undefined, think = 0, since: number | undefined, text = '', thought = '', r: TurnStepResult | undefined, err: unknown
    const asked: string[] = []
    // a redraw per phase, not per chunk: tick's poll counts the time up
    const phase = (p: NonNullable<Live['phase']>, said?: string) => { now.said = said; if (now.phase !== p) { now.phase = p; $.ui.invalidate('ui.render') } }
    const s = next(e)
    try {
      for await (const c of s) {
        if (c.kind !== 'engine' && c.kind !== 'stop') {
          const t = Date.now()
          ttft ??= t - t0
          if (c.kind === 'thinking') { since ??= t; if (thought.length < PEEK) thought += c.text; phase('thinking', first(thought)) }
          else {
            if (since != null) { think += t - since; since = undefined }
            if (c.kind === 'text') { if (text.length < PEEK) text += c.text; phase('writing', first(text)) }
            if (c.kind === 'tool') { asked.push(c.name); stepOf.set(c.id, key); if (stepOf.size > 200) stepOf.delete(stepOf.keys().next().value!); now.tool = c.name; phase('calling') }
          }
        }
        yield c
      }
      r = await s.result
    } catch (x) { err = x; throw x } finally {
      liveNow.delete(me)
      try {
        const end = Date.now()
        if (since != null) think += end - since
        const u = r?.usage
        const tok = u ? [u.input_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens, u.output_tokens] : undefined
        const sig = tok?.join(), b = sig ? bills.find(b => b.sig === sig) : undefined
        if (b) bills = bills.filter(x => x !== b); else if (sig) unbilled = [...unbilled.slice(-19), { t: end, sig, key }]
        const aborted = next.signal.aborted || (!r && !err) // closed early: the person interrupted, or the engine dropped the stream
        const status: Status = aborted ? 'aborted' : err ? 'failed' : stepStatus(r?.stopReason)
        const names = r ? r.toolUses.map(u => u.name) : asked
        const server = r?.serverToolUses?.map((u): [string, number | null] => [u.name, u.endedAt != null ? u.endedAt - u.startedAt : null]) // $.clock.now() ms: only their difference means anything here
        const said = r ? r.answer : text
        if (!e.agentId) { setup.model = e.model; setup.effort = e.effort }
        push($, { kind: 'step', name: e.model, detail: '', outcome: '', status, agent: e.agentId, ms: end - t0, step: key, effort: e.effort, ttft, think: think || undefined,
          stop: r?.stopReason ?? undefined, tok, asked: names.length ? names : undefined, server: server?.length ? server : undefined, cost: b?.cost, req: b?.req,
          thought: first(thought).replace(/^#+\s*|\*\*|__/g, '').slice(0, 200) || undefined, // its first line: a summary's title, and the store's budget
          peek: peek(said) ?? (err ? peek(err instanceof Error ? err.message : String(err)) : undefined) }, { start: t0 })
      } catch {}
    }
    return r
  })

  // What the engine reports happening: a row of its own, whether or not a hook is set on the event. Not repeated is what another row
  // already tells: a cwd change (the environment update's row), a CLAUDE.md loading (the memory row), a permission prompt (the call's
  // wait and its ● line), auto mode's denial (the call's denied row), and tool calls, prompts, agents and sessions (their own rows)
  const eventOf = (e: any, at: (p: string) => string): Omit<Entry, 't'> | undefined => {
    const agent: string | undefined = e.agent_id, ev = (name: string, detail?: string | null, outcome?: string | null, more: Partial<Entry> = {}): Omit<Entry, 't'> => ({ kind: 'event', name, detail: String(detail ?? ''), outcome: String(outcome ?? ''), agent, ...more })
    switch (e.hook_event_name) {
      case 'PostModelSwitch': return ev('model switch', `${e.from_model} → ${e.to_model}`, e.source, { peek: `${num(Number(e.context_tokens) || 0)} tokens of context; the prompt cache was ${e.prompt_cache_warm ? 'warm' : `cold, so the next request writes it again (~$${(Number(e.estimated_cache_write_usd) || 0).toFixed(2)})`}` })
      case 'StopFailure': return ev('turn failed', e.error, '', { status: 'failed', peek: peek(e.error_details) })
      case 'PostCompact': { const t = compactAt.get(agent ?? 'main'); compactAt.delete(agent ?? 'main'); return ev('compacted', e.trigger, '', { ms: t != null ? Date.now() - t : undefined, peek: peek(e.compact_summary) }) }
      case 'ConfigChange': return ev('settings changed', e.file_path ? at(e.file_path) : e.source, e.file_path ? e.source : '')
      case 'DirectoryAdded': return ev('directory added', at(e.directory ?? ''), e.source)
      case 'WorktreeCreate': return ev('worktree created', e.name)
      case 'WorktreeRemove': return ev('worktree removed', at(e.worktree_path ?? ''))
      case 'Elicitation': return ev('MCP question', e.mcp_server_name, e.mode, { peek: peek(e.message) })
      case 'ElicitationResult': return ev('MCP answer', e.mcp_server_name, e.action)
      case 'UserPromptExpansion': return ev('command', `/${e.command_name}`, e.command_source) // not its args: your own typing
      case 'TaskCreated': return ev('task created', e.task_subject, e.teammate_name)
      case 'TaskCompleted': return ev('task completed', e.task_subject, e.teammate_name)
      case 'TeammateIdle': return ev('teammate idle', e.teammate_name, e.team_name)
      case 'Notification': return ev('notification', e.notification_type, '', { peek: peek(e.message) })
      case 'FileChanged': return ev('file changed', at(e.file_path ?? ''), e.event)
      case 'Setup': return ev('setup', e.trigger)
    }
    return undefined
  }

  // every classic event; one that changed nothing (or only added context, logged again as its attachment) ranks debug unless slow
  on('classic.*', async ($, e: any, next) => {
    if (e.hook_event_name === 'SessionStart' && (e.source === 'resume' || e.source === 'fork')) {
      await mutate(() => load($)).catch(() => {}) // a /resume inside this process switches the key: match against the resumed session's counts
      if (!Object.keys(seen).length) { owed = {}; blind = true; closed.clear() } // store pruned: the history is unknown, so its replay is muted whole
    }
    if (/^Subagent(Start|Stop)$/.test(e.hook_event_name) && e.agent_id && !started.has(e.agent_id)) {
      names[e.agent_id] ??= e.agent_type || 'fork'
      // before next: the fork's $.model.fork resolves right after this event, and the model.fork hook looks for it then
      if (e.hook_event_name === 'SubagentStop' && !e.agent_type) stops = [...stops.slice(-19), { id: e.agent_id, t: Date.now(), text: e.last_assistant_message }]
    }
    if (!e.agent_id && e.permission_mode) setup.mode = e.permission_mode // main's; a subagent's may differ
    if (e.hook_event_name === 'Stop' && !e.agent_id) setup.bg = { tasks: e.background_tasks ?? [], crons: e.session_crons ?? [] }
    if (e.hook_event_name === 'PreCompact') compactAt.set(e.agent_id ?? 'main', Date.now())
    if (e.hook_event_name === 'PermissionRequest') { // the prompt is up: the call's ● line says so until the decision lands
      const l = [...liveNow.values()].find(l => l.row?.name === e.tool_name && (l.loop ?? '') === (e.agent_id ?? '') && !l.asking)
      if (l) { l.asking = true; $.ui.invalidate('ui.render') }
    }
    const t0 = Date.now()
    const r: any = await next(e)
    const ms = Date.now() - t0
    // $HOME shortened to ~ in the paths a row shows
    const home = e.file_path || e.directory || e.worktree_path ? await $.env.get('HOME').catch(() => undefined) : undefined
    const at = (p: string) => home && p.startsWith(home + '/') ? '~' + p.slice(home.length) : p
    try { const x = eventOf(e, at); if (x) push($, x, { start: x.ms != null ? Date.now() - x.ms : t0 }) } catch {}
    const blocked = r?.deny ?? r?.block // classic.PreToolUse answers deny, every other classic event block
    const ctx: string[] = r?.additionalContext ?? []
    const event = e.hook_event_name ?? 'PreToolUse' // classic.PreToolUse's envelope is tool.call's, which names no event
    if (event === 'PreToolUse' && e.tool_use_id && blocked) blockedUse.add(e.tool_use_id)
    if (event === 'PostToolUse' && e.tool_use_id && ctx.length) postCtx = [...postCtx.slice(-19), { use: e.tool_use_id, tool: e.tool_name, agent: e.agent_id, n: ctx.length }]
    if (event === 'PreToolUse' && e.tool_use_id && ctx.length) preCtx.set(e.tool_use_id, ctx.length) // one attachment per entry
    const outcome = blocked ? 'block' : ctx.length ? `context x${ctx.length} ${kb(ctx.join('').length)}` : r?.preventContinuation ? 'stop' : ''
    // InstructionsLoaded/FileChanged: which file, and why it loaded
    const detail = String(e.tool_name ?? e.tool ?? e.source ?? e.reason ?? [e.load_reason, e.file_path && at(e.file_path)].filter(Boolean).join(' ')).slice(0, 120) // no e.prompt: that is the person's prompt
    // settings hooks that exited with an error or that the engine cancelled (a timeout), as the collector counted them: a red row,
    // even when the rest of the event changed nothing. Only with OTEL export on
    const run = lastRun && lastRun.event === event && lastRun.t >= t0 ? lastRun : undefined
    const broke = run ? [run.cancelled && `${run.cancelled} cancelled`, run.errors && `${run.errors} failed`].filter(Boolean).join(', ') : ''
    const said = (typeof blocked === 'string' ? blocked : ctx.join('\n')) || broke // the block reason, else the context the hooks added, else what broke
    // classic.PreToolUse's e is the tool.call envelope: `tool`, no `tool_name` or `hook_event_name`
    const cfg = await hooksOf($), target = e.tool ?? e.tool_name ?? e.source ?? e.trigger ?? e.reason
    // each context entry is one hook's, named in its own first line
    const name = typeof blocked === 'string' || ctx.length < 2 ? hookName(cfg, event, target, said) : [...new Set(ctx.flatMap(c => hookName(cfg, event, target, c).split(', ')))].join(', ')
    if (!name && !outcome && !broke && ms < SLOW) return r // the event fired, but no hook is set on it: most events, most of the time
    // every classic event but PreToolUse names its loop (agent_id); PreToolUse's comes from the call it runs inside (loopOf)
    try { push($, { kind: 'hook', name: name || `${event} hook`, origin: event, detail, outcome, status: broke && !outcome ? 'failed' : undefined, src: 'hook', agent: e.agent_id ?? (e.tool_use_id ? loopOf.get(e.tool_use_id) : undefined), ms, peek: peek(said), use: e.tool_use_id }) } catch {}
    return r
  })

  // what reaches the model outside the typed prompt: first-message context blocks (claudeMd, a plugin's own) and engine-injected
  // attachments. The other core blocks reach it as attachments (SENT_AS_ATTACHMENT) and log there
  on('prompt.context', async ($, e, next) => {
    const r = await next(e)
    await ready($)
    for (const b of r.blocks) try {
      if (SENT_AS_ATTACHMENT.has(b.name)) continue // before replayed: never counted in `seen`
      if (replayed($, sigOf(b.name, undefined, undefined, b.text.length))) continue
      if (b.name === 'claudeMd') memBytes = b.text.length
      push($, { kind: 'prompt', name: label(b.name), type: b.name, detail: '', outcome: kb(b.text.length), src: 'engine', bytes: b.text.length, peek: peek(b.text) }) } catch {}
    return r
  })
  on('prompt.attachment', async ($, e, next) => {
    const r = await next(e)
    // a PostToolUse hook's context takes the first call waiting for one, even when left out of the request below: its place in
    // the queue is spent either way, or the next attachment of that tool would fold under this one's call
    const post = e.origin.kind === 'hook' && e.origin.event === 'PostToolUse' ? takePost((r.text ?? e.text ?? '').trimStart().match(/^\w+:(\S+) hook\b/)?.[1], e.agentId) : undefined
    if (r.text == null) return r // left out of the request: never entered the context
    await ready($)
    const origin = e.origin.kind === 'engine' ? undefined : e.origin.event
    if (await copied($, e.agentId, e.type, origin, r.text.length)) return r // a fork's copy of main's history: in its context, but not new
    if (replayed($, sigOf(e.type, origin, e.agentId, r.text.length), e.agentId)) return r // counted before the skips below, so noisy and skipped kinds replay-match too
    if (e.type === 'instructions' && r.text.length === memBytes) { memBytes = undefined; return r } // same bundle as the claudeMd block: log it once. One skip only, so a later re-injection (e.g. after compaction) still shows
    // the hook's name; its event shows in the inspector. The engine's framing carries the target: `PreToolUse:Bash hook additional context:`
    const target = r.text.trimStart().match(/^\w+:(\S+) hook\b/)?.[1]
    const name = e.origin.kind === 'hook' ? hookName(await hooksOf($), e.origin.event, target, r.text) || `${e.origin.event} hook`
      : origin ? `${origin} ${label(e.type)}` : label(e.type)
    const text = e.type === 'queued_command' ? undefined : peek(r.text) // a queued prompt is the person's own typing
    try { push($, { kind: 'prompt', name, type: e.type, origin, detail: '', outcome: kb(r.text.length), src: e.origin.kind, bytes: r.text.length, agent: e.agentId, peek: text, use: post }, { above: e.origin.kind === 'hook' && e.origin.event === 'PreToolUse' ? target : undefined, after: e.origin.kind === 'hook' && e.origin.event === 'PostToolUse' ? target : undefined }) } catch {}
    return r
  })

  // the system prompt: one row for the engine's sections (ids and sizes, no text), one per plugin-added section; again only when its shape changes
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    await mutate(() => load($)).catch(() => {}) // switch to a /clear'd or resumed session first: its load empties `composed`
    const sig = r.sections.map(s => `${s.id}:${s.text.length}`).join() + `|${e.outputStyle?.name ?? ''}`
    if (composed.has(sig)) return r
    composed.add(sig)
    try {
      const own = r.sections.filter(s => !s.id.includes(':')) // a bare id is the engine's, `<plugin>:<name>` a plugin's
      const bytes = own.reduce((n, s) => n + s.text.length, 0)
      push($, { kind: 'prompt', name: 'system prompt', type: 'system_prompt', detail: '', outcome: kb(bytes), src: 'engine', bytes, peek: peek(own.map(s => `${s.id} ${tok(s.text.length)}`).join(', ') + (e.outputStyle ? ` · output style ${e.outputStyle.name}` : '')) })
      for (const s of r.sections) if (s.id.includes(':')) push($, { kind: 'prompt', name: s.id, type: 'system_prompt', detail: '', outcome: kb(s.text.length), src: 'plugin', bytes: s.text.length, peek: peek(s.text) })
    } catch {}
    return r
  })

  on('skill.prompt', async ($, e, next) => {
    const r = await next(e)
    try { push($, { kind: 'prompt', name: `skill ${e.skill}`, type: 'skill_prompt', detail: '', outcome: kb(r.text.length), src: 'engine', bytes: r.text.length, peek: peek(r.text) }) } catch {}
    return r
  })

  on('prompt.submit', async ($, e, next) => {
    if (!OWN.has(e.origin.kind)) return next(e)
    if (e.turnId) { const r = await next(e); if (!('drop' in r && r.drop)) pending++; return r }
    const t = Date.now() // the turn's start: its UserPromptSubmit hooks run inside next
    await mutate(async () => { await load($); turnNo++; touch($) }).catch(() => {}) // before next: the UserPromptSubmit hooks it runs belong to the new number
    const r = await next(e)
    if ('drop' in r && r.drop) mutate(async () => { turnNo--; touch($) }).catch(() => {}) // a dropped prompt never entered
    else { busy = true; turnAt = t }
    return r
  })

  // usage as the engine measures it: context, rate limits and cost, for the setup row
  on('session.measure', async ($, e, next) => {
    setup.cost = e.cost?.usd; setup.limits = [...e.rateLimits]; setup.context = { tokens: e.context.tokens, window: e.context.window, percent: e.context.percent }
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    refreshSetup($).catch(() => {})
    try { await $.command.register({ name: 'agentlog', description: `Toggle the agent log pane; "clear" empties it, "${SHOWN.join('|')}" picks a view, "level debug|info|notice|error" the least important row shown.`, argumentHint: `[clear|${SHOWN.join('|')}|level <debug|info|notice|error>]` }) } catch {} // throws on hot reload: no session bound yet
    if (e.isInteractive) { await $.ui.open({ id: PANE, title: 'Agent log' }); startPoll($) }
    try {
      await prune($)
      // session.start fires once per process, then again on each fresh load of this plugin (a reload, an enable, a worker
      // respawn): only the first is the session beginning. No flag says which, so the first marks it in $.state (declared in state.d.ts)
      const started = { plugin: 'agent-log', key: 'started' } as const
      const again = (await $.state.get(started).catch(() => undefined))?.value === true
      if (!again) await $.state.set(started, true).catch(() => {})
      push($, again ? { kind: 'session', name: 'reload', detail: '', outcome: '' } : { kind: 'session', name: 'start', detail: e.cwd, outcome: '' })
    } catch {}
    return next(e)
  })

  // compaction drops a loop's past attachments from its history, so a later replay no longer asks them: forget their counts
  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (!('skip' in r)) {
      await ready($)
      const a = e.agentId ?? ''
      for (const g of Object.keys(seen)) if (g.split('|')[2] === a) delete seen[g]
      touch($)
    }
    return r
  })

  on('session.end', async ($, e, next) => {
    owed = undefined
    try { await flush($) } catch {} // the last second of entries, before the process goes
    return next(e)
  })

  on('command.run', { command: 'agentlog' }, async ($, e) => {
    if (e.args.trim() === 'clear') {
      await mutate(async () => {
        await load($)
        entries = [] // `seen` stays: clearing the log takes nothing out of the model's context
        expanded.clear()
        await $.store.set(key, saved())
        $.ui.invalidate('ui.render')
      })
      return { text: 'agent log cleared' }
    }
    const up = (await $.ui.panes()).some((p: any) => p.id === PANE)
    const arg = e.args.trim()
    const lv = /^level\s/.test(arg) ? LEVELS.indexOf(arg.replace(/^level\s+/, '') as any) : -1
    if (arg && !SHOWN.includes(arg as View) && lv < 0) return { text: `usage: /agentlog [clear|${SHOWN.join('|')}|level ${LEVELS.join('|')}]` } // a typo must not toggle the pane shut
    if (arg) { // set, not toggled: the command names the view or level it wants
      if (lv >= 0) level = lv; else view = arg as View
      follow = true
      if (!up) { await $.ui.open({ id: PANE, title: 'Agent log', focus: true }); startPoll($) }
      $.ui.invalidate('ui.render')
      return { text: lv >= 0 ? `agent log: level ${LEVELS[lv]}` : `agent log: ${arg} view` }
    }
    if (up) { await $.ui.close({ id: PANE }); timer?.cancel(); timer = undefined }
    else { await $.ui.open({ id: PANE, title: 'Agent log', focus: true }); startPoll($) }
    return { text: up ? 'agent log hidden' : 'agent log shown' }
  })

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (r.agentId) {
      names[r.agentId] = tagOf(names, e.subagentType, id => id !== r.agentId && linked(id)); started.set(r.agentId, Date.now()); if (e.fork) forks.add(r.agentId)
      if (e.tool_use_id) spawned = [...spawned.slice(-19), { use: e.tool_use_id, id: r.agentId }]
      $.ui.invalidate('ui.render')
    }
    return r
  })

  // A plugin's own model call ($.model.complete): one row, under main, named by the plugin; its reply's start, never its prompt.
  // The collector records none of these (none of 100 in the event log carried an api_request), so nothing logs it twice
  on('model.complete', async ($, e, next) => {
    const t0 = Date.now()
    const r: any = await next(e)
    try {
      const by = next.origin.plugin.replace(/^cc-plugin-/, '')
      const v = r?.value ?? r, u = v?.usage
      if (v && by !== 'agent-log') push($, { kind: 'side', name: by, src: 'plugin', detail: e.model, outcome: '', status: v.isAnswered ? 'ok' : v.reason === 'aborted' ? 'aborted' : 'failed', ms: Date.now() - t0,
        tok: u ? [u.input_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens, u.output_tokens] : undefined, peek: peek(v.isAnswered ? v.text : [v.reason, v.status, v.error?.message].filter(Boolean).join(' ')) }, { start: t0 })
    } catch {}
    return r
  })

  // A plugin's $.model.fork runs a loop of its own (rows under its id, then a SubagentStop) and raises no agent.spawn. One row for the
  // fork, under main; the fork's id is the SubagentStop that came in while it ran, its last message the reply
  on('model.fork', async ($, e, next) => {
    const t0 = Date.now()
    const r: any = await next(e)
    try {
      const v = r?.value
      if (!v || v.reason === 'nothing-to-fork') return r // denied, or no request made
      const by = next.origin.plugin.replace(/^cc-plugin-/, '') // built-ins are named cc-plugin-<name>
      const mine = stops.filter(s => s.t >= t0)
      const s = (v.isAnswered && mine.find(s => s.text?.trim() === v.text.trim())) || (mine.length === 1 ? mine[0] : undefined)
      if (s) { names[s.id] = by; stops = stops.filter(x => x !== s) }
      const cost = costOf(v.usage)
      const status: Status = v.isAnswered ? 'ok' : v.reason === 'aborted' ? 'aborted' : 'failed'
      // no agent: a fork always forks main's transcript, and the op says nothing of the loop whose hook called it
      push($, { kind: 'fork', name: by, detail: '', outcome: cost, status, ms: Date.now() - t0, peek: peek(v.isAnswered ? v.text : [v.reason, v.status, v.error].filter(Boolean).join(' ')) })
    } catch {}
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    await ready($)
    closed.add(e.agentId ?? 'main')
    const status: Status = e.isAborted ? 'aborted' : e.reason === 'answer' ? 'ok' : 'failed' // an API error or a refusal ended it
    // a spawned agent keeps its cost and answer for its Agent row's inspector (linked: a foreground agent ends before its Agent row
    // is pushed). Main's and a plugin fork's are shown nowhere: a fork's reply already sits on its fork row
    const mine = !!e.agentId && linked(e.agentId)
    try { push($, { kind: 'turn', name: 'turn', detail: '', outcome: mine ? costOf(e.usage) : '', status, agent: e.agentId, ms: e.durationMs, peek: mine ? peek(e.answer) : undefined }) } catch {} // a closing boundary per loop; push redraws
    // main's split, once its rows are in (queued behind the push): kept on its turn row, so a full log evicting them loses nothing
    if (!e.agentId) mutate(async () => {
      const y = entries.findLast(z => z.kind === 'turn' && !z.agent)
      if (y?.ms != null) { y.split = splitOf(entries.filter(z => z.turn === y.turn), y.t - y.ms, y.t); touch($) }
    }).catch(() => {})
    if (!e.agentId) { busy = false; turnAt = undefined }
    if (!e.agentId && pending) mutate(async () => { await load($); turnNo += pending; pending = 0; touch($) }).catch(() => {}) // queued after the push, so the turn row keeps its number
    return r
  })

  // The person's moves shift the log's own window (win) and never the engine's, so the header above the rows stays put (d.ts
  // ui.scroll: a hook drawing its own rows under a header moves them by e.by and invalidates). The tree fits the body, so the
  // engine reports Home and End as contentRows: about a page; j still jumps to the newest row
  on('ui.scroll', { requestId: PANE }, async ($, e, next) => {
    if (inspect || page) return next(e) // the inspector and the setup page wrap text, so their height is unknown: the engine scrolls them
    if (e.origin.kind === 'person') {
      win = Math.max(0, Math.min(winMax, win + e.by)); follow = win >= winMax // the render decides again with the rows it draws
      $.ui.invalidate('ui.render')
      return {}
    }
    return next({ ...e, offset: 0 }) // back's reset of the window the inspector moved: to the top, where it stays
  })

  // === PANE ===
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e) // other plugins' panes
    await load($)
    const { Box, Text, Button } = $.ui.resolve(e)
    const out = ([s, c]: [string, string?]) => s ? <Text color={c} dimColor={!c}>  {s}</Text> : null
    // back to the row the inspector opened from, or the fold that holds it, centred by the next draw; gone (evicted) -> the end
    const back = () => {
      if (inspect && pageBack) { inspect = undefined; page = 'setup'; pageBack = false; backTo = undefined; $.ui.invalidate('ui.render'); $.ui.scroll({ in: PANE, to: 'start' }).catch(() => {}); return }
      const key = backTo && where.get(backTo)
      inspect = undefined; page = undefined; pageBack = false; backTo = undefined; backKey = key; follow = !key; $.ui.invalidate('ui.render')
      $.ui.scroll({ in: PANE, to: 'start' }).catch(() => {}) // the engine's window, which the inspector may have moved
    }
    const inspector = async (x: Entry) => {
      const a = x.agent ? ((await $.agent.list().catch(() => [])) as AgentInfo[]).find(y => y.id === x.agent) : undefined
      const who = x.agent ? (a ? `${nameOf(a.id)} · ${a.description}` : `${names[x.agent] ?? 'subagent'} ${x.agent}`) : 'main loop'
      const end = runs(x.child).at(-1) // an Agent row's agent's last run
      const what =
        x.kind === 'turn' ? `A turn of the ${who} ended${stat(x) === 'aborted' ? ', aborted' : ''}`
        : x.kind === 'fork' ? `The ${x.name} plugin forked the conversation: one tool-less question over main's transcript, answered in a loop of its own${stat(x) === 'aborted' ? ', cut off when the turn was interrupted' : stat(x) === 'failed' ? ', which got no reply' : ''}`
        : x.kind === 'tool' ? `${x.name} call by the ${who}${stat(x) === 'denied' ? ', refused before it ran' : stat(x) === 'failed' ? ', failed' : stat(x) === 'nomatch' ? ', found nothing' : ''}`
        : x.kind === 'hook' ? `${x.name === x.origin ? 'No hook' : x.name} ran on ${x.origin ?? 'an event'} and ${stat(x) === 'feedback' ? 'sent feedback to the model' : x.outcome.startsWith('block') ? 'blocked it' : x.outcome.startsWith('context') ? 'added context for the model' : x.outcome === 'stop' ? 'stopped the session' : 'changed nothing'}`
        : x.kind === 'prompt' && x.src === 'hook' ? `${label(x.type ?? '')} of a ${x.origin ?? ''} hook, injected into the model's context`
        : x.kind === 'prompt' && x.src === 'plugin' ? `Context a plugin attached on ${x.origin ?? 'a chain'}`
        : x.kind === 'prompt' ? `Text the engine injected into the model's context (${x.type ?? x.name})`
        : x.kind === 'step' ? `A request to ${modelName(x.name)} by the ${who}${x.stop === 'max_tokens' ? ', cut off at the output limit' : stat(x) === 'aborted' ? ', interrupted before it ended'
          : stat(x) === 'denied' ? ', which the model refused' : x.stop === 'model_context_window_exceeded' ? ', over the context window' : stat(x) === 'failed' ? ', which got no response'
          : x.stop === 'end_turn' ? ', which ended the turn' : x.asked ? `, which asked for ${counted(x.asked)}` : ''}`
        : x.kind === 'event' ? `${EVENT_WHAT[x.name] ?? 'Something the engine reported'}${x.agent ? `, in the ${who}` : ''}`
        : x.kind === 'side' ? (x.src === 'plugin' ? `A model call the ${x.name} plugin made ($.model.complete), outside the conversation` : `A model request the engine made on its own (${x.name}), outside the conversation's turns`)
        : `Session ${x.name}`
      // the inspector steps through the rows the log shows, in its order; a row the level hides, through its turn's hidden rows
      const steps = rowsOf.includes(x) ? rowsOf : hidden.get(turnOf(x)) ?? []
      const at = steps.indexOf(x)
      const kv = (k: string, v: string) => <Box key={k} flexDirection="row"><Box flexShrink={0} width={8}><Text dimColor>{k}</Text></Box><Text wrap="wrap">{v}</Text></Box>
      return (
        <Box key="inspect" flexDirection="column" width={e.props.bodyColumns}>
          <Box flexDirection="row" flexWrap="wrap" columnGap={2}>{/* wraps rather than clips: the engine scrolls the inspector, so its height need not be counted */}
            <Button key="back" label="← back" hotkey="b" plain autoFocus onPress={back} />
            {at > 0 && <Button key="prev" label="↑ prev" hotkey="p" plain onPress={() => show(steps[at - 1]!)} />}
            {at >= 0 && at < steps.length - 1 && <Button key="next" label="↓ next" hotkey="n" plain onPress={() => show(steps[at + 1]!)} />}
          </Box>
          <Text> </Text>
          <Box flexDirection="row"><Text weight="semibold">{action(x)}</Text><Text dimColor>  {x.kind === 'tool' ? x.name : toolOf(x)}</Text>{out(cell(x))}</Box>
          <Text dimColor wrap="wrap">{what}</Text>
          <Text> </Text>
          {kv('when', `${x.turn != null ? `${x.turn ? `turn ${x.turn}` : 'session start'} · ` : ''}${new Date(x.t).toLocaleTimeString()} (${ago(Date.now() - x.t)} ago)`)}
          {kv('agent', who)}
          {steps !== rowsOf && kv('hidden', `${at + 1} of ${steps.length} in this turn, below the ${LEVELS[level]} level`)}
          {x.src === 'hook' && x.origin && kv('trigger', [x.origin, x.detail].filter(Boolean).join(' · '))}
          {x.cmd ? kv('command', x.cmd) : x.detail && x.src !== 'hook' && kv(x.name === 'Bash' ? 'command' : 'input', x.detail)}
          {x.cmd && kv('what', x.detail)}
          {x.out && kv('where', `${x.out}, outside the session's project root`)}
          {x.exit != null && kv('exit', String(x.exit))}
          {x.check && kv('decided', `${x.check}${x.rule ? ` by rule ${x.rule}` : x.check === 'ask' ? `, then ${VIA[x.via ?? ''] ?? (x.via ? `by ${x.via}` : 'the mode or you')}` : ' by a mode, hook or the tool\'s own check'}`)}
          {x.ms != null && kv(x.child ? 'call' : 'took', secs(x.ms))}
          {x.wait != null && kv('waited', `${secs(x.wait)} for ${x.waitFor ?? 'the decision'} before it ran, not in took`)}
          {x.kind === 'step' && kv('model', `${x.name}${x.effort != null ? ` · effort ${x.effort}` : ''}`)}
          {x.kind === 'side' && x.detail && kv('model', x.detail)}
          {x.ttft != null && kv('first', `${secs(x.ttft)} to the first token`)}
          {x.think != null && kv('think', secs(x.think))}
          {x.tok && kv('tokens', tokLine(x.tok))}
          {x.cost != null && kv('cost', `$${x.cost.toFixed(4)}`)}
          {x.asked && kv('calls', counted(x.asked))}
          {x.server && kv('server', x.server.map(([n, ms]) => `${n} ${secs(ms ?? undefined)}`).join(', '))}
          {x.stop && kv('stop', x.stop)}
          {x.req && kv('request', x.req)}
          {/* a call's request: the model's time before it, which the call's own row leaves out */}
          {x.kind === 'tool' && x.step && (s => s && kv('asked', `by ${modelName(s.name)} in a ${secs(s.ms)} request${s.thought ? `: ${s.thought}` : ''}`))(entries.find(y => y.kind === 'step' && y.step === x.step))}
          {x.child && kv('ran', ran(x)[0])}
          {/* each hook once: what it said back (blocked, feedback) and whether its text went to the model */}
          {x.kind === 'tool' && x.use && (hs => hs.length > 0 && kv('hooks', [...new Set(hs.map(y => y.name))].map(n => {
            const ys = hs.filter(y => y.name === n), said = ys.find(loud)
            return `${n}${said ? ` (${stat(said)})` : ''}${ys.some(y => y.kind === 'prompt') ? ' · added text' : ''}`
          }).join(', ')))(entries.filter(y => y.use === x.use && y.kind !== 'tool'))}
          {x.kind === 'fork' && x.outcome && kv('tokens', x.outcome)}
          {end?.outcome && kv('tokens', end.outcome)}
          {x.type && x.type !== x.name && kv('type', x.type)}
          {x.insight && (
            <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1} marginTop={1}>
              <Text dimColor>what broke</Text>
              <Text wrap="wrap">{x.insight}</Text>
            </Box>
          )}
          {x.thought && (
            <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1} marginTop={1}>
              <Text dimColor>thought, its first line</Text>
              <Text wrap="wrap">{x.thought}</Text>
            </Box>
          )}
          {x.peek && (
            <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1} marginTop={1}>
              <Text dimColor>{x.kind === 'event' ? 'details' : x.kind === 'step' || x.kind === 'side' ? (stat(x) === 'failed' && !x.stop ? 'error' : x.peek.length >= PEEK ? `reply, first ${PEEK} chars` : 'reply') : x.kind === 'fork' ? (stat(x) === 'ok' ? 'reply' : 'reason') : x.kind === 'tool' ? (stat(x) === 'denied' ? 'reason' : x.peek.length >= PEEK ? `output, first ${PEEK} chars` : 'output') : stat(x) === 'feedback' ? 'feedback' : x.outcome.startsWith('block') ? 'reason' : 'text'}{x.bytes != null && x.bytes > PEEK ? ` (first ${PEEK} of ${x.bytes} chars)` : ''}</Text>
              <Text wrap="wrap">{x.peek}</Text>
            </Box>
          )}
          {end?.peek && (
            <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1} marginTop={1}>
              <Text dimColor>{end.peek.length >= PEEK ? `reply, first ${PEEK} chars` : 'reply'}</Text>
              <Text wrap="wrap">{end.peek}</Text>
            </Box>
          )}
        </Box>
      )
    }
    const jump = () => { follow = true; $.ui.invalidate('ui.render') } // following, the draw pins the window to the end
    // folds stay as they were: a fold's id is its first entry's, the same in every view, level and filter that draws it
    const pick = (id: string) => { only = only === id ? undefined : id; $.ui.invalidate('ui.render') }
    const setView = (v: View) => { view = view === v ? 'all' : v; follow = true; $.ui.invalidate('ui.render') }
    const nextLevel = () => { level = (level + 1) % LEVELS.length; follow = true; $.ui.invalidate('ui.render') }
    const agents: AgentInfo[] = await $.agent.list().catch(() => [])
    // a numbered name (tagOf) wins over the list's type; else the list's, so a teammate still reads `teammate`. ||: an empty type names nothing
    const nameOf = (id: string) => id === 'main' ? 'main' : / #\d+$/.test(names[id] ?? '') ? names[id]! : agents.find(a => a.id === id)?.type || names[id] || 'subagent'
    const kids = new Map<string, AgentInfo[]>()
    const listed = new Set(agents.map(a => a.id))
    // a parent list() does not hold (engine fork, workflow agent) would hide the child: hang it under main
    for (const a of agents) { const p = a.parentId && listed.has(a.parentId) ? a.parentId : 'main'; kids.set(p, [...(kids.get(p) ?? []), a]) }
    const isRootMate = (a: AgentInfo) => a.type === 'teammate' && (kids.get('main') ?? []).includes(a)
    const now = Date.now()
    // The header's agents, each under its parent with its depth; drawn as log rows below (agentRow), so nesting reads by indent.
    // Finished agents fold into the toggle row unless showDone. An agent stays listed while it or one below it runs, and while it is the filter
    const tree: [AgentInfo | typeof TEAM, number][] = []
    const live = (a: AgentInfo): boolean => a.status === 'running' || only === a.id || (kids.get(a.id) ?? []).some(live)
    const done = agents.filter(a => !live(a)).length
    const walk = (all: (AgentInfo | typeof TEAM)[], depth: number) => {
      for (const a of showDone ? all : all.filter(a => a === TEAM ? (kids.get('main') ?? []).filter(isRootMate).some(live) : live(a))) {
        tree.push([a, depth])
        walk(a === TEAM ? (kids.get('main') ?? []).filter(isRootMate) : kids.get(a.id) ?? [], depth + 1)
      }
    }
    const mainKids = kids.get('main') ?? []
    walk([...mainKids.filter(a => !isRootMate(a)), ...(mainKids.some(isRootMate) ? [TEAM] : [])], 0)
    // a spawned agent's rows belong to its Agent row's turn: a background agent can outlive that turn. Sorted by it (stable), so
    // rows that stay flat (a view without the Agent row) keep each turn in one run
    const root = rootOf(entries)
    const turnOf = (x: Entry) => root(x)?.turn ?? x.turn ?? 0
    const runs = (id?: string) => id ? entries.filter(y => y.kind === 'turn' && y.agent === id) : [] // a spawned agent's turn ends: one per run
    const kept = entries.filter(x => (only === undefined || (x.agent ?? 'main') === only) && VIEWS[view](x)).sort((p, q) => turnOf(p) - turnOf(q))
    const shown = kept.filter(x => lvl(x) >= level)
    const rowsOf = shown.filter(x => x.kind !== 'turn')
    // rows the level alone hides, per turn: the header counts them and its `N hidden` opens them in the inspector, which steps
    // through them with prev/next. A turn with none at or above the level draws no header at all
    const hidden = new Map<number, Entry[]>()
    for (const x of kept) if (x.kind !== 'turn' && lvl(x) < level) { const n = turnOf(x); if (!hidden.has(n)) hidden.set(n, []); hidden.get(n)!.push(x) } // turn ends are never drawn
    // a spawned agent's rows fold under its Agent row while that row is drawn; without it (a view or level that hides it, a filter
    // on the agent) they stay flat
    const drawn = new Set(shown)
    const under = new Map<Entry, Entry[]>(), folded = new Set<Entry>()
    // a call's hook rows and the text they injected fold under the call's row while it is drawn, before any agent fold takes them,
    // so inside an agent's fold they still sit under their call. The call hidden (a level, a view): they stay flat
    const callRow = new Map<string, Entry>()
    for (const x of shown) if (x.kind === 'tool' && x.use) callRow.set(x.use, x)
    const hooksUnder = new Map<Entry, Entry[]>()
    for (const x of rowsOf) { const c = x.kind !== 'tool' && x.use ? callRow.get(x.use) : undefined; if (c) { if (!hooksUnder.has(c)) hooksUnder.set(c, []); hooksUnder.get(c)!.push(x); folded.add(x) } }
    // rowsOf: a turn end draws nothing, so it must not open a fold. r === x: a damaged store's spawn cycle; no row folds under itself
    for (const x of rowsOf) { const r = root(x); if (r && r !== x && drawn.has(r) && !folded.has(x)) { if (!under.has(r)) under.set(r, []); under.get(r)!.push(x); folded.add(x) } }
    // autoFocus holds only on a site's first draw, so the ring is moved onto back once the redraw has drawn it
    const show = (x: Entry) => { if (page) pageBack = true; inspect = x; page = undefined; backTo = x; follow = false; $.ui.invalidate('ui.render'); $.ui.scroll({ in: PANE, to: 'start' }).catch(() => {}); $.clock.after(50, () => { $.ui.focus({ requestId: PANE, key: 'back' }).catch(() => {}) }) }
    // One row: disclosure, action (the only bright text, a button: on a fold's row it opens the fold, on any other the inspector),
    // tool, status, duration. The right three cells have fixed widths and the action is cut to what is left, so the description
    // truncates first and the columns line up
    const cols = e.props.bodyColumns ?? 40
    const TOOL = 11, END = 12 // TOOL fits the longest label, a model's: Sonnet 5.5
    const fit = (s: string, n: number) => s.length <= n ? s : s.slice(0, Math.max(0, n - 1)) + '…'
    // mark: drawn in the disclosure's cell when there is none (the header's `›` on the agent the log is filtered to).
    // rail: a fold's tree guides (`│ ├ `), drawn dim in place of the indent. No press: plain text, a line with nothing to open.
    // away: the place outside the project root the row reached, kept in the tail as ` ↗ ~/dir` (its end, when long) so it survives the cut
    type Line = { k: string; act: string; press?: () => void; tool?: string; st?: [string, string?]; who?: string; tail?: string; disc?: [boolean, () => void]; indent?: number; rail?: string; mark?: string; away?: string }
    const line = ({ k, act, press, tool = '', st = [''], who = '', tail = '', disc, indent = 0, rail = ' '.repeat(indent), mark = ' ', away }: Line) => {
      if (away) tail += ` ↗ ${away.length > 32 ? '…' + away.slice(-31) : away}`
      const room = cols - 2 - rail.length - who.length - tail.length - TOOL - END - 1
      return (
        <Box key={k} flexDirection="row" overflow="hidden">
          <Box flexShrink={0} width={2 + rail.length}><Text dimColor>{rail}</Text>{disc ? <Button key={`d${k}`} label={disc[0] ? '▾' : '▸'} plain onPress={disc[1]} /> : <Text>{mark}</Text>}</Box>
          <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">{who ? <Text dimColor>{who}</Text> : null}{press ? <Button key={`b${k}`} label={fit(act, room) + tail} plain onPress={press} /> : <Text wrap="truncate-end">{fit(act, room) + tail}</Text>}</Box>
          <Box flexShrink={0} width={TOOL}><Text dimColor>{fit(tool, TOOL - 1)}</Text></Box>
          <Box flexShrink={0} width={END}><Text color={st[1]} dimColor={!st[1]}>{fit(st[0], END - 1)}</Text></Box>
        </Box>
      )
    }
    // a line of a failure's fold, on its rail; pressed, the failure's inspector
    const note = (k: string, s: string, bright: boolean, rail: string, press: () => void) => <Box key={k} flexDirection="row" overflow="hidden"><Text dimColor>{rail.padEnd(rail.length + 2)}</Text><Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden"><Button key={`b${k}`} label={fit(s, Math.max(1, cols - rail.length - 3))} plain dimColor={!bright} onPress={press} /></Box></Box>
    const total = (xs: Entry[]) => xs.some(x => x.ms != null) ? xs.reduce((n, x) => n + (x.ms ?? 0), 0) : undefined
    // per turn, from every entry whatever the view or level: the loops that acted, and its time (main's turn ends; none yet =
    // still running, shown —). A spawned agent's rows count toward its Agent row's turn (turnOf)
    // ends: main's turn rows (two when a prompt queued in it ran as a turn of its own); xs: every other row, for the split
    type Turn = { agents: Set<string>; ms?: number; aborted: boolean; first?: number; last?: number; ends: Entry[]; xs: Entry[] }
    const turns = new Map<number, Turn>()
    const turnIn = (n: number) => { let m = turns.get(n); if (!m) turns.set(n, m = { agents: new Set<string>(), aborted: false, ends: [], xs: [] }); return m }
    for (const x of entries) {
      const m = turnIn(turnOf(x))
      if (x.kind === 'turn') { if (!x.agent) { m.ms = (m.ms ?? 0) + (x.ms ?? 0); m.aborted ||= stat(x) === 'aborted'; m.ends.push(x) } continue }
      m.xs.push(x)
      if (!hiddenCtx(x)) m.agents.add(x.agent ?? 'main') // a loop whose only rows are hidden context (a fork's first request) shows nothing
      if (!x.agent && x.kind !== 'fork' && x.kind !== 'side') { m.first ??= x.t; m.last = Math.max(m.last ?? 0, x.kind === 'tool' ? x.t + (x.ms ?? 0) + (x.wait ?? 0) : x.kind === 'step' ? x.t + (x.ms ?? 0) : x.t) } // a call's and a step's t is its start. Main's rows only: a fork or a side request logging after the turn would stretch the span (both sit under main)
    }
    // `model 30.1 s · tools 8.2 s · other 1.0 s`, where the turn's time went (splitOf): each turn end's own split, else counted now
    // from the rows still logged; the running turn up to now, a turn whose end was never logged over its rows' span. Parts under
    // 0.1 s are left out; other is the engine's and plugins' own work between steps
    const SHOW = ['model', 'tools', 'agents', 'hooks', 'compact', 'permission', 'you', 'other']
    const splitText = (n: number, m: Turn) => {
      const parts = SPLIT.map(() => 0)
      let span = 0
      const add = (xs: number[], ms: number) => { xs.forEach((v, i) => { parts[i]! += v }); span += ms }
      for (const y of m.ends) if (y.ms != null) add(y.split ?? splitOf(m.xs, y.t - y.ms, y.t), y.ms)
      const from = turnAt ?? m.first
      if (n === turnNo && busy && from != null) add(splitOf(m.xs, from, now), now - from)
      else if (!m.ends.length && m.first != null && m.last! > m.first) add(splitOf(m.xs, m.first, m.last!), m.last! - m.first)
      const by: Record<string, number> = { other: span - parts.reduce((a, b) => a + b, 0) }
      SPLIT.forEach((k, i) => { by[k] = parts[i]! })
      return SHOW.filter(k => by[k]! >= 100).map(k => `${k} ${secs(by[k])}`).join(' · ')
    }
    // one name per kind of loop: a plugin that forks every step names four loops in a turn, `you-should-know ×4`; numbered agents
    // count as their type, `general-purpose ×2`
    const loops = (ids: Set<string>) => {
      const c = new Map<string, number>()
      for (const id of ids) { const n = nameOf(id).replace(/ #\d+$/, ''); c.set(n, (c.get(n) ?? 0) + 1) }
      return [...c].map(([n, k]) => k > 1 ? `${n} ×${k}` : n).join(', ')
    }
    // a turn whose end was never logged (the plugin reloaded mid-turn: a new instance gets no turn.complete for it) shows the span of
    // main's rows, marked ≈ as an estimate; the current turn counts up while it runs (tick redraws), — when its rows are not in yet
    const took = (n: number, m: Turn) => { const from = turnAt ?? m.first; return n === turnNo && busy && from != null ? `running ${secs(now - from)}` : m.ms != null ? secs(m.ms) : n !== turnNo && m.first != null && m.last! > m.first ? `≈ ${secs(m.last! - m.first)}` : '—' }
    // `#2 · model 60.1 s · tools 12.0 s · main, scout · 3 hidden    73.4 s`: the split, the loops only when more than one acted, the
    // count when any row is hidden. The time sits flush right, over the rows' status column, pushed there by a growing spacer; that
    // cell never shrinks, and on a narrow pane the split and loops truncate first
    const header = (n: number, k: string) => {
      const m = turnIn(n), hid = hidden.get(n)?.length // not `h`: that name is the JSX factory, and shadowing it breaks every tag below
      const time = `${m.aborted ? '⚠ ' : ''}${took(n, m)}`
      return (
        <Box key={k} flexDirection="row" overflow="hidden">
          <Box flexShrink={0}><Text weight="semibold">{n ? `#${n}` : 'start'}</Text></Box>
          <Box flexShrink={1} minWidth={0} overflow="hidden"><Text wrap="truncate-end" dimColor>{[splitText(n, m), m.agents.size > 1 ? loops(m.agents) : ''].filter(Boolean).map(s => ` · ${s}`).join('')}</Text></Box>
          {hid ? <Box flexShrink={0}><Text dimColor> · </Text><Button key={`hid${n}`} label={`${hid} hidden`} plain dimColor onPress={() => show(hidden.get(n)![0]!)} /></Box> : null}
          <Box flexGrow={1} flexShrink={0} minWidth={2} />
          <Box flexShrink={0}>
            <Text color={m.aborted ? 'yellow' : undefined} dimColor={!m.aborted}>{time}</Text>
          </Box>
        </Box>
      )
    }
    // Folds, within one turn and one loop: consecutive engine context (`ctx`; a cwd change stands alone), consecutive identical failures or hook runs (`rep`, ×N,
    // each attempt kept inside; one event often fires its hooks several times back to back), consecutive read-only lookups (`look`), consecutive changes to one file (`edit`). Failures never join a lookup or edit fold, so they stay visible when it is closed.
    // Turn ends draw nothing: the turn header carries the time. A group is keyed by its first entry's id (idOf), a row inside by its own.
    // An Agent row that spawned an agent is an `agent` group: its agent's rows (under) fold beneath it, grouped the same way.
    // A fold's row reads short, its count last: `Explore hooks ×5`, `Edit x.ts ×4`, and for context its buckets (bucketsOf),
    // `session start ×6 · capabilities ×4`, each a fold of its own inside; one bucket reads its own row, `files: x.ts, CLAUDE.md`.
    // by: the entry that keys a bucket's fold, its second: its first may be the context fold's own key
    // A call's hook rows and their text fold under it by event (`event`, `PreToolUse ×5`), in run order around the call's own line
    type Group = { kind: 'one' | 'ctx' | 'bucket' | 'event' | 'rep' | 'look' | 'edit' | 'agent'; xs: [Entry, ...Entry[]]; by?: Entry }
    // a call a hook refused or answered with feedback stands alone, so a closed lookup or edit fold never hides that
    const heard = (x: Entry) => (hooksUnder.get(x) ?? []).some(loud)
    const look = (x: Entry) => x.kind === 'tool' && /^(Read|Grep|Glob)$/.test(x.name) && stat(x) === 'ok' && !heard(x)
    const edit = (x: Entry) => x.kind === 'tool' && toolOf(x) === 'Change' && stat(x) === 'ok' && !heard(x)
    const groupsOf = (xs: Entry[]) => {
      const groups: Group[] = []
      xs.forEach(x => {
        if (x.kind === 'turn') return
        if (x.child) { groups.push({ kind: 'agent', xs: [x] }); return }
        const g = groups.at(-1), y = g?.xs[0]
        const near = g && y && turnOf(y) === turnOf(x) && y.agent === x.agent
        if (near && g.kind === 'ctx' && x.src === 'engine' && !envUpdate(x)) g.xs.push(x)
        else if (near && g.kind === 'rep' && x.kind === y.kind && x.name === y.name && x.origin === y.origin && x.detail === y.detail && x.cmd === y.cmd && stat(x) === stat(y) && first(x.peek) === first(y.peek)) g.xs.push(x)
        else if (near && g.kind === 'look' && look(x)) g.xs.push(x)
        else if (near && g.kind === 'edit' && edit(x) && x.detail === y.detail) g.xs.push(x)
        else groups.push({ kind: x.src === 'engine' && !envUpdate(x) && view !== 'context' ? 'ctx' : (x.kind === 'tool' && BAD.has(stat(x))) || x.kind === 'hook' || (x.kind === 'prompt' && x.src === 'hook') ? 'rep' : look(x) ? 'look' : edit(x) ? 'edit' : 'one', xs: [x] }) // the context view is mostly engine entries: folding would leave one row
      })
      return groups
    }
    // an Agent row's cell: its agent's state, not the call's, which a background agent returns from once started. Its turns sum to
    // its run time; one still running counts up (tick redraws). Gone from the list with its turns evicted: —
    const ran = (x: Entry): [string, string?] => {
      if (BAD.has(stat(x))) return cell(x) // refused: no agent ran
      const a = agents.find(y => y.id === x.child)
      if (a?.status === 'running') return [`● ${secs(now - (started.get(a.id) ?? x.t))}`, 'yellow']
      const ts = runs(x.child), ms = total(ts)
      return a?.status === 'failed' || ts.some(y => stat(y) === 'failed') ? [`✗ ${secs(ms)}`, 'red'] : a?.status === 'killed' ? [`■ ${secs(ms)}`]
        : ts.some(y => stat(y) === 'aborted') ? [`⚠ ${secs(ms)}`, 'yellow'] : [secs(ms)]
    }
    const common = (ps: string[]) => { // the deepest folder or file every path shares
      const parts = ps.filter(Boolean).map(p => p.split('/'))
      let k = 0
      while (parts.length && parts.every(p => k < p.length && p[k] === parts[0]![k])) k++
      return parts.length ? parts[0]!.slice(0, k).filter(Boolean).pop() ?? '' : ''
    }
    // a failure opened: the exit code and what broke (insightOf), else its first output line; the stored text sits in the inspector
    const broke = (x: Entry) => {
      const said = x.insight ? x.insight.split('\n') : [first(x.peek)].filter(Boolean)
      const rule = stat(x) === 'denied' && x.rule ? [`rule ${x.rule}`] : []
      return [...rule, ...said].map((s, j) => j === 0 && x.exit != null ? `exit ${x.exit} · ${s}` : s)
    }
    const rows: any[] = []
    const where = new Map<Entry, string>() // each shown entry's drawn row, by its key: its own, else its closed fold's. Back centres it
    const rowAt = (k: string) => rows.findIndex(r => r.props?.key === k)
    const spans = new Map<string, number>() // a group's drawn rows, by its key: how far an opened fold runs, for the window to show it
    const keyOf = (g: Group) => `g${idOf(g.by ?? g.xs[0])}` // a group's own row; its first entry's id keys its fold in expanded
    const inner = (y: Entry) => { const key = `e${idOf(y)}`; where.set(y, key); return key }
    const entryRow = (y: Entry, k: string, rail: string, who = '') => line({ k, act: action(y), press: () => show(y), tool: toolOf(y), st: cell(y), who, rail, away: y.out })
    // a fold's places outside the root: the first, and how many more
    const awayOf = (ys: Entry[]) => { const o = [...new Set(ys.flatMap(y => y.out ? [y.out] : []))]; return o.length ? `${o[0]}${o.length > 1 ? ` +${o.length - 1}` : ''}` : undefined }
    // a call's wait, drawn from its own fields under it; pressed, the call's inspector
    const waitLine = (y: Entry, rail: string) => line({ k: `e${idOf(y)}w`, act: `Waiting for ${y.waitFor ?? 'the decision'}`, press: () => show(y), st: [secs(y.wait)], rail })
    // A group's parts, from the one switch on its kind:
    // - head: its own row, given the press (its fold's toggle when it has one, else the inspector on target) and that disclosure
    // - members: the entries a closed fold stands for, which back lands on
    // - parts: what its fold holds, each drawing its rows on a rail and a fold inside continuing on rest; none, no fold
    // - nested: an agent fold's own groups, which the `o` button (foldsOf) counts too
    // Lazy: counting draws nothing and claims no row in where. Once per group per draw (memo), so an agent's rows are grouped and a
    // failure read once, and the draw and the count see the same nested groups
    type Disc = [boolean, () => void]
    type Parts = { head: (rail: string, who: string, newest: boolean, press: () => void, disc?: Disc) => any; target: Entry; members: Entry[]; parts: ((rail: string, rest: string) => any[])[]; nested: Group[] }
    const memo = new Map<Group, Parts>()
    const partsOf = (g: Group): Parts => {
      const had = memo.get(g)
      if (had) return had
      const x = g.xs[0], k = keyOf(g), n = g.xs.length, last = g.xs[n - 1]!
      let p: Parts
      if (g.kind === 'agent') {
        const body = under.get(x) ?? [], nested = groupsOf(body), reply = first(runs(x.child).at(-1)?.peek)
        const many = new Set(body.map(y => y.agent)).size > 1 // a grandchild shares the fold: rows name their loop
        p = { target: x, members: [x, ...body], nested, // a closed fold's rows: back lands on the fold; drawn ones claim their own
          head: (rail, who, _, press, disc) => line({ k, act: action(x), press, tool: toolOf(x), st: ran(x), who, disc, rail, away: awayOf(body) }),
          // the Agent row's inspector last, where the reply came: the row itself opens the fold
          parts: body.length ? [
            ...nested.map((h, j) => (rail: string, rest: string) => drawGroup(h, rail, rest, many && h.xs[0].agent ? `${nameOf(h.xs[0].agent)} · ` : '', j === nested.length - 1)),
            rail => [line({ k: `${k}i`, act: reply ? `reply: ${reply}` : 'input & result', press: () => show(x), rail })],
          ] : [] }
      } else if (g.kind === 'rep') {
        const why = x.kind === 'tool' ? broke(last) : [] // a hook row already reads `name: what it said`
        p = { target: last, members: g.xs, nested: [],
          head: (rail, who, _, press, disc) => line({ k, act: action(x), tail: n > 1 ? ` ×${n}` : '', press, tool: toolOf(x), st: cell(x, total(g.xs)), who, disc, rail, away: awayOf(g.xs) }),
          parts: [
            ...why.map((s, j) => (rail: string) => [note(`${k}n${j}`, s, j === 0, rail, () => show(last))]),
            ...(hooksUnder.get(last) ?? []).map(y => (rail: string) => [entryRow(y, inner(y), rail)]), // the hook that refused it, beside why
            ...(n > 1 ? g.xs.map((y, j) => (rail: string) => [line({ k: inner(y), act: `${x.kind === 'tool' ? 'attempt' : 'run'} ${j + 1} · ${new Date(y.t).toLocaleTimeString()}${y.exit != null ? ` · exit ${y.exit}` : ''}`, press: () => show(y), st: cell(y), rail })]) : []),
          ] }
      } else if (g.kind === 'event') {
        // a hook that refused or answered the call shows in the event's cell, so the closed fold still says so
        const said = g.xs.find(loud)
        p = { target: x, members: g.xs, nested: [], parts: g.xs.map(y => (rail: string) => [entryRow(y, inner(y), rail)]),
          head: (rail, who, _, press, disc) => line({ k, act: `${x.origin ?? 'hook'} ×${n}`, press, tool: 'Hook', st: said ? cell(said) : [secs(total(g.xs))], who, disc, rail }) }
      } else if (g.kind === 'one' || n === 1) {
        const kids = hooksUnder.get(x) ?? []
        // with hooks the row opens its fold: one line per event, a group of one being its row, and between PreToolUse and the rest
        // the line that opens the call's inspector, as an agent fold's does
        const by = new Map<string, Entry[]>()
        for (const y of kids) by.set(y.origin ?? '', [...by.get(y.origin ?? '') ?? [], y])
        const nested: Group[] = [...by.values()].map((ys): Group => ys.length > 1 ? { kind: 'event', xs: ys as Group['xs'], by: ys[1] } : { kind: 'one', xs: ys as Group['xs'] })
        const own = (rail: string) => [line({ k: `${k}i`, act: x.kind === 'step' ? 'request & reply' : 'input & result', press: () => show(x), rail })]
        const ev = (h: Group) => (rail: string, rest: string) => drawGroup(h, rail, rest, '', false)
        const early = (h: Group) => h.xs[0].origin === 'PreToolUse'
        const pre = nested.filter(early), post = nested.filter(h => !early(h))
        // the wait comes after the check, before the tool runs: between the PreToolUse hooks and the call's own line
        const waited = x.wait != null ? [(rail: string) => [waitLine(x, rail)]] : []
        // a step's calls the API ran itself (the advisor), each its own timed line: inside the request's time, not beside it
        const server = (x.server ?? []).map(([n, ms], j) => (rail: string) => [line({ k: `${k}s${j}`, act: cap(n.replace(/_/g, ' ')), press: () => show(x), tool: 'API', st: [secs(ms ?? undefined)], rail })])
        p = { target: x, members: g.xs, nested,
          parts: kids.length || waited.length || server.length ? [...pre.map(ev), ...waited, ...server, own, ...post.map(ev)] : [],
          head: (rail, who, _, press, disc) => line({ k, act: action(x), press, tool: toolOf(x), st: cell(x), who, disc, rail, away: x.out }) }
      }
      else if (g.kind === 'ctx' && bucketsOf(g.xs).length > 1) {
        const bs = bucketsOf(g.xs)
        const nested: Group[] = bs.map((b): Group => b.xs.length > 1 ? { kind: 'bucket', xs: b.xs as Group['xs'], by: b.xs[1] } : { kind: 'one', xs: b.xs as Group['xs'] })
        p = { target: x, members: g.xs, nested, parts: nested.map(h => (rail: string, rest: string) => drawGroup(h, rail, rest, '', false)),
          head: (rail, who, _, press, disc) => line({ k, act: bs.map(b => b.xs.length > 1 ? `${b.name} ×${b.xs.length}` : b.name).join(' · '), press, tool: 'Engine', who, disc, rail }) }
      }
      else {
        // a member's wait goes just above it, where it happened: the member's own hooks stay in its inspector, as before
        p = { target: x, members: g.xs, nested: [], parts: g.xs.flatMap(y => [...(y.wait != null ? [(rail: string) => [waitLine(y, rail)]] : []), (rail: string) => [entryRow(y, inner(y), rail)]]),
          head: (rail, who, newest, press, disc) => {
            const growing = newest && g.kind === 'look' && (x.agent ? agents.find(a => a.id === x.agent)?.status === 'running' : busy && turnOf(x) === turnNo)
            const one = bucketsOf(g.xs)[0]! // a bucket's fold, or a context fold of one bucket
            const [act, tool, st] = g.kind === 'ctx' || g.kind === 'bucket' ? [one.head === one.name ? `${one.name} ×${n}` : one.head, 'Engine', '']
              : g.kind === 'edit' ? [`${action(x)} ×${n}`, 'Change', secs(total(g.xs))]
              : [`Explore ${common(g.xs.map(y => y.detail)) || 'files'} ×${n}${growing ? ` · ${action(last)}` : ''}`, 'Look', secs(total(g.xs))]
            return line({ k, act, press, tool, st: [st], who, disc, rail, away: awayOf(g.xs) })
          } }
      }
      memo.set(g, p)
      return p
    }
    // One group's rows: its own on the rail `own`; an open fold's below it, each part on `rest` and a twig, `├ ` or the last's `└ `,
    // a fold inside continuing the line (`│ `) while siblings follow it. Pressed, a row with ▸ opens its fold, any other the
    // inspector. newest: the last group of its list, where a lookup fold still growing shows its newest call
    const drawGroup = (g: Group, own: string, rest: string, who: string, newest: boolean): any[] => {
      const { head, target, members, parts } = partsOf(g), id = idOf(g.by ?? g.xs[0]), k = keyOf(g)
      for (const y of members) for (const z of [y, ...hooksUnder.get(y) ?? []]) where.set(z, k) // a call's hooks: drawn ones claim their own row (inner)
      const open = expanded.has(id)
      const disc: Disc | undefined = parts.length ? [open, () => {
        if (!expanded.delete(id)) expanded.add(id)
        const at = rowAt(k) // rows and win: the draw that drew this row
        if (at >= 0) anchor = { k, off: at - win }
        $.ui.invalidate('ui.render')
      }] : undefined
      const out = [head(own, who, newest, disc?.[1] ?? (() => show(target)), disc)]
      if (open && disc) parts.forEach((p, j) => out.push(...p(rest + (j < parts.length - 1 ? '├ ' : '└ '), rest + (j < parts.length - 1 ? '│ ' : '  '))))
      spans.set(k, out.length)
      return out
    }
    const foldsOf = (gs: Group[]): number[] => gs.flatMap(g => { const p = partsOf(g); return p.parts.length ? [idOf(g.by ?? g.xs[0]), ...foldsOf(p.nested)] : [] })
    let cur: number | undefined
    const top = groupsOf(shown.filter(x => !folded.has(x)))
    const tops = new Set<string>() // rows the `o` button may keep in place: turn headers and top groups' own rows, which no closing hides
    top.forEach((g, j) => {
      const x = g.xs[0], n = turnOf(x)
      if (n !== cur) {
        if (cur !== undefined) rows.push(<Text key={`gap${rows.length}`}> </Text>) // a row of its own, not a margin: the window counts elements as rows
        const hk = `turn${n}` // by its turn, not its place: folds opening above it must not rename it, or an anchor on it is lost
        rows.push(header(n, hk)); cur = n; tops.add(hk)
        for (const y of hidden.get(n) ?? []) if (!where.has(y)) where.set(y, hk) // back from a hidden row: its turn's header
      }
      tops.add(keyOf(g))
      rows.push(...drawGroup(g, '', '', x.agent && turns.get(n)!.agents.size > 1 ? `${nameOf(x.agent)} · ` : '', j === top.length - 1))
    })
    // What streams or runs right now, below the rows: each loop's model request and each call in flight, ● counting up (tick
    // redraws while a turn or an agent runs). Not entries yet, so nothing to open: plain lines, under the running turn's header
    const nowAct = (l: Live) => l.row ? `${l.asking ? 'Waiting for your permission: ' : ''}${action({ t: l.t, ...l.row })}` : l.phase === 'thinking' ? `Thinking${l.said ? `: ${l.said}` : ''}`
      : l.phase === 'writing' ? l.said || 'Writing' : l.phase === 'calling' ? `Writing a ${l.tool ?? 'tool'} call` : 'Waiting for the first token'
    const inFlight = view === 'all' || view === 'agent' ? [...liveNow].filter(([, l]) => only === undefined || (l.loop ?? 'main') === only) : []
    if (inFlight.length && busy && cur !== turnNo) { if (cur !== undefined) rows.push(<Text key={`gap${rows.length}`}> </Text>); rows.push(header(turnNo, `turn${turnNo}`)); cur = turnNo }
    for (const [k, l] of inFlight) rows.push(line({ k: `now${k}`, act: nowAct(l), tool: l.row ? toolOf({ t: l.t, ...l.row }) : modelName(l.model ?? ''), st: [`● ${secs(now - l.t)}`, 'yellow'], who: l.loop ? `${nameOf(l.loop)} · ` : '' }))
    const LEGEND = ['✗ refused or broke · ↩ hook feedback to the model · ⚠ slow or aborted · ∅ no match · ● running now · ≈ estimated · ↗ outside the project root · ▸ press to open', 'ctrl+↑↓ previous/next prompt · o every fold · s setup · j newest · b back · n p next/prev in the inspector · k this legend']
    // `no agent entries for scout at notice or above · /agentlog level debug: every row · a: all views · main: clear the filter`; only the filters set
    const empty = () => {
      if (!entries.length) return 'no entries yet'
      const of = only ? ` for ${only === 'main' ? 'main' : nameOf(only)}` : ''
      const tips = [level > 0 && '/agentlog level debug: every row', view !== 'all' && 'a: all views', only && `${only === 'main' ? 'main' : nameOf(only)}: clear the filter`].filter(Boolean)
      return [`no ${view === 'all' ? '' : `${view} `}entries${of}${level > 0 ? ` at ${LEVELS[level]} or above` : ''}`, ...tips].join(' · ')
    }
    // The controls never clip: one row `view: a: all … level: l: info   o: unfold   k: legend` when it fits, else the bare buttons packed into
    // as many rows as the width needs. Counted, not wrapped by flex: the window needs the header's exact height. plain + hotkey
    // draws `a: all`, label + 3 cells; Button takes no bold, so the views not active are drawn dim instead
    // the window's top to the previous or next prompt's turn header (`#3`); past the last, the end. From the inspector or the setup page, back to the log first
    const heads = rows.flatMap((r, i) => String(r.props?.key).startsWith('turn') ? [i] : [])
    const toTurn = (dir: -1 | 1) => {
      if (inspect || page) { inspect = undefined; page = undefined; pageBack = false; backTo = undefined; $.ui.scroll({ in: PANE, to: 'start' }).catch(() => {}) } // the engine's window, which the inspector or page may have moved
      const to = dir < 0 ? heads.filter(i => i < win).at(-1) ?? 0 : heads.find(i => i > win)
      if (to === undefined) follow = true; else { win = to; follow = false } // the draw clamps win and decides follow again
      $.ui.invalidate('ui.render')
    }
    const vbtn = (v: View, k: string) => <Button key={`v${v}`} label={v} hotkey={k} plain dimColor={view !== v} onPress={() => setView(v)} />
    const lbtn = <Button key="lvl" label={LEVELS[level]} hotkey="l" plain onPress={nextLevel} />
    const kbtn = (label: string) => <Button key="legend" label={label} hotkey="k" plain dimColor={!legend} onPress={() => { legend = !legend; $.ui.invalidate('ui.render') }} />
    // `#↑↓`: ctrl+↑ and ctrl+↓ press these from the prompt or the pane. They are the engine's Global chords for the diff panel's file
    // list (app:diffFileListUp/Down, also meta+↑↓), which a Button's `action` takes while that panel is closed; open, the panel keeps them
    const tbtn = <Box key="turns" flexDirection="row"><Text dimColor>#</Text><Button key="tprev" label="↑" plain dimColor action="app:diffFileListUp" onPress={() => toTurn(-1)} /><Button key="tnext" label="↓" plain dimColor action="app:diffFileListDown" onPress={() => toTurn(1)} /></Box>
    // `o: unfold` opens every fold while one is closed, `o: fold` closes them all; the nearest top row at or above the window's
    // top keeps its line. Always drawn, one width (`fold` padded): a label that changed width could change how the controls
    // pack, and with it the header's height, moving the anchored row
    const folds = foldsOf(top), shut = folds.some(id => !expanded.has(id))
    const obtn = <Button key="folds" label={shut || !folds.length ? 'unfold' : 'fold  '} hotkey="o" plain dimColor={!folds.length} onPress={() => {
      for (const id of folds) if (shut) expanded.add(id); else expanded.delete(id)
      const at = rows.slice(0, win + 1).findLastIndex(r => tops.has(String(r.props?.key)))
      if (at >= 0) anchor = { k: String(rows[at].props.key), off: at - win }
      $.ui.invalidate('ui.render')
    }} />
    const VIEW_KEYS: Partial<Record<View, string>> = { all: 'a', agent: 'g', harness: 'h', outside: 'u' }
    const items: [number, any][] = SHOWN.map((v): [number, any] => [v.length + 3, vbtn(v, VIEW_KEYS[v]!)])
    const wide = 'view:'.length + items.reduce((n, [w]) => n + 2 + w, 0) + '   level: '.length + LEVELS[level]!.length + 3 + '   o: unfold'.length + '   k: legend'.length + '   #↑↓'.length
    const bare: [number, any][] = [...items, [LEVELS[level]!.length + 3, lbtn], [9, obtn], [4, kbtn('?')], [3, tbtn]]
    const controls = wide <= cols - 1
      ? [<Box key="ctl0" flexDirection="row" overflow="hidden"><Text dimColor>view:</Text>{items.map(([, el], i) => <Box key={`c${i}`} flexShrink={0}><Text>  </Text>{el}</Box>)}<Text dimColor>   level: </Text>{lbtn}<Text>   </Text>{obtn}<Text>   </Text>{kbtn('legend')}<Text>   </Text>{tbtn}</Box>]
      : pack(bare.map(([w]) => w), cols - 1).map((row, r) => <Box key={`ctl${r}`} flexDirection="row" columnGap={2} overflow="hidden">{row.map(i => bare[i]![1])}</Box>)
    // An agent reads as a log row: `name: task`, a button that filters the log to it; a teammate's name in the tool column; in the
    // status cell its run as its Agent row shows it (ran), else (a teammate, a fork: no Agent row spawned it) its status glyph.
    // Capped so the header leaves the log room: three rows while finished ones are folded, a third of the body with them shown
    const bodyRows = e.props.scroll?.bodyRows ?? 24
    const spawnOf = new Map(entries.filter(x => x.child).map(x => [x.child!, x]))
    const most = showDone ? Math.max(3, Math.floor(bodyRows / 3)) : 3
    const more = Math.max(0, tree.length - most)
    const agentRow = ([a, depth]: [AgentInfo | typeof TEAM, number]) => {
      if (a === TEAM) return <Box key="team" flexDirection="row"><Text dimColor>{' '.repeat(2 + 2 * depth)}team</Text></Box>
      const x = spawnOf.get(a.id), [glyph, c] = STATUS[a.status] ?? ['?'], t = started.get(a.id)
      const st: [string, string?] = x ? ran(x) : [a.status === 'running' && t != null ? `${glyph} ${secs(now - t)}` : glyph, c]
      return line({ k: `a${a.id}`, act: `${nameOf(a.id)}: ${a.description}`, press: () => pick(a.id), tool: a.name ?? '', st, indent: 2 * depth, mark: only === a.id ? '›' : ' ' })
    }
    const toggle = showDone ? `hide finished ▾${more ? ` · ${more} not shown` : ''}` : `${[more && `+${more} more`, done && `${done} done`].filter(Boolean).join(' · ')} ▸`
    // every element of the header and the log is one row, so the window knows the header's height and how many log rows fit under it
    // The setup row: what the session runs on, as the hooks saw it (Setup), and first, in red, what broke this session. Pressed (or s),
    // the setup page. Counted from every entry, whatever the view, level or filter
    if (!setup.asked) refreshSetup($).then(() => $.ui.invalidate('ui.render')).catch(() => {})
    const problems = problemsOf(entries)
    const hookN = Object.values(hookCfg ?? {}).reduce((n, hs) => n + hs.length, 0)
    const servers = new Map<string, number>() // MCP server -> its tools, from the tool list (`mcp__server__tool`) and the connection records
    for (const t of setup.tools ?? []) if (t.mcp) { const sv = t.name.split('__')[1] ?? t.name; servers.set(sv, (servers.get(sv) ?? 0) + 1) }
    for (const sv of setup.mcp.keys()) if (!servers.has(sv)) servers.set(sv, 0)
    const peak = setup.limits.reduce<Setup['limits'][number] | undefined>((m, l) => !m || l.percentUsed > m.percentUsed ? l : m, undefined)
    const plugins = setup.plugins.size || enabled.length
    const bgN = setup.bg?.tasks.length ?? 0, cronN = setup.bg?.crons.length ?? 0
    const setupText = [setup.model && `${modelName(setup.model)}${setup.effort != null ? ` ${setup.effort}` : ''}`, setup.mode, hookN && `${hookN} hooks`, plugins && `${plugins} plugins`,
      servers.size && `${servers.size} MCP`, bgN && `${bgN} in background`, cronN && `${cronN} cron${cronN > 1 ? 's' : ''}`, setup.cost != null && `$${setup.cost.toFixed(2)}`,
      peak && `limit ${Math.round(peak.percentUsed)}%`].filter(Boolean).join(' · ') || 'setup'
    const openSetup = () => { page = 'setup'; inspect = undefined; follow = false; $.ui.invalidate('ui.render'); $.ui.scroll({ in: PANE, to: 'start' }).catch(() => {}); $.clock.after(50, () => { $.ui.focus({ requestId: PANE, key: 'back' }).catch(() => {}) }) }
    // The setup page: the session's setup and how it held up. Hook runs and plugins come from the collector (OTEL export on); without
    // it, the hooks and plugins your settings name. A problem's row opens its inspector
    const setupPage = (at?: [string, string, string | undefined]) => {
      const kw = (k: string, v: string, id = k) => <Box key={`k${id}`} flexDirection="row"><Box flexShrink={0} width={15}><Text dimColor>{k}</Text></Box><Text wrap="wrap">{v}</Text></Box>
      const title = (k: string, t: string) => [<Text key={`gap${k}`}> </Text>, <Text key={`t${k}`} weight="semibold">{t}</Text>]
      const xs = (f: (x: Entry) => boolean) => entries.filter(f)
      // requests: how many, their time, tokens and price where the collector gave one
      const use = (ys: Entry[]) => {
        const sum = (f: (x: Entry) => number) => ys.reduce((a, x) => a + f(x), 0)
        const cost = ys.some(x => x.cost != null) ? ` · $${sum(x => x.cost ?? 0).toFixed(2)}` : ''
        return `${ys.length} request${ys.length === 1 ? '' : 's'} · ${secs(sum(x => x.ms ?? 0))} · ${num(sum(x => x.tok ? x.tok[0]! + x.tok[1]! + x.tok[2]! : 0))} in · ${num(sum(x => x.tok?.[3] ?? 0))} out${cost}`
      }
      const by = (ys: Entry[]) => { const m = new Map<string, Entry[]>(); for (const y of ys) m.set(y.name, [...m.get(y.name) ?? [], y]); return [...m] }
      const bad = xs(x => (x.kind === 'hook' && stat(x) === 'failed') || (x.kind === 'event' && BAD.has(stat(x))))
      const events = [...new Set([...Object.keys(hookCfg ?? {}), ...setup.runs.keys()])]
      const steps = xs(x => x.kind === 'step')
      const added = [...new Set(xs(x => x.kind === 'event' && x.name === 'directory added').map(x => x.detail))]
      const outs = [...xs(x => !!x.out).reduce((m, x) => m.set(x.out!, (m.get(x.out!) ?? 0) + 1), new Map<string, number>())].sort((p, q) => q[1] - p[1])
      return (
        <Box key="setup" flexDirection="column" width={e.props.bodyColumns}>
          <Box flexDirection="row" columnGap={2}><Button key="back" label="← back" hotkey="b" plain autoFocus onPress={back} /></Box>
          {title('cc', `Claude Code ${setup.version ?? ''}`.trim())}
          {kw('model', setup.model ? `${modelName(setup.model)} (${setup.model})${setup.effort != null ? ` · effort ${setup.effort}` : ''}` : '—')}
          {kw('mode', setup.mode ?? '—')}
          {setup.context && kw('context', `${setup.context.tokens != null ? `${num(setup.context.tokens)} of ` : ''}${num(setup.context.window)} tokens${setup.context.percent != null ? ` (${Math.round(setup.context.percent)}%)` : ''}`)}
          {setup.cost != null && kw('cost', `$${setup.cost.toFixed(2)} this session`)}
          {setup.limits.length > 0 && kw('limits', setup.limits.map(l => `${l.kind.replace(/_/g, ' ')} ${Math.round(l.percentUsed)}%${l.resetsAt ? ` (resets ${new Date(l.resetsAt).toLocaleTimeString()})` : ''}`).join(' · '))}
          {title('wh', 'Where')}
          {at && kw('root', tilde(at[0], at[2]))}
          {at && at[1] !== at[0] && kw('cwd', tilde(at[1], at[2]))}
          {added.length > 0 && kw('added', added.join(', '))}
          {kw('calls outside', outs.length ? outs.slice(0, 12).map(([p, n]) => n > 1 ? `${p} ×${n}` : p).join(', ') + (outs.length > 12 ? `, +${outs.length - 12} more` : '') : 'none reached outside the root')}
          {title('pb', problems.length ? `Problems: ${problems.join(', ')}` : 'Problems: none this session')}
          {bad.slice(-20).map(x => <Box key={`p${idOf(x)}`} flexDirection="row"><Button key={`pb${idOf(x)}`} label={fit(`✗ ${action(x)}`, cols - 4)} plain onPress={() => show(x)} /></Box>)}
          {title('hk', `Hooks: ${hookN} settings and plugin command hooks${setup.runs.size ? '; runs as the collector counted them' : ''}`)}
          {events.map(ev => { const r = setup.runs.get(ev), names = [...new Set((hookCfg?.[ev] ?? []).map(h => h.name))]
            return kw(ev, [names.join(', ') || 'no hook in your settings', r && `${r.n} run${r.n === 1 ? '' : 's'} · ${secs(r.ms)}${r.errors ? ` · ${r.errors} failed` : ''}${r.cancelled ? ` · ${r.cancelled} cancelled` : ''}`].filter(Boolean).join(' — '), `hk${ev}`) })}
          {title('pl', `Plugins: ${plugins}`)}
          {setup.plugins.size ? [...setup.plugins].map(([n, pl]) => kw(n, [pl.version, pl.scope, pl.hooks && 'hooks', pl.mcp && 'MCP'].filter(Boolean).join(' · '), `pl${n}`))
            : enabled.map(id => kw(id.split('@')[0]!, `enabled in your settings (${id.split('@')[1] ?? ''})`, `pl${id}`))}
          {title('mc', `MCP servers: ${servers.size}`)}
          {[...servers].map(([sv, k]) => { const c = setup.mcp.get(sv)
            return kw(sv, [c ? (c.status === 'connected' ? `connected${c.transport ? ` over ${c.transport}` : ''}${c.ms != null ? ` in ${secs(c.ms)}` : ''}` : `${c.status || 'failed'}${c.error ? `: ${c.error}` : ''}`) : '', k && `${k} tool${k === 1 ? '' : 's'}`].filter(Boolean).join(' · '), `mc${sv}`) })}
          {title('us', 'Model use this session')}
          {kw('main', use(steps.filter(x => !x.agent)))}
          {steps.some(x => x.agent) && kw('subagents', use(steps.filter(x => x.agent)))}
          {by(xs(x => x.kind === 'side' && x.src !== 'plugin')).map(([n, ys]) => kw(SIDE[n] ?? n, use(ys), `us${n}`))}
          {by(xs(x => (x.kind === 'side' && x.src === 'plugin') || x.kind === 'fork')).map(([n, ys]) => kw(n, `${use(ys)} (plugin)`, `up${n}`))}
          {title('bg', !setup.bg ? 'Background: told at the end of each turn' : bgN + cronN ? 'Background: in flight when the last turn ended' : 'Background: nothing in flight when the last turn ended')}
          {setup.bg?.tasks.map((t, i) => kw(t.type, `${t.status}: ${fit(t.command ?? t.description, 200)}`, `bg${i}`))}
          {setup.bg?.crons.map((c, i) => kw('cron', `${c.schedule}${c.recurring ? '' : ' (once)'}: ${fit(first(c.prompt), 200)}`, `cr${i}`))}
        </Box>
      )
    }
    const head = [
      ...controls,
      <Box key="setuprow" flexDirection="row" overflow="hidden">
        {problems.length ? <Box flexShrink={0}><Text color="red">{`✗ ${problems.join(' · ')}  `}</Text></Box> : null}
        <Box flexShrink={1} minWidth={0} overflow="hidden"><Button key="fsetup" label={setupText} hotkey="s" plain dimColor onPress={openSetup} /></Box>
      </Box>,
      <Box key="main" flexDirection="row" overflow="hidden" columnGap={2}>
        <Button key="fmain" label="main" plain onPress={() => pick('main')} />
        {only ? <Button key="fclear" label={fit(`filter: ${nameOf(only)} ✕`, cols - 8)} plain dimColor onPress={() => pick(only!)} /> : !agents.length && <Text dimColor>no subagents yet</Text>}
      </Box>,
      ...tree.slice(0, most).map(agentRow),
      ...(done || more ? [<Box key="done" flexDirection="row"><Text>  </Text><Button key="fdone" label={toggle} plain dimColor onPress={() => { showDone = !showDone; $.ui.invalidate('ui.render') }} /></Box>] : []),
      ...(legend ? LEGEND.map((l, j) => <Text key={`leg${j}`} dimColor wrap="truncate-end">{l}</Text>) : []),
      <Text key="rule" dimColor>{'─'.repeat(Math.max(1, cols - 1))}</Text>,
    ]
    // taken before the inspector draws: `o` pressed there must not move the window that back is about to centre
    const held = anchor; anchor = undefined
    if (inspect) return <Box flexDirection="column">{head}{await inspector(inspect)}</Box>
    if (page) { // where the session is: asked on each draw of the page, as /cd and a worktree move change it
      const at = await Promise.all([$.session.root(), $.session.cwd(), homeOf($)]).catch(() => undefined)
      return <Box flexDirection="column">{head}{setupPage(at)}</Box>
    }
    if (!rows.length) { winMax = 0; return <Box flexDirection="column">{head}<Text dimColor wrap="truncate-end">{empty()}</Text></Box> } // a stale winMax would let a scroll turn follow off
    // The window: decide follow against the rows without the jump row first, then give the jump row its own row when not
    // following, so landing on the newest row never shows `↓ newest`
    const avail0 = Math.max(1, bodyRows - head.length)
    const max0 = Math.max(0, rows.length - avail0)
    if (backKey) { const at = rowAt(backKey); if (at >= 0) win = at - Math.floor(avail0 / 2); else follow = true; backKey = undefined }
    // The anchored row keeps its line, or the window's top when it was above it (`o` from inside an open fold). Off the end, the
    // jump row takes the last line: the window then moves down until the row's open fold shows (end), never past the row itself
    let pin: [number, number] | undefined
    if (held) { const at = rowAt(held.k); if (at >= 0) { win = at - Math.max(0, held.off); follow = false; pin = [at, at + (spans.get(held.k) ?? 1) - 1] } }
    if (follow) win = max0
    win = Math.max(0, Math.min(max0, win))
    const room = Math.max(1, avail0 - 1)
    if (pin && win < max0 && pin[1] > win + room - 1) win = Math.min(max0, pin[0], pin[1] - room + 1)
    follow = win >= max0
    if (follow) fresh = 0
    const avail = follow ? avail0 : Math.max(1, avail0 - 1)
    winMax = Math.max(0, rows.length - avail)
    return (
      <Box flexDirection="column">
        {head}
        {rows.slice(win, win + avail)}
        {!follow && <Box key="jumprow" flexDirection="row" justifyContent="flex-end"><Button key="jump" label={fresh ? `↓ ${fresh} new event${fresh > 1 ? 's' : ''} (j)` : '↓ newest (j)'} hotkey="j" onPress={jump} /></Box>}
      </Box>
    )
  })
}
