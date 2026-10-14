import { test, expect, mock } from 'claude-code/testing'
import type { SessionContextBreakdown } from 'claude-code'
import { barOf, k, payersOf } from './context-budget'

const cat = (name: string, tokens: number, kind: 'used' | 'free' | 'buffer' | 'deferred', color = 'c') => ({ name, tokens, kind, color, isDeferred: kind === 'deferred' })
const breakdown = (over: Partial<SessionContextBreakdown> = {}): SessionContextBreakdown => ({
  categories: [cat('System prompt', 3000, 'used', 'promptBorder'), cat('Messages', 40000, 'used', 'permission'), cat('Free space', 124000, 'free', 'inactive'), cat('Autocompact buffer', 33000, 'buffer', 'warning')],
  totalTokens: 43000, maxTokens: 200000, rawMaxTokens: 200000, autocompactSource: 'auto', percentage: 22,
  gridRows: [],
  model: 'claude-opus-5-5', memoryFiles: [], mcpTools: [], agents: [], isAutoCompactEnabled: true, autoCompactThreshold: 167000, apiUsage: null,
  ...over,
})

test('sizes read as plain counts under 1000, one decimal under 10k, whole k above', () => {
  expect([k(512), k(3100), k(40123)]).toEqual(['512', '3.1k', '40k'])
})

test('per-request payers: MCP schemas summed per server, unloaded ones left out, biggest first, capped', () => {
  const b = breakdown({
    mcpTools: [
      { name: 'mcp__ctx__a', serverName: 'ctx', tokens: 4000, isLoaded: true },
      { name: 'mcp__ctx__b', serverName: 'ctx', tokens: 2000, isLoaded: true },
      { name: 'mcp__web__x', serverName: 'web', tokens: 9000, isLoaded: false },
    ],
    memoryFiles: [{ path: '/home/u/repo/CLAUDE.md', type: 'Project', tokens: 1200 }],
    skills: { totalSkills: 50, includedSkills: 42, tokens: 3800, skillFrontmatter: [] },
    agents: [{ agentType: 'scout', source: 'userSettings', tokens: 300 }, { agentType: 'judge', source: 'userSettings', tokens: 200 }],
  })
  expect(payersOf(b)).toEqual([
    { label: 'MCP server ctx', tokens: 6000 },
    { label: '42 skill descriptions', tokens: 3800 },
    { label: 'Project repo/CLAUDE.md', tokens: 1200 },
    { label: '2 agent descriptions', tokens: 500 },
  ])
  expect(payersOf(b, 2).length).toBe(2)
})

test('the stacked bar spans the width, keeps a tiny row visible, and puts free space before the reserve', () => {
  const b = breakdown({ categories: [cat('System prompt', 50, 'used', 'p'), cat('Messages', 100000, 'used', 'm'), cat('Free space', 66950, 'free'), cat('Autocompact buffer', 33000, 'buffer', 'w'), cat('MCP tools', 9000, 'deferred')] })
  expect(barOf(b, 20)).toEqual([
    { s: '█', color: 'p' },
    { s: '██████████', color: 'm' },
    { s: '······', color: undefined, dim: true },
    { s: '▒▒▒', color: 'w' },
  ])
})

