import type { ContextBreakdownDetail, EngineInterface, Register, SessionContextBreakdown, SessionUsage } from 'claude-code'

// A teaching view of the context window for people new to Claude Code: the same breakdown /context prints
// ($.session.usage({ breakdown })), with a plain-language note per category, what each request carries, how the
// window filled turn by turn, and where auto-compact starts

const PANE = 'context-budget'
const TITLE = 'Context budget'

// What each /context row is, keyed by its label as /context prints it. Only this prose is keyed on a name: what a row does
// (counts toward the window, free, compaction reserve, loaded on demand) is read from its `kind`. A label not here draws
// without a note. grows: the row gets bigger as you work; every other row is set once and resent with each request
export const ABOUT: Record<string, { text: string; grows?: boolean }> = {
  'System prompt': { text: "Claude Code's built-in instructions. Sent with every request; you can't change them." },
  'System tools': { text: 'How to call the built-in tools (Bash, Read, Edit and the rest). Fixed for the session.' },
  'MCP tools': { text: "Schemas of the tools your MCP servers add. Disconnect a server you don't use to get this back." },
  'Custom agents': { text: 'One description per subagent you defined, so Claude knows when to hand work off.' },
  'Memory files': { text: 'CLAUDE.md and rules files, read at the start. Every line is resent with every request, so keep them short.' },
  'Skills': { text: 'One line per installed skill. The full skill only loads when it is used.' },
  'Messages': { text: 'The conversation: your prompts, the replies, every tool call and its output. This is the part that fills up.', grows: true },
  'Free space': { text: 'Room left before auto-compact starts.' },
  'Autocompact buffer': { text: 'Kept free so Claude Code can summarise the conversation before the window is full.' },
}
const DEFERRED = 'Tool schemas loaded only when Claude searches for one. Not in the window until then.'

export const k = (n: number) => n < 1000 ? `${n}` : `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`

// What every request carries before the conversation starts, biggest first: the rows a newcomer can act on
export type Payer = { label: string; tokens: number }
export const payersOf = (b: SessionContextBreakdown, n = 5): Payer[] => {
  const out: Payer[] = []
  const servers = new Map<string, number>()
  for (const t of b.mcpTools) if (t.isLoaded) servers.set(t.serverName, (servers.get(t.serverName) ?? 0) + t.tokens) // an unloaded schema is outside the window
  for (const [s, t] of servers) out.push({ label: `MCP server ${s}`, tokens: t })
  for (const f of b.memoryFiles) out.push({ label: `${f.type} ${f.path.split('/').slice(-2).join('/')}`, tokens: f.tokens }) // the folder tells one CLAUDE.md from another
  if (b.skills?.tokens) out.push({ label: `${b.skills.includedSkills} skill descriptions`, tokens: b.skills.tokens })
  if (b.agents.length) out.push({ label: `${b.agents.length} agent descriptions`, tokens: b.agents.reduce((s, a) => s + a.tokens, 0) })
  return out.filter(p => p.tokens > 0).sort((x, y) => y.tokens - x.tokens).slice(0, n)
}

// A step's tool calls as one label: `Read ×3, Bash`, an MCP tool as `server tool`
export const toolsLabel = (names: string[]) => {
  const n = new Map<string, number>()
  for (const x of names) { const t = x.replace(/^mcp__/, '').replace(/__/g, ' '); n.set(t, (n.get(t) ?? 0) + 1) }
  return [...n].map(([t, c]) => c > 1 ? `${t} ×${c}` : t).join(', ')
}

// What the model read for one request: the uncached input plus what the prompt cache served and wrote
const readOf = (u: { input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }) =>
  u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens

// Context growth per step of a main turn, live: each request's size is known when its response ends, so the growth from
// one request to the next is what the step between added (its tool results and reply). A row's label is the tools that
// caused it; the first row of a turn is the prompt plus the previous turn's reply. `pending`: the latest step's tools,
// whose growth shows once the next request is answered
const STEPS = 12 // rows drawn for one turn
export type StepRow = { label: string; delta: number }
export type TurnRows = { id: string; rows: StepRow[]; pending?: string }

