import type { Elements, RenderChildren, SessionUsage } from 'claude-code'
import type { Check, Recap, Rerun, View } from '../types'
import { compactIn, contextLabel, splitChecks, NEARLY_FULL, segmentsOf, sparkOf, statusOf, turnsLeft, type Agent, type FileChange, type Segment, type SessionModel, type Source, type Status } from './model'

// The pane's pages as trees. Pure: everything they draw comes in through Page, and every press goes out through Act.
// Words before metrics: no token counts on the overview, a label beside every colour, nothing that animates.
// One device on every page: a section is a titled rule across the column (`── Changes ────── 2 files ──`) with a blank
// line above it, so the eye finds the blocks by their heads and the space between them. Only 'Right now' draws its rule
// heavy and in its status colour, and only when it needs a look (a failure, a question); every other rule is dim. A subpage opens with its title and the way back on one row

export type Els = Elements['terminal']
export type Act = {
  go: (v: View) => void
  help: () => void
  diff: (path: string) => void
  draft: () => void
  use: () => void
  discard: () => void
  rerun: () => void
}
export type Page = { m: SessionModel; view: View; help: boolean; diff: string; recap: Recap; rerun: Rerun; cols: number; usage?: SessionUsage; model?: string }

const MAX_LIST = 8 // per group on a detail page; the rest is counted
const MAX_FILES = 20 // on the Changes page: more than a list one reads; the rest is counted
const MAX_AGENTS_NOW = 4 // running subagents named under Right now; the rest is counted
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const len = (s: string) => [...s].length
// a path cut from the left, so the file name stays: …/src/components/confirm.tsx
const tail = (p: string, n: number) => p.length <= n ? p : `…${p.slice(p.length - n + 1)}`
// the folder every path shares, so the list shows what differs: '/w/src' for /w/src/a.ts and /w/src/b/c.ts
const commonDir = (paths: string[]) => {
  const parts = paths.map(p => p.split('/').slice(0, -1))
  const first = parts[0] ?? []
  let n = 0
  while (n < first.length && parts.every(p => p[n] === first[n])) n++
  return first.slice(0, n).join('/')
}

// The status mark and its colour; the label beside it always says the same in words
const MARK: Record<Status['kind'], [string, string | undefined]> = {
  new: ['○', undefined], working: ['●', 'claude'], input: ['?', 'warning'], failed: ['✗', 'error'], review: ['○', undefined], idle: ['○', undefined],
}

const NOTE: Record<Source['note'], string> = {
  full: 'full file', excerpt: 'excerpt', earlier: 'read before the summary; may need re-reading', unrestored: 'not restored after the summary',
  changed: 'changed on disk since it was read', loaded: 'loaded', summary: 'summary of earlier messages',
}

const HELP: Record<string, string> = {
  goal: 'What this session is for, condensed from your messages while this pane is open. To change it, say so in the conversation.',
  now: 'Shown only when something needs you: a question waiting, a failed check, or subagents still running.',
  context: 'How much of the space for this conversation is in use. When it fills, older details get summarised.',
  changes: 'Files Claude changed in this session, and whether checks such as tests passed since the last change or need rerunning.',
}

// rate-limit windows by the engine's kind; one not listed shows its kind with spaces
const AGENT: Record<Agent['status'], string> = { running: 'Running', done: 'Finished', stopped: 'Stopped' }
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

// how full the context is, in words after the figure: '62% used, filling up'
const usedLine = (percent?: number) => percent == null ? '' : `${Math.round(percent)}% used, ${contextLabel(percent).label.toLowerCase()}`

const UI_FILE = /\.(tsx|jsx|vue|svelte|css|scss|html)$/

// Items joined by ' · ' on one line of the width, as many as fit whole; the rest counted (`a · b +2`)
export function fitList(items: string[], width: number): string {
  for (let n = items.length; n > 1; n--) {
    const s = items.slice(0, n).join(' · ') + (n < items.length ? ` +${items.length - n}` : '')
    if (len(s) <= width) return s
  }
  return items.length > 1 ? `${items[0]} +${items.length - 1}` : items[0] ?? ''
}

