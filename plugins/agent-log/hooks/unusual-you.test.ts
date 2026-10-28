// Your time never makes a turn "unusual": the turn and the earlier turns "the usual" is measured against are each taken less their
// `you` part (SPLIT index 0). The module's state is shared, as in agent-log.test.ts
import { test, expect } from 'claude-code/testing'
import { unusualOf } from './agent-log'
import { capture } from './test-helpers'

const split = (o: Partial<Record<'you' | 'hooks' | 'model', number>>) => [o.you ?? 0, 0, o.hooks ?? 0, 0, 0, 0, o.model ?? 0]

test('a turn you held 30 s of is not unusual against earlier turns of 10-14 s', () => {
  expect(unusualOf(4, split({ you: 30_000, model: 5_000 }), 36_000, [10_000, 12_000, 14_000])).toBe(undefined)
  expect(unusualOf(4, split({ you: 5_000, model: 30_000 }), 36_000, [10_000, 12_000, 14_000])).toBe('#4 took 31.0s, 3× the usual') // your 5 s left out
})

test('the 10 s floor applies to the turn less your part', () => {
  expect(unusualOf(2, split({ you: 12_000, hooks: 6_000 }), 18_000, [])).toBe(undefined) // 6 s without you: never noted
  expect(unusualOf(2, split({ you: 2_000, hooks: 9_000 }), 12_000, [])).toBe('#2: hooks 9.0s of 10.0s') // of the turn less your part
})

test('your part never hides a hooks note: the largest part is picked from the rest', () => {
  expect(unusualOf(3, split({ you: 30_000, hooks: 9_000, model: 2_000 }), 41_000, [])).toBe('#3: hooks 9.0s of 11.0s')
})

test('the time before submit is not other: hooks over the rest of the turn get their note', () => {
  // 14 s: hooks 5, model 3, before submit 4, other 2. Counted as other, the 6 s would outweigh the hooks
  expect(unusualOf(5, split({ hooks: 5_000, model: 3_000 }), 14_000, [], 4_000)).toBe('#5: hooks 5.0s of 14.0s')
  expect(unusualOf(5, split({ hooks: 5_000, model: 3_000 }), 14_000, [])).toBe(undefined)
})

const T = Date.now() - 600_000
const turn = (i: number, ms: number, you?: number) => ({ t: T + i * 100_000, turn: i, kind: 'turn', name: 'turn', detail: '', outcome: '', status: 'ok', ms, split: you == null ? undefined : split({ you, model: ms - you }) })
const read = (i: number) => ({ t: T + 400_000 + i, turn: 3, kind: 'tool', name: 'Read', detail: `/x/${i}.ts`, outcome: 'ok', status: 'ok', ms: 10 })

test('"the usual" is the median of earlier turns less their stored `you` part; a turn with no split counts whole', async ($, on) => {
  const db = capture(on, 'UY', []) // the pane closed: the band shows the note
  // each 10 s without you: whole, 40 s would make the median 40 s and a 25 s turn usual
  db['r:UY'] = { entries: [turn(1, 40_000, 30_000), turn(2, 40_000, 30_000), turn(3, 10_000)], seen: {}, turn: 4, names: {} }
  on('ui.render', ($: any, e: any) => { const { Text } = $.ui.resolve(e) as any; return Text({ key: 'theirs', children: ['other mod'] }) })
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('turn.complete', () => ({ text: '' }))
  await ($ as any).session.start({ cwd: '/w', surface: 'terminal', isInteractive: true, source: 'resume' })
  await ($ as any).turn.complete({ reason: 'answer', answer: '', durationMs: 25_000, usage: undefined })
  const band = await $.ui.mount({ plugin: 'agent-log', surface: 'terminal', component: 'AbovePrompt', props: { isWorking: false, hasSurvey: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 } } as any })
  try { expect(await band.find({ text: /^#\d+ took 25\.0s, 3× the usual$/ })).toBeDefined() } finally { await band.unmount() }
})

test('a turn a full log evicted keeps its time less your part in the session\'s turn times', async ($, on) => {
  const db = capture(on, 'UE', [])
  db['r:UE'] = { entries: [turn(1, 40_000, 30_000), turn(2, 15_000), ...Array.from({ length: 298 }, (_, i) => read(i))], seen: {}, turn: 3, names: {} }
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  await ($ as any).session.start({ cwd: '/w', surface: 'terminal', isInteractive: true, source: 'resume' })
  for (let i = 0; i < 10; i++) await $.tool.call({ tool: 'Read', tool_use_id: `tu${i}`, file_path: `/y/${i}.ts` } as any)
  await $.session.end({ reason: 'other', sessionId: 'UE' } as any)
  expect(db['r:UE'].entries.some((x: any) => x.kind === 'turn')).toBe(false)
  expect(db['r:UE'].totals.turns).toEqual([10_000, 15_000])
})
