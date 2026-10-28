// A tool row's time is the call alone: its PreToolUse and PostToolUse chains run inside the call, and their own rows time them
import { test, expect, type TestBody } from 'claude-code/testing'
import { splitOf, SPLIT } from './agent-log'

type Engine = Parameters<TestBody>[0] // a test's `$`
const wait = (ms: number) => new Promise(res => (globalThis as any).setTimeout(res, ms)) // no DOM or node lib in this tsconfig
// a store the test reads back: what agent-log wrote, by key. session.end flushes the log's last second
const capture = (on: any, id: string) => {
  const db: Record<string, any> = {}
  on('session.id', () => ({ value: id }))
  on('agent.list', () => ({ value: [] }))
  on('config.list', () => ({ value: [] }))
  on('ui.panes', () => ({ value: [{ id: 'agent-log' }] }))
  on('store.get', (_$: any, e: any) => ({ value: db[e.key] }))
  on('store.set', (_$: any, e: any) => { db[e.key] = e.value; return { value: undefined } })
  on('store.delete', (_$: any, e: any) => { delete db[e.key]; return { value: undefined } })
  on('store.keys', () => ({ value: Object.keys(db) }))
  on('session.end', (_$: any, e: any) => ({ sessionId: e.sessionId }))
  return db
}
const flushed = async ($: any, id: string, db: Record<string, any>) => { await $.session.end({ reason: 'other', sessionId: id }); return (db[`r:${id}`]?.entries ?? []) as any[] }
const pane = ($: Engine) => $.ui.mount({ plugin: 'agent-log', surface: 'terminal', component: 'Pane', requestId: 'agent-log', props: { title: 'Agent log', isFocused: false, placement: 'dock', bodyColumns: 160, scroll: { offset: 0, bodyRows: 40 } } as any })

test('a call whose hooks take longer than its run shows the run on its row; the turn split is unchanged', async ($, on) => {
  const db = capture(on, 'TT')
  on('classic.PreToolUse', async () => { await wait(200); return { additionalContext: ['guard ok'] } as any }) // the engine raises it inside the call
  on('classic.PostToolUse', async () => { await wait(300); return { additionalContext: ['lint: 2 warnings'] } as any })
  on('tool.call', async (_$, e: any) => {
    if (e.tool_use_id !== 'tt1') return { result: 'ok', text: 'ok' }
    await wait(100) // the run
    await ($ as any).classic.PostToolUse({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_use_id: 'tt1', tool_input: {}, tool_response: 'ok' }) // a tool.call in a test raises no PostToolUse
    return { result: 'ok', text: 'ok' }
  })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'ttw', command: 'true', description: 'Warm up' } as any) // the first call on $ loads the plugins
  const from = Date.now()
  await $.tool.call({ tool: 'Edit', tool_use_id: 'tt1', file_path: '/home/u/a.ts' } as any)
  const to = Date.now()
  const m = await pane($)
  await m.press({ key: (await m.find({ type: 'Button', text: /^Edit a\.ts$/ }))!.key! })
  expect(await m.find({ text: /around it, in their own rows$/ })).toBeDefined()
  await m.press({ key: 'back' })
  const rows = (await flushed($, 'TT', db)).filter(x => x.use === 'tt1')
  const call = rows.find(x => x.kind === 'tool')!, hooks = rows.filter(x => x.kind === 'hook')
  expect(hooks.map(x => x.origin)).toEqual(['PreToolUse', 'PostToolUse'])
  const pre = hooks[0]!.ms, post = hooks[1]!.ms
  expect(call.ms).toBeGreaterThanOrEqual(100)
  expect(call.ms).toBeLessThan(200) // the run alone, not the 600 ms the call held
  expect([call.pre, call.post]).toEqual([pre, post])
  // the split: the hooks hold their 500 ms, the run its own, and the call's span leaves nothing to `other`
  const split = splitOf(rows, from, to)
  const at = (k: typeof SPLIT[number]) => split[SPLIT.indexOf(k)]!
  expect(at('hooks')).toBe(pre + post)
  expect(at('tools')).toBeGreaterThanOrEqual(call.ms - 20) // a hook row's t is stamped as its handler pushes, a few ms past the chain's end, over the run
  // other: only the handlers' own steps around the call, tens of ms on a busy machine. A row placed at the call's start would leave
  // the PreToolUse chain's 200 ms there
  expect(to - from - split.reduce((a, b) => a + b, 0)).toBeLessThan(100)
})