test('the pane explains each category, lists what each request carries', async ($, on) => {
  const counted: string[] = []
  on('session.usage', (_$, e: any) => { counted.push(e?.breakdown); return { value: { startedAt: 0, rateLimits: [], context: { tokens: 43000, window: 200000, percent: 22, breakdown: breakdown({ memoryFiles: [{ path: '/r/CLAUDE.md', type: 'User', tokens: 900 }], categories: [...breakdown().categories, cat('MCP tools (deferred)', 16000, 'deferred')] }) } } } as any })
  on('ui.panes', () => ({ value: [{ id: 'context-budget' }] }) as any)
  const m = await $.ui.mount({ plugin: 'context-budget', surface: 'terminal', component: 'Pane', requestId: 'context-budget', props: { title: 'Context budget', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 60 } } as any })
  expect(await m.find({ text: /43k of 200k tokens/ })).toBeDefined()
  expect(await m.find({ text: /This is the part that fills up/ })).toBe(undefined) // notes start hidden
  expect(await m.find({ text: /User r\/CLAUDE\.md/ })).toBeDefined()
  expect(await m.find({ text: /124k left before auto-compact/ })).toBeDefined() // the free row, not threshold minus the reserve again
  expect(await m.find({ text: /at 167k · 157k in the window/ })).toBeDefined()
  expect(await m.find({ text: /is 93% of what is used/ })).toBeDefined()
  expect(await m.find({ text: /reserved for compaction/ })).toBeDefined()
  expect(await m.find({ text: /Available tools outside context/ })).toBeDefined()
  expect(await m.find({ text: /16k  MCP tools \(deferred\)/ })).toBeDefined()
  expect(await m.find({ text: /not in window/ })).toBe(undefined)
  expect(await m.find({ text: /Context included in each request/ })).toBeDefined()
  expect(await m.find({ text: /now 43k/ })).toBe(undefined) // one total on screen: the header's
  expect(await m.find({ text: /Auto-compact starts at 167k \(84%\)/ })).toBeDefined()
  expect(counted.includes('full')).toBe(false) // the exact count costs requests: only on r
  await m.press({ key: 'exact' })
  expect(counted.at(-1)).toBe('full')
  expect(await m.find({ text: /Counted with the token-count API/ })).toBeDefined()
  await m.press({ key: 'notes' })
  expect(await m.find({ text: /This is the part that fills up/ })).toBeDefined()
})

test('r counts once at a time, a turn overtakes a slow exact count, a failed refresh keeps the last figures', async ($, on) => {
  const clock = mock.clock(on)
  const asks: string[] = []
  let release = () => {}
  let offline = false
  on('session.usage', async (_$, e: any) => {
    asks.push(e?.breakdown)
    if (offline) return { deny: 'offline' } as any
    if (e?.breakdown === 'full') await new Promise<void>(r => { release = r })
    const totalTokens = e?.breakdown === 'full' ? 11000 : 55000 // the exact count is the pre-turn figure
    return { value: { startedAt: 0, rateLimits: [], context: { tokens: totalTokens, window: 200000, percent: 0, breakdown: breakdown({ totalTokens }) } } } as any
  })
  on('ui.panes', () => ({ value: [{ id: 'context-budget' }] }) as any)
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  const turn = () => $.session.measure({ context: { tokens: 55000, window: 200000 }, rateLimits: [], changed: ['context'] } as any)
  const m = await $.ui.mount({ plugin: 'context-budget', surface: 'terminal', component: 'Pane', requestId: 'context-budget', props: { title: 'Context budget', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 60 } } as any })
  await turn()
  await clock.settle()
  expect(await m.find({ text: /55k of 200k tokens/ })).toBeDefined()

  await m.press({ key: 'exact' })
  await m.press({ key: 'exact' })
  expect(asks.filter(a => a === 'full').length).toBe(1)
  await clock.settle()
  expect(await m.find({ text: /Counting exactly/ })).toBeDefined()

  await turn() // a turn ends while the count is still out
  release()
  await clock.settle()
  expect(await m.find({ text: /11k of 200k/ })).toBe(undefined)
  expect(await m.find({ text: /55k of 200k tokens/ })).toBeDefined()
  expect(await m.find({ text: /Counted with the token-count API/ })).toBe(undefined)

  offline = true
  await turn()
  await clock.settle()
  expect(await m.find({ text: /55k of 200k tokens/ })).toBeDefined()
  expect(await m.find({ text: /Could not refresh, showing the last figures: .*offline/ })).toBeDefined()
})

test('the bar never runs past its width: once free space is gone the biggest rows give way, every row keeps a cell', () => {
  const small = ['System prompt', 'System tools', 'MCP tools', 'Custom agents', 'Memory files', 'Skills'].map((n, i) => cat(n, 600, 'used', `s${i}`))
  const b = breakdown({ categories: [...small, cat('Messages', 190000, 'used', 'm'), cat('Free space', 0, 'free'), cat('Autocompact buffer', 33000, 'buffer', 'w')], totalTokens: 226600 })
  const bar = barOf(b, 20)
  expect(bar.reduce((s, r) => s + r.s.length, 0)).toBe(20)
  expect(bar.every(r => r.s.length >= 1)).toBe(true)
  expect(bar.length).toBe(8) // no free-space run: there is none
})

