import { test, expect } from 'claude-code/testing'
import { STREAMING, splitOf, unusualOf } from './agent-log'

const x = (t: number, kind: string, ms: number | undefined, extra: object = {}) => ({ t, kind, name: 'Read', detail: '', outcome: '', ms, ...extra })

test('answering an AskUserQuestion or approving an ExitPlanMode plan splits as you, however its wait is labelled', () => {
  const turn = (extra: object) => [
    x(0, 'step', 5000), // 0-5000 model
    x(5000, 'tool', 100, { name: 'AskUserQuestion', wait: 60_000, ...extra }), // 5000-65000 you, then its run 65000-65100 tools
  ]
  expect(splitOf(turn({ waitFor: STREAMING }) as any, 0, 65_100)).toEqual([60_000, 0, 0, 0, 0, 100, 5000]) // what the engine labels most
  expect(splitOf(turn({}) as any, 0, 65_100)).toEqual([60_000, 0, 0, 0, 0, 100, 5000]) // a row logged before waitFor
  const plan = [x(0, 'step', 1000), x(1000, 'tool', 100, { name: 'ExitPlanMode', wait: 9000, waitFor: STREAMING })]
  expect(splitOf(plan as any, 0, 10_100)).toEqual([9000, 0, 0, 0, 0, 100, 1000])
})

test('a 5 s model and 60 s AskUserQuestion turn is not noted unusual', () => {
  const xs = [x(0, 'step', 5000), x(5000, 'tool', 100, { name: 'AskUserQuestion', wait: 60_000 })]
  // no earlier turns: the median rule leaving your time out is ticket 03's
  expect(unusualOf(2, splitOf(xs as any, 0, 65_100), 65_100, [])).toBe(undefined)
})

test('a foreground agent\'s question splits as you inside its Agent call', () => {
  const xs = [
    x(0, 'tool', 30_000, { name: 'Agent', child: 'A' }), // foreground: the call holds 0-30000
    x(1000, 'tool', 100, { name: 'AskUserQuestion', agent: 'A', wait: 20_000, waitFor: STREAMING }), // 1000-21000 you
    x(25_000, 'tool', 100, { name: 'ExitPlanMode', agent: 'A', wait: 10_000 }), // 25000-30000 you; past the call's end not counted
  ]
  expect(splitOf(xs as any, 0, 30_000)).toEqual([25_000, 0, 0, 0, 5000, 0, 0])
})
