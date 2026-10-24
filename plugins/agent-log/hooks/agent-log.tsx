import type { AgentInfo, ModelUsage, Register, Timer, TurnStepResult } from 'claude-code'
import { scrub } from './scrub'

// Deliberately single-file: every hook and the pane read and mutate the module-level state (entries, seen, owed, chain, the
// view and expansion state), so a split would pass that state across modules. Sections, in order (search `// ===`):
// ENTRIES AND TEXT, HOOK NAMES, ROWS, STATE AND STORE, HOOKS, PANE

// === ENTRIES AND TEXT ===
type Src = 'engine' | 'hook' | 'plugin' // who authored injected text: the engine's own framing, a settings hook, or a plugin chain
// agent: the loop's agentId, absent on main. bytes: injected size (kept, not shown for now). ms: tool run time, minus its wait.
// wait/waitFor: on a tool row, the time between tool.check's verdict and the engine's decision, and what it waited on
// type: the engine's attachment kind or context-block name, kept beside the readable `name`. origin: the settings hook event that produced the text or, on a hook row, ran the hook (its trigger; `name` is then the hook's own name).
// cmd: a Bash call's full scrubbed command, shown in the inspector while the row shows its description. pat: a Grep's or Glob's
// pattern, scrubbed and cut to 80, which its row reads (`Search "secs\(" in hooks`)
// check/rule: tool.check's verdict on a tool call and the settings rule that decided it, as written (`Bash(git push:*)`); no rule = a mode, hook or the tool's own check
// via: who settled the call, as the collector's tool_decision names it (`config`, `hook`, `user_temporary`, `user_reject`). The engine raises collector records with export on or off (2.1.310)
// peek: the first PEEK chars of the injected text, error, or deny/block reason, secret-scrubbed; never the person's typed prompt
// turn: the number of your prompt the entry followed (`#N` = since your Nth prompt; 0 = before your first, drawn `start`); a subagent's entries carry the same number. Absent on entries from before turns were counted
// status: a tool call's result as data, so views and folds never parse the `outcome` label; entries from before it derive one (stat).
// exit/insight: a failed call's exit code and its output boiled down (insightOf)
// child: on an Agent row, the id of the agent it spawned; that agent's rows fold under it (rootOf)
// use: the tool_use_id of the call a row belongs to: on a tool row, and on its PreToolUse/PostToolUse hook rows and their text, which the log draws around it, linked
// again: hook text the session already logged word for word (a plugin's tip on every call), or a cwd change back to where the session began: ranked info
type Status = 'ok' | 'failed' | 'denied' | 'blocked' | 'feedback' | 'stopped' | 'aborted' | 'nomatch'
// fork: a plugin's $.model.fork, logged under main; name is the plugin, outcome its token cost, peek its reply or why it has none
// step: one model request (turn.step); name is the model the request named, peek the start of its reply. step: on a step row its
// own key, on a tool row the request that asked for the call. effort as requested; ttft: ms to the first streamed thinking, text
// or call; think: ms spent thinking; stop: the API's stop reason; tok: [uncached in, cache read, cache write, out]; asked: the
// tools it called; server: the calls the API ran itself (the advisor) and their ms; thought: its thinking's first line;
// cost/req: the collector's price and request id for it
// split: on main's turn row, where its time went as splitOf counts it, kept so evicting the turn's rows does not lose it
// out: on a tool row, the place outside the session's project root the call reached (outsideOf), `~`-shortened; absent inside it
// each: on a row of several hooks, each hook's own ms, by name, as hook-timer recorded it (pickRuns); hooks it does not wrap are absent
// spoke: on such a row, the hooks whose text (context, a block, feedback) the row's outcome is; errs: the wrapped hooks that exited
// neither 0 nor 2 (2 is a block) without saying anything. Each hook's own row (hookOf) takes its mark from them; a row stored before
// they existed shows times only. says: on such a row, each hook's own text (peek), by the hook it is credited to (speaker,
// hookName); exits: each wrapped hook's nonzero exit code. Both feed the inspector a hook's line opens (hookOf)
// event: something the engine reports happening (eventOf, harnessOf): name is what (`model switch`, `API error`), detail and outcome
// its particulars. side: a model request outside the turns: the engine's own (src engine, name its query source: a title, a
// prompt suggestion, compaction) or a plugin's $.model.complete (src plugin, name the plugin); detail is the model
type Entry = { t: number; turn?: number; kind: 'tool' | 'hook' | 'session' | 'prompt' | 'turn' | 'fork' | 'step' | 'event' | 'side'; name: string; detail: string; outcome: string; status?: Status; src?: Src; bytes?: number; agent?: string; ms?: number; type?: string; origin?: string; peek?: string; cmd?: string; check?: 'allow' | 'ask' | 'deny'; rule?: string; exit?: number; insight?: string; child?: string; use?: string; wait?: number; waitFor?: string; again?: boolean
  pat?: string; via?: string; step?: string; effort?: string | number; ttft?: number; think?: number; stop?: string; tok?: number[]; asked?: string[]; server?: [string, number | null][]; thought?: string; cost?: number; req?: string; split?: number[]; out?: string; each?: Record<string, number>; spoke?: string[]; errs?: string[]; says?: Record<string, string>; exits?: Record<string, number> }