test('e estimates again for free; the headroom turns red when little is left', async ($, on) => {
  const asks: string[] = []
  on('session.usage', (_$, e: any) => { asks.push(e?.breakdown); return { value: { startedAt: 0, rateLimits: [], context: { tokens: 170000, window: 200000, percent: 85, breakdown: breakdown({ totalTokens: 160000, categories: [cat('Messages', 160000, 'used', 'm'), cat('Free space', 7000, 'free'), cat('Autocompact buffer', 33000, 'buffer', 'w')] }) } } } as any })
  on('ui.panes', () => ({ value: [{ id: 'context-budget' }] }) as any)
  const m = await $.ui.mount({ plugin: 'context-budget', surface: 'terminal', component: 'Pane', requestId: 'context-budget', props: { title: 'Context budget', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 60 } } as any })
  const headroom = await m.findAll({ type: 'Text', text: /7\.0k left before auto-compact/ })
  expect(headroom.some(t => t.props.color === 'red')).toBe(true)
  const before = asks.length
  await m.press({ key: 'estimate' })
  expect(asks.length).toBe(before + 1)
  expect(asks.at(-1)).not.toBe('full')
})

test('per turn: the window after each turn, newest first, its total and the change since the turn before, bars in category colours', async ($, on) => {
  let messages = 40000
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [], context: { tokens: 0, window: 200000, percent: 0, breakdown: breakdown({ totalTokens: 3000 + messages, categories: [cat('System prompt', 3000, 'used', 'promptBorder'), cat('Messages', messages, 'used', 'permission'), cat('Free space', 124000, 'free'), cat('Autocompact buffer', 33000, 'buffer', 'warning')] }) } } }) as any)
  on('ui.panes', () => ({ value: [] }) as any) // pane closed: turns are still kept
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  const turn = async (m: number) => { messages = m; await $.session.measure({ context: { tokens: 0, window: 200000 }, rateLimits: [], changed: ['context'] } as any) }
  await turn(40000)
  await turn(44000)
  await turn(20000) // compacted
  await $.session.measure({ context: { tokens: 0, window: 200000 }, rateLimits: [], changed: ['rateLimits'] } as any) // not a turn
  const m = await $.ui.mount({ plugin: 'context-budget', surface: 'terminal', component: 'Pane', requestId: 'context-budget', props: { title: 'Context budget', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 80 } } as any })
  expect(await m.find({ text: /Per turn\s+23k -24k in the last turn/ })).toBeDefined()
  const rows = await m.findAll({ type: 'Text', text: /^\s+#\d+\s+\d+k\s+[+-]?/ })
  expect(rows.map(r => r.text.replace(/█+/g, '').trim().replace(/\s+/g, ' '))).toEqual(['#3 23k -24k', '#2 47k +4.0k', '#1 43k'])
  const bars = await m.findAll({ type: 'Text', text: /^█+$/ })
  expect(bars.some(t => t.props.color === 'permission')).toBe(true) // Messages in its own colour, as in the top bar

  for (let i = 1; i <= 10; i++) await turn(20000 + i * 1000) // past the ten rows kept
  const kept = await m.findAll({ type: 'Text', text: /^\s+#\d+\s+\d+k/ })
  expect(kept.length).toBe(10)
  expect(kept.at(-1)!.text.replace(/█+/g, '').trim().replace(/\s+/g, ' ')).toBe('#4 24k +1.0k') // the oldest kept row keeps its change, against #3 (23k) now dropped
})

test('a turn whose estimate fails or is overtaken still gets its row, from the next breakdown that lands', async ($, on) => {
  let offline = false
  on('session.usage', () => offline ? { deny: 'offline' } as any : ({ value: { startedAt: 0, rateLimits: [], context: { tokens: 0, window: 200000, percent: 0, breakdown: breakdown() } } }) as any)
  on('ui.panes', () => ({ value: [{ id: 'context-budget' }] }) as any)
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  const m = await $.ui.mount({ plugin: 'context-budget', surface: 'terminal', component: 'Pane', requestId: 'context-budget', props: { title: 'Context budget', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 80 } } as any })
  offline = true
  await $.session.measure({ context: { tokens: 0, window: 200000 }, rateLimits: [], changed: ['context'] } as any)
  expect(await m.find({ text: /^\s+#1\s/ })).toBe(undefined)
  offline = false
  await m.press({ key: 'estimate' })
  expect(await m.find({ text: /^\s+#1\s+43k/ })).toBeDefined()
})
