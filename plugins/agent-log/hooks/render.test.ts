// The pane over a seeded two-turn session, drawn as text: what the review read at 100×60 and 60×20. Each test sets the
// module's state (level, view) back before it ends, as agent-log.test.ts's pane tests do.
import { test, expect, mock } from 'claude-code/testing'

const DUMP = false // true prints every frame, for a visual pass (the test sandbox sees no env vars)

// a rough text frame of the mounted tree: rows are the root Box's children; fixed-width boxes padded, the first grow box fills.
// `*x*` marks a bright Button, `‹color:x›` coloured text
const txt = (el: any): string => {
  if (typeof el === 'string') return el
  if (!el) return ''
  if (el.type === 'Button') {
    const lab = String(el.props?.label ?? el.text ?? '')
    const s = el.props?.plain ? (el.props?.hotkey ? `${el.props.hotkey}: ${lab}` : lab) : `[ ${lab} ]`
    return el.props?.dimColor ? s : `*${s}*`
  }
  if (el.type === 'Text') {
    const s = (el.children ?? []).map(txt).join('')
    return el.props?.color ? `‹${el.props.color}:${s}›` : s
  }
  return (el.children ?? []).map(txt).join('')
}
const visLen = (s: string) => s.replace(/[*]|‹\w+:|›/g, '').length
const row = (el: any, width: number): string => {
  if (el?.type !== 'Box' || el.props?.flexDirection !== 'row') return txt(el)
  const segs = (el.children ?? []).map((k: any) => {
    let s = k?.type === 'Box' && k.props?.flexDirection === 'row' && !k.props?.width ? row(k, width) : txt(k)
    const w = k?.props?.width
    if (typeof w === 'number') { const pad = Math.max(0, w - visLen(s)); s = k.props?.justifyContent === 'flex-end' ? ' '.repeat(pad) + s : s + ' '.repeat(pad) }
    return { s, grow: !!k?.props?.flexGrow }
  })
  const gap = el.props?.columnGap ?? 0
  const used = segs.reduce((n: number, x: any) => n + visLen(x.s), 0) + gap * Math.max(0, segs.length - 1)
  const g = segs.find((x: any) => x.grow)
  if (g && used < width) g.s += ' '.repeat(width - used)
  return segs.map((x: any) => x.s).join(' '.repeat(gap))
}
// the pane's lines, top to bottom; the inspector's and the setup page's column counted row by row
const frame = async (m: any, cols: number, label: string): Promise<string[]> => {
  const root = await m.find({ type: 'Box' })
  const lines: string[] = (root.children ?? []).flatMap((c: any) => c?.type === 'Box' && c.props?.flexDirection === 'column' ? c.children : [c]).map((c: any) => row(c, cols))
  if (DUMP) (globalThis as any).console.log(`\n===== ${label} (${cols} cols) =====\n┌${'─'.repeat(cols)}┐\n${lines.map(l => `│${l}`).join('\n')}\n└${'─'.repeat(cols)}┘`)
  return lines
}
const plainOf = (l: string) => l.replace(/[*]|‹\w+:|›/g, '')
const ruleAt = (lines: string[]) => lines.findIndex(l => /^─+$/.test(plainOf(l))) // the header's last row

