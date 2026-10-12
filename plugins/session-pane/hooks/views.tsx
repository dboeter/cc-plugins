import type { Elements, SessionUsage } from 'claude-code'
import type { Recap, View } from '../types'
import { checksOf, contextLabel, NEARLY_FULL, segmentsOf, statusOf, type FileChange, type SessionModel, type Source, type Status } from './model'

// The pane's pages as trees. Pure: everything they draw comes in through Page, and every press goes out through Act.
// Words before metrics: no token counts on the overview, a label beside every colour, nothing that animates

export type Els = Elements['terminal']
export type Act = {
  go: (v: View) => void
  help: () => void
  diff: (path: string) => void
  draft: () => void
  use: () => void
  discard: () => void
}
export type Page = { m: SessionModel; view: View; help: boolean; diff: string; recap: Recap; cols: number; usage?: SessionUsage; model?: string }

const MAX_LIST = 8 // per group on a detail page; the rest is counted
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
// a path cut from the left, so the file name stays: …/src/components/confirm.tsx
const tail = (p: string, n: number) => p.length <= n ? p : `…${p.slice(p.length - n + 1)}`

// The status mark and its colour; the label beside it always says the same in words
const MARK: Record<Status['kind'], [string, string | undefined]> = {
  new: ['○', undefined], working: ['●', 'claude'], input: ['?', 'warning'], failed: ['✗', 'error'], review: ['◆', 'suggestion'], idle: ['○', undefined],
}

const NOTE: Record<Source['note'], string> = {
  full: 'full file', excerpt: 'excerpt', earlier: 'read before the summary; may need re-reading', unrestored: 'not restored after the summary',
  changed: 'changed on disk since it was read', loaded: 'loaded', summary: 'summary of earlier messages',
}

const HELP: Record<string, string> = {
  goal: 'What this session is for, condensed from your messages. To change it, say so in the conversation.',
  now: 'What Claude is doing at this moment, and its next planned step when it has a plan.',
  context: 'How much of the space for this conversation is in use. When it fills, older details get summarised.',
  changes: 'Files Claude changed in this session, and whether checks such as tests ran after the last change.',
}

const UI_FILE = /\.(tsx|jsx|vue|svelte|css|scss|html)$/

