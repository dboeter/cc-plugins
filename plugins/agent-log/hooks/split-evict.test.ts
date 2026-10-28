// A turn's split when a full log evicts its rows as they come: the module's state is shared, as in agent-log.test.ts
import { test, expect } from 'claude-code/testing'

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
const wait = (ms: number) => new Promise(res => (globalThis as any).setTimeout(res, ms)) // no DOM or node lib in this tsconfig
const drain = async (s: any) => { let n: any; while (!(n = await s.next()).done) {} return n.value }
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`

const W = 300 // ms per request
// a request that only called a tool: no text, so its step row ranks debug
const silent = (on: any) => on('turn.step', async function* (_$: any, e: any) {
  await wait(W)
  yield { kind: 'tool', index: 0, id: `tu${e.index}`, name: 'Read' }
  return { turnId: e.turnId, index: e.index, answer: '', toolUses: [{ name: 'Read', input: {} }], stopReason: 'tool_use', usage: undefined }
})

test('a full log evicting a turn\'s text-less requests as they come keeps their time in its split', async ($, on) => {
  const db = capture(on, 'SE')
  const T = Date.now() - 600_000
  // the cap of earlier rows, none debug: each new debug row is the oldest debug one, so its own push evicts it
  db['r:SE'] = { entries: Array.from({ length: 300 }, (_, i) => ({ t: T + i, turn: 1, kind: 'tool', name: 'Read', detail: `/x/${i}.ts`, outcome: 'ok', status: 'ok', ms: 10 })), seen: {}, turn: 1, names: {} }
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  silent(on)
  const t0 = Date.now()
  await $.prompt.submit({ text: 'Read the files', origin: { kind: 'composer' }, wait: false } as any)
  for (let i = 0; i < 4; i++) {
    await drain(($ as any).turn.step({ turnId: 'e7d91f2f-e937', index: i, model: 'claude-opus-5-5', messageCount: 3 }))
    await $.tool.call({ tool: 'Read', tool_use_id: `tu${i}`, file_path: `/y/${i}.ts` } as any) // the turn's rows that stay: its header draws over them
  }
  await ($ as any).turn.complete({ reason: 'answer', answer: '', durationMs: Date.now() - t0, usage: undefined })
  const m = await ($ as any).ui.mount({ plugin: 'agent-log', surface: 'terminal', component: 'Pane', requestId: 'agent-log', props: { title: 'Agent log', isFocused: false, placement: 'dock', bodyColumns: 120, scroll: { offset: 0, bodyRows: 40 } } })
  const rows = await flushed($, 'SE', db)
  expect(rows.filter(x => x.kind === 'step').length).toBe(0) // all four went on their own push
  const y = rows.find(x => x.kind === 'turn' && x.turn === 2)
  expect(y.split[6]).toBeGreaterThanOrEqual(4 * W) // model: each request's whole time, none of it other
  const model = `model ${secs(y.split[6])}`
  expect(await m.find({ text: new RegExp(`· ${model}\\b`) })).toBeDefined() // the header's two largest parts
  await m.press({ key: 'bturn2' }) // the inspector's whole split
  expect(await m.find({ text: new RegExp(`^${model}\\b`) })).toBeDefined()
})
