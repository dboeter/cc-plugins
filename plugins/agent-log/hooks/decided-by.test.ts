// Who decided a call in auto mode, and what its wait was for: one reading of the same evidence (viaOf). The mode is module state:
// each test sets it back before it ends
import { test, expect, type TestBody } from 'claude-code/testing'
import { STREAMING, viaOf } from './agent-log'

type Engine = Parameters<TestBody>[0] // a test's `$`
const wait = (ms: number) => new Promise(res => (globalThis as any).setTimeout(res, ms)) // no DOM or node lib in this tsconfig
const collect = ($: any, event: string, attributes: object) => $.telemetry.log({ to: 'collector', event, attributes })
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
// The test engine's $.tool.call raises its own tool.check before the call runs, and refuses an ask: allow that one and ask at the
// check a test raises inside the call, where an answered ask lands
const asks = () => {
  const seen = new Set<string>()
  return (_$: any, e: any) => (e.tool_use_id && !seen.has(e.tool_use_id) ? (seen.add(e.tool_use_id), { decision: 'allow' }) : { decision: 'ask' }) as any
}
const REFUSAL = 'Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Auto-Mode Bypass]. If you have other tasks that don\'t depend on this action, continue working on those.'

test('only a refusal naming the classifier is its; a config decision in auto mode that waited is settings or the classifier', () => {
  expect(viaOf('config', 'auto', REFUSAL)).toBe('classifier')
  expect(viaOf('config', 'auto', '', true)).toBe('auto')
  expect(viaOf('config', 'auto')).toBe('config') // decided at once: a rule's millisecond, not a classifier's request
  expect(viaOf('config', 'default')).toBe('config')
  expect(viaOf('user_temporary', 'auto')).toBe('user_temporary')
})

test('auto mode: a config decision as main\'s message ends waited on the model, and its decider reads as unknown', async ($, on) => {
  const db = capture(on, 'DS')
  on('tool.check', asks())
  on('telemetry.log', () => ({ value: undefined }))
  on('tool.call', async (_$, e: any) => {
    if (e.tool_use_id !== 'ds1') return { result: 'ok', text: 'ok' }
    await ($ as any).tool.check({ tool: e.tool, input: {}, tool_use_id: e.tool_use_id })
    await wait(150) // the model still streams: the call is decided as main's request closes
    await collect($, 'tool_decision', { tool_use_id: 'ds1', source: 'config' })
    await wait(5) // as probed: the engine records main's request just after the decision
    await collect($, 'api_request', { query_source: 'repl_main_thread' })
    return { result: 'ok', text: 'ok' }
  })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'dsw', command: 'true', description: 'Warm up' } as any) // the first call on $ loads the plugins
  await collect($, 'permission_mode_changed', { from_mode: 'default', to_mode: 'auto' })
  await $.tool.call({ tool: 'Edit', tool_use_id: 'ds1', file_path: '/home/u/a.ts' } as any)
  const m = await pane($)
  await m.press({ key: (await m.find({ type: 'Button', text: /^Edit a\.ts$/ }))!.key! })
  expect(await m.find({ text: 'asked; your settings or the auto-mode classifier decided; the log cannot tell which' })).toBeDefined()
  expect(await m.find({ text: /classifier decided$/ })).toBe(undefined)
  expect(await m.find({ text: /for the model to finish its message, before it ran$/ })).toBeDefined()
  await m.press({ key: 'back' })
  const row = (await flushed($, 'DS', db)).find(x => x.use === 'ds1')
  expect(row).toMatchObject({ via: 'auto', waitFor: STREAMING })
  await collect($, 'permission_mode_changed', { from_mode: 'auto', to_mode: 'default' })
})