// The window as one stacked bar, `width` cells, in breakdown order. Every
// non-empty row gets at least one cell so a small one stays visible; free space takes up the rounding (and gives way
// first when those minimum cells overflow)
export const barOf = (b: SessionContextBreakdown, width: number): { s: string; color?: string; dim?: boolean }[] => {
  const rows = b.categories.filter(c => c.kind !== 'deferred' && c.kind !== 'free' && c.tokens > 0)
    .map(c => ({ c, n: Math.max(1, Math.round((c.tokens / b.rawMaxTokens) * width)) }))
  const free = b.categories.find(c => c.kind === 'free')
  const left = Math.max(0, width - rows.reduce((s, r) => s + r.n, 0))
  const out: { s: string; color?: string; dim?: boolean }[] = rows.map(({ c, n }) => ({ s: (c.kind === 'buffer' ? '▒' : '█').repeat(n), color: c.color }))
  // free space sits before the reserve, as in the window: the reserve is its last stretch
  const at = rows.findIndex(r => r.c.kind === 'buffer')
  if (free && left) out.splice(at < 0 ? out.length : at, 0, { s: '·'.repeat(left), color: undefined, dim: true })
  return out
}

let usage: SessionUsage | undefined
let failed = ''
let tried = false // the first draw fetched once; a failed fetch must not redraw-and-refetch forever
let exact = false // the shown breakdown was counted with the token-count API (`full`), not estimated
let notes = true // the per-category notes; an experienced reader hides them
// The last turns' growth, newest last, and the size of the latest main request. Module state: a reload starts it over
let turns: TurnRows[] = []
let lastRead: number | undefined
// Each refresh's number. A reply a newer refresh overtook is dropped, so a slow exact count that a turn's estimate
// passed can't land pre-turn figures labelled as counted
let seq = 0
let counting = false // an exact count is in flight: r waits for it rather than paying for a second one