// the review's session: setup hooks, a turn of calls with their hooks (a failed test run that waited on you, a refusal, a lint
// block, calls outside the root), then a turn with a subagent, the engine's own request, a model switch and two problems
const seed = () => {
  const T = Date.now() - 20 * 60000
  let use = 0
  const tool = (t: number, turn: number, name: string, detail: string, extra: object = {}) => ({ t: T + t, turn, kind: 'tool', name, detail, outcome: 'ok', status: 'ok', ms: 40, use: `u${++use}`, ...extra })
  const hook = (t: number, turn: number, name: string, origin: string, detail: string, extra: object = {}) => ({ t: T + t, turn, kind: 'hook', name, origin, detail, outcome: '', src: 'hook', ms: 60, ...extra })
  const ctx = (t: number, turn: number, name: string, origin: string, extra: object = {}) => ({ t: T + t, turn, kind: 'prompt', name, type: 'hook_additional_context', origin, detail: '', outcome: '', src: 'hook', bytes: 900, peek: `${origin} hook additional context: <context_guidance> tip`, ...extra })
  const step = (t: number, turn: number, ms: number, extra: object = {}) => ({ t: T + t, turn, kind: 'step', name: 'claude-opus-5-5', detail: '', outcome: '', status: 'ok', ms, stop: 'tool_use', ...extra })
  return [
    { t: T, turn: 0, kind: 'session', name: 'start', detail: '/home/u/cc-plugins', outcome: '' },
    hook(10, 0, 'preflight-context', 'SessionStart', 'startup', { outcome: 'context x1', ms: 400 }),
    ctx(11, 0, 'preflight-context', 'SessionStart', { type: 'hook_success' }),
    ctx(12, 0, 'context-mode', 'SessionStart'),
    hook(13, 0, 'install-check', 'SessionStart', 'startup', { ms: 2100 }),
    // turn 1
    hook(60000, 1, 'question-mode', 'UserPromptSubmit', '', { outcome: 'context x1' }),
    ctx(60001, 1, 'question-mode', 'UserPromptSubmit', { type: 'hook_success' }),
    step(60100, 1, 5200, { thought: 'Looking at the pane code', asked: ['Read', 'Grep'], ttft: 1100, think: 2400, step: 's1', tok: [3, 40000, 200, 300] }),
    { ...tool(65400, 1, 'Read', '/home/u/cc-plugins/plugins/agent-log/README.md', { step: 's1' }), use: 'r1' },
    { ...ctx(65380, 1, 'context-mode', 'PreToolUse'), use: 'r1' },
    tool(65500, 1, 'Grep', '/home/u/cc-plugins/plugins/agent-log/hooks', { step: 's1', pat: 'secs\\(' }),
    step(65600, 1, 3100, { asked: ['Bash'], step: 's2' }),
    { ...tool(72900, 1, 'Bash', 'Run the tests', { cmd: 'claude plugin test plugins/agent-log', ms: 18400, wait: 4200, waitFor: 'you to answer the permission prompt', outcome: 'error', status: 'failed', exit: 1, insight: 'agent-log.test.ts:412 expected 12 rows, got 13', check: 'ask', via: 'user_temporary', step: 's2' }), use: 'b1' },
    { ...hook(68750, 1, 'guard', 'PreToolUse', 'Bash', { ms: 30 }), use: 'b1' },
    { ...ctx(68760, 1, 'context-mode', 'PreToolUse'), use: 'b1' },
    { ...tool(91500, 1, 'Bash', 'Clean the build output', { cmd: 'rm -rf dist', outcome: 'error', status: 'denied', ms: undefined, peek: 'guard.sh blocked this command: rm -rf' }), use: 'b2' },
    { ...hook(91490, 1, 'guard', 'PreToolUse', 'Bash', { outcome: 'block', peek: 'guard.sh blocked this command: rm -rf', ms: 25 }), use: 'b2' },
    { ...tool(92000, 1, 'Edit', '/home/u/cc-plugins/plugins/agent-log/hooks/agent-log.tsx', { ms: 120 }), use: 'e1' },
    { ...hook(92130, 1, 'lint-feedback', 'PostToolUse', 'Edit', { outcome: 'block', ms: 1300, peek: 'agent-log.tsx:1505: unused variable room' }), use: 'e1' },
    tool(93000, 1, 'Read', '/home/u/other-project/src/index.ts', { out: '~/other-project/src' }),
    tool(93100, 1, 'Read', '/home/u/.claude/settings.json', { out: '~/.claude' }),
    tool(93200, 1, 'Bash', 'git status --short', { cmd: 'git status --short', ms: 90 }),
    step(93400, 1, 6100, { peek: 'The test fails because the header grew a row.\nI will fix the count.', stop: 'end_turn', ttft: 800, tok: [3, 52000, 900, 700], server: [['advisor', 3200]] }),
    { t: T + 99600, turn: 1, kind: 'turn', name: 'turn', detail: '', outcome: '', status: 'ok', ms: 39600 },
    // turn 2
    { t: T + 300000, turn: 2, kind: 'event', name: 'model switch', detail: 'claude-opus-5-5 → claude-sonnet-5-5', outcome: '/model' },
    step(300100, 2, 2100, { name: 'claude-sonnet-5-5', asked: ['Agent'], step: 's3' }),
    tool(302300, 2, 'Agent', 'Explore: map how hooks are named', { child: 'A', ms: 300 }),
    tool(302500, 2, 'Read', '/home/u/cc-plugins/plugins/agent-log/hooks/agent-log.tsx', { agent: 'A', ms: 30 }),
    tool(303000, 2, 'Grep', '/home/u/cc-plugins/plugins', { agent: 'A', ms: 50 }),
    step(303100, 2, 4000, { name: 'claude-haiku-5-5', agent: 'A', peek: 'hookName() maps settings hooks by script.', stop: 'end_turn' }),
    { t: T + 307200, turn: 2, kind: 'turn', name: 'turn', detail: '', outcome: '12.0k tok in · 400 tok out', status: 'ok', agent: 'A', ms: 4900, peek: 'hookName() maps settings hooks by script name.' },
    { t: T + 307300, turn: 2, kind: 'side', name: 'generate_session_title', src: 'engine', detail: 'claude-haiku-5-5', outcome: '', status: 'ok', ms: 900 },
    { t: T + 307400, turn: 2, kind: 'event', name: 'API error', detail: 'overloaded_error 529', outcome: 'retry 1', status: 'failed' },
    { t: T + 307500, turn: 2, kind: 'event', name: 'MCP failed', detail: 'terminal-browser', outcome: 'spawn ENOENT', status: 'failed' },
    step(308000, 2, 7300, { name: 'claude-sonnet-5-5', peek: 'Hooks are named from settings and hooks.json.', stop: 'end_turn' }),
    { t: T + 315400, turn: 2, kind: 'turn', name: 'turn', detail: '', outcome: '', status: 'ok', ms: 15400 },
  ]
}

