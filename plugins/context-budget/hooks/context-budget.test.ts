import { test, expect } from 'claude-code/testing'
import type { ContextGridSquare, SessionContextBreakdown } from 'claude-code'
import { k, payersOf, runsOf, spark } from './context-budget'

const sq = (categoryName: string, color: string, squareFullness = 1): ContextGridSquare => ({ categoryName, color, squareFullness, isFilled: squareFullness > 0, tokens: 0, percentage: 0 })
const cat = (name: string, tokens: number, kind: 'used' | 'free' | 'buffer' | 'deferred', color = 'c') => ({ name, tokens, kind, color, isDeferred: kind === 'deferred' })
const breakdown = (over: Partial<SessionContextBreakdown> = {}): SessionContextBreakdown => ({
  categories: [cat('System prompt', 3000, 'used', 'promptBorder'), cat('Messages', 40000, 'used', 'permission'), cat('Free space', 124000, 'free', 'inactive'), cat('Autocompact buffer', 33000, 'buffer', 'warning')],
  totalTokens: 43000, maxTokens: 200000, rawMaxTokens: 200000, autocompactSource: 'auto', percentage: 22,
  gridRows: [[sq('System prompt', 'promptBorder'), sq('Messages', 'permission'), sq('Messages', 'permission', 0.5), sq('Free space', 'inactive', 0), sq('Autocompact buffer', 'warning')]],
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

test('the growth line is scaled to the window, so a half-full window draws a middle bar', () => {
  expect(spark([0, 100000, 200000], 200000)).toBe('▁▅█')
})

test('a grid row merges same-colour squares, draws a partial square hollow, free space dim', () => {
  const b = breakdown()
  const kindOf = (n: string) => b.categories.find(c => c.name === n)?.kind
  expect(runsOf(b.gridRows[0], kindOf)).toEqual([
    { s: '■', color: 'promptBorder', dim: false },
    { s: ' ■ □', color: 'permission', dim: false },
    { s: ' ·', color: undefined, dim: true },
    { s: ' ▒', color: 'warning', dim: false },
  ])
})

test('the pane explains each category, lists what every request pays, and records growth per turn', async ($, on) => {
  const counted: string[] = []
  on('session.usage', (_$, e: any) => { counted.push(e?.breakdown); return { value: { startedAt: 0, rateLimits: [], context: { tokens: 43000, window: 200000, percent: 22, breakdown: breakdown({ memoryFiles: [{ path: '/r/CLAUDE.md', type: 'User', tokens: 900 }] }) } } } as any })
  on('ui.panes', () => ({ value: [{ id: 'context-budget' }] }) as any)
  on('session.measure', (_$, e) => ({ changed: e.changed })) // core echoes `changed`
  await $.session.measure({ context: { tokens: 20000, window: 200000 }, rateLimits: [], changed: ['context'] } as any)
  await $.session.measure({ context: { tokens: 43000, window: 200000 }, rateLimits: [], changed: ['context'] } as any)
  await $.session.measure({ context: { tokens: 99999, window: 200000 }, rateLimits: [], changed: ['rateLimits'] } as any) // not a context move: not a turn on the line
  const m = await $.ui.mount({ plugin: 'context-budget', surface: 'terminal', component: 'Pane', requestId: 'context-budget', props: { title: 'Context budget', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 60 } } as any })
  expect(await m.find({ text: /43k of 200k tokens/ })).toBeDefined()
  expect(await m.find({ text: /This is the part that fills up/ })).toBeDefined()
  expect(await m.find({ text: /User r\/CLAUDE\.md/ })).toBeDefined()
  expect(await m.find({ text: /now 43k, first 20k/ })).toBeDefined()
  expect(await m.find({ text: /Auto-compact starts at 167k \(84%\)/ })).toBeDefined()
  expect(counted.includes('full')).toBe(false) // the exact count costs requests: only on r
  await m.press({ key: 'exact' })
  expect(counted.at(-1)).toBe('full')
  expect(await m.find({ text: /Counted with the token-count API/ })).toBeDefined()
  await m.press({ key: 'notes' })
  expect(await m.find({ text: /This is the part that fills up/ })).toBe(undefined)
})