async function refresh($: EngineInterface, detail: ContextBreakdownDetail = 'summary') {
  const mine = ++seq
  if (detail === 'full') { counting = true; $.ui.invalidate('ui.render') }
  try {
    const u = await $.session.usage({ breakdown: detail }) // `full` sends a token-count request per tool and file: only on the reader's ask
    if (mine === seq) { usage = u; exact = detail === 'full'; failed = '' }
  } catch (err) { if (mine === seq) failed = String((err as Error)?.message ?? err) }
  finally { if (detail === 'full') counting = false }
  $.ui.invalidate('ui.render')
}
const isUp = async ($: EngineInterface) => (await $.ui.panes()).some(p => p.id === PANE)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try { await $.command.register({ name: 'contextbudget', description: 'Toggle a pane that explains what fills the context window and how it grows.' }) }
    catch (err) { $.ui.log(`context-budget: /contextbudget not registered: ${(err as Error)?.message ?? err}`, { to: 'debug' }) } // throws on hot reload (no session bound yet); anything else should be findable
    return next(e)
  })

  on('command.run', { command: 'contextbudget' }, async $ => {
    const up = await isUp($)
    if (up) await $.ui.close({ id: PANE })
    else { usage = undefined; tried = false; await $.ui.open({ id: PANE, title: TITLE, focus: true }) }
    return { text: up ? 'context budget hidden' : 'context budget shown' }
  })

  // after each main turn, while the pane is up: re-estimate the breakdown (local, no request)
  on('session.measure', async ($, e, next) => {
    const r = await next(e)
    if (e.changed.includes('context') && await isUp($).catch(() => false)) await refresh($)
    return r
  })

  // each main request as its response ends: how much the context grew since the last one, and which tools to blame.
  // A subagent's requests are its own window, not this one
  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    if (e.agentId || !r.usage) return r
    const read = readOf(r.usage)
    let t = turns.at(-1)
    if (t?.id !== e.turnId) { t = { id: e.turnId, rows: [] }; turns = [...turns, t].slice(-9) }
    if (lastRead != null) {
      const delta = read - lastRead
      t.rows.push({ label: delta < 0 ? 'compacted or cleared' : e.index === 0 ? 'prompt + last reply' : t.pending ?? 'reply', delta })
    }
    lastRead = read
    t.pending = toolsLabel([...r.toolUses.map(u => u.name), ...(r.serverToolUses ?? []).map(u => u.name)]) || undefined
    if (await isUp($).catch(() => false)) $.ui.invalidate('ui.render')
    return r
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const w = e.props.bodyColumns ?? 60
    // not awaited: the pane draws "Measuring…" at once and the reply draws it again
    if (!tried) { tried = true; void refresh($) }
    const b = usage?.context.breakdown
    if (!b) return <Text dimColor>{failed ? `Could not measure the context: ${failed}` : 'Measuring the context window…'}</Text>

    const pct = (n: number) => `${Math.round((n / b.rawMaxTokens) * 100)}%`
    const legend = (
      <Box flexDirection="column">
        {b.categories.filter(c => c.kind !== 'deferred').map(c => {
          const mark = c.kind === 'free' ? '·' : c.kind === 'buffer' ? '▒' : '█'
          return (
            <Text>
              <Text color={c.kind === 'free' ? undefined : c.color} dimColor={c.kind === 'free'}>{mark}</Text>
              <Text> {c.name.padEnd(19)}{k(c.tokens).padStart(6)}</Text>
              <Text dimColor>{`  ${pct(c.tokens).padStart(4)}`}</Text>
              {/* a label ABOUT lacks gets no tag: guessing "each request" would be wrong if it is the conversation */}
              {c.kind === 'used' && ABOUT[c.name] && (ABOUT[c.name]!.grows ? <Text color="yellow">  grows</Text> : <Text dimColor>  each request</Text>)}
              {c.kind === 'buffer' && <Text dimColor>  reserved for compaction</Text>}
            </Text>
          )
        })}
      </Box>
    )
    const payers = payersOf(b)
    const deferred = b.categories.filter(c => c.kind === 'deferred')
    // The free row is already measured against the threshold (window - used - compaction reserve), so it is the room
    // before auto-compact as it stands; free plus the reserve is the room left in the whole window
    const free = b.categories.find(c => c.kind === 'free')?.tokens ?? 0
    const buffer = b.categories.find(c => c.kind === 'buffer')?.tokens ?? 0
    const compacts = b.isAutoCompactEnabled && b.autoCompactThreshold
    const grows = b.categories.find(c => c.kind === 'used' && ABOUT[c.name]?.grows)
    // Growth is read from the API's request sizes, never the header's estimate: it states changes, not a second "now"
    // that would disagree with the header
    const turn = turns.at(-1)
    const sum = (t: TurnRows) => t.rows.reduce((s, x) => s + x.delta, 0)
    const signed = (n: number) => `${n < 0 ? '-' : '+'}${k(Math.abs(n))}`
    const most = Math.max(1, ...(turn?.rows ?? []).map(x => Math.abs(x.delta)))
    const span = Math.max(4, Math.min(w, 100) - 34) // label 24, number 7, gaps: the bar takes what is left
    const earlier = turns.slice(0, -1).filter(t => t.rows.length).reverse().map(sum) // the first turn measured has no before

    return (
      <Box flexDirection="column">
        <Text>
          <Text bold>{k(b.totalTokens)} of {k(b.rawMaxTokens)} tokens</Text>
          <Text dimColor> · {b.percentage}% used · {b.model}</Text>
        </Text>
        {compacts
          ? <Text><Text bold color="green">{k(free)} left before auto-compact</Text><Text dimColor> at {k(b.autoCompactThreshold!)} · {k(free + buffer)} in the window</Text></Text>
          : <Text><Text bold color="green">{k(free)} left in the window</Text><Text dimColor> · auto-compact is off</Text></Text>}
        {grows && b.totalTokens > 0 && <Text><Text color={grows.color}>{grows.name} {k(grows.tokens)}</Text><Text dimColor> is {Math.round((grows.tokens / b.totalTokens) * 100)}% of what is used, and the part that grows</Text></Text>}
        {notes && <Text dimColor>The bar is the whole window, in the colours below. Every part gets at least one cell, however small.</Text>}
        <Text> </Text>
        <Text>{barOf(b, Math.min(w, 100)).map(r => <Text color={r.color} dimColor={r.dim}>{r.s}</Text>)}</Text>
        <Text> </Text>
        {legend}

        {notes && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>What each part is</Text>
            {b.categories.filter(c => c.kind !== 'deferred').map(c => {
              // a label this table lacks (a new engine row, or a renamed one) says so, rather than vanishing from the list
              const text = ABOUT[c.name]?.text ?? (c.kind === 'used' ? 'no note for this row yet' : undefined)
              return text ?<Text><Text color={c.kind === 'free' ? undefined : c.color}>{c.name}</Text><Text dimColor>: {text}</Text></Text> : null
            })}
          </Box>
        )}

        {/* apart from the breakdown so nobody adds these to the total: they are not in the window */}
        {deferred.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Available tools outside context</Text>
            {notes && <Text dimColor>{DEFERRED}</Text>}
            {deferred.map(c => <Text dimColor>  {k(c.tokens).padStart(6)}  {c.name}</Text>)}
          </Box>
        )}

        {payers.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Context included in each request</Text>
            {notes && <Text dimColor>Sent again with each message before the conversation even starts. The biggest are the easiest wins.</Text>}
            {payers.map(p => <Text>  {k(p.tokens).padStart(6)}  {p.label}</Text>)}
          </Box>
        )}

        <Box flexDirection="column" marginTop={1}>
          <Text><Text bold>Growth this turn</Text>{turn && <Text dimColor>  {signed(sum(turn))}</Text>}</Text>
          {notes && <Text dimColor>What each step added, live: the tools' results and Claude's text. Bars are scaled to the biggest step.</Text>}
          {turn && (turn.rows.length || turn.pending) ? (
            <Box flexDirection="column">
              {/* a long agentic turn runs to hundreds of steps: draw the latest, the total still counts them all */}
              {turn.rows.length > STEPS ? <Text dimColor>  …{turn.rows.length - STEPS} earlier steps</Text> : null}
              {turn.rows.slice(-STEPS).map(x => (
                <Text>
                  <Text>  {x.label.slice(0, 24).padEnd(24)}</Text>
                  <Text dimColor>{signed(x.delta).padStart(6)}  </Text>
                  <Text color={x.delta < 0 ? 'green' : 'cyan'}>{'█'.repeat(Math.max(1, Math.round((Math.abs(x.delta) / most) * span)))}</Text>
                </Text>
              ))}
              {turn.pending ? <Text dimColor>  {turn.pending.slice(0, 24).padEnd(24)}       …</Text> : null}
            </Box>
          ) : <Text dimColor>Shows up once Claude has answered twice.</Text>}
          {earlier.length > 0 && <Text dimColor>Earlier turns: {earlier.map(signed).join('  ')}</Text>}
        </Box>

        <Box flexDirection="column" marginTop={1}>
          <Text bold>When it fills up</Text>
          <Text dimColor>
            {b.isAutoCompactEnabled && b.autoCompactThreshold
              ? `Auto-compact starts at ${k(b.autoCompactThreshold)} (${pct(b.autoCompactThreshold)}). Claude Code replaces the older conversation with a summary: Messages shrinks, the rest stays.`
              : 'Auto-compact is off. Run /compact before the window fills, or /clear to start over.'}
          </Text>
        </Box>

        <Box marginTop={1}>
          <Button key="exact" label="Count exactly" hotkey="r" plain onPress={() => { if (!counting) void refresh($, 'full') }} />
          <Text>  </Text>
          <Button key="notes" label={notes ? 'Hide notes' : 'Show notes'} hotkey="n" plain dimColor onPress={() => { notes = !notes; $.ui.invalidate('ui.render') }} />
        </Box>
        <Text dimColor>{counting ? 'Counting exactly…' : exact ? 'Counted with the token-count API.' : 'Estimated locally; r counts exactly (one request per tool and file).'}</Text>
        {failed && <Text color="red">Could not refresh, showing the last figures: {failed}</Text>}
      </Box>
    )
  })
}