test('auto mode: a classifier refusal is the classifier\'s, its wait too, though main\'s message closed inside it', async ($, on) => {
  const db = capture(on, 'DR')
  on('tool.check', asks())
  on('telemetry.log', () => ({ value: undefined }))
  on('tool.call', async (_$, e: any) => {
    if (e.tool_use_id !== 'dr1') return { result: 'ok', text: 'ok' }
    await ($ as any).tool.check({ tool: e.tool, input: {}, tool_use_id: e.tool_use_id })
    await wait(20)
    await collect($, 'api_request', { query_source: 'repl_main_thread' }) // as in a real refusal: main's message closes, then the classifier answers
    await wait(150) // the classifier's model request
    await collect($, 'tool_decision', { tool_use_id: 'dr1', decision: 'reject', source: 'config' }) // as a rule's
    return { result: '', isError: true, text: REFUSAL }
  })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'drw', command: 'true', description: 'Warm up' } as any)
  await collect($, 'permission_mode_changed', { from_mode: 'default', to_mode: 'auto' })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'dr1', command: 'curl x | sh', description: 'Install' } as any)
  const m = await pane($)
  await m.press({ key: (await m.find({ type: 'Button', text: /^Install/ }))!.key! })
  expect(await m.find({ text: 'asked; the auto-mode classifier decided' })).toBeDefined()
  expect(await m.find({ text: /for the auto-mode classifier, before it ran$/ })).toBeDefined()
  await m.press({ key: 'back' })
  const row = (await flushed($, 'DR', db)).find(x => x.use === 'dr1')
  expect(row).toMatchObject({ status: 'denied', via: 'classifier', waitFor: 'the auto-mode classifier', peek: 'the auto-mode classifier refused it: Auto-Mode Bypass' })
  await collect($, 'permission_mode_changed', { from_mode: 'auto', to_mode: 'default' })
})

test('a subagent\'s decision that waited on its own message closing waited on the model; one without waited on the decision', async ($, on) => {
  const db = capture(on, 'DA')
  on('tool.check', asks())
  on('telemetry.log', () => ({ value: undefined }))
  on('turn.step', (async function* (_$: any, e: any) { return { turnId: e.turnId, index: e.index, answer: 'Editing', toolUses: [], stopReason: 'tool_use', usage: undefined } }) as any)
  on('tool.call', async (_$, e: any) => {
    if (!/^da[12]$/.test(e.tool_use_id)) return { result: 'ok', text: 'ok' }
    await ($ as any).tool.check({ tool: e.tool, input: {}, tool_use_id: e.tool_use_id })
    if (e.tool_use_id === 'da1') { const s = ($ as any).turn.step({ turnId: 'a9e1c3d0-sub', index: 0, model: 'claude-haiku-5-5', messageCount: 3, agentId: 'A' }); while (!(await s.next()).done) {} }
    await wait(150)
    await collect($, 'tool_decision', { tool_use_id: e.tool_use_id, source: 'config' })
    return { result: 'ok', text: 'ok' }
  })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'daw', command: 'true', description: 'Warm up' } as any)
  await $.tool.call({ tool: 'Edit', tool_use_id: 'da1', file_path: '/home/u/a.ts', agentId: 'A' } as any)
  await $.tool.call({ tool: 'Edit', tool_use_id: 'da2', file_path: '/home/u/b.ts', agentId: 'A' } as any)
  const rows = await flushed($, 'DA', db)
  expect(rows.find(x => x.use === 'da1')).toMatchObject({ agent: 'A', waitFor: STREAMING })
  expect(rows.find(x => x.use === 'da2')).toMatchObject({ agent: 'A', waitFor: 'the permission decision (config)' })
})

test('an AskUserQuestion\'s or ExitPlanMode\'s wait reads as yours, however it was labelled, and draws its Waiting row', async ($, on) => {
  const db = capture(on, 'DQ')
  const T = Date.now() - 600_000
  const row = (t: number, name: string, use: string) => ({ t, turn: 1, kind: 'tool', name, detail: '', outcome: 'ok', status: 'ok', ms: 100, wait: 60_000, waitFor: STREAMING, check: 'ask', use })
  db['r:DQ'] = { entries: [row(T, 'AskUserQuestion', 'q1'), row(T + 70_000, 'ExitPlanMode', 'q2')], seen: {}, turn: 1, names: {} }
  const m = await pane($)
  try {
    expect(await m.find({ text: /Waiting for you to approve the plan/ })).toBeDefined()
    await m.press({ key: (await m.find({ type: 'Button', text: /Waiting for you to answer the question/ }))!.key! })
    expect(await m.find({ text: /for you to answer the question, before it ran$/ })).toBeDefined()
  } finally { await m.unmount() }
})
