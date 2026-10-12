import type { Elements, RenderChildren, SessionUsage } from 'claude-code'
import type { Recap, View } from '../types'
import { checksOf, contextLabel, NEARLY_FULL, segmentsOf, statusOf, type FileChange, type Segment, type SessionModel, type Source, type Status } from './model'

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

// rate-limit windows by the engine's kind; one not listed shows its kind with spaces
const LIMIT: Record<string, string> = { five_hour: '5-hour limit', seven_day: 'Weekly limit', spend_limit: 'Spend limit' }
// a time as words relative to now ('2 hours ago', 'in 1 hour'): a full date makes you do the sum
const ago = (t: number) => {
  const min = Math.round((t - Date.now()) / 60_000)
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
  return Math.abs(min) < 60 ? rtf.format(min, 'minute') : Math.abs(min) < 48 * 60 ? rtf.format(Math.round(min / 60), 'hour') : rtf.format(Math.round(min / 1440), 'day')
}
// Code's diff format parses only `@@ -a,b +c,d @@` headers; without the counts the hunk is drawn as plain, uncoloured text
const hunkHead = (h: { oldStart: number; newStart: number; lines: string[] }) => {
  const n = (marks: string) => h.lines.filter(l => marks.includes(l[0] ?? '')).length
  return `@@ -${h.oldStart},${n(' -')} +${h.newStart},${n(' +')} @@`
}

const UI_FILE =/\.(tsx|jsx|vue|svelte|css|scss|html)$/