const PANE = 'agent-log'
// a block after the fact refuses nothing: PostToolUse's tool already ran and Stop's turn already ended, so the hook's text is
// feedback the model reads next (lint-feedback's lint errors), not a refusal
const FEEDBACK = new Set(['PostToolUse', 'PostToolUseFailure', 'PostToolBatch', 'Stop', 'SubagentStop'])
const stat = (x: Entry): Status => x.status ?? (x.outcome === 'deny' ? 'denied' : x.outcome === 'error' ? 'failed' : x.outcome.startsWith('block') ? (FEEDBACK.has(x.origin ?? '') ? 'feedback' : 'blocked') : x.outcome === 'stop' ? 'stopped' : x.outcome === 'aborted' ? 'aborted' : 'ok')
const BAD = new Set<Status>(['failed', 'denied', 'blocked', 'stopped']) // ranked error (lvl); drawn red, save REFUSED and a stop
// refused before it ran: by a hook (your guard), a rule, the classifier, you, or the model. Drawn a cyan ⊘, not a red ✗: a safety
// check doing its job, not something that broke
const REFUSED = new Set<Status>(['denied', 'blocked'])
const loud = (x: Entry) => BAD.has(stat(x)) || stat(x) === 'feedback' // a hook row that refused its call or answered it
const num = (t: number) => t < 1000 ? String(t) : `${(t / 1000).toFixed(1)}k`
const toks = (t: number) => `${num(t)} tok`
// a loop's token cost. input_tokens is only the uncached tail: a fork re-sends main's whole transcript, mostly from the cache
export const costOf = (u?: ModelUsage) => u ? `${toks(u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens)} in · ${toks(u.output_tokens)} out` : ''
const tok = (n: number) => toks(Math.round(n / 4)) // ponytail: chars/4, no tokenizer in the plugin API; ±20% on prose
const kb = (n: number) => `~${tok(n)}`
// scrub: secret-shaped text as ***, from hooks/scrub.ts (a copy of plugins/shared/scrub.ts, as event-log's is); re-exported for the tests
export { scrub }
const SESSIONS = 10 // was 20 before step rows. Each session's key is held to BUDGET bytes, so 10 of them fit the store's 4 MiB cap
const PEEK = 300 // chars of text kept per entry
const peek = (s: unknown): string | undefined => typeof s === 'string' && s.trim() ? scrub(s.trim()).slice(0, PEEK) : undefined
const noCd = (s: string) => s.replace(/^\s*cd\s+\S+\s*(&&|;)\s*/, '') // a Bash command minus its leading `cd <dir> &&` / `;`
const first = (s?: string) => (s ?? '').split('\n').find(l => l.trim())?.trim() ?? ''
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// the engine's framing in front of a hook's text (`PreToolUse:Bash hook error: [$HOME/…/guard.sh]: `), which hookName reads past
const FRAME = /^\w+(:\S+)? hook [^:\n]*:\s*(\[[^\]\n]*\]:\s*)?/

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
type HookCfg = Record<string, { matcher: string; name: string; plugin?: boolean; cmd?: string }[]> // cmd: the command as written, so one script on several events or matchers counts once
let hookCfg: HookCfg | undefined
let hookFresh = false // hookCfg came from a settings read that worked and no ConfigChange has fired since: else read again
let enabled: string[] = [] // the plugins settings enable (`name@marketplace`): the setup's plugin list where no plugin_loaded record came
export const scriptName = (h: any): string => {
  const cmd = String(h?.command ?? '')
  // a name starts a path segment or word and is no dotfile: `source ~/.vars.sh && ~/hooks/guard.sh` is guard. hook-timer's matches
  return cmd.match(/(?:^|[\s\/"'=;&|(])([\w-][\w.-]*)\.(sh|py|js|mjs|ts|rb|pl)\b/)?.[1] ?? cmd.split(/\s+/)[0]?.split('/').pop() ?? String(h?.type ?? 'hook')
}
async function hooksOf($: any): Promise<HookCfg> {
  if (hookCfg && hookFresh) return hookCfg
  const cfg: HookCfg = {}
  const add = (hooks: any, plugin?: string) => {
    for (const [ev, groups] of Object.entries<any>(hooks ?? {})) for (const g of Array.isArray(groups) ? groups : []) for (const h of g?.hooks ?? []) (cfg[ev] ??= []).push({ matcher: String(g?.matcher ?? ''), name: plugin ?? scriptName(h), plugin: !!plugin, cmd: String(h?.command ?? h?.prompt ?? h?.type ?? '') })
  }
  let s: any
  let ok = false
  try { s = await $.settings.read(); ok = true; add(s?.hooks); enabled = Object.entries(s?.enabledPlugins ?? {}).filter(([, on]) => on).map(([id]) => id) } catch {}
  // a plugin's command hooks run in the same classic chain; named by the plugin (`context-mode`), not their scripts (`pretooluse`)
  try {
    const installed = JSON.parse(await $.fs.read(`${await $.env.get('HOME')}/.claude/plugins/installed_plugins.json`))?.plugins ?? {}
    for (const [id, on] of Object.entries(s?.enabledPlugins ?? {})) if (on) for (const i of installed[id] ?? []) try { add(JSON.parse(await $.fs.read(`${i.installPath}/hooks/hooks.json`))?.hooks, id.split('@')[0]) } catch {}
  } catch {}
  hookFresh = ok
  return hookCfg = cfg
}
// a matcher as the engine reads it (hooks reference): empty or `*` fits all; only letters, digits, `_`, `-`, spaces, `,` and `|` is
// a list of exact names (`Edit, Write`); anything else an unanchored regex (`Edit.*` fits NotebookEdit)
const fits = (matcher: string, target?: string) => {
  if (!matcher || matcher === '*' || target == null) return true
  if (/^[\w ,|-]+$/.test(matcher)) return matcher.split(/[|,]/).some(m => m.trim() === target)
  try { return new RegExp(matcher).test(target) } catch { return true }
}
// the input field each event's matcher tests (hooks reference); an event not here has no matcher, so every hook on it fits.
// classic.PreToolUse's envelope is tool.call's: `tool`, not `tool_name`
const MATCHED_BY: Record<string, string> = {
  SessionStart: 'source', SessionEnd: 'reason', Setup: 'trigger', Notification: 'notification_type', SubagentStart: 'agent_type',
  SubagentStop: 'agent_type', PreCompact: 'trigger', PostCompact: 'trigger', PreModelSwitch: 'to_model', PostModelSwitch: 'to_model',
  ConfigChange: 'source', DirectoryAdded: 'source', StopFailure: 'error', InstructionsLoaded: 'load_reason',
  UserPromptExpansion: 'command_name', Elicitation: 'mcp_server_name', ElicitationResult: 'mcp_server_name',
}
export const targetOf = (e: any, event: string): string | undefined => e.tool ?? e.tool_name ?? (event in MATCHED_BY ? e[MATCHED_BY[event]!] : undefined)
// hook-timer's runs (~/.claude/hooks/hook-timer, which settings.json puts in front of each hook command): `{name, event, use,
// agent, t0, t1, exit, say}` per run, one file per session; say is the first line of what the hook handed back. The engine times an
// event's chain whole and merges its hooks' text, so these are what name a wrapped hook, time it and credit its text to it;
// hooks it does not wrap (a plugin's) are still read from the settings and their text (hookName).
// keep: the runs that count; reading goes newest first and stops at the first run that ended before `from`
type Run = { name: string; ms: number; say?: string; exit?: number }
export const pickRuns = (text: string, keep: (r: any) => boolean, from: number): Run[] => {
  const out: Run[] = [], lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    let r: any
    try { r = JSON.parse(lines[i]!) } catch { continue }
    if (r.t1 < from - SKEW) break
    if (keep(r)) out.unshift({ name: String(r.name), ms: r.t1 - r.t0, say: r.say ?? undefined, exit: r.exit ?? undefined })
  }
  return out
}
const SKEW = 100 // ms: the wrapper's clock read sits a process start inside the engine's
// a hook-timer run of this event's chain (t0..now): a call's by its tool_use_id; others by loop too, so two agents' overlapping
// SubagentStop chains keep their own. A run recorded before hook-timer wrote `agent` has no such key and still counts
export const runOf = (e: any, event: string, t0: number, now: number) => (r: any) =>
  r.event === event && (r.use ?? undefined) === e.tool_use_id && (!!e.tool_use_id || !('agent' in r) || (r.agent ?? undefined) === e.agent_id) &&
  r.t0 >= t0 - SKEW && r.t1 <= now + SKEW
const LATE = 30 * 60_000 // ms: how far back a hook's text can have been said: a PreToolUse hook's goes out with the request after its call
const runsOf = async ($: any, keep: (r: any) => boolean, from: number) => {
  try { return pickRuns(await $.fs.read(`${await $.env.get('HOME')}/.claude/hook-times/${await $.session.id()}.jsonl`), keep, from) } catch { return [] } // no file yet
}
const timed = (h: { cmd?: string }) => !!h.cmd?.includes('hook-timer')
// the setup page's per-hook times line: how many of your distinct settings hook commands run through hook-timer (a plugin's can't)
export const hookTimes = (cfg: HookCfg) => {
  const own = [...new Set(Object.values(cfg).flat().filter(h => !h.plugin).map(h => h.cmd ?? h.name))]
  const n = own.filter(cmd => timed({ cmd })).length
  return !own.length ? 'no settings hooks' : !n ? 'off: no settings hook runs through hook-timer (README: Per-hook times)'
    : `on for ${n} of ${own.length} settings hook${own.length === 1 ? '' : 's'}`
}
// whether hook-timer wraps any hook this event runs: else there is nothing to read
const wraps = (cfg: HookCfg, event: string, target?: string) => (cfg[event] ?? []).some(h => timed(h) && fits(h.matcher, target))
// the hook that handed back a text: the wrapped run whose first line starts one of its lines, past the engine's framing
export const speaker = (runs: Run[], text: string) => {
  const lines = text.split('\n').map(l => l.trim().replace(FRAME, ''))
  return [...runs].reverse().find(r => r.say?.trim() && lines.some(l => l.startsWith(r.say!.trim())))?.name
}
// a classic event's hooks, given its runs: each text (pieces) by its speaker, else by hookName; with nothing said, the wrapped
// hooks that ran and the unwrapped ones that fit
export const runNames = (cfg: HookCfg, event: string, target: string | undefined, runs: Run[], pieces: string[]) => {
  if (pieces.length) return [...new Set(pieces.flatMap(p => (speaker(runs, p) ?? hookName(cfg, event, target, p)).split(', ')))].join(', ')
  const other = (cfg[event] ?? []).filter(h => !timed(h) && fits(h.matcher, target)).map(h => h.name)
  return [...new Set([...runs.map(r => r.name), ...other])].join(', ')
}
// the hooks that spoke, then the rest that ran in silence (runNames with nothing said)
export const withSilent = (cfg: HookCfg, event: string, target: string | undefined, runs: Run[], spoke: string) =>
  [...new Set([...spoke.split(', '), ...runNames(cfg, event, target, runs, []).split(', ')])].filter(Boolean).join(', ')
// '' = no hook fits: the event ran its chain, but no hook of yours or a plugin's
export const hookName =(cfg: HookCfg, event: string, target?: string, text?: string): string => {
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
  // several plugins and nothing names one: the event's, not a guess at each
  return (plugin.length === 1 ? plugin : names(fit).length === 1 ? names(fit) : [`${event} hook`]).join(', ')
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
const STATUS: Record<string, [string, string?]> = { running: ['●', 'green'], completed: ['✓'], failed: ['✗', 'red'], killed: ['⚠', 'yellow'] } // cell's colours; a killed agent ended early, ⚠ as an interrupt
const TEAM = 'team' as const // pseudo node: header over main's direct teammate children
const SLOW = 1000 // ms: a classic hook this slow logs even when it changed nothing
// slow enough to flag ⚠. SessionStart is exempt: its hooks set the session up once and take seconds every time (context-mode's
// 1.7-2.9 s), so a ◷ on every session's first rows would teach you to read past the ◷ on a slow ConfigChange
// one hook of a row of several, as a row of its own for its line's mark and its inspector: its own time, exit and text, the row's
// outcome only if it said it. A row stored before says existed gives the whole text to its one speaker, else none
export const hookOf = (x: Entry, n: string): Entry => {
  const spoke = x.spoke?.includes(n)
  return { ...x, name: n, ms: x.each?.[n], exit: x.exits?.[n], outcome: spoke ? x.outcome : '', status: x.errs?.includes(n) ? 'failed' : spoke ? x.status : undefined,
    peek: x.says ? x.says[n] : spoke && x.spoke!.length === 1 ? x.peek : undefined, each: undefined, spoke: undefined, errs: undefined, says: undefined, exits: undefined }
}
// a row of several hooks as the log draws it: one row per hook (hookOf). The same objects on every draw, so ids, the inspector and back hold
const perHook = new WeakMap<Entry, Entry[]>()
const splitHooks = (x: Entry): Entry[] => {
  if (x.kind !== 'hook' || !x.name.includes(', ')) return [x]
  if (!perHook.has(x)) perHook.set(x, x.name.split(', ').map(n => hookOf(x, n)))
  return perHook.get(x)!
}
const slow = (x: Entry, ms = x.ms) => x.kind === 'hook' && ms != null && ms >= SLOW && x.origin !== 'SessionStart'
const ago = (ms: number) => { const s = Math.floor(ms / 1000); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${Math.floor(s / 3600)}h${String(Math.floor(s / 60) % 60).padStart(2, '0')}m` }

let keep = 300
let entries: Entry[] = []
let turnNo = 0 // your prompts so far (0: the session's start, before your first): only your own submissions count, not notifications, peers, schedules or plugins
let pending = 0 // prompts typed while a turn ran: counted when that turn ends, so its last rows keep their number
// turn -> its prompt's first few words (wordsOf) for the turn header, in memory only: saved() never stores them, and a session
// switch (load) drops them. queued: the words of the `pending` prompts, in order, numbered once they are counted
const words = new Map<number, string>()
let queued: string[] = []
// a prompt's first line, scrubbed, cut to its first 4 words within 24 characters (`Implement the following…`); a slash
// command its name alone (`/review`): its arguments are your own typing
const wordsOf = (e: { text: string; command?: { name: string } }): string => {
  if (e.command) return `/${e.command.name}`
  const ws = scrub(first(e.text)).split(/\s+/).filter(Boolean)
  let s = ''
  for (const w of ws.slice(0, 4)) { const t = s ? `${s} ${w}` : w; if (t.length > 24) break; s = t }
  if (!s && ws[0]) s = ws[0].slice(0, 23)
  return s.length < ws.join(' ').length ? `${s}…` : s
}
const OWN = new Set(['composer', 'bridge', 'sdk']) // PromptOrigin kinds that are the person's own prompt
let key = '' // this session's store key; one per session so concurrent sessions never clobber each other
let inspect: Entry | undefined // the entry shown in full; set, the pane draws it in place of the log (a second pane cannot take the keys from this one)
let page: 'setup' | 'keys' | undefined // the setup page or the keys page (what each mark and key means), drawn in place of the log as the inspector is
let pageBack = false // the inspector opened from the setup page: back returns to the page, not the log
// The session's setup as the hooks saw it, for the setup button and page, in memory only: the main loop's last model and effort
// (asked at session.start, then its steps), the permission mode (every classic event carries it), rate limits (session.measure),
// and from the collector: the plugins the engine loaded and the MCP servers it connected
// (records at startup), and per hook event the settings hooks' runs, the silent ones included (hook_execution_complete). bg: the
// background tasks and crons still in flight when main's last turn ended (Stop): TaskCreated/Completed rows log their lives
type Setup = { model?: string; effort?: string | number; mode?: string; limits: { kind: string; percentUsed: number; resetsAt?: string }[]
  bg?: { tasks: { type: string; status: string; description: string; command?: string }[]; crons: { schedule: string; recurring: boolean; prompt: string }[] }
  asked?: boolean
  plugins: Map<string, { version?: string; scope?: string; hooks?: boolean; mcp?: boolean }>; mcp: Map<string, { status: string }>
  runs: Map<string, { n: number; ms: number; errors: number; cancelled: number }>; runsOf?: string } // runsOf: the session id the runs count for
const setup: Setup = { limits: [], plugins: new Map(), mcp: new Map(), runs: new Map() }
// what the API alone answers: asked once at session.start (a reload's included), and by the first draw where none ran
async function refreshSetup($: any): Promise<void> {
  setup.asked = true
  try { setup.model ??= await $.session.model() } catch {}
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
// turns whose rows below the level are drawn in place, dim, by their header's `N hidden ▸`; kept across views and levels
const openTurns = new Set<number>()
let busy = false // main's turn is running: the header counts its time up
// The pane scrolls its own rows under a header that never moves: the engine's window stays at the top (ui.scroll) and the log
// draws rows win..win+avail. winMax is the last render's, for the scroll hook; backKey is the row back centres on
let win = 0, winMax = 0
let backKey: string | undefined
// a row that opened or closed a fold, and its line in the window: the next draw keeps it on that line rather than pinning the end
let anchor: { k: string; off: number } | undefined
let follow = true // auto-scroll to the newest entry; off once the person scrolls up, on again at the bottom or via the jump button
// The row cursor: sel is the key of the row it is on (a line's k), the focus ring on that row's Button so Enter opens it. j, k
// or an arrow ask a move of `move` rows, which the next draw makes (the rows exist only there); winEnd: the last row the window
// drew, where a cursor starts. nav: the inspector's previous and next rows, which j and k step to while it is open
let sel: string | undefined
let move = 0
let winStart = 0, winEnd = 0 // the rows the last draw showed, for the cursor's start
let nav: { prev?: Entry; next?: Entry } = {}
let fresh = 0 // entries logged while not following: the jump button's "N new events"; the render zeroes it once following again
let chain: Promise<void> = Promise.resolve() // all store mutations run one after another, so no write lands a stale snapshot
let only: string | undefined // agent filter: an agent id, 'main', or undefined for every loop
// A row reads: disclosure, action, tool (muted), then one right cell (fixed width, so the action truncates first): the time.
// A flag rides in front of the time in its color, one meaning per glyph so none needs the colour: red ✗ = broke, cyan ⊘ =
// refused, yellow ⚠ = ended early (interrupted, cut off, an agent killed), ■ = a hook stopped the session (on purpose, but it ends
// the turn), ◷ = slow, blue ↩ = a hook's feedback, green ● = running (ran, the live lines), magenta ↗ = another project (line). Dim: + = a hook added context, · = it changed nothing, ∅ = found
// nothing (grep/diff exit 1): routine, no colour. No time (a denied call never ran) -> the status word stands in for it.
// Derived at draw time so stored entries relabel too. Injected text shows no size for now (`+N tok` was a chars/4 guess)
const cell = (x: Entry, ms = x.ms): [string, string?] => {
  const s = stat(x), time = ms == null ? undefined : secs(ms)
  return REFUSED.has(s) ? [`⊘ ${time ?? s}`, 'cyan'] : s === 'stopped' ? [`■ ${time ?? s}`, 'yellow'] : BAD.has(s) ? [`✗ ${time ?? s}`, 'red'] : s === 'feedback' ? [`↩ ${time ?? s}`, 'blue'] : s === 'aborted' ? [`⚠ ${time ?? s}`, 'yellow'] : s === 'nomatch' ? [`∅ ${time ?? 'no match'}`]
    : slow(x, ms) ? [`◷ ${time}`, 'yellow'] // over + and ·: slowness is what a slow hook's row has to say
    : x.kind === 'hook' ? (x.outcome.startsWith('context') ? [`+ ${time ?? '—'}`] : [`· ${time ?? '—'}`])
    : [time ?? (x.kind === 'tool' ? '—' : '')]
}
// a row's time, in seconds so a column reads in one unit: `<0.1s` under 100 ms (never `0.0s`), `18.4s` under a minute, then
// `ago`'s `2m05s`, `1h05m`. At most 6 characters, so a flag and the time fit the row's cell (END). Unknown is —, never a guess.
// The minute cut-off rounds first: 59.96 s reads `1m00s`, not `60.0s`
const secs = (ms?: number) => ms == null ? '—' : ms < 100 ? '<0.1s' : ms < 59_950 ? `${(ms / 1000).toFixed(1)}s` : ago(Math.max(ms, 60_000))
// the inspector's and the setup page's time, where one value is read on its own: milliseconds under a second (`40ms`), else secs
const exact = (ms?: number) => ms != null && ms < 999.5 ? `${Math.round(ms)}ms` : secs(ms)
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
// `claude-opus-5-5[1m]` -> `Opus 5.5`, `claude-opus-4-20250514` -> `Opus 4`, `claude-3-5-sonnet-20241022` -> `Sonnet 3.5`;
// an id of no known shape (a gateway's alias) as named. (?!\d): a date suffix is no minor version
export const modelName = (id: string) => {
  const m = id.match(/claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?!\d)/)
  if (m) return `${cap(m[1]!)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
  const o = id.match(/claude-(\d+)(?:-(\d))?-([a-z]+)/)
  return o ? `${cap(o[3]!)} ${o[1]}${o[2] ? `.${o[2]}` : ''}` : id
}
// a step's result: cut off at the output limit reads ⚠ like an interrupt; a refusal ⊘; a full context window or no response at all, ✗
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
// the classifier, the guard on the session's working directories. Read from the text too: a decision record can be missing (an
// older engine), and a refusal's record can come late
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
    if (a.status === 'disconnected') return { kind: 'event', name: 'MCP disconnected', detail: String(a.server_name ?? ''), outcome: String(a.transport_type ?? ''), status: 'ok', peek: Number(a.duration_ms) ? `connected for ${exact(Number(a.duration_ms))}` : undefined }
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
// A place outside the root that is routine, not another project: Claude Code's own ~/.claude (memory, plans, settings) and
// scratch space (/tmp, /var/tmp, macOS /private/tmp). It draws dim with no ↗; any other place draws ↗ magenta and counts in the controls
export const routine = (p: string) => /^~\/\.claude(\/|$)/.test(p) || /^\/(private\/)?(var\/)?tmp(\/|$)/.test(p)
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
// kind: what tallies count by (`changed ×3`); tail: what this row is about, with its own glue (` → agent-log`, `: x.md`).
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
// a request's reply, its first line; '' when it wrote none. One that threw keeps its error in peek: no reply
const replyOf = (x: Entry) => x.kind === 'step' && !(stat(x) === 'failed' && !x.stop) ? first(x.peek) : ''
// what happened, action first in sentence case, its verb saying what the tool did; the inspector names the tool
// bare: a hook's or its text's name alone, for its row on its call's bracket, where the event and tool are plain
const action = (x: Entry, bare = false): string => {
  const d = x.detail
  if (x.kind === 'tool') switch (x.name) {
    case 'Bash': { // noCd: entries stored before the strip hold the raw command
      const s = noCd(d).replace(/^bash\b[:\s-]*/i, '')
      // no description: the detail is the command itself, an identifier like a hook's name, so `wc -l` never reads `Wc -l`
      return (x.cmd && noCd(x.cmd).replace(/\s+/g, ' ').startsWith(s) ? s : cap(s)) || 'Run a command'
    }
    case 'Read': case 'Edit': case 'Write': case 'NotebookEdit': return `${x.name} ${base(d)}`
    // by the pattern where the row holds it; rows stored before it read their folder alone
    case 'Grep': return x.pat ? `Search "${x.pat}"${d ? ` in ${base(d)}` : ''}` : `Search ${base(d) || 'files'}`
    case 'Glob': return x.pat ? `Find ${x.pat}${d ? ` in ${base(d)}` : ''}` : `Find files in ${base(d) || '.'}`
    case 'Skill': return `Run skill ${d}`
    case 'WebFetch': return `Fetch ${d.replace(/^https?:\/\//, '')}`
    case 'WebSearch': return `Search the web for ${d}`
    case 'ToolSearch': return `Load tools: ${d}`
    case 'SubagentHandback': return 'Hand back' // a subagent delivering its report to its parent
    case 'Agent': return d || x.name // `type: task`: the type is an identifier, as named
    default: return (x.name.startsWith('mcp__') ? d : cap(d)) || x.name // mcp `tool: arg` stays as named, an identifier
  }
  // A hook's row and its text's row read by name and event, never by what it said: that text stays in the inspector
  if (x.kind === 'hook') { // one hook by name, `guard on PreToolUse Bash`; a row of several draws as one row per hook (splitHooks). name = origin: a row stored before no-hook events were skipped
    const n = x.name.split(', ').length
    const who = x.name === x.origin ? 'No hook' : n > 1 ? `${n} hooks` : x.name
    return bare ? who : `${who} on ${x.origin ?? 'event'}${d ? ` ${d}` : ''}`
  }
  if (x.kind === 'prompt') {
    if (x.src && x.src !== 'engine') return `${x.name} ${label(x.type ?? '')}${!bare && x.origin && !x.name.includes(x.origin) ? ` on ${x.origin}` : ''}` // `context-mode context on PreToolUse`, `PreToolUse hook context`; a hook or plugin name is an identifier: never recased
    const [k, tail = ''] = ctxOf(x)
    return cap(k) + tail
  }
  if (x.kind === 'session') return x.name === 'reload' ? 'Plugin reloaded' : `Session init${d ? ` in ${base(d)}` : ''}` // `init`: `session start` is the engine context it sent
  if (x.kind === 'fork') return `Fork by ${x.name}: ${first(x.peek) || stat(x)}`
  // a request reads by what it did: the first line of its reply, else of its thinking, else the calls it made, else why it
  // stopped (replyOf). The rest of what it said or thought is the inspector's
  if (x.kind === 'step') {
    const said = replyOf(x)
    return (said ? `Reply: ${said}` : '') || (x.thought ? `Thought: ${x.thought}` : '') || (x.asked?.length ? `Called ${counted(x.asked)}` : '') || STOPPED[x.stop ?? ''] || (stat(x) === 'aborted' ? 'Interrupted' : 'No response')
  }
  if (x.kind === 'event') return x.name === 'model switch' ? `Model: ${x.detail.split(' → ').map(modelName).join(' → ')}${x.outcome ? ` (${x.outcome})` : ''}`
    : `${cap(x.name)}${x.detail ? `: ${x.detail}` : ''}${x.outcome ? ` (${x.outcome})` : ''}`
  if (x.kind === 'side') return x.src === 'plugin' ? (first(x.peek) || stat(x) === 'ok' ? x.name : `${x.name}: ${stat(x)}`) /* its reply in the inspector */ : cap(SIDE[x.name] ?? x.name.replace(/_/g, ' '))
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
  model: (x: Entry) => x.kind === 'tool' || x.kind === 'turn' || x.kind === 'fork' || x.kind === 'step', // what the model did: its requests, calls and turns, and what it answered a plugin's fork
  harness: (x: Entry) => x.kind === 'hook' || x.kind === 'fork' || x.kind === 'event' || x.kind === 'side' || (x.kind === 'prompt' && !hiddenCtx(x)) || (x.kind === 'tool' && (x.rule != null || x.check === 'deny')), // what your setup and the engine did: hooks, the text they injected, plugins' forks and model calls, rule decisions, the engine's own requests and what it reported happening
  context: (x: Entry) => x.bytes != null && x.kind !== 'hook', // hidden for now: no button, no command. Prompt blocks and attachments, everything with an injected size
  // where the session went beyond its project root: the calls that reached outside it, the directories and worktrees it gained or lost, its cwd changes
  outside: (x: Entry) => !!x.out || (x.kind === 'event' && /^(directory added|worktree created|worktree removed)$/.test(x.name)) || (x.kind === 'prompt' && ctxOf(x)[0] === 'CWD'),
} satisfies Record<string, (x: Entry) => boolean>
type View = keyof typeof VIEWS
const SHOWN: View[] = ['all', 'model', 'harness', 'outside'] // the views the controls and /agentlog offer
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
  // a request that wrote no text ranks debug: the calls it made follow as rows of their own, and its time stays in the turn header's split and in its calls' inspector
  if (x.kind === 'step') return stat(x) === 'aborted' ? 2 : first(x.peek) ? 1 : 0
  if (x.kind === 'event') return QUIET_EVENTS.has(x.name) || x.name === 'MCP connected' ? 0 : /^(MCP disconnected|file changed|command|task |teammate|setup)/.test(x.name) ? 1 : 2
  if (x.kind === 'side') return x.src === 'plugin' || !CHATTER.has(x.name) ? (x.name === 'compact' ? 2 : 1) : 0
  return stat(x) === 'aborted' ? 2 : 1
}
// a row that did something, drawn bright when its cell has no colour: a call at notice or above (shell, edits, agents, web, a
// rule's verdict), a request that replied, a plugin's fork. The rest (lookups, hook runs, context, engine events) draws dim
const bright = (x: Entry) => (x.kind === 'tool' && lvl(x) >= 2) || !!replyOf(x) || x.kind === 'fork'

// === STATE AND STORE ===
const started = new Map<string, number>() // agent id -> spawn time; AgentInfo has no timestamp. Teammates raise no agent.spawn, so they have none
// agent id -> the name a row shows when $.agent.list() does not hold the loop: a spawned agent's type once the engine drops it, a
// fork's plugin. Stored with the entries, so old turns keep their names. A fork has no agent.spawn and its SubagentStop's agent_type
// is '' (probed on 2.1.294), so it is named `fork` there and by its plugin once that plugin's $.model.fork resolves (the model.fork hook)
let names: Record<string, string> = {}
// PostToolUse context to come, per call, in the order its hooks ran: its attachment names only the tool (`PostToolUse:Read hook …`),
// and parallel calls of one tool run their hooks in turn, so the first waiting call of that tool is the one it belongs to.
// A copy or a replay of an attachment takes no place: its call was served when it first came
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
// The band's note on a turn that ended unusually, or none: `#4 took 41.2s, 3× the usual` against the median of main's earlier
// turns (3 or more of them), else `#4: hooks 12.0s of 20.0s` when hooks or a slow permission decision held the turn longest.
// Turns under 10 s never note: a short turn is not worth a look. Waiting on you is left out: that is your time, not a fault
export const unusualOf = (n: number, split: number[], ms: number, prior: number[]): string | undefined => {
  if (ms < 10_000) return undefined
  const ps = prior.filter(p => p > 0).sort((a, b) => a - b), mid = ps.length >= 3 ? ps[ps.length >> 1]! : undefined
  if (mid && ms > 2 * mid) return `#${n} took ${secs(ms)}, ${Math.round(ms / mid)}× the usual`
  const top = split.reduce((m, v, i) => v > split[m]! ? i : m, 0), other = ms - split.reduce((a, b) => a + b, 0)
  const who = SPLIT[top]!
  if ((who === 'hooks' || who === 'permission') && split[top]! > other && split[top]! >= 3000) return `#${n}: ${who} ${secs(split[top])} of ${secs(ms)}`
  return undefined
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
// with no classifier request). Without its collector records (an older engine) no wait is logged
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
// wrote: the request has streamed text, so its step row will rank info (lvl): until then it may end as a hidden debug row
type Live = { t: number; loop?: string; model?: string; phase?: 'waiting' | 'thinking' | 'writing' | 'calling'; said?: string; tool?: string; row?: Omit<Entry, 't'>; asking?: boolean; wrote?: boolean }
const liveNow = new Map<string, Live>()
const compactAt = new Map<string, number>() // loop -> when its PreCompact fired: PostCompact's row takes the time
// the collector's last hook_execution_complete: the settings hooks a classic event just ran, how many failed and how many the engine
// cancelled (a timeout). It lands inside that event's next, so classic.* reads it right after
// name: the collector's hook_name, `<event>:<target>` (`PostToolUse:Edit`). The first row that fits it takes it (classic.*), so one
// record marks one row; two parallel calls of one tool both fit, and which takes it is a guess: the record names no call
let lastRun: { t: number; event: string; name: string; errors: number; cancelled: number } | undefined
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
const startPoll = ($: any) => { timer ??= $.clock.every(2000, () => { tick($) }); note = undefined } // the pane is open: the band's note is read
// the band's line above the prompt while the pane is closed: the last turn's unusualOf, until the next turn ends or the pane opens
let note: string | undefined

// The engine caches prompt.attachment and prompt.context answers, and when the cache drops it asks again for every one
// in the history, in order, on a loop's next request: for a fresh instance of this plugin (a resume, a hot reload of
// it), and for a running one whenever the plugin chain changes (another plugin loaded, edited or removed: seen dumping
// a session's whole history as new rows, its SessionStart text and every prompt's hook text again) or a plugin calls
// $.ui.invalidate on either event. No per-ask replay flag exists, so `seen` counts how often each signature entered the
// context this session, stored beside the entries. A fresh instance owes those counts back: until a loop's first tool
// call or turn end, an ask that matches an owed copy is a replay and is skipped; one past the count is new and is logged.
// A running instance knows a replay by its lead: per loop and event, the first ask of a kind a context carries once (`once`),
// which comes back only when the history is asked again. It opens `rerun`, the counts owed back on that event, until the
// same end. A lead that recurs for real (an environment update exactly as long as the first) hides that request's repeats.
// What a loop asked before its lead (`pre`: a subagent's history can open with a hook tip) comes back ahead of it and logs
// as new; once the lead shows, those asks are counted back out and their rows taken away (`unlog`)
let seen: Record<string, number> = {}
let owed: Record<string, number> | undefined // undefined: not joining a conversation with history
let blind = false // a resume whose store is gone (pruned): nothing to match against, so the window logs nothing
const closed = new Set<string>() // loops ('main' or an agent id) whose first request since the instance began is over
const lead = new Map<string, string>() // `<loop>|att` or `<loop>|ctx` (prompt.context) -> the lead's signature
// what a context carries once, from its start: a first-message block, a SessionStart or SubagentStart hook's text, the engine's
// environment. Not a hook's tip or a reminder: they recur for real, and the first ask of a subagent's history can be one
const once = (sig: string, via: 'att' | 'ctx') => { const [type, origin] = sig.split('|'); return via === 'ctx' || origin === 'SessionStart' || origin === 'SubagentStart' || type === 'environment' }
// same keys -> the loop's counts a replay still owes back. All of the loop's: attachment types and block names never collide
// (`instructions` is an attachment, `claudeMd` a block), so only its own event's asks can match
const rerun = new Map<string, Record<string, number>>()
const close = (loop: string) => { closed.add(loop); rerun.delete(`${loop}|att`); rerun.delete(`${loop}|ctx`) }
const pre = new Map<string, string[]>() // same keys -> what the loop asked before its lead was set, in order
const recent = new Map<string, { sig: string; t?: number }[]>() // same keys -> the loop's latest asks, as many as its `pre`. t: when one logged as new
// an ask into its loop's lead, `pre` and `recent`. After the replay check, which reads them as they were before this ask.
// `pre` stops at 20: a loop that never gets a lead must not grow it all session, and a longer prefix then never matches
const track = (at: string, sig: string, via: 'att' | 'ctx', t?: number) => {
  if (!lead.has(at)) { if (once(sig, via)) lead.set(at, sig); else if ((pre.get(at)?.length ?? 0) < 20) pre.set(at, [...pre.get(at) ?? [], sig]) }
  const n = pre.get(at)?.length
  if (n) recent.set(at, [...recent.get(at) ?? [], { sig, t }].slice(-n))
}
// A fork re-reads its parent's history on its first request: every attachment main already logged comes back under the fork's id
// (seen: an engine fork between turns logging ~10k tok of environment, skill list and old hook output). Forks are Agent-tool spawns
// with `fork` and the engine's own (memory, compaction), which raise no agent.spawn and carry ids no list names. While a fork's
// first request lasts, an attachment matching one main logged is a copy, taken from the fork's own tally of main's counts.
// A copy logs no row but sits in the fork's context: `took` keeps it for a replay of the fork to owe back, and it can be the
// fork's lead. In memory, not in `seen`: `seen` is stored, and a session forks several times a turn.
// A plain subagent starts fresh: its skill list and memory files are its own cost and still log
const forks = new Set<string>()
const inherited = new Map<string, Record<string, number>>() // fork id -> main's counts not yet matched
const took = new Map<string, Record<string, number>>() // fork id -> the copies it matched, under its own signatures
async function copied($: any, agent: string | undefined, type: string, origin: string | undefined, bytes: number): Promise<boolean> {
  if (!agent || closed.has(agent)) return false
  if (!forks.has(agent) && (started.has(agent) || ((await $.agent.list().catch(() => [])) as AgentInfo[]).some(a => a.id === agent))) return false
  let left = inherited.get(agent)
  if (!left) { left = {}; for (const [g, c] of Object.entries(seen)) if (g.split('|')[2] === '') left[g] = c; inherited.set(agent, left) }
  const g = sigOf(type, origin, undefined, bytes)
  if (!left[g]) return false
  left[g]--
  const own = sigOf(type, origin, agent, bytes), mine = took.get(agent) ?? {}
  mine[own] = (mine[own] ?? 0) + 1; took.set(agent, mine)
  track(`${agent}|att`, own, 'att')
  return true
}
// type + author + loop + size: different texts of one kind and length (a date change) still count apart per copy,
// since a replay asks each past copy once and anything past the count is new
const sigOf = (type: string, origin: string | undefined, agent: string | undefined, bytes: number) => `${type}|${origin ?? ''}|${agent ?? ''}|${bytes}`
// stores written before `seen` hold entries alone; seed from them (only logged rows, so noisy kinds start at zero)
const seed = (xs: Entry[]) => { const s: Record<string, number> = {}; for (const x of xs) if (x.kind === 'prompt' && x.type && x.bytes != null) { const g = sigOf(x.type, x.origin, x.agent, x.bytes); s[g] = (s[g] ?? 0) + 1 } return s }
// names only for loops the kept entries still show: a session forks several times a turn, and the store has a size cap
// `seen` likewise drops a subagent's counts once no kept entry shows it: else they grow all session. Main's (agent part '') stay
const shown = (id: string) => entries.some(x => x.agent === id)
const saved = () => ({ entries, seen: Object.fromEntries(Object.entries(seen).filter(([g]) => { const a = g.split('|')[2]; return !a || shown(a) })), turn: turnNo, names: Object.fromEntries(Object.entries(names).filter(([id]) => shown(id))) })

// session id changes on /clear and resume; a failed load is retried next call. Outside the chain, so a load during a session
// switch cannot interleave with a push's: loadNow runs only inside mutate, which is why it checks the key again
const load = async ($: any): Promise<void> => { if (key && `r:${await $.session.id()}` === key) return; return mutate(() => loadNow($)) }
async function loadNow($: any): Promise<void> {
  const id = await $.session.id()
  const k = `r:${id}` // r: = redacted format (scrubbed, PEEK-capped text only); older s: keys hold unredacted text and pruneOthers() deletes them
  if (k === key) return
  if (dirty && key) { const tail = { key, value: saved() }; if (!await save($, tail.key, tail.value)) pendingTail = tail } // the old session's unflushed tail, before its key is dropped
  dirty = false
  const v = await $.store.get(k)
  if (key) { stepOf.clear(); bills = []; unbilled = [] } // the old session's requests; not on the first load, which a step's push can trigger after its pairing was queued
  if (setup.runsOf !== id) { setup.runs.clear(); setup.runsOf = id } // the old session's hook runs; ones the new session's records counted before this load stay
  key = k
  words.clear(); openTurns.clear(); sel = undefined // the old session's prompts (never stored, so a resumed session's turns have none), opened turns, the cursor
  entries = Array.isArray(v) ? v : Array.isArray(v?.entries) ? v.entries : []
  turnNo = typeof v?.turn === 'number' ? v.turn : Math.max(0, ...entries.map(x => x.turn ?? 0)) // stores from before turns hold none: start at 0
  seen = v?.seen && !Array.isArray(v) ? v.seen : seed(entries)
  names = { ...(v?.names && !Array.isArray(v) ? v.names : {}), ...names } // merged: a fresh instance can name a loop before its first load. Ids are unique, and saved() drops the ones no entry shows
  owed = entries.length || Object.keys(seen).length ? { ...seen } : undefined // /clear's empty session owes nothing
  blind = false; closed.clear(); lead.clear(); rerun.clear(); pre.clear(); recent.clear(); composed.clear(); checks.clear(); inherited.clear(); took.clear(); postCtx = [] // the old session's calls
  // every new key prunes the others: a session's start, and /clear and resume, which add a key. Queued, not awaited: prompt.submit
  // awaits this load before its next, and a prune reads every other session
  mutate(() => pruneOthers($)).catch(() => {})
}
const ready = ($: any) => key ? Promise.resolve() : load($).catch(() => {}) // a fresh instance loads before the replay window is read

function mutate(fn: () => Promise<void>): Promise<void> {
  const run = chain.then(fn)
  chain = run.catch(() => {})
  return run
}

// The store is one JSON file for all sessions (~1 MB), so a write per entry made a burst (a resume re-asks
// every past attachment) take seconds, and hooks awaiting it ran past their budget. Entries now land in
// memory and flush at most once a second; a hot reload loses at most that last second.
// A write the store refuses (its 4 MiB cap, shared by every session's key) keeps the rows dirty, shows "log not saved" (problemsOf),
// prunes the other sessions and tries again in RETRY ms; pendingTail is a switched-away session's tail still to write
let dirty = false
let flushTimer: Timer | undefined
let retryTimer: Timer | undefined
let unsaved = false
let pendingTail: { key: string; value: unknown } | undefined
const RETRY = 5000
async function save($: any, k: string, v: unknown): Promise<boolean> {
  try { await $.store.set(k, v); return true } catch {}
  unsaved = true
  await pruneOthers($).catch(() => {})
  retryTimer ??= $.clock.after(RETRY, () => { retryTimer = undefined; dirty = true; flush($).catch(() => {}) })
  $.ui.invalidate('ui.render')
  return false
}
// per session, in JSON text: SESSIONS of these and headroom fit the store's 4 MiB. Measured, as rows vary from ~200 bytes to over 2 KB
const BUDGET = Math.floor((4 * 1024 * 1024 - 256 * 1024) / SESSIONS)
const fit = () => {
  let n = JSON.stringify(saved()).length
  if (n <= BUDGET) return
  const size = new Map(entries.map(x => [x, JSON.stringify(x).length + 1]))
  while (n > BUDGET && entries.length) n -= size.get(evictOne())!
  // the rows are gone and it is still over: `seen` alone, a session that logged thousands of signatures. Its rarest go first
  if (n > BUDGET) for (const [g] of Object.entries(seen).sort((a, b) => a[1] - b[1])) { if (JSON.stringify(saved()).length <= BUDGET) break; delete seen[g] }
}
function flush($: any): Promise<void> {
  flushTimer?.cancel(); flushTimer = undefined
  return mutate(async () => {
    if (pendingTail && await save($, pendingTail.key, pendingTail.value)) pendingTail = undefined
    if (dirty && key) { dirty = false; fit(); if (!await save($, key, saved())) dirty = true }
    if (unsaved && !pendingTail && !dirty) { unsaved = false; retryTimer?.cancel(); retryTimer = undefined; $.ui.invalidate('ui.render') } // all written
  })
}
const touch = ($: any) => { dirty = true; flushTimer ??= $.clock.after(1000, () => { flushTimer = undefined; flush($).catch(() => {}) }) }

// true when this ask re-reads history already counted (see `seen`); otherwise counts it. Call after ready()
function replayed($: any, sig: string, agent?: string, via: 'att' | 'ctx' = 'att'): boolean {
  const at = `${agent ?? 'main'}|${via}`, again = recounted($, sig, agent, at)
  track(at, sig, via, again ? undefined : Date.now())
  return again
}
function recounted($: any, sig: string, agent: string | undefined, at: string): boolean {
  const loop = agent ?? 'main', back = lead.get(at) === sig
  if (owed && !closed.has(loop)) {
    if (blind) return true
    if (owed[sig]) { owed[sig]--; return true }
  }
  // not gated on `closed`: a chain change before the loop's first tool call replays too
  if (back && !rerun.has(at)) {
    // the asks just before the lead were this replay's too, logged as new: count them back out and take their rows away
    const p = pre.get(at) ?? [], r = recent.get(at) ?? []
    const ahead = p.length > 0 && r.length === p.length && r.every((a, i) => a.sig === p[i])
    if (ahead) for (const a of r) if (a.t != null) { if (!--seen[a.sig]!) delete seen[a.sig]; unlog($, a.sig, a.t) }
    const debt: Record<string, number> = { ...took.get(loop) } // a fork's copies of main's history
    for (const [g, n] of Object.entries(seen)) if (g.split('|')[2] === (agent ?? '')) debt[g] = (debt[g] ?? 0) + n
    if (ahead) for (const g of p) if (debt[g]) debt[g]-- // asked again already
    rerun.set(at, debt)
  }
  const debt = rerun.get(at)
  if (debt?.[sig]) { debt[sig]--; return true } // counted when it first came
  seen[sig] = (seen[sig] ?? 0) + 1
  touch($)
  return false
}
// takes away the row logged at t or later for an ask that turned out to be a replay's. The newest that matches: the replay's copy
function unlog($: any, sig: string, t: number): void {
  mutate(async () => {
    const i = entries.findLastIndex(y => y.kind === 'prompt' && y.t >= t && sigOf(y.type ?? '', y.origin, y.agent, y.bytes ?? 0) === sig)
    if (i < 0) return // counted but never logged (a skipped kind)
    const gone = entries.splice(i, 1)[0]!
    if (!gone.again && (gone.src === 'hook' || gone.src === 'plugin')) markAgain(entries, gone)
    touch($)
    $.ui.invalidate('ui.render')
  }).catch(() => {})
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
    await loadNow($)
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
    // over `keep`, the oldest hidden or debug row goes first: chatter only fills slots the rest leaves free (evictOne)
    while (entries.length > keep) evictOne()
    touch($)
    $.ui.invalidate('ui.render') // a hidden row still redraws: its turn's hidden count changed
    if (lvl(x) < level) return // no "N new" for a row nobody sees
    if (!follow) fresh++ // following, the redraw pins the window to the end
  }).catch(() => {})
}

// over `keep` or the store budget (fit), the oldest hidden or debug row goes first, else the oldest; returns it
// an evicted first copy of a hook text hands that role to the next copy, which then ranks notice again (markAgain)
function evictOne(): Entry {
  const d = entries.findIndex(y => hiddenCtx(y) || lvl(y) === 0)
  const gone = entries.splice(Math.max(0, d), 1)[0]!
  if (gone.kind === 'prompt' && !gone.again && (gone.src === 'hook' || gone.src === 'plugin')) markAgain(entries, gone)
  return gone
}

// called from loadNow on each key change (session.start's first load among them), and when a write is refused
async function pruneOthers($: any): Promise<void> {
  // keep the SESSIONS - 1 other sessions whose newest entry is newest. Insertion order pruned live sessions: every hot reload
  // prunes in every running session, and a long-lived session's key is the oldest. A session idle behind 9 busier ones still goes.
  // And by bytes: keys written before BUDGET can be larger, so the oldest kept ones also go until this session's share is free
  const others: string[] = (await $.store.keys()).filter((k: string) => k !== key)
  const redacted = others.filter(k => k.startsWith('r:'))
  const last = new Map<string, number>(), size = new Map<string, number>()
  for (const k of redacted) { const v = await $.store.get(k); const es = Array.isArray(v) ? v : v?.entries; last.set(k, Array.isArray(es) ? es.at(-1)?.t ?? 0 : 0); size.set(k, JSON.stringify(v ?? null).length) }
  const kept = [...redacted].sort((a, b) => last.get(b)! - last.get(a)!).slice(0, SESSIONS - 1)
  let total = kept.reduce((n, k) => n + size.get(k)!, 0)
  while (kept.length && total > 4 * 1024 * 1024 - 256 * 1024 - BUDGET) total -= size.get(kept.pop()!)!
  for (const k of others.filter(k => !kept.includes(k))) await $.store.delete(k)
}

// What broke this session, for the controls' red badge and the setup page: settings hook runs that failed or were cancelled (the collector's counts, else the red
// hook rows), API errors, turns the API failed, MCP servers that did not connect
const problemsOf = (xs: Entry[]): string[] => {
  const n = (f: (x: Entry) => boolean) => xs.filter(f).length
  const many = (k: number, one: string, more = `${one}s`) => k ? `${k} ${k > 1 ? more : one}` : ''
  const runs = [...setup.runs.values()].reduce((a, r) => a + r.errors + r.cancelled, 0)
  return [
    many(runs || n(x => x.kind === 'hook' && stat(x) === 'failed'), 'hook run failed', 'hook runs failed'),
    many(n(x => x.kind === 'event' && x.name === 'API error'), 'API error'),
    many(n(x => x.kind === 'event' && x.name === 'turn failed'), 'turn failed', 'turns failed'),
    unsaved ? 'log not saved' : '',
    many([...setup.mcp.values()].filter(m => m.status !== 'connected' && m.status !== 'disconnected').length || n(x => x.kind === 'event' && x.name === 'MCP failed'), 'MCP server down', 'MCP servers down'),
  ].filter(Boolean)
}

// === HOOKS ===
export const register: Register = (on, options) => {
  keep = Math.min(300, Math.max(1, Number(options.keep) || 300)) // the most a session keeps, as plugin.json says; fit() keeps fewer when its rows are large (step rows run to 2 KB)

  // what identifies a call: the scrubbed Bash command, a file target, or a short handle (agent type and task, skill, query, URL).
  // Prompts, file contents and edit bodies stay out of the store
  const RESERVED = new Set(['tool', 'tool_use_id', 'consent', 'agentId']) // tool.call keys that are not the tool's arguments
  // `tool: arg`. The server is dropped: the row stays short, and the inspector keeps the full name. A handle key
  // (url, query, path, command) beats the first string, which is often a mode flag (ctx_execute's language)
  const HANDLES = ['url', 'query', 'queries', 'path', 'file_path', 'command']
  const mcpDetail = (e: any): string => {
    const tool = String(e.tool).split('__').slice(2).join('__')
    const pick = (v: unknown) => [v].flat().filter(s => typeof s === 'string').join(', ') // queries is a string array
    const arg = HANDLES.map(k => pick(e[k])).find(Boolean) ?? pick(Object.entries(e).find(([k, v]) => !RESERVED.has(k) && typeof v === 'string')?.[1])
    return arg ? `${tool}: ${scrub(arg)}` : tool
  }
  const detailOf = (e: any): string =>
    e.tool === 'Bash' ? scrub(e.description ?? '') || noCd(scrub(e.command ?? '')) // the model's own label; else the command minus a leading cd
    : /^(Read|Edit|Write|NotebookEdit|Grep|Glob)$/.test(e.tool) ? e.file_path ?? e.notebook_path ?? e.path ?? ''
    : e.tool === 'Agent' ? `${e.subagent_type ?? 'general-purpose'}: ${scrub(e.description ?? '')}`
    : e.tool === 'Skill' ? `${e.skill ?? ''}${e.args ? ` ${scrub(e.args)}` : ''}`
    : e.tool === 'WebFetch' ? scrub(e.url ?? '')
    : /^(WebSearch|ToolSearch)$/.test(e.tool) ? scrub(e.query ?? '')
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
      const run = lastRun = { t: Date.now(), event: String(a.hook_event ?? ''), name: String(a.hook_name ?? ''), errors: Number(a.num_non_blocking_error) || 0, cancelled: Number(a.num_cancelled) || 0 }
      // the count is this session's: /clear and resume start it over, here and at load(). A record can land before the new session's
      // first load (its SessionStart hooks run first), so it asks the id itself. The plugins and MCP servers stay: the process loaded them once
      try { const sid = await $.session.id(); if (sid !== setup.runsOf) { setup.runs.clear(); setup.runsOf = sid } } catch {}
      const r = setup.runs.get(run.event) ?? { n: 0, ms: 0, errors: 0, cancelled: 0 }
      setup.runs.set(run.event, { n: r.n + 1, ms: r.ms + (Number(a.total_duration_ms) || 0), errors: r.errors + run.errors, cancelled: r.cancelled + run.cancelled })
    }
    if (e.event === 'plugin_loaded' && a['plugin.name']) setup.plugins.set(String(a['plugin.name']), { version: a['plugin.version'], scope: a['plugin.scope'], hooks: a.has_hooks === true || a.has_hooks === 'true', mcp: a.has_mcp === true || a.has_mcp === 'true' })
    // each server's last status, for the problems' `MCP server down`; the server list itself is /mcp's
    if (e.event === 'mcp_server_connection' && a.server_name) setup.mcp.set(String(a.server_name), { status: String(a.status ?? '') })
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
    close(e.agentId ?? 'main')
    const detail = String(detailOf(e)).replace(/\s+/g, ' ').slice(0, 400)
    const cmd = e.tool === 'Bash' && e.command ? scrub(e.command).slice(0, 400) : undefined // newlines kept so heredocs stay readable in the inspector; 400 = the old detail cap, keeping the store budget
    // Grep's and Glob's pattern: not in the plugin types (BuiltinToolInputs is undeclared), but in Claude Code's tool schemas.
    // Absent, the row reads its folder alone
    const p0 = (e as any).pattern, pat = /^(Grep|Glob)$/.test(e.tool) && typeof p0 === 'string' && p0 ? scrub(p0).replace(/\s+/g, ' ').slice(0, 80) : undefined
    const t0 = Date.now()
    const step = e.tool_use_id ? stepOf.get(e.tool_use_id) : undefined
    if (e.tool_use_id) { loopOf.set(e.tool_use_id, e.agentId); stepOf.delete(e.tool_use_id) }
    const now = `t${e.tool_use_id ?? t0}`
    liveNow.set(now, { t: began, loop: e.agentId, row: { kind: 'tool', name: e.tool, detail, outcome: '', cmd, pat, agent: e.agentId } })
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
    const why = CLASSIFIED.test(text) ? scrub(classifierWhy(text)) : refused && DENIED.test(text) ? scrub(deniedWhy(text))
      : r.deny ? peek(r.deny) ?? peek(v?.reason) : r.isError ? peek(r.text) : undefined // only failures keep text: an ok result can be a whole file
    const ins = r.isError && !r.deny && !refused && !hookBlocked && text ? insightOf(cmd, text) : undefined // refused: it never ran, so no output to boil down
    const status: Status = r.deny || refused || hookBlocked ? 'denied' : ins?.quiet ? 'nomatch' : r.isError ? 'failed' : 'ok'
    const pl = await place, a = e as any
    const out = pl ? outsideOf(e.tool, { path: a.file_path ?? a.notebook_path ?? a.path, cmd }, ...pl) : undefined
    try { push($, { kind: 'tool', name: e.tool, detail, outcome, status, agent: e.agentId, ms: r.deny ? undefined : Date.now() - t0 - (wait ?? 0), wait, waitFor, peek: why, cmd, pat, check: v?.check, rule: v?.rule, exit: ins?.exit, insight: ins?.text || undefined, child: sp?.id, use: e.tool_use_id, step, via: classified ? 'classifier' : d?.source, out }, { ahead: pre, start: began }) } catch {} // logger never breaks the call
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
            if (c.kind === 'text') { if (text.length < PEEK) text += c.text; now.wrote = true; phase('writing', first(text)) }
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
          thought: scrub(first(thought)).replace(/^#+\s*|\*\*|__/g, '').slice(0, 200) || undefined, // its first line: a summary's title, and the store's budget
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
      case 'ConfigChange': hookFresh = false; return ev('settings changed', e.file_path ? at(e.file_path) : e.source) // the path says whose settings: no `(user_settings)` after it
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
    // ConfigChange's source (`user_settings`) is left out: its event row names the settings file
    const detail = String(e.tool_name ?? e.tool ?? (event === 'ConfigChange' ? undefined : e.source) ?? e.reason ?? [e.load_reason, e.file_path && at(e.file_path)].filter(Boolean).join(' ')).slice(0, 120) // no e.prompt: that is the person's prompt
    // settings hooks that exited with an error or that the engine cancelled (a timeout), as the collector counted them: a red row,
    // even when the rest of the event changed nothing
    const target = targetOf(e, event)
    const run = lastRun && lastRun.event === event && lastRun.t >= t0 && (!lastRun.name.includes(':') || fits(lastRun.name.slice(lastRun.name.indexOf(':') + 1), target)) ? lastRun : undefined
    if (run) lastRun = undefined
    const broke = run ? [run.cancelled && `${run.cancelled} cancelled`, run.errors && `${run.errors} failed`].filter(Boolean).join(', ') : ''
    const said = (typeof blocked === 'string' ? blocked : ctx.join('\n')) || broke // the block reason, else the context the hooks added, else what broke
    // a hook that broke beside others that added context is still a failure: red, and what broke leads the text. A block or stop keeps its own mark
    const failed = !!broke && !blocked && !r?.preventContinuation
    const cfg = await hooksOf($)
    // the wrapped hooks that ran on this event and call, within its span
    const runs = wraps(cfg, event, target) ? await runsOf($, runOf(e, event, t0, Date.now()), t0) : []
    // each context entry is one hook's: by the run that said it, else named in its own first line. Context leaves the silent hooks
    // in the name: they ran too, and the row counts them. A block keeps only its blocker, whom the call's ⊘ names (byOf)
    const spoke = runs.length ? runNames(cfg, event, target, runs, typeof blocked === 'string' ? [blocked] : ctx)
      : typeof blocked === 'string' || ctx.length < 2 ? hookName(cfg, event, target, said) : [...new Set(ctx.flatMap(c => hookName(cfg, event, target, c).split(', ')))].join(', ')
    const name = runs.length && !blocked && ctx.length ? withSilent(cfg, event, target, runs, spoke) : spoke
    if (!name && !outcome && !broke && ms < SLOW) return r // the event fired, but no hook is set on it: most events, most of the time
    // every classic event but PreToolUse names its loop (agent_id); PreToolUse's comes from the call it runs inside (loopOf)
    // several hooks: each wrapped one's own time; the engine times only the chain
    const each = name.includes(', ') && runs.length ? Object.fromEntries(runs.map(r => [r.name, r.ms])) : undefined
    // several hooks: which of them the outcome is, and which broke in silence, so each hook's line gets its own mark
    const spokeN = name.includes(', ') ? (typeof blocked === 'string' || ctx.length ? spoke.split(', ').filter(Boolean) : []) : undefined
    const bad = spokeN && runs.filter(r => r.exit != null && r.exit !== 0 && r.exit !== 2 && !spokeN.includes(r.name)).map(r => r.name)
    const errs = bad?.length ? bad : undefined
    // several hooks: each one's own text, credited as spoke was, so a hook's line opens what that hook said, not the merged chain.
    // A text credited to several at once (hookName could not tell them apart) stays on the row only
    const own: Record<string, string> = {}
    if (spokeN?.length) for (const p of typeof blocked === 'string' ? [blocked] : ctx) { const n = speaker(runs, p) ?? hookName(cfg, event, target, p); if (!n.includes(', ')) own[n] = own[n] ? `${own[n]}\n${p}` : p }
    const says = Object.keys(own).length ? Object.fromEntries(Object.entries(own).map(([n, s]) => [n, peek(s) ?? ''])) : undefined
    const exits = name.includes(', ') && runs.some(r => r.exit) ? Object.fromEntries(runs.filter(r => r.exit).map(r => [r.name, r.exit!])) : undefined
    try { push($, { kind: 'hook', name: name || `${event} hook`, origin: event, detail, outcome, status: failed ? 'failed' : undefined, src: 'hook', agent: e.agent_id ?? (e.tool_use_id ? loopOf.get(e.tool_use_id) : undefined), ms, peek: peek(failed && said !== broke ? `${broke}\n${said}` : said), use: e.tool_use_id, each, spoke: spokeN, errs, says, exits }) } catch {}
    return r
  })

  // what reaches the model outside the typed prompt: first-message context blocks (claudeMd, a plugin's own) and engine-injected
  // attachments. The other core blocks reach it as attachments (SENT_AS_ATTACHMENT) and log there
  on('prompt.context', async ($, e, next) => {
    const r = await next(e)
    await ready($)
    for (const b of r.blocks) try {
      if (SENT_AS_ATTACHMENT.has(b.name)) continue // before replayed: never counted in `seen`
      if (replayed($, sigOf(b.name, undefined, undefined, b.text.length), undefined, 'ctx')) continue
      if (b.name === 'claudeMd') memBytes = b.text.length
      push($, { kind: 'prompt', name: label(b.name), type: b.name, detail: '', outcome: kb(b.text.length), src: 'engine', bytes: b.text.length, peek: peek(b.text) }) } catch {}
    return r
  })
  on('prompt.attachment', async ($, e, next) => {
    const r = await next(e)
    // a PostToolUse hook's context takes the first call waiting for one, even when left out of the request: its place in the
    // queue is spent either way, or the next attachment of that tool would go with this one's call. Not a copy or a replay
    const isPost = e.origin.kind === 'hook' && e.origin.event === 'PostToolUse'
    const postTool = isPost ? (r.text ?? e.text ?? '').trimStart().match(/^\w+:(\S+) hook\b/)?.[1] : undefined
    if (r.text == null) { if (isPost) takePost(postTool, e.agentId); return r } // left out of the request: never entered the context
    await ready($)
    const origin = e.origin.kind === 'engine' ? undefined : e.origin.event
    if (await copied($, e.agentId, e.type, origin, r.text.length)) return r // a fork's copy of main's history: in its context, but not new
    if (replayed($, sigOf(e.type, origin, e.agentId, r.text.length), e.agentId)) return r // counted before the skips below, so noisy and skipped kinds replay-match too
    const post = isPost ? takePost(postTool, e.agentId) : undefined
    if (e.type === 'instructions' && r.text.length === memBytes) { memBytes = undefined; return r } // same bundle as the claudeMd block: log it once. One skip only, so a later re-injection (e.g. after compaction) still shows
    // the hook's name; its event shows in the inspector. The engine's framing carries the target: `PreToolUse:Bash hook additional context:`
    const target = r.text.trimStart().match(/^\w+:(\S+) hook\b/)?.[1]
    // a hook's text: by the wrapped run that said it, within the last LATE (PreToolUse context waits for the next request), else
    // named in its own first line
    const cfg = e.origin.kind === 'hook' ? await hooksOf($) : {}, ev = e.origin.kind === 'hook' ? e.origin.event : ''
    const by = ev && wraps(cfg, ev, target) ? speaker(await runsOf($, x => x.event === ev && !!x.say, Date.now() - LATE), r.text) : undefined
    const name = e.origin.kind === 'hook' ? by ?? (hookName(cfg, ev, target, r.text) || `${ev} hook`)
      : origin ? `${origin} ${label(e.type)}` : label(e.type)
    // a queued prompt is the person's own typing. session_context carries their email, which scrub keeps (paths and git output stay readable)
    const text = e.type === 'queued_command' ? undefined : peek(e.type === 'session_context' ? r.text.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '***') : r.text)
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
    if (e.command?.name === 'agentlog') return { drop: 'agentlog: kept out of the conversation' } // not a turn either
    if (!OWN.has(e.origin.kind)) return next(e)
    if (e.turnId) { const r = await next(e); if (!('drop' in r && r.drop)) { pending++; queued.push(wordsOf(e)) } return r }
    const t = Date.now() // the turn's start: its UserPromptSubmit hooks run inside next
    await mutate(async () => { await loadNow($); turnNo++; words.set(turnNo, wordsOf(e)); touch($) }).catch(() => {}) // before next: the UserPromptSubmit hooks it runs belong to the new number
    const r = await next(e)
    if ('drop' in r && r.drop) mutate(async () => { words.delete(turnNo); turnNo--; touch($) }).catch(() => {}) // a dropped prompt never entered
    else { busy = true; turnAt = t }
    return r
  })

  // rate limits as the engine measures them, for the setup button's `limit 80%`. Context, cost and the limits in full are
  // /context, /cost and /status's; the setup page leaves them out
  on('session.measure', async ($, e, next) => {
    setup.limits = [...e.rateLimits]
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    refreshSetup($).catch(() => {})
    try { await $.command.register({ name: 'agentlog', description: `Toggle the agent log pane; "clear" empties it, "${SHOWN.join('|')}" picks a view, "level debug|info|notice|error" the least important row shown.`, argumentHint: `[clear|${SHOWN.join('|')}|level <debug|info|notice|error>]`, immediate: true }) } catch {} // throws on hot reload: no session bound yet
    // never opens by itself: a debugger, not a dashboard. A turn that ended unusually says so in the band (AbovePrompt)
    try {
      await load($) // which prunes the other sessions
      // session.start fires once per process, then again on each fresh load of this plugin (a reload, an enable, a worker
      // respawn): only the first is the session beginning. No flag says which, so the first marks it in $.state (declared in state.d.ts)
      const started = { plugin: 'agent-log', key: 'started' } as const
      const again = (await $.state.get(started).catch(() => undefined))?.value === true
      if (!again) await $.state.set(started, true).catch(() => {})
      push($, again ? { kind: 'session', name: 'reload', detail: '', outcome: '' } : { kind: 'session', name: 'start', detail: e.cwd, outcome: '' })
    } catch {}
    return next(e)
  })

  // compaction drops a loop's past attachments from its history, so a later replay no longer asks them: forget their counts,
  // and its lead: a replay starts at the first ask after the compaction
  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (!('skip' in r)) {
      await ready($)
      const a = e.agentId ?? ''
      for (const g of Object.keys(seen)) if (g.split('|')[2] === a) delete seen[g]
      if (e.agentId) took.delete(e.agentId) // a fork's inherited copies went with the rest
      for (const v of ['att', 'ctx']) for (const m of [lead, rerun, pre, recent]) m.delete(`${e.agentId ?? 'main'}|${v}`)
      touch($)
    }
    return r
  })

  // The band above the prompt, shared with other mods: theirs stays, ours goes on top. Between turns, while the pane is closed
  // (timer lives only while it is open) and the last turn ended unusually
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const theirs = await next(e)
    if (!note || timer || e.props.hasSurvey || e.props.isWorking) return theirs
    const { Box, Text } = $.ui.resolve(e)
    const line = <Text key="agent-log-band" wrap="truncate-end"><Text dimColor>/agentlog </Text><Text color="yellow">{note}</Text></Text>
    return theirs ? <Box flexDirection="column">{line}{theirs}</Box> : line
  })

  on('session.end', async ($, e, next) => {
    owed = undefined
    try { await flush($) } catch {} // the last second of entries, before the process goes
    return next(e)
  })

  // /agentlog stays out of the conversation: its reply is a toast, and prompt.submit drops its line
  on('command.run', { command: 'agentlog' }, async ($, e) => {
    const r = await (async () => {
    if (e.args.trim() === 'clear') {
      await mutate(async () => {
        await loadNow($)
        entries = [] // `seen` stays: clearing the log takes nothing out of the model's context
        expanded.clear()
        fit()
        dirty = !await save($, key, saved())
        $.ui.invalidate('ui.render')
      })
      return { text: 'agent log cleared' }
    }
    const up = (await $.ui.panes()).some((p: any) => p.id === PANE)
    const arg = e.args.trim() === 'agent' ? 'model' : e.args.trim() // `agent`: the model view's name before it was renamed, kept as an alias
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
    })()
    try { $.ui.toast(r.text) } catch {}
    return {}
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
    close(e.agentId ?? 'main')
    const status: Status = e.isAborted ? 'aborted' : e.reason === 'answer' ? 'ok' : 'failed' // an API error or a refusal ended it
    // a spawned agent keeps its cost and answer for its Agent row's inspector (linked: a foreground agent ends before its Agent row
    // is pushed). Main's and a plugin fork's are shown nowhere: a fork's reply already sits on its fork row
    const mine = !!e.agentId && linked(e.agentId)
    try { push($, { kind: 'turn', name: 'turn', detail: '', outcome: mine ? costOf(e.usage) : '', status, agent: e.agentId, ms: e.durationMs, peek: mine ? peek(e.answer) : undefined }) } catch {} // a closing boundary per loop; push redraws
    // main's split, once its rows are in (queued behind the push): kept on its turn row, so a full log evicting them loses nothing
    if (!e.agentId) mutate(async () => {
      const y = entries.findLast(z => z.kind === 'turn' && !z.agent)
      if (y?.ms != null) {
        y.split = splitOf(entries.filter(z => z.turn === y.turn), y.t - y.ms, y.t)
        note = unusualOf(y.turn ?? turnNo, y.split, y.ms, entries.filter(z => z !== y && z.kind === 'turn' && !z.agent && z.ms != null).map(z => z.ms!))
        touch($)
      }
    }).catch(() => {})
    if (!e.agentId) { busy = false; turnAt = undefined }
    if (!e.agentId && pending) mutate(async () => { await loadNow($); queued.forEach((w, i) => words.set(turnNo + 1 + i, w)); turnNo += pending; pending = 0; queued = []; touch($) }).catch(() => {}) // queued after the push, so the turn row keeps its number
    return r
  })

  // The person's moves shift the log's own window (win) and never the engine's, so the header above the rows stays put (d.ts
  // ui.scroll: a hook drawing its own rows under a header moves them by e.by and invalidates). The tree fits the body, so the
  // engine reports Home and End as contentRows: about a page; e still jumps to the newest row. An arrow (one row, no pointer:
  // a wheel tick carries one) moves the row cursor instead, as j and k do; the wheel and the page keys move the window
  on('ui.scroll', { requestId: PANE }, async ($, e, next) => {
    if (inspect || page) return next(e) // the inspector and the pages wrap text, so their height is unknown: the engine scrolls them
    if (e.origin.kind === 'person' && !e.pointer && Math.abs(e.by) === 1) { move = e.by; $.ui.invalidate('ui.render'); return {} }
    if (e.origin.kind === 'person') {
      win = Math.max(0, Math.min(winMax, win + e.by)); follow = win >= winMax // the render decides again with the rows it draws
      $.ui.invalidate('ui.render')
      return {}
    }
    return next({ ...e, offset: 0 }) // back's reset of the window the inspector moved: to the top, where it stays
  })

  // the ring moved by the person (Tab, the arrows, a click) onto a row's Button: the cursor is there now, so j and k go on from
  // it. A row Button's key is `b` and its line's (`bg12`, `bg12s0` an advisor's, `be12w` a wait's); the plugin's own moves
  // (show, a cursor move) are ours already
  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    if (e.origin.kind === 'person' && e.element && /^b(g\d+(s\d+)?|e\d+w)$/.test(e.element)) sel = e.element.slice(1)
    return next(e)
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
      // the cursor on the row back lands on, the ring with it: j and k go on from the row the inspector showed last
      if (key) { sel = key; $.clock.after(50, () => { $.ui.focus({ requestId: PANE, key: `b${key}` }).catch(() => {}) }) }
    }
    const inspector = async (x: Entry) => {
      const a = x.agent ? ((await $.agent.list().catch(() => [])) as AgentInfo[]).find(y => y.id === x.agent) : undefined
      const who = x.agent ? (a ? `${nameOf(a.id)} · ${a.description}` : `${names[x.agent] ?? 'subagent'} ${x.agent}`) : 'main loop'
      const end = runs(x.child).at(-1) // an Agent row's agent's last run
      const what =
        x.kind === 'turn' ? `A turn of the ${who} ended${stat(x) === 'aborted' ? ', aborted' : ''}`
        : x.kind === 'fork' ? `The ${x.name} plugin forked the conversation: one tool-less question over main's transcript, answered in a loop of its own${stat(x) === 'aborted' ? ', cut off when the turn was interrupted' : stat(x) === 'failed' ? ', which got no reply' : ''}`
        : x.kind === 'tool' ? `${x.name} call by the ${who}${stat(x) === 'denied' ? ', refused before it ran' : stat(x) === 'failed' ? ', failed' : stat(x) === 'nomatch' ? ', found nothing' : ''}`
        : x.kind === 'hook' ? `${x.name === x.origin ? 'No hook' : x.name} ran on ${x.origin ?? 'an event'} and ${stat(x) === 'failed' ? `failed${x.exit != null ? ` with exit ${x.exit}` : ''}` : stat(x) === 'feedback' ? 'sent feedback to the model' : x.outcome.startsWith('block') ? 'blocked it' : x.outcome.startsWith('context') ? 'added context for the model' : x.outcome === 'stop' ? 'stopped the session' : 'changed nothing'}`
        : x.kind === 'prompt' && x.src === 'hook' ? `${label(x.type ?? '')} of a ${x.origin ?? ''} hook, injected into the model's context`
        : x.kind === 'prompt' && x.src === 'plugin' ? `Context a plugin attached on ${x.origin ?? 'a chain'}`
        : x.kind === 'prompt' ? `Text the engine injected into the model's context (${x.type ?? x.name})`
        : x.kind === 'step' ? `A request to ${modelName(x.name)} by the ${who}${x.stop === 'max_tokens' ? ', cut off at the output limit' : stat(x) === 'aborted' ? ', interrupted before it ended'
          : stat(x) === 'denied' ? ', which the model refused' : x.stop === 'model_context_window_exceeded' ? ', over the context window' : stat(x) === 'failed' ? ', which got no response'
          : x.stop === 'end_turn' ? ', which ended the turn' : x.asked ? `, which asked for ${counted(x.asked)}` : ''}`
        : x.kind === 'event' ? `${EVENT_WHAT[x.name] ?? 'Something the engine reported'}${x.agent ? `, in the ${who}` : ''}`
        : x.kind === 'side' ? (x.src === 'plugin' ? `A model call the ${x.name} plugin made ($.model.complete), outside the conversation` : `A model request the engine made on its own (${x.name}), outside the conversation's turns`)
        : `Session ${x.name}`
      // the inspector steps through the rows the log shows, in its order (order): a call's hook rows around it, a turn's hidden
      // rows once its header opened them in place. A row the log does not show (a problem the setup page opened) steps nowhere
      const steps = order
      const at = steps.indexOf(x)
      nav = { prev: at > 0 ? steps[at - 1] : undefined, next: at >= 0 ? steps[at + 1] : undefined }
      // an Agent row's agent: the log filtered to its rows (pick), back on the log; pressed again there, every loop's
      const only1 = () => { const id = x.child!; inspect = undefined; pageBack = false; backTo = undefined; follow = true; $.ui.scroll({ in: PANE, to: 'start' }).catch(() => {}); pick(id) }
      const kv = (k: string, v: string) => <Box key={k} flexDirection="row"><Box flexShrink={0} width={8}><Text dimColor>{k}</Text></Box><Text wrap="wrap">{v}</Text></Box>
      return (
        <Box key="inspect" flexDirection="column" width={e.props.bodyColumns}>
          <Box flexDirection="row" flexWrap="wrap" columnGap={2}>{/* wraps rather than clips: the engine scrolls the inspector, so its height need not be counted */}
            <Button key="back" label="← back" hotkey="b" plain autoFocus onPress={back} />
            {at > 0 && <Button key="prev" label="↑ prev" hotkey="p" plain onPress={() => show(steps[at - 1]!)} />}
            {at >= 0 && at < steps.length - 1 && <Button key="next" label="↓ next" hotkey="n" plain onPress={() => show(steps[at + 1]!)} />}
            {x.child && <Button key="fonly" label={only === x.child ? 'every agent' : 'only this agent'} hotkey="f" plain onPress={only1} />}
          </Box>
          <Text> </Text>
          <Box flexDirection="row"><Text weight="semibold">{action(x)}</Text><Text dimColor>  {x.kind === 'tool' ? x.name : toolOf(x)}</Text>{out(cell(x))}</Box>
          <Text dimColor wrap="wrap">{what}</Text>
          <Text> </Text>
          {kv('when', `${x.turn != null ? `${x.turn ? `turn ${x.turn}` : 'session start'} · ` : ''}${new Date(x.t).toLocaleTimeString()} (${ago(Date.now() - x.t)} ago)`)}
          {kv('agent', who)}
          {x.src === 'hook' && x.origin && kv('trigger', [x.origin, x.detail].filter(Boolean).join(' · '))}
          {/* a hook's input: the call it ran on, as its row stores it; its command as your settings or the plugin's hooks.json write it */}
          {x.kind === 'hook' && x.use && (c => c && kv('input', `${c.name}: ${c.cmd ?? c.detail}`))(entries.find(y => y.kind === 'tool' && y.use === x.use))}
          {x.kind === 'hook' && (cs => cs.length > 0 && kv('command', cs.join('\n')))([...new Set((hookCfg?.[x.origin ?? ''] ?? []).filter(h => h.name === x.name && fits(h.matcher, x.detail || undefined)).map(h => h.cmd ?? ''))].filter(Boolean))}
          {x.cmd ? kv('command', x.cmd) : x.detail && x.src !== 'hook' && kv(x.name === 'Bash' ? 'command' : 'input', x.detail)}
          {x.cmd && kv('what', x.detail)}
          {x.pat && kv('pattern', x.pat)}
          {x.out && kv('where', `${x.out}, outside the session's project root`)}
          {x.exit != null && kv('exit', String(x.exit))}
          {/* the check's verdict, then who settled an ask: `asked you; you allowed it once`, `allowed by rule Bash(git push:*)` */}
          {x.check && kv('decided', x.check === 'ask'
            ? `asked${x.via?.startsWith('user_') ? ' you' : ''}${x.rule ? ` (rule ${x.rule})` : ''}; ${VIA[x.via ?? ''] ?? (x.via ? `${x.via} decided` : 'the mode or you decided')}`
            : `${x.check === 'allow' ? 'allowed' : 'denied'} by ${x.rule ? `rule ${x.rule}` : 'the mode, a hook or the tool itself'}`)}
          {x.ms != null && kv(x.child ? 'call' : 'took', exact(x.ms))}
          {x.kind === 'turn' && !x.agent && (m => [(sp => sp && kv('split', sp + (sp.includes('other ') ? ' (other: the engine\'s and plugins\' own work between steps)' : '')))(splitText(turnOf(x), m)), m.agents.size > 1 && kv('loops', loops(m.agents))])(turnIn(turnOf(x)))}
          {/* the wait came before the call ran, so took leaves it out */}
          {x.wait != null && kv('waited', `${exact(x.wait)} for ${x.waitFor ?? 'the decision'}, before it ran`)}
          {x.kind === 'step' && kv('model', `${x.name}${x.effort != null ? ` · effort ${x.effort}` : ''}`)}
          {x.kind === 'side' && x.detail && kv('model', x.detail)}
          {x.ttft != null && kv('first', `${exact(x.ttft)} to the first token`)}
          {x.think != null && kv('think', exact(x.think))}
          {x.tok && kv('tokens', tokLine(x.tok))}
          {x.cost != null && kv('cost', `$${x.cost.toFixed(4)}`)}
          {x.asked && kv('calls', counted(x.asked))}
          {x.server && kv('server', x.server.map(([n, ms]) => `${n} ${exact(ms ?? undefined)}`).join(', '))}
          {x.stop && kv('stop', x.stop)}
          {x.req && kv('request', x.req)}
          {/* a call's request: the model's time before it, which the call's own row leaves out */}
          {x.kind === 'tool' && x.step && (s => s && kv('asked', `by ${modelName(s.name)} in a ${exact(s.ms)} request${s.thought ? `: ${s.thought}` : ''}`))(entries.find(y => y.kind === 'step' && y.step === x.step))}
          {x.child && kv('ran', ran(x)[0])}
          {/* each hook once, what it did in brackets: what it said back (blocked, feedback), whether its text went to the model */}
          {x.kind === 'tool' && x.use && (hs => hs.length > 0 && kv('hooks', [...new Set(hs.map(y => y.name))].map(n => {
            const ys = hs.filter(y => y.name === n), said = ys.find(loud)
            const did = [said && stat(said), ys.some(y => y.kind === 'prompt') && 'added text'].filter(Boolean)
            return `${n}${did.length ? ` (${did.join(', ')})` : ''}`
          }).join(', ')))(entries.filter(y => y.use === x.use && y.kind !== 'tool'))}
          {x.kind === 'fork' && x.outcome && kv('tokens', x.outcome)}
          {end?.outcome && kv('tokens', end.outcome)}
          {x.type && x.type !== x.name && kv('type', x.type)}
          {x.insight && (
            <Box flexDirection="column" marginTop={1}>
              <Text dimColor>what broke</Text>
              <Text wrap="wrap">{x.insight}</Text>
            </Box>
          )}
          {x.thought && (
            <Box flexDirection="column" marginTop={1}>
              <Text dimColor>thought, its first line</Text>
              <Text wrap="wrap">{x.thought}</Text>
            </Box>
          )}
          {x.peek && (
            <Box flexDirection="column" marginTop={1}>
              <Text dimColor>{x.kind === 'event' ? 'details' : x.kind === 'step' || x.kind === 'side' ? (stat(x) === 'failed' && !x.stop ? 'error' : x.peek.length >= PEEK ? `reply, first ${PEEK} chars` : 'reply') : x.kind === 'fork' ? (stat(x) === 'ok' ? 'reply' : 'reason') : x.kind === 'tool' ? (stat(x) === 'denied' ? 'reason' : x.peek.length >= PEEK ? `output, first ${PEEK} chars` : 'output') : stat(x) === 'feedback' ? 'feedback' : x.outcome.startsWith('block') ? 'reason' : 'text'}{x.bytes != null && x.bytes > PEEK ? ` (first ${PEEK} of ${x.bytes} chars)` : ''}</Text>
              <Text wrap="wrap">{x.peek}</Text>
            </Box>
          )}
          {end?.peek && (
            <Box flexDirection="column" marginTop={1}>
              <Text dimColor>{end.peek.length >= PEEK ? `reply, first ${PEEK} chars` : 'reply'}</Text>
              <Text wrap="wrap">{end.peek}</Text>
            </Box>
          )}
        </Box>
      )
    }
    const jump = () => { follow = true; sel = undefined; $.ui.invalidate('ui.render') } // following, the draw pins the window to the end; the cursor starts over
    // folds stay as they were: a fold's id is its first entry's, the same in every view, level and filter that draws it
    const pick = (id: string) => { only = only === id ? undefined : id; $.ui.invalidate('ui.render') }
    const setView = (v: View) => { view = view === v ? 'all' : v; follow = true; $.ui.invalidate('ui.render') }
    // `l` toggles the two levels a log is read at: info, notice. Debug's rows open per turn in place (openTurns), error is
    // the setup page's problems; `/agentlog level` still sets all four. From debug or error, back to info
    const nextLevel = () => { level = level === 1 ? 2 : 1; follow = true; $.ui.invalidate('ui.render') }
    const agents: AgentInfo[] = await $.agent.list().catch(() => [])
    // a numbered name (tagOf) wins over the list's type; else the list's, so a teammate still reads `teammate`. ||: an empty type names nothing
    const nameOf = (id: string) => id === 'main' ? 'main' : / #\d+$/.test(names[id] ?? '') ? names[id]! : agents.find(a => a.id === id)?.type || names[id] || 'subagent'
    // a row's loop prefix, kept short so the action keeps its room: the type cut to 10, its `#N` kept (`general-… #2 · `)
    const whoOf = (id: string) => { const [, n = '', tag = ''] = nameOf(id).match(/^(.*?)( #\d+)?$/) ?? []; return `${n.length > 10 ? n.slice(0, 9) + '…' : n}${tag} · ` }
    const kids = new Map<string, AgentInfo[]>()
    const listed = new Set(agents.map(a => a.id))
    // a parent list() does not hold (engine fork, workflow agent) would hide the child: hang it under main
    for (const a of agents) { const p = a.parentId && listed.has(a.parentId) ? a.parentId : 'main'; kids.set(p, [...(kids.get(p) ?? []), a]) }
    const isRootMate = (a: AgentInfo) => a.type === 'teammate' && (kids.get('main') ?? []).includes(a)
    const now = Date.now()
    // The header's agents, each under its parent on the log's tree guides: `├ ` or the last sibling's `└ `, a parent's line carried
    // on (`│ `) while its siblings follow; drawn as log rows below (agentRow), so nesting reads as it does in an open fold.
    // Finished agents fold into the toggle row unless showDone. An agent stays listed while it or one below it runs, and while it is the filter
    const tree: [AgentInfo | typeof TEAM, string][] = []
    const live = (a: AgentInfo): boolean => a.status === 'running' || only === a.id || (kids.get(a.id) ?? []).some(live)
    const done = agents.filter(a => !live(a)).length
    const walk = (all: (AgentInfo | typeof TEAM)[], rest: string) => {
      const xs = showDone ? all : all.filter(a => a === TEAM ? (kids.get('main') ?? []).filter(isRootMate).some(live) : live(a))
      xs.forEach((a, j) => {
        const last = j === xs.length - 1
        tree.push([a, rest + (last ? '└ ' : '├ ')])
        walk(a === TEAM ? (kids.get('main') ?? []).filter(isRootMate) : kids.get(a.id) ?? [], rest + (last ? '  ' : '│ '))
      })
    }
    const mainKids = kids.get('main') ?? []
    walk([...mainKids.filter(a => !isRootMate(a)), ...(mainKids.some(isRootMate) ? [TEAM] : [])], '')
    // a spawned agent's rows belong to its Agent row's turn: a background agent can outlive that turn. Sorted by it (stable), so
    // rows that stay flat (a view without the Agent row) keep each turn in one run
    const root = rootOf(entries)
    const turnOf = (x: Entry) => root(x)?.turn ?? x.turn ?? 0
    const runs = (id?: string) => id ? entries.filter(y => y.kind === 'turn' && y.agent === id) : [] // a spawned agent's turn ends: one per run
    const kept = entries.filter(x => (only === undefined || (x.agent ?? 'main') === only) && VIEWS[view](x)).sort((p, q) => turnOf(p) - turnOf(q))
    // the level by the merged row, so a slow chain keeps all its hooks; an opened turn's rows below it too, drawn dim (partsOf)
    const shown = kept.filter(x => lvl(x) >= level || openTurns.has(turnOf(x))).flatMap(splitHooks)
    const rowsOf = shown.filter(x => x.kind !== 'turn')
    // rows the level alone hides, per turn, opened or not: the header counts them, and its `N hidden ▸` draws them in place
    // (openTurns). A turn with none at or above the level draws no header at all
    const hidden = new Map<number, Entry[]>()
    for (const x of kept) if (x.kind !== 'turn' && lvl(x) < level) { const n = turnOf(x); if (!hidden.has(n)) hidden.set(n, []); hidden.get(n)!.push(...splitHooks(x)) } // turn ends are never drawn
    // a spawned agent's rows fold under its Agent row while that row is drawn; without it (a view or level that hides it, a filter
    // on the agent) they stay flat
    const drawn = new Set(shown)
    const under = new Map<Entry, Entry[]>(), folded = new Set<Entry>()
    // a call's hook rows and the text they injected, by the call's row while it is drawn: groupsOf draws them around it, linked,
    // also inside an agent's fold. The call hidden (a level, a view): they stay where they happened, unlinked
    const callRow = new Map<string, Entry>()
    for (const x of shown) if (x.kind === 'tool' && x.use) callRow.set(x.use, x)
    const hooksUnder = new Map<Entry, Entry[]>()
    for (const x of rowsOf) { const c = x.kind !== 'tool' && x.use ? callRow.get(x.use) : undefined; if (c) { if (!hooksUnder.has(c)) hooksUnder.set(c, []); hooksUnder.get(c)!.push(x) } }
    // rowsOf: a turn end draws nothing, so it must not open a fold. r === x: a damaged store's spawn cycle; no row folds under itself
    for (const x of rowsOf) { const r = root(x); if (r && r !== x && drawn.has(r) && !folded.has(x)) { if (!under.has(r)) under.set(r, []); under.get(r)!.push(x); folded.add(x) } }
    // autoFocus holds only on a site's first draw, so the ring is moved onto back once the redraw has drawn it
    const show = (x: Entry) => { if (page) pageBack = true; inspect = x; page = undefined; backTo = x; follow = false; $.ui.invalidate('ui.render'); $.ui.scroll({ in: PANE, to: 'start' }).catch(() => {}); $.clock.after(50, () => { $.ui.focus({ requestId: PANE, key: 'back' }).catch(() => {}) }) }
    // One row: disclosure, action (the only bright text, a button: on a fold's row it opens the fold, on any other the inspector),
    // then the time cell, flush right like the turn header's. No tool column: the action already names its verb (`Read x.ts`, `Run the tests`) and the inspector the
    // tool. The cell has a fixed width and the action is cut to what is left, so the description truncates first and times line up
    const cols = e.props.bodyColumns ?? 40
    const END = 9 // fits `● 59m59s`: secs is at most 6 wide
    const fit = (s: string, n: number) => s.length <= n ? s : s.slice(0, Math.max(0, n - 1)) + '…'
    // a path cut from the left at a folder boundary, so its last folders stay whole: `…/acme/projects/dv`
    const lfit = (s: string, n: number) => { if (s.length <= n) return s; const t = s.slice(s.length - n + 1), j = t.indexOf('/'); return '…' + (j >= 0 ? t.slice(j) : t) }
    // mark: drawn in the disclosure's cell when there is none (the header's `›` on the agent the log is filtered to).
    // rail: a fold's tree guides (`│ ├ `), drawn dim in place of the indent. No press: plain text, a line with nothing to open.
    // away: the places outside the project root the row reached (awayOf), drawn after the action as ` ↗ ~/path` (the first, cut from
    // the left so its last folders stay; a fold's ` +N` more), so it survives the cut. Magenta unless every place is routine(); then
    // dim and without the ↗, so another project and ~/.claude differ without colour
    // link: the row's place on its call's bracket (bracketed), drawn dim in the mark's cell so a bracketed row keeps the column of
    // one without. dim: a routine row, drawn quiet (partsOf's brightness rule)
    type Line = { k: string; act: string; press?: () => void; st?: [string, string?]; who?: string; tail?: string; disc?: [boolean, () => void]; indent?: number; rail?: string; mark?: string; link?: string; dim?: boolean; away?: string[] }
    const pressable = new Set<string>() // this draw's lines that open something: where the row cursor can stop
    const line = ({ k, act, press, st = [''], who = '', tail = '', disc, indent = 0, rail = ' '.repeat(indent), mark = ' ', link, dim, away }: Line) => {
      if (press) pressable.add(k)
      const usual = !!away?.every(routine)
      const there = away?.length ? ` ${usual ? '' : '↗ '}${lfit(away[0]!, 24)}${away.length > 1 ? ` +${away.length - 1}` : ''}` : ''
      const room = cols - 2 - rail.length - who.length - tail.length - there.length - END - 1
      return (
        <Box key={k} flexDirection="row" overflow="hidden">
          <Box flexShrink={0} width={2 + rail.length}><Text dimColor>{rail}</Text>{disc ? <Button key={`d${k}`} label={disc[0] ? '▾' : '▸'} plain onPress={disc[1]} /> : link ? <Text dimColor>{link}</Text> : <Text>{mark}</Text>}</Box>
          <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">{who ? <Text dimColor>{who}</Text> : null}{press ? <Button key={`b${k}`} label={fit(act, room) + tail} plain dimColor={dim} onPress={press} /> : <Text wrap="truncate-end" dimColor={dim}>{fit(act, room) + tail}</Text>}{there ? <Text color={usual ? undefined : 'magenta'} dimColor={usual}>{there}</Text> : null}</Box>
          {/* flush right, as the turn header's time: times of any width end on the same column */}
          <Box flexShrink={0} width={END} justifyContent="flex-end"><Text color={st[1]} dimColor={!st[1]}>{fit(st[0], END - 1)}</Text></Box>
        </Box>
      )
    }
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
    // `model 30.1s · tools 8.2s · other 1.0s`, where the turn's time went (splitOf), largest first: each turn end's own split, else
    // counted now from the rows still logged; the running turn up to now, a turn whose end was never logged over its rows' span.
    // Parts under 0.1 s are left out; other is the engine's and plugins' own work between steps. most: the header's two largest
    const SHOW = ['model', 'tools', 'agents', 'hooks', 'compact', 'permission', 'you', 'other']
    const splitText = (n: number, m: Turn, most = Infinity) => {
      const parts = SPLIT.map(() => 0)
      let span = 0
      const add = (xs: number[], ms: number) => { xs.forEach((v, i) => { parts[i]! += v }); span += ms }
      for (const y of m.ends) if (y.ms != null) add(y.split ?? splitOf(m.xs, y.t - y.ms, y.t), y.ms)
      const from = turnAt ?? m.first
      if (n === turnNo && busy && from != null) add(splitOf(m.xs, from, now), now - from)
      else if (!m.ends.length && m.first != null && m.last! > m.first) add(splitOf(m.xs, m.first, m.last!), m.last! - m.first)
      const by: Record<string, number> = { other: span - parts.reduce((a, b) => a + b, 0) }
      SPLIT.forEach((k, i) => { by[k] = parts[i]! })
      return SHOW.filter(k => by[k]! >= 100).sort((p, q) => by[q]! - by[p]!).slice(0, most).map(k => `${k} ${secs(by[k])}`).join(' · ')
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
    // `#2 Fix the header… · model 60.1s · tools 12.0s · 3 hidden    73.4s`: the prompt's first words (in memory only, so a
    // reloaded log's turns have none), the split's two largest parts, the count when any row is hidden. `#2` opens the turn's
    // inspector, which holds the whole split and the loops that acted. The time sits flush right, over the rows' time cell,
    // pushed there by a growing spacer; that cell never shrinks, and on a narrow pane the split truncates first. `start` (n 0)
    // is no turn: no words, no split, no time, only its hidden rows
    const header = (n: number, k: string) => {
      const m = turnIn(n), hid = hidden.get(n)?.length // not `h`: that name is the JSX factory, and shadowing it breaks every tag below
      const time = n ? `${m.aborted ? '⚠ ' : ''}${took(n, m)}` : ''
      const said = words.get(n), split = n ? splitText(n, m, 2) : ''
      return (
        <Box key={k} flexDirection="row" overflow="hidden">
          <Box flexShrink={0}>{m.ends.length ? <Button key={`th${n}`} label={n ? `#${n}` : 'start'} plain onPress={() => show(m.ends.at(-1)!)} /> : <Text weight="semibold">{n ? `#${n}` : 'start'}</Text>}</Box>
          <Box flexShrink={1} minWidth={0} overflow="hidden"><Text wrap="truncate-end" dimColor>{`${said ? ` ${said}` : ''}${split ? ` · ${split}` : ''}`}</Text></Box>
          {hid ? <Box flexShrink={0}><Text dimColor> · </Text><Button key={`hid${n}`} label={openTurns.has(n) ? `hide ${hid} ▾` : `${hid} hidden ▸`} plain dimColor onPress={() => {
            if (!openTurns.delete(n)) openTurns.add(n)
            const at = rowAt(k) // the header keeps its line, as a fold's row does
            if (at >= 0) anchor = { k, off: at - win }
            $.ui.invalidate('ui.render')
          }} /></Box> : null}
          <Box flexGrow={1} flexShrink={0} minWidth={2} />
          <Box flexShrink={0}>
            <Text color={m.aborted ? 'yellow' : undefined} dimColor={!m.aborted}>{time}</Text>
          </Box>
        </Box>
      )
    }
    // Flat: every row its own, in time order. Only an Agent row that spawned an agent folds (`agent`): its agent's rows (under)
    // beneath it, laid out the same way. A call's hook rows and the text they injected (hooksUnder) move next to it, its
    // PreToolUse ones above and the rest below, all on one bracket with it (bracket): a parallel call's hooks can land between
    // another call and its own. Turn ends draw nothing: the turn header carries the time. A group is keyed by its entry's id (idOf).
    // link: its row's place on the bracket; wait, server: a call's own rows' places (partsOf)
    type Group = { kind: 'one' | 'agent'; xs: [Entry]; link?: string; wait?: string; server?: string[] }
    // n rows on a call's bracket, the call at `at`: `╭` opens it, `╰` closes it, `├` marks the call between, `│` the rest
    const bracket = (n: number, at: number) => Array.from({ length: n }, (_, i) => n < 2 ? undefined : i === 0 ? '╭' : i === n - 1 ? '╰' : i === at ? '├' : '│')
    const groupsOf = (xs: Entry[]) => {
      const there = new Set(xs)
      const linked = (x: Entry) => x.kind !== 'tool' && !!x.use && there.has(callRow.get(x.use)!)
      const groups: Group[] = []
      for (const x of xs) {
        if (x.kind === 'turn' || linked(x)) continue
        const hs = (hooksUnder.get(x) ?? []).filter(y => there.has(y))
        const pre = hs.filter(y => y.origin === 'PreToolUse'), post = hs.filter(y => y.origin !== 'PreToolUse')
        const w = !x.child && waits(x) ? 1 : 0, sv = x.child ? 0 : x.server?.length ?? 0, at = pre.length + w
        const b = bracket(at + 1 + sv + post.length, at)
        pre.forEach((y, i) => groups.push({ kind: 'one', xs: [y], link: b[i] }))
        groups.push({ kind: x.child ? 'agent' : 'one', xs: [x], link: b[at], wait: w ? b[at - 1] : undefined, server: b.slice(at + 1, at + 1 + sv) as string[] })
        post.forEach((y, i) => groups.push({ kind: 'one', xs: [y], link: b[at + 1 + sv + i] }))
      }
      return groups
    }
    // an Agent row's cell: its agent's state, not the call's, which a background agent returns from once started. Its turns sum to
    // its run time; one still running counts up (tick redraws). Gone from the list with its turns evicted: —
    const ran = (x: Entry): [string, string?] => {
      if (BAD.has(stat(x))) return cell(x) // refused: no agent ran
      const a = agents.find(y => y.id === x.child)
      if (a?.status === 'running') return [`● ${secs(now - (started.get(a.id) ?? x.t))}`, 'green']
      const ts = runs(x.child), ms = total(ts)
      return a?.status === 'failed' || ts.some(y => stat(y) === 'failed') ? [`✗ ${secs(ms)}`, 'red'] : a?.status === 'killed' ? [`⚠ ${secs(ms)}`, 'yellow']
        : ts.some(y => stat(y) === 'aborted') ? [`⚠ ${secs(ms)}`, 'yellow'] : [secs(ms)]
    }
    const rows: any[] = []
    const where = new Map<Entry, string>() // each shown entry's drawn row, by its key: its own, else its closed fold's. Back centres it
    const rowAt = (k: string) => rows.findIndex(r => r.props?.key === k)
    const spans = new Map<string, number>() // a group's drawn rows, by its key: how far an opened fold runs, for the window to show it
    const keyOf = (g: Group) => `g${idOf(g.xs[0])}` // a group's own row; its entry's id keys its fold in expanded
    // a model request's row names its model only when it is not main's at the time (a subagent on Haiku, the engine's own on
    // another): the tool column that named it is gone, and the same model on every request is noise. Main's own requests never:
    // the `Model: … → …` row marks a switch. Main's model then: its last request at or before this one, else the setup's
    const actOf = (y: Entry) => { const id = (y.kind === 'step' && y.agent) ? y.name : y.kind === 'side' ? y.detail : undefined
      const main = id ? entries.findLast(z => z.kind === 'step' && !z.agent && z.t <= y.t)?.name ?? setup.model : undefined
      return id && main && modelName(id) !== modelName(main) ? `${modelName(id)} · ${action(y)}` : action(y) }
    // who refused a call, named once. A refusing hook on the call's bracket names itself there: nothing. Else after the action,
    // no glyph (`Clean up · you`): the hook (its row not drawn, a view without hooks), the rule, the classifier or you. The ⊘
    // rides in the cells: the call's, and a refusing hook's on its bracket
    const byOf = (y: Entry) => {
      if (y.kind !== 'tool' || !REFUSED.has(stat(y))) return ''
      if ((hooksUnder.get(y) ?? []).some(z => REFUSED.has(stat(z)))) return ''
      const hook = [...new Set((y.use ? entries.filter(z => z.kind === 'hook' && z.use === y.use && REFUSED.has(stat(z))) : []).map(z => z.name))].join(', ')
      const by = hook || y.rule || (y.via === 'classifier' ? 'classifier' : /^user_/.test(y.via ?? '') ? 'you' : '')
      return by ? ` · ${by}` : ''
    }
    // a row's or a fold's places outside the root, each once; another project's first, so the one the fold names is the one to look at
    const awayOf = (ys: Entry[]) => [...new Set(ys.flatMap(y => y.out ? [y.out] : []))].sort((p, q) => +routine(p) - +routine(q))
    // a call's wait, drawn from its own fields above it; pressed, the call's inspector
    // only a wait on a decision: one on the model finishing the message that holds the call is the model's time (splitOf counts
    // it so), and would draw a row for every call. The inspector still says it
    const waits = (y: Entry) => y.wait != null && y.waitFor !== STREAMING
    const waitLine = (y: Entry, rail: string, link?: string) => line({ k: `e${idOf(y)}w`, act: `Waiting for ${y.waitFor ?? 'the decision'}`, press: () => show(y), st: [secs(y.wait)], rail, link })
    // A group's parts, from the one switch on its kind:
    // - head: its own row, given the press (its fold's toggle when it has one, else the inspector on target) and that disclosure
    // - members: the entries a closed fold stands for, which back lands on
    // - parts: what its fold holds, each drawing its rows on a rail and a fold inside continuing on rest; none, no fold
    // - nested: an agent fold's own groups, which the `o` button (foldsOf) counts too
    // Lazy: counting draws nothing and claims no row in where. Once per group per draw (memo), so an agent's rows are grouped and a
    // failure read once, and the draw and the count see the same nested groups
    type Disc = [boolean, () => void]
    type Parts = { head: (rail: string, who: string, press: () => void, disc?: Disc) => any; target: Entry; members: Entry[]; parts: ((rail: string, rest: string) => any[])[]; nested: Group[] }
    const memo = new Map<Group, Parts>()
    const partsOf = (g: Group): Parts => {
      const had = memo.get(g)
      if (had) return had
      const x = g.xs[0], k = keyOf(g)
      let p: Parts
      if (g.kind === 'agent') {
        const body = under.get(x) ?? [], nested = groupsOf(body)
        const many = new Set(body.map(y => y.agent)).size > 1 // a grandchild shares the fold: rows name their loop
        p = { target: x, members: [x, ...body], nested, // a closed fold's rows: back lands on the fold; drawn ones claim their own
          head: (rail, who, press, disc) => line({ k, act: action(x), press, st: ran(x), who, disc, rail, link: g.link, away: awayOf(body) }),
          // the agent's input and reply are the Agent row's inspector, which the row itself opens; its ▸ opens the fold
          parts: nested.map(h => (rail: string, rest: string) => drawGroup(h, rail, rest, many && h.xs[0].agent ? whoOf(h.xs[0].agent) : '')) }
      } else {
        // a call's wait above it, where it happened, and a request's calls the API ran itself (the advisor) below it: rows of
        // their own, on the row's link. What broke stays in its inspector
        const server = (x.server ?? []).map(([sn, ms], j) => (rail: string) => line({ k: `${k}s${j}`, act: cap(sn.replace(/_/g, ' ')), press: () => show(x), st: [secs(ms ?? undefined)], rail, link: g.server?.[j] }))
        // a hook's row on its call's bracket names just the hook: the call beside it names the tool, the side names the event.
        // Dim unless its cell has a colour: a hook that blocked or broke stays as loud as the call. A row with no use is no
        // call's hook: a model request sits on a bracket only for its server rows (the advisor), and keeps its own name
        const hooked = x.kind !== 'tool' && !!x.use && !!g.link
        // a refusing hook on its call's bracket carries the ⊘ as its call does: the glyph, not the colour, says which hook refused
        const c = cell(x)
        // Bright is what did something: a row whose cell has a colour (it broke, was refused, ended early or slow) or bright().
        // A row below the level (a turn's hidden rows, opened in place) is dim whatever it did
        const dim = lvl(x) < level || (!c[1] && !bright(x))
        // the rows share one twig: on a fold's last part (`└ `) only the last row closes the guide, the ones above it carry it on
        // (`├ `), or a wait above the call ends the line a row early
        p = { target: x, members: [x], nested: [], parts: [],
          head: (rail, who, press) => {
            const rs = [
              ...(waits(x) ? [(r: string) => waitLine(x, r, g.wait)] : []),
              (r: string) => line({ k, act: hooked ? action(x, true) : actOf(x), tail: byOf(x), press, st: c, who, rail: r, link: g.link, dim, away: awayOf([x]) }),
              ...server,
            ], mid = rail.endsWith('└ ') ? `${rail.slice(0, -2)}├ ` : rail
            return rs.map((f, i) => f(i < rs.length - 1 ? mid : rail))
          } }
      }
      memo.set(g, p)
      return p
    }
    // One group's rows: its own on the rail `own`; an open fold's below it, each part on `rest` and a twig, `├ ` or the last's `└ `,
    // a fold inside continuing the line (`│ `) while siblings follow it. Pressed, a row opens its inspector; only its ▸ opens
    // its fold
    const drawGroup = (g: Group, own: string, rest: string, who: string): any[] => {
      const { head, target, members, parts } = partsOf(g), id = idOf(g.xs[0]), k = keyOf(g)
      for (const y of members) where.set(y, k)
      const open = expanded.has(id)
      const disc: Disc | undefined = parts.length ? [open, () => {
        if (!expanded.delete(id)) expanded.add(id)
        const at = rowAt(k) // rows and win: the draw that drew this row
        if (at >= 0) anchor = { k, off: at - win }
        $.ui.invalidate('ui.render')
      }] : undefined
      const out = [head(own, who, () => show(target), disc)].flat()
      if (open && disc) parts.forEach((p, j) => out.push(...p(rest + (j < parts.length - 1 ? '├ ' : '└ '), rest + (j < parts.length - 1 ? '│ ' : '  '))))
      spans.set(k, out.length)
      return out
    }
    const foldsOf = (gs: Group[]): number[] => gs.flatMap(g => { const p = partsOf(g); return p.parts.length ? [idOf(g.xs[0]), ...foldsOf(p.nested)] : [] })
    let cur: number | undefined
    const top = groupsOf(shown.filter(x => !folded.has(x)))
    // every row in the order the log lays it out, a closed agent fold's too: the inspector steps through it
    const orderOf = (gs: Group[]): Entry[] => gs.flatMap(g => [g.xs[0], ...(g.kind === 'agent' ? orderOf(partsOf(g).nested) : [])])
    const order = orderOf(top)
    const tops = new Set<string>() // rows the `o` button may keep in place: turn headers and top groups' own rows, which no closing hides
    top.forEach(g => {
      const x = g.xs[0], n = turnOf(x)
      if (n !== cur) {
        if (cur !== undefined) rows.push(<Text key={`gap${rows.length}`}> </Text>) // a row of its own, not a margin: the window counts elements as rows
        const hk = `turn${n}` // by its turn, not its place: folds opening above it must not rename it, or an anchor on it is lost
        rows.push(header(n, hk)); cur = n; tops.add(hk)
        for (const y of hidden.get(n) ?? []) if (!where.has(y)) where.set(y, hk) // back from a hidden row: its turn's header
      }
      tops.add(keyOf(g))
      rows.push(...drawGroup(g, '', '', x.agent && turns.get(n)!.agents.size > 1 ? whoOf(x.agent) : ''))
    })
    // What streams or runs right now, below the rows: each loop's model request and each call in flight, ● counting up (tick
    // redraws while a turn or an agent runs). Not entries yet, so nothing to open: plain lines, under the running turn's header
    const nowAct = (l: Live) => l.row ? `${l.asking ? 'Waiting for your permission: ' : ''}${action({ t: l.t, ...l.row })}` : l.phase === 'thinking' ? 'Thinking'
      : l.phase === 'writing' ? 'Writing' : l.phase === 'calling' ? `Writing a ${l.tool ?? 'tool'} call` : 'Waiting for the first token'
    // only a line whose row will stay visible at this level: one that ends as a hidden row would flash and vanish (a request
    // that only calls tools ranks debug). A permission prompt always shows: it waits for the person
    const shows = (l: Live) => l.asking || (l.row ? lvl({ t: l.t, ...l.row }) : l.wrote ? 1 : 0) >= level
    const inFlight = view === 'all' || view === 'model' ? [...liveNow].filter(([, l]) => (only === undefined || (l.loop ?? 'main') === only) && shows(l)) : []
    if (inFlight.length && busy && cur !== turnNo) { if (cur !== undefined) rows.push(<Text key={`gap${rows.length}`}> </Text>); rows.push(header(turnNo, `turn${turnNo}`)); cur = turnNo }
    for (const [k, l] of inFlight) rows.push(line({ k: `now${k}`, act: nowAct(l), st: [`● ${secs(now - l.t)}`, 'green'], who: l.loop ? whoOf(l.loop) : '' }))
    // the keys page (i): what each mark means, then what each key does, one per line
    const MARKS = ['✗ red: broke', '⊘ cyan: refused, by a hook, a rule, the classifier or you', '⚠ yellow: ended early (interrupted, cut off, an agent killed)',
      '■ yellow: a hook stopped the session', '◷ yellow: a slow hook', '↩ blue: a hook\'s feedback to the model', '● green: running now', '✓ an agent finished',
      '↗ magenta: a place in another project; a dim path with no ↗: ~/.claude or /tmp', '+ a hook added context', '· a hook changed nothing', '∅ found nothing', '≈ estimated',
      '╭ │ ├ ╰ a call bracketed with its hooks: those above it ran before it, those below after', '› the agent the log is filtered to',
      'bright: a row that did something; dim: routine, or below the level', '▸ ▾ open, close an Agent fold or a turn\'s hidden rows',
      'other, in a turn\'s split: the engine\'s and plugins\' own work between steps']
    const KEYS: [string, string][] = [['a m h u', 'views: all, what the model did, the harness, outside the root'], ['l', 'level: info or notice (/agentlog level sets debug and error)'],
      ['o', 'open or close every Agent fold'], ['s', 'the setup page'], ['i', 'this page'], ['j k', 'the row cursor down, up; in the inspector, the next or previous row'], ['↓ ↑', 'the row cursor too'],
      ['enter', 'open the row under the cursor'], ['e', 'the newest row'], ['^↑ ^↓', 'ctrl+↑ ↓: the previous or next prompt'], ['b', 'back'], ['n p', 'in the inspector: the next or previous row'],
      ['f', 'in an Agent row\'s inspector: only its agent\'s rows; elsewhere, clear that filter'], ['tab', 'move the focus over the buttons; enter presses one']]
    // `no agent entries for scout at notice or above · /agentlog level debug: every row · a: all views · main: clear the filter`; only the filters set
    const empty = () => {
      if (!entries.length) return 'no entries yet'
      const of = only ? ` for ${only === 'main' ? 'main' : nameOf(only)}` : ''
      const tips = [level > 0 && '/agentlog level debug: every row', view !== 'all' && 'a: all views', only && `${only === 'main' ? 'main' : nameOf(only)}: clear the filter`].filter(Boolean)
      return [`no ${view === 'all' ? '' : `${view} `}entries${of}${level > 0 ? ` at ${LEVELS[level]} or above` : ''}`, ...tips].join(' · ')
    }
    // the window's top to the previous or next prompt's turn header (`#3`); past the last, the end. From the inspector or a page, back to the log first
    const heads = rows.flatMap((r, i) => String(r.props?.key).startsWith('turn') ? [i] : [])
    const toTurn = (dir: -1 | 1) => {
      if (inspect || page) { inspect = undefined; page = undefined; pageBack = false; backTo = undefined; $.ui.scroll({ in: PANE, to: 'start' }).catch(() => {}) } // the engine's window, which the inspector or page may have moved
      const to = dir < 0 ? heads.filter(i => i < win).at(-1) ?? 0 : heads.find(i => i > win)
      if (to === undefined) follow = true; else { win = to; follow = false } // the draw clamps win and decides follow again
      $.ui.invalidate('ui.render')
    }
    // Bright in the controls means active, nothing else: the view shown, the page open, the loop filtered to. The active view also
    // carries a `•` after its name, so it reads without colour; the others a space in its place, so a view switch keeps every label's width
    const vbtn = (v: View, k: string) => <Button key={`v${v}`} label={`${v}${view === v ? '•' : ' '}`} hotkey={k} plain dimColor={view !== v} onPress={() => setView(v)} />
    // one width whatever the level (`level info  `), as `fold  ` is: a label that changed width could repack the controls
    const LVW = Math.max(...LEVELS.map(l => l.length)) + 6
    const lbtn = <Button key="lvl" label={`level ${LEVELS[level]}`.padEnd(LVW)} hotkey="l" plain dimColor onPress={nextLevel} />
    const kbtn = <Button key="legend" label="keys" hotkey="i" plain dimColor={page !== 'keys'} onPress={() => openPage('keys')} />
    // `^↑↓ turn`: ctrl+↑ and ctrl+↓ press these from the prompt or the pane (`^`: ctrl, apart from the cursor's plain ↓ ↑). They are the engine's Global chords for the diff panel's file
    // list (app:diffFileListUp/Down, also meta+↑↓), which a Button's `action` takes while that panel is closed; open, the panel keeps them
    const tbtn = <Box key="turns" flexDirection="row"><Text dimColor>^</Text><Button key="tprev" label="↑" plain dimColor action="app:diffFileListUp" onPress={() => toTurn(-1)} /><Button key="tnext" label="↓" plain dimColor action="app:diffFileListDown" onPress={() => toTurn(1)} /><Text dimColor> turn</Text></Box>
    // `j: ↓  k: ↑`, the row cursor. Drawn in the header, so the inspector and the pages draw them too: in the inspector they step
    // to its next and previous row (nav), as n and p do; on a page they do nothing, so no move waits to fire on back
    const cbtn = (d: 1 | -1) => <Button key={d > 0 ? 'cdown' : 'cup'} label={d > 0 ? '↓' : '↑'} hotkey={d > 0 ? 'j' : 'k'} plain dimColor onPress={() => {
      if (inspect) { const y = d > 0 ? nav.next : nav.prev; if (y) show(y); return }
      if (page) return
      move = d; $.ui.invalidate('ui.render')
    }} />
    // `o: unfold` opens every fold while one is closed, `o: fold` closes them all; the nearest top row at or above the window's
    // top keeps its line. Always drawn, one width (`fold` padded): a label that changed width could change how the controls
    // pack, and with it the header's height, moving the anchored row
    const folds = foldsOf(top), shut = folds.some(id => !expanded.has(id))
    const obtn = <Button key="folds" label={shut || !folds.length ? 'unfold' : 'fold  '} hotkey="o" plain dimColor onPress={() => {
      for (const id of folds) if (shut) expanded.add(id); else expanded.delete(id)
      const at = rows.slice(0, win + 1).findLastIndex(r => tops.has(String(r.props?.key)))
      if (at >= 0) anchor = { k: String(rows[at].props.key), off: at - win }
      $.ui.invalidate('ui.render')
    }} />
    // An agent reads as a log row: `name: task`, a button that filters the log to it, a teammate's name after its type; in the
    // status cell its run as its Agent row shows it (ran), else (a teammate, a fork: no Agent row spawned it) its status glyph.
    // Capped so the header leaves the log room: three rows while finished ones are folded, a third of the body with them shown
    const bodyRows = e.props.scroll?.bodyRows ?? 24
    const spawnOf = new Map(entries.filter(x => x.child).map(x => [x.child!, x]))
    const most = showDone ? Math.max(3, Math.floor(bodyRows / 3)) : 3
    const more = Math.max(0, tree.length - most)
    const agentRow = ([a, rail]: [AgentInfo | typeof TEAM, string]) => {
      if (a === TEAM) return <Box key="team" flexDirection="row"><Text dimColor>{`${rail}  team`}</Text></Box>
      const x = spawnOf.get(a.id), [glyph, c] = STATUS[a.status] ?? ['?'], t = started.get(a.id)
      const st: [string, string?] = x ? ran(x) : [a.status === 'running' && t != null ? `${glyph} ${secs(now - t)}` : glyph, c]
      return line({ k: `a${a.id}`, act: `${nameOf(a.id)}${a.name ? ` (${a.name})` : ''}: ${a.description}`, press: () => pick(a.id), st, rail, mark: only === a.id ? '›' : ' ' })
    }
    const toggle = showDone ? `hide finished ▾${more ? ` · ${more} not shown` : ''}` : `${[more && `+${more} more`, done && `${done} done`].filter(Boolean).join(' · ')} ▸`
    // every element of the header and the log is one row, so the window knows the header's height and how many log rows fit under it
    // The setup button, last in the controls: what the session runs on, as the hooks saw it (Setup), after what broke this session, in red. Pressed (or s),
    // the setup page. Counted from every entry, whatever the view, level or filter
    if (!setup.asked) refreshSetup($).then(() => $.ui.invalidate('ui.render')).catch(() => {})
    const problems = problemsOf(entries)
    const elsewhere = entries.filter(x => x.out && !routine(x.out)).length // calls into another project, magenta in the controls (u: the outside view lists them)
    const hookN = new Set(Object.values(hookCfg ?? {}).flat().map(h => h.cmd ?? h.name)).size // distinct scripts, not registrations: context-mode registers one script on 9 PreToolUse matchers
    const peak = setup.limits.reduce<Setup['limits'][number] | undefined>((m, l) => !m || l.percentUsed > m.percentUsed ? l : m, undefined)
    const plugins = setup.plugins.size || enabled.length
    const bgN = setup.bg?.tasks.length ?? 0, cronN = setup.bg?.crons.length ?? 0
    // the row itself says only what needs the eye: the model, and a rate limit once it nears (80%); the rest is on the page
    // led by `setup`, so the button says what it opens: `s: setup Opus 5.5 · limit 85%`
    const setupText = ['setup', [setup.model && `${modelName(setup.model)}${setup.effort != null ? ` ${setup.effort}` : ''}`, peak && peak.percentUsed >= 80 && `limit ${Math.round(peak.percentUsed)}%`].filter(Boolean).join(' · ')].filter(Boolean).join(' ')
    // a page in place of the log; its own key pressed on it again, back to the log
    const openPage = (p: NonNullable<typeof page>) => {
      if (page === p && !inspect) return back()
      page = p; inspect = undefined; pageBack = false; follow = false; $.ui.invalidate('ui.render'); $.ui.scroll({ in: PANE, to: 'start' }).catch(() => {}); $.clock.after(50, () => { $.ui.focus({ requestId: PANE, key: 'back' }).catch(() => {}) })
    }
    const keysPage = () => (
      <Box key="keys" flexDirection="column" width={e.props.bodyColumns}>
        <Box flexDirection="row" columnGap={2}><Button key="back" label="← back" hotkey="b" plain autoFocus onPress={back} /></Box>
        <Text key="gapmk"> </Text>
        <Text key="tmk" weight="semibold">Marks</Text>
        {MARKS.map((l, i) => <Text key={`mk${i}`} wrap="wrap">{l}</Text>)}
        <Text key="gapky"> </Text>
        <Text key="tky" weight="semibold">Keys</Text>
        {KEYS.map(([k, v]) => <Box key={`ky${k}`} flexDirection="row"><Box flexShrink={0} width={11}><Text dimColor>{k}</Text></Box><Text wrap="wrap">{v}</Text></Box>)}
      </Box>
    )
    // The setup page: the session's setup and how it held up. Hook runs and plugins come from the collector; without its
    // records, the hooks and plugins your settings name. A problem's row opens its inspector
    const setupPage = (at?: [string, string, string | undefined]) => {
      const xs = (f: (x: Entry) => boolean) => entries.filter(f)
      // requests: how many, their time, tokens and price where the collector gave one
      const use = (ys: Entry[]) => {
        const sum = (f: (x: Entry) => number) => ys.reduce((a, x) => a + f(x), 0)
        const cost = ys.some(x => x.cost != null) ? ` · $${sum(x => x.cost ?? 0).toFixed(2)}` : ''
        // no row with tokens (requests from before they were stored, a plugin's fork): unknown, not 0
        const io = ys.some(x => x.tok) ? `${num(sum(x => x.tok ? x.tok[0]! + x.tok[1]! + x.tok[2]! : 0))} in · ${num(sum(x => x.tok?.[3] ?? 0))} out` : '— tokens'
        return `${ys.length} request${ys.length === 1 ? '' : 's'} · ${exact(sum(x => x.ms ?? 0))} · ${io}${cost}`
      }
      const by = (ys: Entry[]) => { const m = new Map<string, Entry[]>(); for (const y of ys) m.set(y.name, [...m.get(y.name) ?? [], y]); return [...m] }
      const bad = xs(x => (x.kind === 'hook' && stat(x) === 'failed') || (x.kind === 'event' && BAD.has(stat(x))))
      const events = [...new Set([...Object.keys(hookCfg ?? {}), ...setup.runs.keys()])]
      const steps = xs(x => x.kind === 'step')
      const added = [...new Set(xs(x => x.kind === 'event' && x.name === 'directory added').map(x => x.detail))]
      const outs = [...xs(x => !!x.out).reduce((m, x) => m.set(x.out!, (m.get(x.out!) ?? 0) + 1), new Map<string, number>())].sort((p, q) => q[1] - p[1])
      // the key column fits the longest key (hook events like PermissionRequest, plugin and server names), capped at a third of the
      // pane; a key past the cap is cut, never wrapped into its value
      const keys = ['calls outside', ...events, ...(setup.plugins.size ? setup.plugins.keys() : enabled.map(id => id.split('@')[0]!))]
      const keyW = Math.max(15, Math.min(Math.max(...keys.map(k => k.length)) + 2, Math.floor(cols / 3)))
      const kw = (k: string, v: string, id = k) => <Box key={`k${id}`} flexDirection="row"><Box flexShrink={0} width={keyW}><Text dimColor wrap="truncate-end">{fit(k, keyW - 2)}</Text></Box><Text wrap="wrap">{v}</Text></Box>
      const title = (k: string, t: string) => [<Text key={`gap${k}`}> </Text>, <Text key={`t${k}`} weight="semibold">{t}</Text>]
      return (
        <Box key="setup" flexDirection="column" width={e.props.bodyColumns}>
          <Box flexDirection="row" columnGap={2}><Button key="back" label="← back" hotkey="b" plain autoFocus onPress={back} /></Box>
          {title('cc', 'Session')}
          {kw('model', setup.model ? `${modelName(setup.model)} (${setup.model})${setup.effort != null ? ` · effort ${setup.effort}` : ''}` : '—')}
          {kw('mode', setup.mode ?? '—')}
          {title('wh', 'Where')}
          {at && kw('root', tilde(at[0], at[2]))}
          {at && at[1] !== at[0] && kw('cwd', tilde(at[1], at[2]))}
          {added.length > 0 && kw('added', added.join(', '))}
          {kw('calls outside', outs.length ? outs.slice(0, 12).map(([p, n]) => n > 1 ? `${p} ×${n}` : p).join(', ') + (outs.length > 12 ? `, +${outs.length - 12} more` : '') : 'none reached outside the root')}
          {title('pb', problems.length ? `Problems: ${problems.join(', ')}` : 'Problems: none this session')}
          {bad.slice(-20).map(x => <Box key={`p${idOf(x)}`} flexDirection="row"><Button key={`pb${idOf(x)}`} label={fit(`✗ ${action(x)}`, cols - 4)} plain onPress={() => show(x)} /></Box>)}
          {title('hk', `Hooks: ${hookN} distinct settings and plugin hook commands${setup.runs.size ? '; runs as the collector counted them' : ''}`)}
          {hookCfg && kw('per-hook times', hookTimes(hookCfg))}
          {events.map(ev => { const r = setup.runs.get(ev), names = [...new Set((hookCfg?.[ev] ?? []).map(h => h.name))]
            return kw(ev, [names.join(', ') || 'no hook in your settings', r && `${r.n} run${r.n === 1 ? '' : 's'} · ${exact(r.ms)}${r.errors ? ` · ${r.errors} failed` : ''}${r.cancelled ? ` · ${r.cancelled} cancelled` : ''}`].filter(Boolean).join(' — '), `hk${ev}`) })}
          {title('pl', `Plugins: ${plugins}`)}
          {setup.plugins.size ? [...setup.plugins].map(([n, pl]) => kw(n, [pl.version, pl.scope, pl.hooks && 'hooks', pl.mcp && 'MCP'].filter(Boolean).join(' · '), `pl${n}`))
            : enabled.map(id => kw(id.split('@')[0]!, `enabled in your settings (${id.split('@')[1] ?? ''})`, `pl${id}`))}
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
    // The controls never clip: views, level, folds, keys, the prompt jumps, then what broke first (`✗ 1 API error +1`), the calls
    // into another project and the setup, packed into as many rows as the width needs. Every button is drawn because a hotkey
    // only presses a drawn Button. Counted, not wrapped by flex: the window needs the header's exact height. plain + hotkey draws
    // `a: all•`, label + 3 cells (a view's label is its name and the `•` cell); Button takes no bold, so the views not active are drawn dim instead
    const VIEW_KEYS: Partial<Record<View, string>> = { all: 'a', model: 'm', harness: 'h', outside: 'u' }
    const items: [number, any][] = SHOWN.map((v): [number, any] => [v.length + 4, vbtn(v, VIEW_KEYS[v]!)])
    const broke = problems.length ? `✗ ${problems[0]}${problems.length > 1 ? ` +${problems.length - 1}` : ''}` : '', away = elsewhere ? `↗ ${elsewhere} other project` : ''
    const bare: [number, any][] = [...items, [LVW + 3, lbtn], [9, obtn], [7, kbtn], [8, tbtn], [4, cbtn(1)], [4, cbtn(-1)],
      ...(broke ? [[broke.length, <Text key="broke" color="red">{broke}</Text>] as [number, any]] : []),
      ...(away ? [[away.length, <Text key="away" color="magenta">{away}</Text>] as [number, any]] : []),
      [setupText.length + 3, <Button key="fsetup" label={setupText} hotkey="s" plain dimColor={page !== 'setup'} onPress={() => openPage('setup')} />]]
    const controls = pack(bare.map(([w]) => w), cols - 1).map((row, r) => <Box key={`ctl${r}`} flexDirection="row" columnGap={2} overflow="hidden">{row.map(i => bare[i]![1])}</Box>)
    // the agent tree, only while an agent runs or the log is filtered: a finished agent is filtered to from its Agent row's
    // inspector (f), so a tree of finished agents would only take the log's rows
    const treeOn = agents.some(a => a.status === 'running') || only !== undefined
    const head = [
      ...controls,
      ...(treeOn ? [<Box key="main" flexDirection="row" overflow="hidden" columnGap={2}>
        <Button key="fmain" label="main" plain dimColor={only !== 'main'} onPress={() => pick('main')} />
        {only ? <Button key="fclear" label={fit(`filter: ${nameOf(only)} ✕`, cols - 8)} hotkey="f" plain onPress={() => pick(only!)} /> : null}
      </Box>, ...tree.slice(0, most).map(agentRow)] : []),
      ...(treeOn && (done || more) ? [<Box key="done" flexDirection="row"><Text>  </Text><Button key="fdone" label={toggle} plain dimColor onPress={() => { showDone = !showDone; $.ui.invalidate('ui.render') }} /></Box>] : []),
      <Text key="rule" dimColor>{'─'.repeat(Math.max(1, cols - 1))}</Text>,
    ]
    // taken before the inspector draws: `o` pressed there must not move the window that back is about to centre
    const held = anchor; anchor = undefined
    if (inspect) return <Box flexDirection="column">{head}{await inspector(inspect)}</Box>
    if (page === 'keys') return <Box flexDirection="column">{head}{keysPage()}</Box>
    if (page) { // where the session is: asked on each draw of the page, as /cd and a worktree move change it
      const at = await Promise.all([$.session.root(), $.session.cwd(), homeOf($)]).catch(() => undefined)
      return <Box flexDirection="column">{head}{setupPage(at)}</Box>
    }
    // The cursor's move: by `move` rows that open something (pressable), in the log's order, stopping at either end. None yet, or
    // its row gone (evicted, another view) or out of the window the last draw showed (a ^↑↓, a wheel, a page scroll), it starts
    // there: j on the window's first such row, k on its last. The window below keeps it in view
    let moved = false
    if (move) {
      const ts = rows.flatMap((r, i) => pressable.has(String(r.props?.key)) ? [[String(r.props.key), i] as const] : [])
      const i = sel ? ts.findIndex(([k, at]) => k === sel && at >= winStart && at <= winEnd) : -1
      const first = ts.findIndex(([, at]) => at >= winStart)
      const to = i >= 0 ? Math.max(0, Math.min(ts.length - 1, i + move))
        : move > 0 ? (first < 0 ? ts.length - 1 : first) : Math.max(0, ts.findLastIndex(([, at]) => at <= winEnd))
      if (ts[to]) { sel = ts[to][0]; moved = true }
      move = 0
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
    // the cursor's row in view: at the top when it went above the window, at the bottom when below (the end: following)
    if (moved) {
      const at = rowAt(sel!)
      if (at >= 0 && at < win) win = at; else if (at > win + room - 1) win = Math.min(max0, at - room + 1)
      const k = `b${sel}` // the ring onto its Button once this draw is in, as show does for back: Enter then opens it
      $.clock.after(50, () => { $.ui.focus({ requestId: PANE, key: k }).catch(() => {}) })
    }
    // A window that starts mid-turn pins that turn's header on its first line, so the rows on screen keep their `#N`. It costs a
    // row as the jump row does: following, the window moves down one so the newest row stays; the cursor's row stays in view, so
    // a cursor moved onto the top row of the last page stops the following rather than drop off it.
    // Not on a gap row: the next turn's header is right below it
    const sticks = (w: number) => heads.some(i => i < w) && !heads.includes(w) && !String(rows[w]?.props?.key).startsWith('gap')
    follow = win >= max0 && !(moved && rowAt(sel!) === win && sticks(win))
    if (follow) fresh = 0
    const avail = follow ? avail0 : Math.max(1, avail0 - 1)
    if (sticks(win) && (follow || (moved && rowAt(sel!) === win + avail - 1))) win = Math.min(rows.length - 1, win + 1)
    const stick = sticks(win) ? heads.filter(i => i < win).at(-1)! : undefined
    const winRows = avail - (stick !== undefined ? 1 : 0)
    winMax = Math.max(0, rows.length - avail + (sticks(rows.length - avail) ? 1 : 0))
    winStart = win; winEnd = win + winRows - 1
    return (
      <Box flexDirection="column">
        {head}
        {stick !== undefined ? rows[stick] : null}
        {rows.slice(win, win + winRows)}
        {!follow && <Box key="jumprow" flexDirection="row" justifyContent="flex-end"><Button key="jump" label={fresh ? `↓ ${fresh} new event${fresh > 1 ? 's' : ''} (e)` : '↓ newest (e)'} hotkey="e" onPress={jump} /></Box>}
      </Box>
    )
  })
}
