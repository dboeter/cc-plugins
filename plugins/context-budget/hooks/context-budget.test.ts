import { test, expect, mock } from 'claude-code/testing'
import type { SessionContextBreakdown } from 'claude-code'
import { barOf, k, payersOf, toolsLabel } from './context-budget'

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

test('the tools of a step read as one label, repeats counted, MCP names spaced', () => {
  expect(toolsLabel(['Read', 'Bash', 'Read', 'mcp__ctx__search'])).toBe('Read ×2, Bash, ctx search')
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
  expect(await m.find({ text: /This is the part that fills up/ })).toBeDefined()
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
  expect(await m.find({ text: /This is the part that fills up/ })).toBe(undefined)
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

test('growth fills in per step while a turn runs: each row blames the tools before it, subagents left out', async ($, on) => {
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [], context: { tokens: 43000, window: 200000, percent: 22, breakdown: breakdown() } } }) as any)
  on('ui.panes', () => ({ value: [{ id: 'context-budget' }] }) as any)
  // core: answers each step with the usage and tool calls the test queued for it
  const answers: { read: number; tools?: string[] }[] = []
  on('turn.step', async function* (_$, e) {
    const a = answers.shift()!
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: (a.tools ?? []).map(name => ({ name })), stopReason: 'end_turn', usage: { input_tokens: 100, cache_read_input_tokens: a.read - 300, cache_creation_input_tokens: 200, output_tokens: 50, model: 'm' } } as any
  })
  const step = async (turnId: string, index: number, read: number, tools?: string[], agentId?: string) => {
    answers.push({ read, tools })
    const s = $.turn.step({ turnId, index, model: 'm', messageCount: 1, agentId } as any)
    for await (const _ of s);
    await s.result
  }
  await step('t1', 0, 20000)
  await step('t2', 0, 23000, ['Read', 'Read'])
  await step('t2', 1, 999999, ['Bash'], 'sub') // a subagent's own window
  const m = await $.ui.mount({ plugin: 'context-budget', surface: 'terminal', component: 'Pane', requestId: 'context-budget', props: { title: 'Context budget', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 80 } } as any })
  expect(await m.find({ text: /prompt \+ last reply\s+\+3\.0k/ })).toBeDefined()
  expect(await m.find({ text: /Read ×2\s+…/ })).toBeDefined() // its growth is known once the next request is answered

  await step('t2', 1, 37000)
  expect(await m.find({ text: /Read ×2\s+\+14k/ })).toBeDefined()
  expect(await m.find({ text: /Growth this turn\s+\+17k/ })).toBeDefined()

  await step('t3', 0, 5000) // a /clear or compaction between turns
  expect(await m.find({ text: /compacted or cleared\s+-32k/ })).toBeDefined()
  expect(await m.find({ text: /Earlier turns: \+17k$/ })).toBeDefined()

  for (let i = 1; i <= 14; i++) await step('t3', i, 5000 + i * 1000, ['Grep']) // a long turn draws its latest 12 of 15 rows
  expect(await m.find({ text: /…3 earlier steps/ })).toBeDefined()
  expect(await m.find({ text: /Growth this turn\s+-18k/ })).toBeDefined() // the total still counts them all: -32k + 14 × 1k
})
