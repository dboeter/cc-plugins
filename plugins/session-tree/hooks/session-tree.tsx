import type { Register } from 'claude-code'

// One row of `claude agents --json`, which lists the sessions on this machine: background ones carry the short `id`
// and a `state`, interactive ones a `pid` and a `status`. A background one with no `pid` has exited but stays listed
// with its last state (seen: five `blocked`, `claude logs` "job not found") until `claude rm`; `claude stop` unlists it
export type Session = {
  id?: string; pid?: number; cwd: string; kind: string; startedAt: number
  sessionId: string; name: string; state?: string; status?: string
}
export type Group = { root: string; sessions: Session[] }
// What the ⋯ block reads from a session's transcript tail and, while it runs, its process record
export type Info = { branch?: string; model?: string; lastPrompt?: string; lastReply?: string; activeAt?: number; since?: number }

// The look of herdr-agent-tree (~/.config/herdr/local-plugins/herdr-agent-tree/agent_tree.py): its STATUS glyphs
// and colours, DIM, GROUP and its Nerd Font carets (Nerd Fonts 3.5.0+, else boxes)
const STATUS = {
  blocked: ['●', '#f7768e'],
  working: ['◐', '#e0af68'],
  done: ['✓', '#9ece6a'],
  idle: ['○', '#6e6e78'],
  failed: ['✗', '#f7768e'], // herdr has no failed; a background session can end so
  unknown: ['·', '#6e6e78'],
  exited: ['◌', '#6e6e78'], // not herdr's: a background session whose process is gone
} satisfies Record<string, [string, string]>
type Status = keyof typeof STATUS
const ORDER: Status[] = ['blocked', 'working', 'done', 'idle', 'failed', 'exited']
const DIM = '#6e6e78'
const GROUP = '#7dcfff'
const OPEN = '' // fa-caret_down
const SHUT = '' // fa-caret_right

const PANE = 'session-tree'
const SHOWN = 'shown' // $.store key: the pane's toggle, kept across sessions so a /resume or a new session reopens it
const FOLDED = 'folded' // $.store key: the repo roots folded shut

let sessions: Session[] = []
let self = ''
let home = ''
let failed = ''
let fetched = false
let folded = new Set<string>()
let timer: { cancel: () => void } | undefined
let expanded: string | undefined // the session whose ⋯ block is open
let armed: string | undefined // the session whose stop/remove was pressed once: the next press runs it
const infos = new Map<string, Info>()
const roots = new Map<string, string>() // cwd → its git toplevel, or the cwd itself outside a repo

// sessions under their repo root, roots by path, newest session first
export const groupOf = (list: readonly Session[], rootOf: (cwd: string) => string): Group[] => {
  const by = new Map<string, Session[]>()
  for (const s of list) { const r = rootOf(s.cwd); by.set(r, [...(by.get(r) ?? []), s]) }
  return [...by].sort(([a], [b]) => a.localeCompare(b)).map(([root, ss]) => ({ root, sessions: ss.sort((a, b) => b.startedAt - a.startedAt) }))
}

// a background session's `state` or an interactive one's `status`, as one of herdr's statuses
export const statusOf = (s: Session): Status => {
  if (s.kind === 'background' && s.pid === undefined) return 'exited'
  const v = s.state ?? s.status ?? ''
  return v === 'busy' || v === 'running' ? 'working' : Object.hasOwn(STATUS, v) ? v as Status : 'unknown'
}

// the facts a transcript's tail gives, the latest of each winning; typed prompts only, not command or reminder rows
export const infoOf = (jsonl: string): Info => {
  const info: Info = {}
  for (const line of jsonl.split('\n')) {
    let r: any
    try { r = JSON.parse(line) } catch { continue }
    if (r.gitBranch) info.branch = r.gitBranch
    if (r.timestamp) info.activeAt = Date.parse(r.timestamp)
    if (r.type === 'last-prompt' && r.lastPrompt) info.lastPrompt = r.lastPrompt
    const said = r.message?.content
    if (r.type === 'user' && !r.isMeta && typeof said === 'string' && !said.startsWith('<')) info.lastPrompt = said
    if (r.type === 'assistant') {
      if (r.message?.model && !r.message.model.startsWith('<')) info.model = r.message.model
      const text = Array.isArray(said) ? said.find((b: any) => b.type === 'text' && b.text?.trim())?.text : undefined
      if (text) info.lastReply = text
    }
  }
  return info
}

