// The engine's turn starts before the prompt submit agent-log sees: that stretch is the turn row's lead, drawn as `before submit`.
// The module's state is shared, as in agent-log.test.ts
import { test, expect } from 'claude-code/testing'

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
const pane = ($: any) => $.ui.mount({ plugin: 'agent-log', surface: 'terminal', component: 'Pane', requestId: 'agent-log', props: { title: 'Agent log', isFocused: false, placement: 'dock', bodyColumns: 120, scroll: { offset: 0, bodyRows: 40 } } })

test('a turn whose duration starts 2 s before its submit reads that 2 s as before submit, not other', async ($, on) => {
  const db = capture(on, 'PS')
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  await ($ as any).session.start({ cwd: '/w', surface: 'terminal', isInteractive: true, source: 'startup' }) // loaded, so the submit is not held by it
  const t0 = Date.now()
  await $.prompt.submit({ text: 'Say hi', origin: { kind: 'composer' }, wait: false } as any)
  const t1 = Date.now() // agent-log took its submit time between t0 and t1
  await $.tool.call({ tool: 'Read', tool_use_id: 'tu1', file_path: '/w/a.ts' } as any) // a row, so the turn has a header
  await ($ as any).turn.complete({ reason: 'answer', answer: '', durationMs: Date.now() - t0 + 2000, usage: undefined })
  const m = await pane($)
  await $.session.end({ reason: 'other', sessionId: 'PS' } as any)
  const y = db['r:PS'].entries.find((x: any) => x.kind === 'turn' && !x.agent)
  expect(y.lead).toBeGreaterThanOrEqual(1950)
  expect(y.lead).toBeLessThanOrEqual(2000 + (t1 - t0))
  await m.press({ key: `bturn${y.turn}` }) // the inspector's whole split
  expect(await m.find({ text: /^before submit 2\.0s\b/ })).toBeDefined()
  expect(await m.find({ text: /other \d/ })).toBeUndefined() // nothing else in the turn: none of the 2 s is other
})

test('a turn stored before lead existed still draws, its time before submit in other', async ($, on) => {
  const db = capture(on, 'PO')
  const T = Date.now() - 600_000
  db['r:PO'] = { entries: [{ t: T, turn: 1, kind: 'turn', name: 'turn', detail: '', outcome: '', status: 'ok', ms: 3000, split: [0, 0, 0, 0, 0, 0, 1000] }], seen: {}, turn: 1, names: {} }
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  await ($ as any).session.start({ cwd: '/w', surface: 'terminal', isInteractive: true, source: 'resume' })
  const m = await pane($)
  await m.press({ key: 'bturn1' })
  expect(await m.find({ text: /^other 2\.0s · model 1\.0s\b/ })).toBeDefined()
})