export function draw(el: Els, p: Page, act: Act) {
  const { Box, Text, Button } = el
  const w = Math.max(24, p.cols)
  const back = <Button key="back" label="← Session overview" hotkey="b" plain onPress={() => act.go('overview')} />
  const rule = (k: string) => <Text key={k} dimColor>{'─'.repeat(Math.min(w, 60))}</Text>
  const head = (k: string, title: string, right?: string) => (
    <Box key={k} flexDirection="row" justifyContent="space-between" width={w}>
      <Text bold>{title}</Text>
      {right ? <Text dimColor>{right}</Text> : null}
    </Box>
  )
  const helpLine = (k: string) => p.help ? <Text key={`h-${k}`} dimColor italic wrap="wrap">{HELP[k]}</Text> : null
  const bar = (k: string, runs: { n: number; color?: string }[], width: number) => {
    const used = runs.reduce((s, r) => s + r.n, 0)
    return (
      <Text key={k}>
        {runs.filter(r => r.n > 0).map((r, i) => <Text key={`${k}${i}`} color={r.color}>{'█'.repeat(r.n)}</Text>)}
        <Text dimColor>{'░'.repeat(Math.max(0, width - used))}</Text>
      </Text>
    )
  }

  const m = p.m
  const st = statusOf(m)
  const ctx = contextLabel(m.context.percent)
  const nearly = (m.context.percent ?? 0) >= NEARLY_FULL
  const checks = checksOf(m)

  // === OVERVIEW ===
  if (p.view === 'overview') {
    const [mark, color] = MARK[st.kind]
    const bw = Math.min(w, 30)
    const filled = m.context.percent == null ? 0 : Math.max(1, Math.round((m.context.percent / 100) * bw))
    return (
      <Box flexDirection="column" width={w}>
        {head('goal-h', 'Your goal')}
        {helpLine('goal')}
        {m.goal
          ? <Button key="goal" label={`${m.goal.title} ›`} hotkey="g" plain onPress={() => act.go('goal')} />
          : <Text key="goal-none" dimColor wrap="wrap">Your goal appears here after your first message.</Text>}
        {rule('r1')}
        {head('now-h', 'Right now')}
        {helpLine('now')}
        <Text key="now"><Text color={color}>{mark}</Text> <Text bold>{st.label}</Text></Text>
        {st.detail ? <Text key="now-d" wrap="wrap">{st.detail}</Text> : null}
        {st.kind === 'input' ? <Text key="now-a" dimColor>Answer in the dialog</Text> : null}
        {st.next ? <Text key="now-n" dimColor wrap="truncate-end">Next: {st.next}</Text> : null}
        {st.kind === 'review' ? <Button key="review" label="Review changes ›" hotkey="r" variant="primary" onPress={() => act.go('changes')} /> : null}
        {rule('r2')}
        {head('ctx-h', 'Context', m.context.percent == null ? ctx.label : `${ctx.label} · ${Math.round(m.context.percent)}%`)}
        {helpLine('context')}
        {bar('ctx-bar', [{ n: filled, color: nearly ? 'warning' : 'claude' }], bw)}
        <Text key="ctx-t" dimColor wrap="wrap">{ctx.text}</Text>
        {nearly ? <Button key="recap" label="Prepare a recap" hotkey="p" variant="primary" onPress={() => act.go('recap')} /> : null}
        <Button key="ctx" label="What's included ›" hotkey="c" plain onPress={() => act.go('context')} />
        {rule('r3')}
        {head('chg-h', 'Changes so far')}
        {helpLine('changes')}
        {m.files.length
          ? <Button key="chg" label={`${plural(m.files.length, 'file')} changed ›`} hotkey="f" plain onPress={() => act.go('changes')} />
          : <Text key="chg-none" dimColor>No files changed yet</Text>}
        {checks.line ? <Text key="chk" color={checks.line.endsWith('failed') ? 'error' : undefined} dimColor={checks.stale}>{checks.line}</Text> : null}
        {rule('r4')}
        <Box key="foot" flexDirection="row" gap={2}>
          <Button key="details" label="Session details" hotkey="d" plain onPress={() => act.go('details')} />
          <Button key="help" label={p.help ? 'ⓘ Hide help' : 'ⓘ Help'} hotkey="h" plain onPress={act.help} />
        </Box>
      </Box>
    )
  }

  // === GOAL ===
  if (p.view === 'goal') {
    const g = m.goal
    return (
      <Box flexDirection="column" width={w}>
        {back}
        {head('h', 'Your goal')}
        {!g ? <Text key="none" dimColor wrap="wrap">Your goal appears here after your first message.</Text> : null}
        {g ? <Text key="t" bold wrap="wrap">{g.title}</Text> : null}
        {g?.isDraft ? <Text key="draft" dimColor>Taken from your message; a shorter title follows.</Text> : null}
        {g ? <Text key="from" dimColor>From: {g.from}</Text> : null}
        {g ? <Text key="text" wrap="wrap">“{g.text.length > 600 ? `${g.text.slice(0, 599)}…` : g.text}”</Text> : null}
        {g?.keep.length ? rule('r1') : null}
        {g?.keep.length ? <Text key="keep-h" bold>Keep in mind</Text> : null}
        {g?.keep.map((k, i) => <Text key={`k${i}`} wrap="wrap">• {k.text} <Text dimColor>({k.from})</Text></Text>)}
        {g?.done ? rule('r2') : null}
        {g?.done ? <Text key="done-h" bold>Finished means</Text> : null}
        {g?.done ? <Text key="done" wrap="wrap">{g.done}</Text> : null}
        {rule('r3')}
        <Text key="how" dimColor wrap="wrap">To change the goal, say so in the conversation.</Text>
      </Box>
    )
  }

  // === CONTEXT ===
  if (p.view === 'context') {
    const window = p.usage?.context.window ?? m.context.window
    const rows = p.usage?.context.breakdown?.categories
    const seg = segmentsOf(m.est, rows)
    const bw = Math.min(w, 40)
    const share = (n: number) => window ? n / window : 0
    const runs = seg.segments.map(s => ({ n: Math.round(share(s.tokens) * bw), color: s.color }))
    const pct = (n: number) => `${Math.round(share(n) * 100)}%`
    const group = (g: Source['group']) => m.sources.filter(s => s.group === g)
    const list = (k: string, title: string, items: Source[], first?: string) => {
      const shown = items.slice(0, MAX_LIST)
      return [
        <Text key={`${k}-h`} bold>{title}</Text>,
        ...(first ? [<Text key={`${k}-0`} dimColor wrap="wrap">{first}</Text>] : []),
        // label and note on one line when both fit, else the note goes under it: a path cut to fit a long note says nothing
        ...shown.flatMap(s => s.label.length + NOTE[s.note].length + 3 <= w
          ? [<Text key={`${k}-${s.key}`}>{s.label} <Text dimColor>· {NOTE[s.note]}</Text></Text>]
          : [<Text key={`${k}-${s.key}`}>{tail(s.label, w)}</Text>, <Text key={`${k}-${s.key}-n`} dimColor wrap="wrap">  {NOTE[s.note]}</Text>]),
        ...(items.length > shown.length ? [<Text key={`${k}-more`} dimColor>and {items.length - shown.length} more</Text>] : []),
        ...(!items.length && !first ? [<Text key={`${k}-none`} dimColor>None yet</Text>] : []),
      ]
    }
    const confidence = seg.confidence === 'close'
      ? `The split is an estimate from what this pane saw; it matches the engine's own total within ${Math.max(1, Math.round((seg.gap ?? 0) * 100))}%.`
      : seg.confidence === 'rough'
        ? "The split is a rough estimate: it differs from the engine's own total by more than a quarter, often because some of the conversation came before this pane loaded. The total is the engine's."
        : 'The split appears after the first response.'
    return (
      <Box flexDirection="column" width={w}>
        {back}
        {head('h', 'Context', m.context.percent == null ? ctx.label : `${ctx.label} · ${Math.round(m.context.percent)}%`)}
        <Text key="t" dimColor wrap="wrap">{ctx.text}</Text>
        {rows ? bar('bar', runs, bw) : null}
        {rows ? seg.segments.map(s => <Text key={`s-${s.name}`}><Text color={s.color}>█</Text> {s.name}{s.isEstimate ? ' (estimate)' : ''} <Text dimColor>{pct(s.tokens)}</Text></Text>) : null}
        <Text key="conf" dimColor wrap="wrap">{confidence}</Text>
        {nearly ? <Button key="recap" label="Prepare a recap" hotkey="p" variant="primary" onPress={() => act.go('recap')} /> : null}
        {rule('r1')}
        <Text key="inc-h" bold>What's included</Text>
        <Text key="inc-t" dimColor wrap="wrap">Available for the next response. Reading a file once does not mean all of it stays available.</Text>
        {list('i', 'Instructions', group('instructions'), "Claude Code's built-in instructions and tool descriptions")}
        {list('c', 'Conversation', group('conversation'), m.prompts ? `Your ${plural(m.prompts, 'message')} and Claude's replies${m.compactions ? ' since the last summary' : ''}` : undefined)}
        {list('f', 'Files and references', group('files'))}
        <Text key="r-h" bold>Tool results</Text>
        <Text key="r-t" dimColor wrap="wrap">Output of commands, searches and other tools Claude ran.</Text>
        {m.summary ? rule('r2') : null}
        {m.summary ? <Text key="sum-h" bold>Carried forward in the summary</Text> : null}
        {m.summary ? <Text key="sum" wrap="wrap" dimColor>{m.summary.split('\n').slice(0, 8).join('\n')}</Text> : null}
      </Box>
    )
  }

  // === CHANGES ===
  if (p.view === 'changes') {
    const fresh = m.checks.filter(c => c.t >= m.lastEdit)
    const stale = m.checks.filter(c => c.t < m.lastEdit)
    const ui = m.files.some(f => UI_FILE.test(f.path))
    const row = (f: FileChange) => {
      const label = `${f.isNew ? 'New   ' : 'Edited'} ${tail(f.path, Math.max(12, w - 10))}${f.byShell ? ' (by a command)' : ''}`
      return f.hunks?.length
        ? <Button key={`f-${f.path}`} label={label} plain onPress={() => act.diff(f.path)} />
        : <Text key={`f-${f.path}`} wrap="truncate-start">{label}</Text>
    }
    return (
      <Box flexDirection="column" width={w}>
        {back}
        {head('h', 'Changes so far', plural(m.files.length, 'file'))}
        {m.files.length ? <Text key="t" dimColor wrap="wrap">Changed, not yet verified unless a check below says so. Select a file for its diff.</Text> : <Text key="none" dimColor>No files changed yet</Text>}
        {m.files.map(row)}
        {rule('r1')}
        <Text key="c-h" bold>Checks</Text>
        {!m.checks.length ? <Text key="c-none" dimColor>{m.files.length ? "Checks haven't run yet" : 'None run yet'}</Text> : null}
        {fresh.map(c => <Text key={`c-${c.name}`} wrap="wrap"><Text color={c.ok ? 'success' : 'error'}>{c.ok ? '✓' : '✗'}</Text> {c.name} {c.ok ? 'passed' : 'failed'}{c.ok ? '' : `\n${c.line}`}</Text>)}
        {stale.map(c => <Text key={`s-${c.name}`} dimColor wrap="wrap">– {c.name} {c.ok ? 'passed' : 'failed'} before the last change; not rerun since</Text>)}
        {ui ? <Text key="ui" dimColor wrap="wrap">Browser review: not done. Checks don't show how the page looks; open it to see.</Text> : null}
      </Box>
    )
  }

  // === DIFF ===
  if (p.view === 'diff') {
    const f = m.files.find(x => x.path === p.diff)
    const source = (f?.hunks ?? []).map(h => `@@ -${h.oldStart} +${h.newStart} @@\n${h.lines.join('\n')}`).join('\n')
    const { Code } = el
    return (
      <Box flexDirection="column" width={w}>
        <Button key="back" label="← Changes" hotkey="b" plain onPress={() => act.go('changes')} />
        <Text key="p" bold wrap="truncate-start">{p.diff}</Text>
        {f?.isNew ? <Text key="new" dimColor>New file</Text> : null}
        {source ? <Code key="d" source={source} format="diff" path={p.diff} wrap="wrap" /> : <Text key="none" dimColor>No diff kept for this file.</Text>}
      </Box>
    )
  }

  // === RECAP ===
  if (p.view === 'recap') {
    const r = p.recap
    return (
      <Box flexDirection="column" width={w}>
        {back}
        {head('h', 'Prepare a recap')}
        <Text key="t" dimColor wrap="wrap">A recap carries the goal, your preferences, decisions, progress and what's left into a fresh summary. Details it leaves out may need to be given again; a recap is not permanent memory.</Text>
        {r.status === 'idle' || r.status === 'failed' ? <Button key="draft" label="Draft a recap" hotkey="p" variant="primary" onPress={act.draft} /> : null}
        {r.status === 'failed' && r.note ? <Text key="err" color="error" wrap="wrap">{r.note}</Text> : null}
        {r.status === 'drafting' ? <Text key="busy" dimColor>Drafting…</Text> : null}
        {r.status === 'applying' ? <Text key="busy" dimColor>Summarising the conversation with this recap…</Text> : null}
        {r.status === 'applied' ? <Text key="ok" wrap="wrap">The conversation was summarised with this recap.</Text> : null}
        {r.text && r.status !== 'idle' ? rule('r1') : null}
        {r.text && r.status !== 'idle' ? <Text key="text" wrap="wrap">{r.text}</Text> : null}
        {r.status === 'ready' ? rule('r2') : null}
        {r.status === 'ready' ? <Text key="ask" dimColor wrap="wrap">Anything wrong or missing? Say it in the conversation and draft again.</Text> : null}
        {r.status === 'ready'
          ? <Box key="act" flexDirection="row" gap={2}>
              <Button key="use" label="Use this recap" hotkey="u" variant="primary" onPress={act.use} />
              <Button key="discard" label="Discard" hotkey="x" onPress={act.discard} />
            </Box>
          : null}
      </Box>
    )
  }

  // === DETAILS ===
  const u = p.usage
  const started = u?.startedAt ? new Date(u.startedAt).toLocaleString() : undefined
  const limits = u?.rateLimits ?? []
  const cost = u?.cost?.usd ?? m.cost
  return (
    <Box flexDirection="column" width={w}>
      {back}
      {head('h', 'Session details')}
      {p.model ? <Text key="model">Model: {p.model}</Text> : null}
      {started ? <Text key="start">Started: {started}</Text> : null}
      <Text key="prompts">Your messages: {m.prompts}</Text>
      <Text key="sum">Summaries so far: {m.compactions}</Text>
      {rule('r1')}
      <Text key="u-h" bold>Usage</Text>
      <Text key="ctx">Context in use: {m.context.percent == null ? 'not measured yet' : `${Math.round(m.context.percent)}%`}</Text>
      {limits.map(l => <Text key={`l-${l.kind}`}>Plan limit ({l.kind}): {Math.round(l.percentUsed)}% used{l.resetsAt ? <Text dimColor> · resets {new Date(l.resetsAt).toLocaleString()}</Text> : null}</Text>)}
      {/* money only where it means something: off a subscription, the session's cost is what the person pays */}
      {!limits.length && !m.onPlan && cost != null ? <Text key="cost">Cost so far: ${cost.toFixed(2)}</Text> : null}
      {limits.length || m.onPlan ? <Text key="plan" dimColor wrap="wrap">On a subscription: usage counts toward your plan's limits, not a per-session charge.</Text> : null}
    </Box>
  )
}

