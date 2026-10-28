// The setup page's totals and the turn times "the usual" is measured against cover the whole session, rows a full log evicted
// included: the module's state is shared, as in agent-log.test.ts
import { test, expect } from 'claude-code/testing'

// a store the test reads back: what agent-log wrote, by key. session.end flushes the log's last second
const capture = (on: any, id: string, panes = [{ id: 'agent-log' }]) => {
  const db: Record<string, any> = {}
  on('session.id', () => ({ value: id }))
  on('agent.list', () => ({ value: [] }))
  on('config.list', () => ({ value: [] }))
  on('ui.panes', () => ({ value: panes }))
  on('store.get', (_$: any, e: any) => ({ value: db[e.key] }))
  on('store.set', (_$: any, e: any) => { db[e.key] = e.value; return { value: undefined } })
  on('store.delete', (_$: any, e: any) => { delete db[e.key]; return { value: undefined } })
  on('store.keys', () => ({ value: Object.keys(db) }))
  on('session.end', (_$: any, e: any) => ({ sessionId: e.sessionId }))
  return db
}
const PANE = { plugin: 'agent-log', surface: 'terminal', component: 'Pane', requestId: 'agent-log', props: { title: 'Agent log', isFocused: false, placement: 'dock', bodyColumns: 120, scroll: { offset: 0, bodyRows: 80 } } }
// the setup page's model-use lines and its problems title, then back to the log (s on the page again would close it)
const setupOf = async ($: any) => {
  const m = await $.ui.mount(PANE)
  await m.press({ key: 'fsetup' })
  const read = async (re: RegExp) => (await m.find({ text: re }))?.text
  const r = { main: await read(/^\d+ requests? · .* \$/), agents: await read(/^1 request · 1\.0s/), side: await read(/^1 request · 200ms · — tokens$/), problems: await read(/^Problems: /) }
  await m.press({ key: 'back' })
  await m.unmount()
  return r
}
const T = Date.now() - 600_000
const step = (i: number, agent?: string) => ({ t: T + i, turn: 1, kind: 'step', name: 'request', detail: '', outcome: '', status: 'ok', ms: 1000, tok: [100, 0, 0, 10], cost: 0.5, agent })
const read = (i: number) => ({ t: T + i, turn: 1, kind: 'tool', name: 'Read', detail: `/x/${i}.ts`, outcome: 'ok', status: 'ok', ms: 10 })

test('a full log evicting the requests and problems the setup page counts leaves its totals as they were', async ($, on) => {
  const db = capture(on, 'ST')
  // at the cap: a failed hook run and an API error oldest, then debug rows (text-less requests, a prompt suggestion) a push evicts first
  const rows = [
    { t: T, turn: 1, kind: 'hook', name: 'lint', detail: '', outcome: '', status: 'failed', origin: 'PostToolUse', ms: 50 },
    { t: T + 1, turn: 1, kind: 'event', name: 'API error', detail: 'overloaded', outcome: '', status: 'failed' },
    step(2), step(3), step(4), step(5, 'a1'),
    { t: T + 6, turn: 1, kind: 'side', name: 'prompt_suggestion', detail: '', outcome: '', status: 'ok', ms: 200 },
  ]
  db['r:ST'] = { entries: [...rows, ...Array.from({ length: 300 - rows.length }, (_, i) => read(10 + i))], seen: {}, turn: 1, names: { a1: 'general-purpose' } }
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  const before = await setupOf($)
  expect(before.main).toContain('3 requests · 3.0s · 300 in · 30 out · $1.50')
  expect(before.agents).toBeDefined()
  expect(before.side).toBeDefined()
  expect(before.problems).toContain('Problems: 1 hook run failed, 1 API error')
  for (let i = 0; i < 10; i++) await $.tool.call({ tool: 'Read', tool_use_id: `tu${i}`, file_path: `/y/${i}.ts` } as any)
  await $.session.end({ reason: 'other', sessionId: 'ST' } as any)
  const kept = db['r:ST'].entries as any[]
  expect(kept.some(x => x.kind !== 'tool')).toBe(false) // every counted row is gone
  expect(db['r:ST'].totals.use.main).toEqual({ n: 3, ms: 3000, tok: [300, 30], cost: 1.5 }) // saved with the entries
  expect(await setupOf($)).toEqual(before)
  // cleared, the log keeps the session's totals
  await ($ as any).command.run({ command: 'agentlog', args: 'clear', origin: { kind: 'composer' }, presentation: 'text' })
  expect(db['r:ST'].entries).toEqual([])
  expect(await setupOf($)).toEqual(before)
})

