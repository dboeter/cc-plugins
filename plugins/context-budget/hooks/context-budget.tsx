import type { ContextBreakdownDetail, ContextGridSquare, EngineInterface, Register, SessionContextBreakdown, SessionUsage } from 'claude-code'

// A teaching view of the context window for people new to Claude Code: the same breakdown /context prints
// ($.session.usage({ breakdown })), with a plain-language note per category, what is paid on every request, how the
// window filled turn by turn, and where auto-compact starts

const PANE = 'context-budget'
const TITLE = 'Context budget'

// What each /context row is, keyed by its label as /context prints it. Only this prose is keyed on a name: what a row does
// (counts toward the window, free, compaction reserve, loaded on demand) is read from its `kind`. A label not here draws
// without a note. grows: the row gets bigger as you work; every other row is paid once and resent with each request
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

// One bar per turn, scaled to the whole window rather than to the highest turn, so a full bar means a full window
const BARS = '▁▂▃▄▅▆▇█'
export const spark = (xs: number[], max: number) => xs.map(x => BARS[Math.min(7, Math.max(0, Math.round((x / max) * 7)))]).join('')

// A grid row as runs of one colour, so a row is a few Text elements rather than one per square. Glyphs follow /context's
// reading: a row's last square draws hollow under 0.7 full; free space and the compaction reserve get their own marks
export const runsOf = (row: ContextGridSquare[], kindOf: (name: string) => string | undefined): { s: string; color?: string; dim?: boolean }[] => {
  const out: { s: string; color?: string; dim?: boolean }[] = []
  for (const q of row) {
    const kind = kindOf(q.categoryName)
    const ch = kind === 'free' ? '·' : kind === 'buffer' ? '▒' : q.squareFullness >= 0.7 ? '■' : '□'
    const color = kind === 'free' ? undefined : q.color
    const last = out.at(-1)
    if (last && last.color === color) last.s += ` ${ch}`
    else out.push({ s: `${out.length ? ' ' : ''}${ch}`, color, dim: kind === 'free' })
  }
  return out
}

let usage: SessionUsage | undefined
let failed = ''
let tried = false // the first draw fetched once; a failed fetch must not redraw-and-refetch forever
let exact = false // the shown breakdown was counted with the token-count API (`full`), not estimated
let notes = true // the per-category notes; an experienced reader hides them
let cols = 60
// context.tokens after each main turn, from session.measure: the API's own figure, so the growth line is what the model
// actually read. Module state: a reload of this plugin starts the line over
let history: number[] = []