const agentlog = ($: any, args: string) => $.command.run({ command: 'agentlog', args, origin: { kind: 'composer' }, presentation: 'text' })
const mountAt = async ($: any, on: any, id: string, cols: number, bodyRows: number) => {
  on('session.id', () => ({ value: id }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('agent.list', () => ({ value: [{ id: 'A', type: 'Explore', description: 'map how hooks are named', status: 'completed' }] }))
  on('config.list', () => ({ value: [] }))
  on('ui.panes', () => ({ value: [{ id: 'agent-log' }] })) // the pane is up: /agentlog sets the level, it does not toggle it shut
  mock.store(on, { [`r:${id}`]: { entries: seed(), seen: {}, turn: 2, names: { A: 'Explore' } } })
  return $.ui.mount({ plugin: 'agent-log', surface: 'terminal', component: 'Pane', requestId: 'agent-log', props: { title: 'Agent log', isFocused: false, placement: 'dock', bodyColumns: cols, scroll: { offset: 0, bodyRows } } as any })
}

test('the review\'s session at 100×60: every level, view and page draws', async ($, on) => {
  const m = await mountAt($, on, 'RV1', 100, 60)
  const all = await frame(m, 100, 'default: all view, info level')
  expect(all.some(l => /Run the tests/.test(l))).toBe(true)
  expect(all.some(l => /\*Reply/.test(l))).toBe(true) // main's request on its advisor's bracket is no hook: bright
  expect(all.some(l => /Sonnet 5\.5 · /.test(l))).toBe(false) // main's requests name no model: the switch row says it
  expect(all.some(l => /↗ 1 outside root/.test(l))).toBe(true)
  // rows say what happened: the pattern searched, the reply's first line; a time in its own unit, never `0.0s`
  expect(all.some(l => /Search "secs\\\(" in hooks/.test(l))).toBe(true)
  expect(all.some(l => /Reply: The test fails because the header grew a row\./.test(l))).toBe(true)
  expect(all.some(l => /\b0\.0s/.test(l))).toBe(false)
  expect(all.some(l => /\b40ms\b/.test(l))).toBe(true)
  expect(plainOf(all.find(l => /^start/.test(plainOf(l)))!).trimEnd()).toBe('start · 2 hidden') // no turn: no split, no time
  // weight and colour: one ⊘ per refusal, its hook named once on the bracket; lookups dim, calls that change things bright
  expect(all.join('\n').match(/⊘/g)?.length).toBe(1)
  expect(all.some(l => /Clean the build output\*? *‹cyan:⊘ denied›/.test(l))).toBe(true)
  expect(all.some(l => /\*guard\* +‹cyan:25ms›/.test(l))).toBe(true)
  expect(all.some(l => /^  Read index\.ts‹magenta: ↗ ~\/other-project\/src›/.test(l))).toBe(true)
  expect(all.some(l => /\*Edit agent-log\.tsx\*/.test(l))).toBe(true)
  expect(all.some(l => /‹blue:↩ 1\.3s›/.test(l))).toBe(true)
  await agentlog($, 'level debug'); await m.redraw()
  const debug = await frame(m, 100, 'debug level')
  expect(debug.some(l => /install-check/.test(l))).toBe(true) // a fast hook that changed nothing ranks debug
  expect(debug.some(l => /preflight-context on SessionStart startup +\+ 400ms/.test(l))).toBe(true) // added context: routine, no colour
  await agentlog($, 'level notice'); await m.redraw()
  await frame(m, 100, 'notice level')
  await agentlog($, 'level info'); await m.redraw()
  const fold = (await m.findAll({ type: 'Button', text: /^▸$/ }))[0]
  await m.press({ key: fold!.key! })
  const open = await frame(m, 100, 'Agent fold open')
  expect(open.some(l => /Haiku 5\.5 · /.test(l))).toBe(true) // a subagent on another model than main's at the time
  expect(open.some(l => /input & result|reply: /.test(l))).toBe(false) // the Agent row's inspector holds them
  await m.press({ key: fold!.key! })
  await m.press({ key: 'vharness' }); await frame(m, 100, 'harness view'); await m.press({ key: 'vharness' })
  await m.press({ key: (await m.find({ type: 'Button', text: /^Run the tests/ }))!.key! }); await frame(m, 100, 'inspector: failed Bash'); await m.press({ key: 'back' })
  await m.press({ key: 'th1' }); await frame(m, 100, 'inspector: turn #1'); await m.press({ key: 'back' })
  await m.press({ key: 'fsetup' }); await frame(m, 100, 'setup page'); await m.press({ key: 'back' })
})

test('the review\'s session at 60×20: the header leaves the log its room', async ($, on) => {
  const m = await mountAt($, on, 'RV2', 60, 20)
  const lines = await frame(m, 60, 'default at 60×20')
  expect(ruleAt(lines)).toBeGreaterThan(0)
  expect(lines.length).toBeLessThanOrEqual(20)
})