export const ago = (ms: number, now: number) => {
  const m = Math.max(0, Math.floor((now - ms) / 60000))
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`
}

const clip = (t: string, n: number) => (t.length > n ? t.slice(0, Math.max(1, n - 1)) + '…' : t)
const countsOf = (list: readonly Session[], order: readonly Status[]) =>
  order.map(st => [st, list.filter(s => statusOf(s) === st).length] as const).filter(([, n]) => n > 0)

const fetchAll = async ($: any) => {
  fetched = true
  try {
    self = await $.session.id() // read each time: a /resume moves this process to another session
    const r = await $.process.run(['claude', 'agents', '--json'], { timeoutMs: 10_000 })
    if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `claude agents exited ${r.exitCode}`)
    const list: Session[] = JSON.parse(r.stdout)
    for (const s of list) {
      if (roots.has(s.cwd)) continue
      const g = await $.process.run(['git', '-C', s.cwd, 'rev-parse', '--show-toplevel']).catch(() => undefined)
      roots.set(s.cwd, g?.exitCode === 0 ? g.stdout.trim() : s.cwd)
    }
    sessions = list
    failed = ''
  } catch (err) { failed = String(err) }
}

const tick = async ($: any) => {
  await fetchAll($)
  $.ui.invalidate('ui.render')
}

const show = async ($: any) => {
  await $.ui.open({ id: PANE, title: 'Sessions' })
  timer ??= $.clock.every(3000, () => { tick($) })
}

const hide = async ($: any) => {
  await $.ui.close({ id: PANE })
  timer?.cancel()
  timer = undefined
}

// A pane of herdr's `agent list`: the Claude session it runs, when it reports one
export type HerdrAgent = { agent_session?: { value?: string }; pane_id: string; workspace_id: string; cwd: string }
export type Action = { kind: 'here' } | { kind: 'focus'; pane: string } | { kind: 'attach'; workspace: string } | { kind: 'copy' } | { kind: 'elsewhere' }

// How a press reaches a session. Not /resume: every listed session is live, and /resume opens a live one a second
// time (seen: a --bg session open twice) and finds no session of another repo. So a session in a herdr pane is
// focused there, a background one is attached in a new herdr tab, by the workspace of a pane in its repo or else
// ours; with this session in no herdr pane, the attach command is copied
export const actionOf = (s: Session, self: string, root: string, agents: readonly HerdrAgent[]): Action => {
  if (s.sessionId === self) return { kind: 'here' }
  const pane = agents.find(a => a.agent_session?.value === s.sessionId)?.pane_id
  if (pane) return { kind: 'focus', pane }
  if (s.kind !== 'background') return { kind: 'elsewhere' }
  const mine = agents.find(a => a.agent_session?.value === self)
  if (!mine) return { kind: 'copy' }
  const near = agents.find(a => a.cwd === root || a.cwd.startsWith(root + '/'))
  return { kind: 'attach', workspace: near?.workspace_id ?? mine.workspace_id }
}

const open = async ($: any, s: Session) => {
  const run = async (argv: string[]) => {
    const r = await $.process.run(argv)
    if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `${argv.slice(0, 3).join(' ')} exited ${r.exitCode}`)
    return r.stdout as string
  }
  try {
    const agents: HerdrAgent[] = await run(['herdr', 'agent', 'list']).then(out => JSON.parse(out).result.agents, () => [])
    const a = actionOf(s, self, roots.get(s.cwd) ?? s.cwd, agents)
    const attach = `claude attach ${s.id}`
    if (a.kind === 'here') $.ui.toast('already in this session')
    else if (a.kind === 'focus') await run(['herdr', 'agent', 'focus', a.pane])
    else if (a.kind === 'attach') {
      const tab = JSON.parse(await run(['herdr', 'tab', 'create', '--workspace', a.workspace, '--cwd', s.cwd, '--label', s.name, '--focus'])).result
      await run(['herdr', 'pane', 'run', tab.root_pane.pane_id, attach])
    } else if (a.kind === 'copy') $.ui.toast((await $.ui.copy({ text: attach })).isCopied ? `copied: ${attach}` : `run: ${attach}`)
    else $.ui.toast(`${s.name} runs in a terminal outside herdr (pid ${s.pid})`)
  } catch (err) { $.ui.toast(`session-tree: ${err}`) }
}

const more = async ($: any, s: Session) => {
  armed = undefined
  expanded = expanded === s.sessionId ? undefined : s.sessionId
  $.ui.invalidate('ui.render')
  if (expanded === undefined) return
  const info: Info = {}
  try {
    const found = await $.process.run(['find', `${home}/.claude/projects`, '-maxdepth', '2', '-name', `${s.sessionId}.jsonl`, '-print', '-quit'])
    const path = found.stdout.trim()
    if (path) Object.assign(info, infoOf((await $.process.run(['tail', '-n', '300', path])).stdout))
  } catch {}
  if (s.pid !== undefined) {
    try { info.since = JSON.parse(await $.fs.read(`${home}/.claude/sessions/${s.pid}.json`)).statusUpdatedAt } catch {}
  }
  infos.set(s.sessionId, info)
  $.ui.invalidate('ui.render')
}

// A running background session is stopped (its conversation kept, `claude attach` reopens it), an exited one
// removed from the list (`claude rm`: its worktree too where safe, its transcript kept), an interactive one sent
// SIGTERM (it exits within seconds, its transcript kept for --resume, unsent typed text lost); this session never
const KILLS = {
  stop: ['stop', 'stopped'], rm: ['remove', 'removed'], kill: ['kill', 'killed'],
} as const
export const killOf = (s: Session, self: string): keyof typeof KILLS | undefined =>
  s.sessionId === self ? undefined
  : s.kind !== 'background' ? (s.pid === undefined ? undefined : 'kill')
  : !s.id ? undefined : s.pid === undefined ? 'rm' : 'stop'

// the first press arms it
const kill = async ($: any, s: Session) => {
  const verb = killOf(s, self)
  if (!verb) return
  if (armed !== s.sessionId) { armed = s.sessionId; return void $.ui.invalidate('ui.render') }
  armed = undefined
  if (verb === 'kill') {
    // the pid as listed now, so a pid reused since the last poll is never signalled
    await fetchAll($)
    if (!sessions.some(x => x.sessionId === s.sessionId && x.pid === s.pid)) { $.ui.toast(`${s.name}: already gone`); return void $.ui.invalidate('ui.render') }
  }
  const argv = verb === 'kill' ? ['kill', '-TERM', String(s.pid)] : ['claude', verb, s.id!]
  const r = await $.process.run(argv, { timeoutMs: 30_000 }).catch((err: unknown) => ({ exitCode: -1, stdout: '', stderr: String(err) }))
  $.ui.toast(r.exitCode === 0 ? `${s.name}: ${KILLS[verb][1]}` : `${argv.join(' ')}: ${(r.stderr || r.stdout).trim()}`)
  if (r.exitCode === 0) expanded = undefined
  await tick($)
}

const fold = ($: any, root: string) => {
  if (!folded.delete(root)) folded.add(root)
  $.store.set(FOLDED, [...folded]).catch(() => {})
  $.ui.invalidate('ui.render')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try { await $.command.register({ name: 'sessiontree', description: 'Toggle the tree of this machine\'s Claude sessions; press one to focus its herdr pane, or attach a background one in a new herdr tab; ⋯ for info, stop, remove and kill.' }) } catch {} // agent-log saw this throw on hot reload
    home = (await $.process.run(['printenv', 'HOME']).catch(() => undefined))?.stdout.trim() ?? ''
    folded = new Set(((await $.store.get(FOLDED).catch(() => undefined)) as string[] | undefined) ?? [])
    if (e.isInteractive && (await $.store.get(SHOWN).catch(() => undefined)) !== false) await show($)
    return next(e)
  })

  on('command.run', { command: 'sessiontree' }, async $ => {
    const up = (await $.ui.panes()).some((p: any) => p.id === PANE)
    if (up) await hide($)
    else await show($)
    await $.store.set(SHOWN, !up)
    return { text: up ? 'session tree hidden' : 'session tree shown' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    if (!fetched) await fetchAll($) // the first draw waits for the list rather than drawing "no sessions"
    const cols = (e.props.bodyColumns ?? 41) - 1 // herdr's PAD: one blank column inside the border
    const groups = groupOf(sessions, cwd => roots.get(cwd) ?? cwd)
    const total = countsOf(sessions, ORDER)
    const now = Date.now()
    const first = (t?: string) => t?.split('\n').find(l => l.trim())?.trim()
    // the ⋯ block under a row, its rail carrying on the tree's │ while more rows follow
    const detail = (s: Session, rail: string) => {
      const info = infos.get(s.sessionId)
      const line = (t: string, color: string | undefined = DIM) => <Text color={color}>{rail}{clip(t, cols - rail.length)}</Text>
      const which = killOf(s, self)
      const verb = which && KILLS[which][0]
      const isArmed = armed === s.sessionId
      return (
        <Box key={`d${s.sessionId}`} flexDirection="column">
          {line([s.id && `id ${s.id}`, s.pid ? `pid ${s.pid}` : 'not running', s.kind].filter(Boolean).join(' · '))}
          {!info ? line('…') : null}
          {info?.branch || info?.model ? line([info.branch, info.model].filter(Boolean).join(' · ')) : null}
          {info?.since ? line(`${statusOf(s)} for ${ago(info.since, now)}`) : null}
          {info?.activeAt ? line(`last active ${ago(info.activeAt, now)} ago`) : null}
          {first(info?.lastPrompt) ? line(`› ${first(info?.lastPrompt)}`, undefined) : null}
          {first(info?.lastReply) ? line(`‹ ${first(info?.lastReply)}`) : null}
          {verb ? (
            <Box flexDirection="row">
              <Text color={DIM}>{rail}</Text>
              <Button key={`k${s.sessionId}`} plain onPress={() => { void kill($, s) }}>
                <Text color={isArmed ? STATUS.blocked[1] : DIM}>{isArmed ? `press again to ${verb}` : verb}</Text>
              </Button>
            </Box>
          ) : null}
        </Box>
      )
    }
    return (
      <Box flexDirection="column" paddingLeft={1}>
        {failed ? <Text color={STATUS.blocked[1]}>{clip(failed, cols)}</Text> : null}
        {!failed && !groups.length ? <Text color={DIM}>no sessions</Text> : null}
        {groups.map((g, i) => {
          const isOpen = !folded.has(g.root)
          const label = g.root === home ? '~' : g.root.slice(g.root.lastIndexOf('/') + 1) || g.root
          // the rows say it while open; folded, the counts stand in for them, idle included
          const counts = isOpen ? [] : countsOf(g.sessions, ORDER)
          const room = cols - `${i + 1}  `.length - 2 - counts.reduce((n, [, c]) => n + ` ● ${c}`.length, 0)
          return (
            <Box key={`g${g.root}`} flexDirection="column">
              <Button key={`f${g.root}`} plain onPress={() => fold($, g.root)}>
                <Text color={DIM}>{i + 1} {isOpen ? OPEN : SHUT} </Text>
                <Text bold color={GROUP}>{clip(label, room)}</Text>
                {counts.map(([st, n]) => <Text color={STATUS[st][1]}> {STATUS[st][0]} {n}</Text>)}
              </Button>
              {isOpen && g.sessions.map((s, j) => {
                const [glyph, colour] = STATUS[statusOf(s)]
                const here = s.sessionId === self
                const isLast = j === g.sessions.length - 1
                return (
                  <Box key={`r${s.sessionId}`} flexDirection="column">
                    <Box flexDirection="row">
                      <Button key={s.sessionId} plain onPress={() => { void open($, s) }}>
                        <Text color={colour}>{here ? '▶ ' : '  '}</Text>
                        <Text color={DIM}>{isLast ? '└ ' : '├ '}</Text>
                        <Text color={colour}>{glyph} </Text>
                        <Text bold={here} dimColor={statusOf(s) === 'exited'}>{clip(s.name, cols - 8)}</Text>
                      </Button>
                      <Button key={`i${s.sessionId}`} plain onPress={() => { void more($, s) }}>
                        <Text color={expanded === s.sessionId ? GROUP : DIM}> ⋯</Text>
                      </Button>
                    </Box>
                    {expanded === s.sessionId ? detail(s, isLast ? '      ' : '  │   ') : null}
                  </Box>
                )
              })}
            </Box>
          )
        })}
        {sessions.length ? (
          <Box flexDirection="row">
            <Text color={DIM}>{sessions.length} session{sessions.length === 1 ? '' : 's'}</Text>
            {total.map(([st, n]) => <Text color={STATUS[st][1]}>  {STATUS[st][0]} {n}</Text>)}
          </Box>
        ) : null}
      </Box>
    )
  })
}