async function refresh($: EngineInterface, detail: ContextBreakdownDetail = 'summary') {
  try {
    usage = await $.session.usage({ breakdown: detail, columns: cols }) // `full` sends a token-count request per tool and file: only on the reader's ask
    exact = detail === 'full'
    failed = ''
  } catch (err) { failed = String((err as Error)?.message ?? err) }
  $.ui.invalidate('ui.render')
}
const isUp = async ($: EngineInterface) => (await $.ui.panes()).some((p: any) => p.id === PANE)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try { await $.command.register({ name: 'contextbudget', description: 'Toggle a pane that explains what fills the context window and how it grows.' }) } catch {} // throws on hot reload: no session bound yet
    return next(e)
  })

  on('command.run', { command: 'contextbudget' }, async $ => {
    const up = await isUp($)
    if (up) await $.ui.close({ id: PANE })
    else { usage = undefined; tried = false; await $.ui.open({ id: PANE, title: TITLE, focus: true }) }
    return { text: up ? 'context budget hidden' : 'context budget shown' }
  })

  // after each main turn: record the fill, and while the pane is up re-estimate the breakdown (local, no request)
  on('session.measure', async ($, e, next) => {
    const r = await next(e)
    if (!e.changed.includes('context')) return r
    if (e.context.tokens != null) history = [...history, e.context.tokens].slice(-200)
    if (await isUp($).catch(() => false)) await refresh($)
    return r
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const w = e.props.bodyColumns ?? 60
    const narrow = (w < 80) !== (cols < 80) // the grid is 5 wide under 80 columns: refetch when the pane crosses that
    cols = w
    if (!tried || (narrow && usage)) { tried = true; await refresh($) }
    const b = usage?.context.breakdown
    if (!b) return <Text dimColor>{failed ? `Could not measure the context: ${failed}` : 'Measuring the context window…'}</Text>

    const kindOf = (name: string) => b.categories.find(c => c.name === name)?.kind
    const pct = (n: number) => `${Math.round((n / b.rawMaxTokens) * 100)}%`
    const side = w >= 64 // grid and legend side by side; narrower, stacked
    const grid = (
      <Box flexDirection="column" marginRight={side ? 3 : 0}>
        {b.gridRows.map(row => <Text>{runsOf(row, kindOf).map(r => <Text color={r.color} dimColor={r.dim}>{r.s}</Text>)}</Text>)}
      </Box>
    )
    const legend = (
      <Box flexDirection="column">
        {b.categories.map(c => {
          const deferred = c.kind === 'deferred'
          const mark = c.kind === 'free' ? '·' : c.kind === 'buffer' ? '▒' : '■'
          return (
            <Text>
              <Text color={c.kind === 'free' ? undefined : c.color} dimColor={c.kind === 'free'}>{mark}</Text>
              <Text dimColor={deferred}> {c.name.padEnd(19)}{k(c.tokens).padStart(6)}</Text>
              <Text dimColor>{deferred ? '  not in window' : `  ${pct(c.tokens).padStart(4)}`}</Text>
              {c.kind === 'used' && (ABOUT[c.name]?.grows ? <Text color="yellow">  grows</Text> : <Text dimColor>  per request</Text>)}
            </Text>
          )
        })}
      </Box>
    )
    const payers = payersOf(b)
    const shown = history.slice(-Math.max(8, w - 4))
    const now = history.at(-1)

    return (
      <Box flexDirection="column">
        <Text>
          <Text bold>{k(b.totalTokens)} of {k(b.rawMaxTokens)} tokens</Text>
          <Text dimColor> · {b.percentage}% used · {b.model}</Text>
        </Text>
        {notes && <Text dimColor>Everything Claude reads on each request. Each ■ is about {k(Math.round(b.rawMaxTokens / b.gridRows.flat().length))} tokens.</Text>}
        <Text> </Text>
        <Box flexDirection={side ? 'row' : 'column'}>{grid}{!side && <Text> </Text>}{legend}</Box>

        {notes && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>What each part is</Text>
            {b.categories.map(c => {
              // a label this table lacks (a new engine row, or a renamed one) says so, rather than vanishing from the list
              const text = c.kind === 'deferred' ? DEFERRED : ABOUT[c.name]?.text ?? (c.kind === 'used' ? 'no note for this row yet' : undefined)
              return text ?<Text><Text color={c.kind === 'free' ? undefined : c.color}>{c.name}</Text><Text dimColor>: {text}</Text></Text> : null
            })}
          </Box>
        )}

        {payers.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Paid on every request</Text>
            {notes && <Text dimColor>Sent again with each message before the conversation even starts. The biggest are the easiest wins.</Text>}
            {payers.map(p => <Text>  {k(p.tokens).padStart(6)}  {p.label}</Text>)}
          </Box>
        )}

        <Box flexDirection="column" marginTop={1}>
          <Text bold>Growth after each turn</Text>
          {shown.length
            ? <Text><Text color="cyan">{spark(shown, usage!.context.window)}</Text><Text dimColor>  {now != null && `now ${k(now)}`}{history.length > 1 && `, first ${k(history[0]!)}`}</Text></Text>
            : <Text dimColor>Shows up after Claude's first reply.</Text>}
          {notes && shown.length > 0 && <Text dimColor>Each bar is one turn, out of the whole window. A drop is a compaction or a /clear.</Text>}
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
          <Button key="exact" label="Count exactly" hotkey="r" plain onPress={() => { void refresh($, 'full') }} />
          <Text>  </Text>
          <Button key="notes" label={notes ? 'Hide notes' : 'Show notes'} hotkey="n" plain dimColor onPress={() => { notes = !notes; $.ui.invalidate('ui.render') }} />
        </Box>
        <Text dimColor>{exact ? 'Counted with the token-count API.' : 'Estimated locally; r counts exactly (one request per tool and file).'}</Text>
      </Box>
    )
  })
}