test('a resumed or reloaded session adds its stored totals to the rows it still has', async ($, on) => {
  const db = capture(on, 'SR')
  db['r:SR'] = { entries: [step(1)], seen: {}, turn: 1, names: {}, totals: { use: { main: { n: 2, ms: 2000, tok: [200, 20], cost: 1 }, 'side:prompt_suggestion': { n: 1, ms: 200 } }, bad: { 'API error': 2 }, turns: [] } }
  const s = await setupOf($)
  expect(s.main).toContain('3 requests · 3.0s · 300 in · 30 out · $1.50')
  expect(s.side).toBeDefined() // a line only evicted rows had
  expect(s.problems).toContain('Problems: 2 API errors')
})

test('a store from before the totals counts its rows, as it did', async ($, on) => {
  const db = capture(on, 'SO')
  db['r:SO'] = { entries: [step(1), step(2), { t: T + 3, turn: 1, kind: 'event', name: 'API error', detail: '', outcome: '', status: 'failed' }], seen: {}, turn: 1, names: {} }
  const s = await setupOf($)
  expect(s.main).toContain('2 requests · 2.0s · 200 in · 20 out · $1.00')
  expect(s.problems).toContain('Problems: 1 API error')
})

test('"the usual" is the median of the kept turn times, the evicted turns\' included', async ($, on) => {
  const db = capture(on, 'SU', []) // the pane closed: the band shows the note
  db['r:SU'] = ({ entries: [], seen: {}, turn: 4, names: {}, totals: { use: {}, bad: {}, turns: [10_000, 10_000, 10_000] } })
  on('ui.render', ($: any, e: any) => { const { Text } = $.ui.resolve(e) as any; return Text({ key: 'theirs', children: ['other mod'] }) })
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('turn.complete', () => ({ text: '' }))
  await ($ as any).session.start({ cwd: '/w', surface: 'terminal', isInteractive: true, source: 'resume' }) // loads the session's store
  await ($ as any).turn.complete({ reason: 'answer', answer: '', durationMs: 40_000, usage: undefined })
  const band = await $.ui.mount({ plugin: 'agent-log', surface: 'terminal', component: 'AbovePrompt', props: { isWorking: false, hasSurvey: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 } } as any })
  expect(await band.find({ text: /^#\d+ took 40\.0s, 4× the usual$/ })).toBeDefined()
})

test('a text-less request a full log evicted on its own push still adds the price its collector record brings later', async ($, on) => {
  const db = capture(on, 'SP')
  db['r:SP'] = { entries: Array.from({ length: 300 }, (_, i) => read(i)), seen: {}, turn: 1, names: {} }
  on('telemetry.log', () => ({ value: undefined }))
  on('turn.step', async function* (_$: any, e: any) {
    yield { kind: 'tool', index: 0, id: 'tu1', name: 'Read' }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [{ name: 'Read', input: {} }], stopReason: 'tool_use', usage: { input_tokens: 2, output_tokens: 50, cache_read_input_tokens: 9000, cache_creation_input_tokens: 100, model: 'claude-opus-5-5' } }
  })
  await setupOf($) // loads the store
  const s = ($ as any).turn.step({ turnId: 'a3c0', index: 0, model: 'claude-opus-5-5', messageCount: 3 })
  while (!(await s.next()).done) {}
  await ($ as any).telemetry.log({ to: 'collector', event: 'api_request', attributes: { input_tokens: 2, cache_read_tokens: 9000, cache_creation_tokens: 100, output_tokens: 50, cost_usd: 0.25, request_id: 'req_1', query_source: 'repl_main_thread' } })
  await $.session.end({ reason: 'other', sessionId: 'SP' } as any)
  expect(db['r:SP'].entries.some((x: any) => x.kind === 'step')).toBe(false) // evicted on its push
  expect((await setupOf($)).main).toMatch(/^1 request · .* · 9\.1k in · 50 out · \$0\.25$/)
})

test('a skipped hook a full log evicted is not logged again after a reload, so the problem counts once', async ($, on) => {
  const db = capture(on, 'SS')
  db['r:SS'] = { entries: [step(1)], seen: {}, turn: 1, names: {}, totals: { use: {}, bad: { 'hook skipped': 1 }, turns: [], skips: ['skins classic.SessionStart|by cc-plugin-sec-default'] } }
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
  const notice = '<task-notification>\nskins: its classic.SessionStart hook was skipped. "cc-plugin-sec-default" runs first and sent the event on past it.\n</task-notification>'
  await $.prompt.submit({ text: notice, origin: { kind: 'task-notification' }, wait: false } as any)
  await $.session.end({ reason: 'other', sessionId: 'SS' } as any)
  expect(db['r:SS'].entries.some((x: any) => x.name === 'hook skipped')).toBe(false)
  expect((await setupOf($)).problems).toContain('Problems: 1 hook skipped')
})