export function draw(el: Els, p: Page, act: Act) {
  const { Box, Text, Button } = el
  const w = Math.max(24, p.cols)
  const back = <Button key="back" label="← Session overview" hotkey="b" plain onPress={() => act.go('overview')} />
  // a blank line between blocks: a drawn rule every few lines packed the text tighter, not apart
  const rule = (k: string) => <Text key={k}> </Text>
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
    // each section: its heading flush left, its body indented under it, a blank line before the next
    const section = (k: string, title: string, body: RenderChildren[], right?: string) => (
      <Box key={k} flexDirection="column">
        {head(`${k}-h`, title, right)}
        <Box key={`${k}-b`} flexDirection="column" paddingLeft={2}>{helpLine(k)}{body}</Box>
      </Box>
    )
    return (
      <Box flexDirection="column" width={w} gap={1}>
        {section('goal', 'Your goal', [m.goal
          ? <Button key="goal" label={`${m.goal.title} ›`} hotkey="g" plain onPress={() => act.go('goal')} />
          : <Text key="goal-none" dimColor wrap="wrap">Your goal appears here after your first message.</Text>])}
        {section('now', 'Right now', [
          <Text key="now"><Text color={color}>{mark}</Text> <Text bold>{st.label}</Text></Text>,
          // a review's detail is the button under it in other words
          st.detail && st.kind !== 'review' ? <Text key="now-d" wrap="wrap">{st.detail}</Text> : null,
          st.kind === 'input' ? <Text key="now-a" dimColor>Answer in the dialog</Text> : null,
          st.next ? <Text key="now-n" dimColor wrap="truncate-end">Next: {st.next}</Text> : null,
          st.kind === 'review' ? <Button key="review" label="Review changes ›" hotkey="r" variant="primary" onPress={() => act.go('changes')} /> : null,
        ])}
        {section('context', 'Context', [
          bar('ctx-bar', [{ n: filled, color: nearly ? 'warning' : 'claude' }], bw),
          // the 'Plenty of room' and 'Filling up' texts only restate the heading; the context page keeps them
          m.context.percent == null || nearly ? <Text key="ctx-t" dimColor wrap="wrap">{ctx.text}</Text> : null,
          nearly ? <Button key="recap" label="Prepare a recap" hotkey="p" variant="primary" onPress={() => act.go('recap')} /> : null,
          <Button key="ctx" label="What's included ›" hotkey="c" plain onPress={() => act.go('context')} />,
        ], m.context.percent == null ? ctx.label : `${ctx.label} · ${Math.round(m.context.percent)}%`)}
        {section('changes', 'Changes so far', [
          m.files.length
            ? <Button key="chg" label={`${plural(m.files.length, 'file')} changed ›`} hotkey="f" plain onPress={() => act.go('changes')} />
            : <Text key="chg-none" dimColor>No files changed yet</Text>,
          // a failed check already heads 'Right now'
          checks.line && st.kind !== 'failed' ? <Text key="chk" color={checks.line.endsWith('failed') ? 'error' : undefined} dimColor={checks.stale}>{checks.line}</Text> : null,
        ])}
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
        {/* not bold: two bold lines back to back read as one heading */}
        {g ? <Text key="t" color="claude" wrap="wrap">{g.title}</Text> : null}
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
    // one group: its legend row (colour, name, share) is its heading, its sources listed under it
    const list = (k: string, s: Segment | undefined, items: Source[], first?: string) => {
      const shown = items.slice(0, MAX_LIST)
      if (!s) return null
      return (
        <Box key={k} flexDirection="column">
          <Text key={`${k}-h`}>{rows ? <Text color={s.color}>█ </Text> : null}<Text bold>{s.name}{s.isEstimate ? ' (estimate)' : ''}</Text>{rows ? <Text dimColor>  {pct(s.tokens)}</Text> : null}</Text>
          <Box key={`${k}-b`} flexDirection="column" paddingLeft={2}>{[
        ...(first ? [<Text key={`${k}-0`} dimColor wrap="wrap">{first}</Text>] : []),
        // label and note on one line when both fit, else the note goes under it: a path cut to fit a long note says nothing
        ...shown.flatMap(x => x.label.length + NOTE[x.note].length + 3 <= w - 2
          ? [<Text key={`${k}-${x.key}`}>{x.label} <Text dimColor>· {NOTE[x.note]}</Text></Text>]
          : [<Text key={`${k}-${x.key}`}>{tail(x.label, w - 2)}</Text>, <Text key={`${k}-${x.key}-n`} dimColor wrap="wrap">  {NOTE[x.note]}</Text>]),
        ...(items.length > shown.length ? [<Text key={`${k}-more`} dimColor>and {items.length - shown.length} more</Text>] : []),
        ...(!items.length && !first ? [<Text key={`${k}-none`} dimColor>None yet</Text>] : []),
          ]}</Box>
        </Box>
      )
    }
    const segment = (name: string) => seg.segments.find(s => s.name === name)
    const confidence = seg.confidence === 'close'
      ? `The split is an estimate from what this pane saw; it matches the engine's own total within ${Math.max(1, Math.round((seg.gap ?? 0) * 100))}%.`
      : seg.confidence === 'rough'
        ? "The split is a rough estimate: it differs from the engine's own total by more than a quarter, often because some of the conversation came before this pane loaded. The total is the engine's."
        : 'The split appears after the first response.'
    return (
      <Box flexDirection="column" width={w} gap={1}>
        <Box key="top" flexDirection="column">
          {back}
          {head('h', 'Context', m.context.percent == null ? ctx.label : `${ctx.label} · ${Math.round(m.context.percent)}%`)}
          <Text key="t" dimColor wrap="wrap">{ctx.text}</Text>
          {rows ? bar('bar', runs, bw) : null}
          {nearly ? <Button key="recap" label="Prepare a recap" hotkey="p" variant="primary" onPress={() => act.go('recap')} /> : null}
        </Box>
        <Text key="inc-t" dimColor wrap="wrap">What's included: available for the next response. Reading a file once does not mean all of it stays available.</Text>
        {list('i', segment('Instructions'), group('instructions'), "Claude Code's built-in instructions and tool descriptions")}
        {list('c', segment('Conversation'), group('conversation'), m.prompts ? `Your ${plural(m.prompts, 'message')} and Claude's replies${m.compactions ? ' since the last summary' : ''}` : undefined)}
        {list('f', segment('Files and references'), group('files'))}
        {list('r', segment('Tool results'), [], 'Output of commands, searches and other tools Claude ran.')}
        <Text key="conf" dimColor wrap="wrap">{confidence}</Text>
        {m.summary
          ? <Box key="sum" flexDirection="column">
              <Text key="sum-h" bold>Carried forward in the summary</Text>
              <Text key="sum" wrap="wrap" dimColor>{m.summary.split('\n').slice(0, 8).join('\n')}</Text>
            </Box>
          : null}
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
        {/* whether the changes are verified is the Checks block's to say */}
        {m.files.length ? <Text key="t" dimColor wrap="wrap">Select a file for its diff.</Text> : <Text key="none" dimColor>No files changed yet</Text>}
        {m.files.map(row)}
        {rule('r1')}
        <Text key="c-h" bold>Checks</Text>
        {!m.checks.length ? <Text key="c-none" dimColor>{m.files.length ? "Checks haven't run yet" : 'None run yet'}</Text> : null}
        {fresh.map(c => <Text key={`c-${c.name}`} wrap="wrap"><Text color={c.ok ? 'success' : 'error'}>{c.ok ? '✓' : '✗'}</Text> {c.name} {c.ok ? 'passed' : 'failed'}{c.ok ? '' : `\n${c.line}`}</Text>)}
        {stale.map(c => <Text key={`s-${c.name}`} dimColor wrap="wrap">– {c.name} {c.ok ? 'passed' : 'failed'} before the last change; not rerun since</Text>)}
        {ui ? rule('r2') : null}
        {ui ? <Text key="ui" dimColor wrap="wrap">Browser review: not done. Checks don't show how the page looks; open it to see.</Text> : null}
      </Box>
    )
  }

  // === DIFF ===
  if (p.view === 'diff') {
    const f = m.files.find(x => x.path === p.diff)
    const source = (f?.hunks ?? []).map(h => `${hunkHead(h)}\n${h.lines.join('\n')}`).join('\n')
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
  const limits = u?.rateLimits ?? []
  const cost = u?.cost?.usd ?? m.cost
  // a dim label column and the value beside it: the label is read once, the value is what changes
  const kv = (k: string, label: string, value: RenderChildren) => (
    <Box key={k} flexDirection="row">
      <Box key="l" width={14} flexShrink={0}><Text dimColor>{label}</Text></Box>
      <Text key="v" wrap="wrap">{value}</Text>
    </Box>
  )
  return (
    <Box flexDirection="column" width={w}>
      {back}
      {head('h', 'Session details')}
      {p.model ? kv('model', 'Model', p.model) : null}
      {u?.startedAt ? kv('start', 'Started', ago(u.startedAt)) : null}
      {kv('prompts', 'Messages', `${m.prompts}${m.compactions ? ` · ${plural(m.compactions, 'summary', 'summaries')}` : ''}`)}
      {rule('r1')}
      <Text key="u-h" bold>Usage</Text>
      {kv('ctx', 'Context', m.context.percent == null ? 'not measured yet' : `${Math.round(m.context.percent)}% in use`)}
      {limits.map(l => kv(`l-${l.kind}`, LIMIT[l.kind] ?? l.kind.replace(/_/g, ' '), <Text>{Math.round(l.percentUsed)}% used{l.resetsAt ? <Text dimColor> · resets {ago(Date.parse(l.resetsAt))}</Text> : null}</Text>))}
      {/* money only where it means something: off a subscription, the session's cost is what the person pays */}
      {!limits.length && !m.onPlan && cost != null ? kv('cost', 'Cost', `$${cost.toFixed(2)} so far`) : null}
    </Box>
  )
}

