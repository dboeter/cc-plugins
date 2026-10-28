// The engine's turn starts before the prompt submit agent-log sees: that stretch is the turn row's preSubmit, drawn as `before submit`.
// The module's state is shared, as in agent-log.test.ts
import { test, expect } from 'claude-code/testing'
import { capture, pane, wait } from './test-helpers'

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
  const m = await pane($, 120)
  try {
    await $.session.end({ reason: 'other', sessionId: 'PS' } as any)
    const y = db['r:PS'].entries.find((x: any) => x.kind === 'turn' && !x.agent)
    expect(y.preSubmit).toBeGreaterThanOrEqual(1950)
    expect(y.preSubmit).toBeLessThanOrEqual(2000 + (t1 - t0))
    await m.press({ key: `bturn${y.turn}` }) // the inspector's whole split
    expect(await m.find({ text: /^before submit 2\.0s\b/ })).toBeDefined()
    expect(await m.find({ text: /other \d/ })).toBeUndefined() // nothing else in the turn: none of the 2 s is other
  } finally { await m.unmount() }
})

test('a turn stored before preSubmit existed still draws, its time before submit in other', async ($, on) => {
  const db = capture(on, 'PO')
  const T = Date.now() - 600_000
  db['r:PO'] = { entries: [{ t: T, turn: 1, kind: 'turn', name: 'turn', detail: '', outcome: '', status: 'ok', ms: 3000, split: [0, 0, 0, 0, 0, 0, 1000] }], seen: {}, turn: 1, names: {} }
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  await ($ as any).session.start({ cwd: '/w', surface: 'terminal', isInteractive: true, source: 'resume' })
  const m = await pane($, 120)
  try {
    await m.press({ key: 'bturn1' })
    expect(await m.find({ text: /^other 2\.0s · model 1\.0s\b/ })).toBeDefined()
  } finally { await m.unmount() }
})

test('the turn\'s start is its end, read as turn.complete arrives, less its duration: a slow handler after it takes nothing off before submit', async ($, on) => {
  const db = capture(on, 'PL')
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
  on('turn.complete', async () => { await wait(500); return { text: '' } })
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  await ($ as any).session.start({ cwd: '/w', surface: 'terminal', isInteractive: true, source: 'startup' })
  const t0 = Date.now()
  await $.prompt.submit({ text: 'Say hi', origin: { kind: 'composer' }, wait: false } as any)
  const t1 = Date.now()
  await $.tool.call({ tool: 'Read', tool_use_id: 'tl1', file_path: '/w/a.ts' } as any)
  await ($ as any).turn.complete({ reason: 'answer', answer: '', durationMs: Date.now() - t0 + 1000, usage: undefined })
  await $.session.end({ reason: 'other', sessionId: 'PL' } as any)
  const y = db['r:PL'].entries.find((x: any) => x.kind === 'turn' && !x.agent)
  expect(y.preSubmit).toBeGreaterThanOrEqual(950) // the engine's 1 s before the submit, not less the 500 ms the next handler took after the end
  expect(y.preSubmit).toBeLessThanOrEqual(1000 + (t1 - t0))
})

test('a turn stored before its split was kept still draws one, counted from its rows', async ($, on) => {
  const db = capture(on, 'PN')
  const T = Date.now() - 600_000
  // no split, no time before submit, no totals: a store from before this split was kept
  db['r:PN'] = { entries: [
    { t: T - 3000, turn: 1, kind: 'step', name: 'claude-opus-5-5', detail: '', outcome: '', status: 'ok', ms: 1000 },
    { t: T, turn: 1, kind: 'turn', name: 'turn', detail: '', outcome: '', status: 'ok', ms: 3000 },
  ], seen: {}, turn: 1, names: {} }
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  await ($ as any).session.start({ cwd: '/w', surface: 'terminal', isInteractive: true, source: 'resume' })
  const m = await pane($, 120)
  try {
    expect(await m.find({ text: /other 2\.0s · model 1\.0s$/ })).toBeDefined() // the header's two largest parts
    await m.press({ key: 'bturn1' })
    expect(await m.find({ text: /^other 2\.0s · model 1\.0s\b/ })).toBeDefined()
  } finally { await m.unmount() }
})