// Shares of a width in whole cells, by largest remainder: rounded one by one, four runs can sum past the width and push a
// cell onto the next row. Never more than the width in all
export function cells(shares: number[], width: number): number[] {
  const raw = shares.map(s => Math.max(0, s) * width)
  const out = raw.map(Math.floor)
  let left = Math.min(width, Math.round(raw.reduce((a, b) => a + b, 0))) - out.reduce((a, b) => a + b, 0)
  for (const i of raw.map((_, i) => i).sort((a, b) => (raw[b]! % 1) - (raw[a]! % 1))) { if (left-- <= 0) break; out[i]!++ }
  return out
}

export function draw(el: Els, p: Page, act: Act) {
  const { Box, Text, Button } = el
  const w = Math.max(1, p.cols) // no floor of our own: a wider tree than the body would spill

  // A section's head: `── Title ───── right ──`, filled to the column from w. The right-hand value goes first when the
  // two don't fit, then the title is cut; never a wrapped rule. swatch: a coloured square before the title (a legend)
  type Rule = { right?: string; color?: string; heavy?: boolean; swatch?: string; rightColor?: string }
  const bareOf = (title: string, o: Rule) => 3 + (o.swatch ? 2 : 0) + len(title) + 1
  // whether a right-hand value fits on the rule; a caller whose value must show puts it in the body when not
  const fits = (title: string, o: Rule) => !!o.right && w - bareOf(title, o) - (len(o.right) + 4) >= 2
  const section = (k: string, title: string, o: Rule = {}) => {
    const ch = o.heavy ? '━' : '─'
    const bare = bareOf(title, o)
    const right = fits(title, o) ? o.right : undefined
    const fill = Math.max(2, w - bare - (right ? len(right) + 4 : 0))
    const line = { color: o.color, dimColor: !o.color }
    return (
      <Text key={k} wrap="truncate-end">
        <Text {...line}>{ch.repeat(2)} </Text>
        {o.swatch ? <Text color={o.swatch}>■ </Text> : null}
        <Text bold>{title}</Text>
        <Text {...line}> {ch.repeat(fill)}</Text>
        {right ? <Text color={o.rightColor} dimColor={!o.rightColor}> {right} </Text> : null}
        {right ? <Text {...line}>{ch.repeat(2)}</Text> : null}
      </Text>
    )
  }
  // a block: its head, its help line when help is on, its body
  const block = (k: string, title: string, body: RenderChildren[], o: Rule = {}) => (
    <Box key={k} flexDirection="column">
      {section(`${k}-h`, title, o)}
      {p.help && HELP[k] ? <Text key={`${k}-help`} dimColor italic wrap="wrap">{HELP[k]}</Text> : null}
      {body}
    </Box>
  )
  // a subpage's first row: its title, and the way back at the far end
  const top = (title: string, to: View = 'overview', toLabel = 'Overview') => (
    <Box key="top" flexDirection="row" justifyContent="space-between" width={w}>
      <Text key="t" bold wrap="truncate-end">{title}</Text>
      <Button key="back" label={`← ${toLabel}`} hotkey="b" plain onPress={() => act.go(to)} />
    </Box>
  )
  const bar = (k: string, runs: { n: number; color?: string }[], width: number) => {
    const used = runs.reduce((s, r) => s + r.n, 0)
    return (
      <Text key={k}>
        {runs.filter(r => r.n > 0).map((r, i) => <Text key={`${k}${i}`} color={r.color}>{'█'.repeat(r.n)}</Text>)}
        <Text dimColor>{'░'.repeat(Math.max(0, width - used))}</Text>
      </Text>
    )
  }
  // one check, the same mark and words on every page; full adds what failed under a failure
  const check = (c: Check, stale: boolean, full: boolean) => stale
    ? <Text key={`s-${c.name}`} wrap="wrap"><Text color="warning">–</Text> <Text dimColor>{c.name} {c.ok ? 'passed' : 'failed'} before the last change; rerun needed</Text></Text>
    : <Box key={`c-${c.name}`} flexDirection="column">
        <Text key="l" wrap="wrap"><Text color={c.ok ? 'success' : 'error'}>{c.ok ? '✓' : '✗'}</Text> {c.name} {c.ok ? 'passed' : 'failed'}</Text>
        {!c.ok && full && c.line ? <Box key="f" paddingLeft={2}><Text dimColor wrap="wrap">{c.line}</Text></Box> : null}
      </Box>

  const m = p.m
  const st = statusOf(m)
  const ctx = contextLabel(m.context.percent)
  const nearly = (m.context.percent ?? 0) >= NEARLY_FULL
  const { fresh, stale } = splitChecks(m)
  const used = usedLine(m.context.percent)
  // the turns-left estimate in words; nothing at all when there is no estimate
  const left = turnsLeft(m)
  const compactLine = left == null ? null
    : <Text key="turns" color={left <= 2 ? 'warning' : undefined} dimColor={left > 2}>{compactIn(left)}</Text>
  const running = m.agents.filter(a => a.status === 'running')
  const recapButton = nearly ? <Button key="recap" label="Prepare a recap" hotkey="p" variant="primary" onPress={() => act.go('recap')} /> : null

  // === OVERVIEW ===
  // Goal, then what needs you (only when something does), then what changed and whether it is verified (what a review
  // needs, together), then context. Each block ends in the one press that opens its page
  if (p.view === 'overview') {
    const [mark, color] = MARK[st.kind]
    const loud = st.kind === 'input' || st.kind === 'failed' // working is the usual state: lit, it would dull these two
    const filled = m.context.percent == null ? 0 : Math.max(1, Math.round((m.context.percent / 100) * w))
    return (
      <Box flexDirection="column" width={w} gap={1}>
        {/* two lines at most: the title, and the constraints on one dim line. A draft says so on the rule, not in a line of
            its own; what finished looks like goes to a recap, not here */}
        {block('goal', 'Goal', m.goal
          ? [<Text key="goal-t" bold wrap="wrap">{m.goal.title}</Text>,
            m.goal.keep.length ? <Text key="goal-k" dimColor wrap="truncate-end">{fitList(m.goal.keep.map(k => k.text), w)}</Text> : null]
          : [<Text key="goal-none" dimColor wrap="wrap">Your goal appears here after your first message.</Text>],
        { right: m.goal?.isDraft ? 'draft' : undefined })}
        {/* only what needs you: a question, a failure, subagents still running. What Claude is doing and what's next are
            the spinner's and the todo list's to show. Only a failure or a question lights the rule */}
        {loud || running.length ? block('now', 'Right now', [
          <Text key="now-l" wrap="wrap"><Text color={color}>{mark}</Text> <Text bold>{st.label}</Text></Text>,
          loud && st.detail ? <Box key="now-d" paddingLeft={2}><Text wrap="wrap">{st.detail}</Text></Box> : null,
          st.kind === 'input' ? <Box key="now-a" paddingLeft={2}><Text dimColor>Answer in the dialog</Text></Box> : null,
          // subagents: what each is doing, no token counts (those are on Session details)
          ...running.slice(0, MAX_AGENTS_NOW).map(a => <Box key={`ag-${a.id}`} paddingLeft={2}><Text wrap="truncate-end"><Text color="claude">◐</Text> {a.name}<Text dimColor>{a.doing ? ` · ${a.doing}` : ''}</Text></Text></Box>),
          running.length > MAX_AGENTS_NOW ? <Box key="ag-more" paddingLeft={2}><Text dimColor>and {running.length - MAX_AGENTS_NOW} more agents</Text></Box> : null,
        ], loud ? { color, heavy: true } : {}) : null}
        {block('changes', 'Changes', m.files.length
          ? [...fresh.map(c => check(c, false, false)),
            ...stale.map(c => check(c, true, false)),
            !m.checks.length ? <Text key="chk-none" dimColor>Checks haven't run yet</Text> : null,
            <Button key="chg" label="Review changes" hotkey="r" plain onPress={() => act.go('changes')} />]
          : [<Text key="chg-none" dimColor>No files changed yet</Text>],
        { right: m.files.length ? plural(m.files.length, 'file') : undefined })}
        {/* no colour until nearly full, so a near-empty bar reads as no warning; the bar takes the whole column */}
        {block('context', 'Context', [
          used && !fits('Context', { right: used }) ? <Text key="ctx-u" color={nearly ? 'warning' : undefined}>{used}</Text> : null,
          m.context.percent == null ? <Text key="ctx-t" dimColor wrap="wrap">{ctx.text}</Text> : bar('ctx-bar', [{ n: filled, color: nearly ? 'warning' : undefined }], w),
          compactLine,
          nearly ? <Text key="ctx-n" dimColor wrap="wrap">{ctx.text}</Text> : null,
          recapButton,
          <Button key="ctx" label="What's included" hotkey="c" plain onPress={() => act.go('context')} />,
        ], { right: used || undefined, rightColor: nearly ? 'warning' : undefined })}
        <Box key="foot" flexDirection="column">
          <Text key="foot-r" dimColor>{'─'.repeat(w)}</Text>
          <Box key="foot-b" flexDirection="row" flexWrap="wrap" columnGap={3}>
            <Button key="details" label="Session details" hotkey="d" plain onPress={() => act.go('details')} />
            <Button key="help" label={p.help ? 'Hide help' : 'Show help'} hotkey="h" plain onPress={act.help} />
          </Box>
        </Box>
      </Box>
    )
  }

  // === CONTEXT ===
  if (p.view === 'context') {
    const window = p.usage?.context.window ?? m.context.window
    const rows = p.usage?.context.breakdown?.categories
    const seg = segmentsOf(m.est, rows)
    const share = (n: number) => window ? n / window : 0
    const runs = cells(seg.segments.map(s => share(s.tokens)), w).map((n, i) => ({ n, color: seg.segments[i]!.color }))
    const pct = (n: number) => `${Math.round(share(n) * 100)}%`
    const group = (g: Source['group']) => m.sources.filter(s => s.group === g)
    // one group: a section whose head is its legend (colour, name, share), its sources listed under it
    const list = (k: string, s: Segment | undefined, items: Source[], first?: string) => {
      if (!s) return null
      const shown = items.slice(0, MAX_LIST)
      return (
        <Box key={k} flexDirection="column">
          {section(`${k}-h`, `${s.name}${s.isEstimate ? ' (estimate)' : ''}`, rows ? { swatch: s.color, right: pct(s.tokens) } : {})}
          {first ? <Text key={`${k}-0`} dimColor wrap="wrap">{first}</Text> : null}
          {/* label and note on one line when both fit, else the note goes under it: a path cut to fit a long note says nothing */}
          {shown.flatMap(x => len(x.label) + len(NOTE[x.note]) + 3 <= w
            ? [<Text key={`${k}-${x.key}`}>{x.label} <Text dimColor>({NOTE[x.note]})</Text></Text>]
            : [<Text key={`${k}-${x.key}`}>{tail(x.label, w)}</Text>, <Box key={`${k}-${x.key}-n`} paddingLeft={2}><Text dimColor wrap="wrap">{NOTE[x.note]}</Text></Box>])}
          {items.length > shown.length ? <Text key={`${k}-more`} dimColor>and {items.length - shown.length} more</Text> : null}
          {!items.length && !first ? <Text key={`${k}-none`} dimColor>None yet</Text> : null}
        </Box>
      )
    }
    const segment = (name: string) => seg.segments.find(s => s.name === name)
    const spark = sparkOf(m)
    const confidence = seg.confidence === 'close'
      ? `The split is an estimate from what this pane saw; it matches the engine's own total within ${Math.max(1, Math.round((seg.gap ?? 0) * 100))}%.`
      : seg.confidence === 'rough'
        ? "The split is a rough estimate: it differs from the engine's own total by more than a quarter, often because some of the conversation came before this pane loaded. The total is the engine's."
        : 'The split appears after the first response.'
    return (
      <Box flexDirection="column" width={w} gap={1}>
        {top('Context')}
        <Box key="fill" flexDirection="column">
          <Text key="u" bold color={nearly ? 'warning' : undefined}>{used || ctx.label}</Text>
          {rows ? bar('bar', runs, w) : null}
          {compactLine}
          {spark ? <Text key="spark" color={nearly ? 'warning' : undefined}>{spark}</Text> : null}
          {spark ? <Text key="spark-t" dimColor wrap="wrap">How full it was after each turn since the last summary; full height is where summarising starts.</Text> : null}
          <Text key="t" dimColor wrap="wrap">{ctx.text} What's listed is available for the next response; reading a file once does not mean all of it stays available.</Text>
          {recapButton}
        </Box>
        {list('i', segment('Instructions'), group('instructions'), "Claude Code's built-in instructions and tool descriptions")}
        {list('c', segment('Conversation'), group('conversation'), m.prompts ? `Your ${plural(m.prompts, 'message')} and Claude's replies${m.compactions ? ' since the last summary' : ''}` : undefined)}
        {list('f', segment('Files and references'), group('files'))}
        {list('r', segment('Tool results'), [], 'Output of commands, searches and other tools Claude ran.')}
        {m.summary
          ? <Box key="sum" flexDirection="column">
              {section('sum-h', 'Carried forward in the summary')}
              <Text key="sum" wrap="wrap" dimColor>{m.summary.split('\n').slice(0, 8).join('\n')}</Text>
            </Box>
          : null}
        <Text key="conf" dimColor italic wrap="wrap">{confidence}</Text>
      </Box>
    )
  }

  // === CHANGES ===
  if (p.view === 'changes') {
    const ui = m.files.some(f => UI_FILE.test(f.path))
    // paths under the folder they share, named once above the list; one file keeps its whole path
    const dir = m.files.length > 1 ? commonDir(m.files.map(f => f.path)) : ''
    const rel = (path: string) => dir ? path.slice(dir.length + 1) : path
    const row = (f: FileChange) => {
      const by = f.byShell ? ' (by a command)' : ''
      const label = `${f.isNew ? 'New   ' : 'Edited'}  ${tail(rel(f.path), Math.max(12, w - 8 - by.length))}${by}`
      return f.hunks?.length
        ? <Button key={`f-${f.path}`} label={label} plain onPress={() => act.diff(f.path)} />
        : <Text key={`f-${f.path}`} dimColor wrap="truncate-end">{label}</Text>
    }
    return (
      <Box flexDirection="column" width={w} gap={1}>
        {top('Changes')}
        <Box key="files" flexDirection="column">
          {section('files-h', 'Files', { right: m.files.length ? plural(m.files.length, 'file') : undefined })}
          {dir ? <Text key="dir" dimColor wrap="truncate-start">in {dir}</Text> : null}
          {m.files.slice(0, MAX_FILES).map(row)}
          {m.files.length > MAX_FILES ? <Text key="more" dimColor>and {m.files.length - MAX_FILES} more</Text> : null}
          {!m.files.length ? <Text key="none" dimColor>No files changed yet</Text> : m.files.some(f => f.hunks?.length) ? <Text key="t" dimColor wrap="wrap">Select a file for its diff.</Text> : null}
        </Box>
        {/* whether the changes are verified is this block's to say */}
        <Box key="checks" flexDirection="column">
          {section('c-h', 'Checks')}
          {!m.checks.length ? <Text key="c-none" dimColor>{m.files.length ? "Checks haven't run yet" : 'None run yet'}</Text> : null}
          {fresh.map(c => check(c, false, true))}
          {stale.map(c => check(c, true, true))}
          {/* only a command kept exactly as run, and never mid-turn: a rerun while Claude edits measures nothing */}
          {stale.some(c => c.canRerun) && !m.running
            ? p.rerun.busy ? <Text key="c-busy" dimColor>Rerunning…</Text> : <Button key="rerun" label="Rerun stale checks" hotkey="e" onPress={act.rerun} />
            : null}
          {p.rerun.note && !m.checks.some(c => c.t > (p.rerun.at ?? 0)) ? <Text key="c-note" color="error" wrap="wrap">{p.rerun.note}</Text> : null}
        </Box>
        {ui
          ? <Box key="ui" flexDirection="column">
              {section('ui-h', 'Browser review')}
              <Text key="ui-t" dimColor wrap="wrap">Not done. Checks don't show how the page looks; open it to see.</Text>
            </Box>
          : null}
      </Box>
    )
  }

  // === DIFF ===
  if (p.view === 'diff') {
    const f = m.files.find(x => x.path === p.diff)
    const hunks = f?.hunks ?? []
    const source = hunks.map(h => `${hunkHead(h)}\n${h.lines.join('\n')}`).join('\n')
    const count = (mark: string) => hunks.reduce((s, h) => s + h.lines.filter(l => l[0] === mark).length, 0)
    const { Code } = el
    return (
      <Box flexDirection="column" width={w} gap={1}>
        {top(p.diff.split('/').pop() || p.diff, 'changes', 'Changes')}
        <Box key="d" flexDirection="column">
          {section('d-h', f?.isNew ? 'New file' : 'Edited', { right: source ? `${count('+')} added, ${count('-')} removed` : undefined })}
          <Text key="p" dimColor wrap="truncate-start">{p.diff}</Text>
          {source ? <Code key="code" source={source} format="diff" path={p.diff} wrap="wrap" /> : <Text key="none" dimColor>No diff kept for this file.</Text>}
        </Box>
      </Box>
    )
  }

  // === RECAP ===
  if (p.view === 'recap') {
    const r = p.recap
    const { Markdown } = el
    return (
      <Box flexDirection="column" width={w} gap={1}>
        {top('Prepare a recap')}
        <Box key="intro" flexDirection="column">
          <Text key="t" dimColor wrap="wrap">A recap carries the goal, your preferences, decisions, progress and what's left into a fresh summary. Details it leaves out may need to be given again; a recap is not permanent memory.</Text>
          {r.status === 'idle' || r.status === 'failed' ? <Button key="draft" label="Draft a recap" hotkey="d" variant="primary" onPress={act.draft} /> : null}
          {r.status === 'failed' && r.note ? <Text key="err" color="error" wrap="wrap">{r.note}</Text> : null}
          {r.status === 'drafting' ? <Text key="busy" dimColor>Drafting…</Text> : null}
        </Box>
        {r.text && r.status !== 'idle'
          ? <Box key="draft-b" flexDirection="column">
              {section('r-h', 'Draft', { right: r.status === 'applying' ? 'summarising' : r.status === 'applied' ? 'used' : undefined })}
              <Markdown key="text" text={r.text} />
            </Box>
          : null}
        {r.status === 'applying' ? <Text key="busy" dimColor>Summarising the conversation with this recap…</Text> : null}
        {r.status === 'applied' ? <Text key="ok" wrap="wrap">The conversation was summarised with this recap.</Text> : null}
        {r.status === 'ready'
          ? <Box key="act" flexDirection="column">
              <Text key="ask" dimColor wrap="wrap">Anything wrong or missing? Say it in the conversation and draft again.</Text>
              <Box key="btn" flexDirection="row" gap={2}>
                <Button key="use" label="Use this recap" hotkey="u" variant="primary" onPress={act.use} />
                <Button key="discard" label="Discard" hotkey="x" onPress={act.discard} />
              </Box>
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
    <Box flexDirection="column" width={w} gap={1}>
      {top('Session details')}
      <Box key="s" flexDirection="column">
        {section('s-h', 'Session')}
        {p.model ? kv('model', 'Model', p.model) : null}
        {u?.startedAt ? kv('start', 'Started', ago(u.startedAt)) : null}
        {kv('prompts', 'Messages', `${m.prompts}${m.compactions ? ` (${plural(m.compactions, 'summary', 'summaries')})` : ''}`)}
      </Box>
      <Box key="u" flexDirection="column">
        {section('u-h', 'Usage')}
        {kv('ctx', 'Context', m.context.percent == null ? 'not measured yet' : `${Math.round(m.context.percent)}% used`)}
        {limits.map(l => kv(`l-${l.kind}`, LIMIT[l.kind] ?? l.kind.replace(/_/g, ' '), <Text>{Math.round(l.percentUsed)}% used{l.resetsAt ? <Text dimColor>, resets {ago(Date.parse(l.resetsAt))}</Text> : null}</Text>))}
        {/* money only where it means something: off a subscription, the session's cost is what the person pays */}
        {!limits.length && !m.onPlan && cost != null ? kv('cost', 'Cost', `$${cost.toFixed(2)} so far`) : null}
      </Box>
      {m.agents.length
        ? <Box key="a" flexDirection="column">
            {section('a-h', 'Subagents', { right: plural(m.agents.length, 'agent') })}
            {m.agents.slice(0, MAX_LIST).map(a => (
              <Box key={`a-${a.id}`} flexDirection="column">
                <Text key="n" wrap="truncate-end">{a.name}{a.type && a.type !== a.name ? <Text dimColor> ({a.type})</Text> : null}</Text>
                <Box key="d" paddingLeft={2}><Text dimColor wrap="wrap">{AGENT[a.status]}, {plural(a.calls, 'tool call')}{a.tokens ? `, ${Math.round(a.tokens / 1000)}k tokens` : ''}{a.status === 'running' && a.doing ? ` · ${a.doing}` : ''}</Text></Box>
              </Box>
            ))}
            {m.agents.length > MAX_LIST ? <Text key="a-more" dimColor>and {m.agents.length - MAX_LIST} more</Text> : null}
          </Box>
        : null}
    </Box>
  )
}
