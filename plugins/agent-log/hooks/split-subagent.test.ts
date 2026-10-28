import { test, expect } from 'claude-code/testing'
import { ASKED, splitOf } from './agent-log'

// main's Agent row carries the agent it spawned as child; that agent's rows carry it as agent (a grandchild's, its own id)
const x = (t: number, kind: string, ms: number | undefined, extra: object = {}) => ({ t, kind, name: 'Read', detail: '', outcome: '', ms, ...extra })

test('a foreground agent\'s permission prompt, decision wait and hooks split as main\'s own do, not as agents', () => {
  const xs = [
    x(0, 'tool', 30_000, { name: 'Agent', child: 'A' }), // foreground: the call holds 0-30000
    x(1000, 'step', 2000, { agent: 'A' }), // its model: agents
    x(3000, 'tool', 1000, { name: 'Bash', agent: 'A', wait: 20_000, waitFor: ASKED }), // 3000-23000 you, then its run: agents
    x(24_000, 'tool', 500, { name: 'Edit', agent: 'A', wait: 1000, waitFor: 'the permission decision (config)' }), // 24000-25000 permission
    x(26_000, 'hook', 500, { agent: 'A' }), // 25500-26000 hooks
    x(27_000, 'tool', 100, { name: 'Bash', agent: 'B', wait: 1000, waitFor: ASKED }), // a grandchild's prompt: 27000-28000 you
  ]
  expect(splitOf([...xs, x(26_500, 'tool', 1000, { name: 'Agent', agent: 'A', child: 'B' })] as any, 0, 30_000)).toEqual([21_000, 1000, 500, 0, 7500, 0, 0])
})

test('a background agent adds nothing to main\'s turn: its call returns at once', () => {
  const xs = [
    x(0, 'step', 1000),
    x(1000, 'tool', 50, { name: 'Agent', child: 'A' }), // background: the call returns after 50 ms
    x(1050, 'step', 3950), // main goes on
    x(2000, 'tool', 100, { name: 'Bash', agent: 'A', wait: 20_000, waitFor: ASKED }),
    x(3000, 'hook', 500, { agent: 'A' }),
  ]
  expect(splitOf(xs as any, 0, 5000)).toEqual([0, 0, 0, 0, 50, 0, 4950])
})

test('a subagent\'s wait counts only inside the turn and its Agent call', () => {
  const xs = [
    x(0, 'tool', 10_000, { name: 'Agent', wait: 2000, waitFor: ASKED, child: 'A' }), // 0-2000 you on the Agent call itself, 2000-12000 the call
    x(3000, 'hook', 2000, { agent: 'A' }), // 1000-3000: starts before the call runs: 2000-3000 hooks
    x(11_000, 'tool', 100, { name: 'Bash', agent: 'A', wait: 5000, waitFor: ASKED }), // 11000-12000 you; its wait past the call's end is not counted
    x(0, 'hook', 100, { agent: 'C' }), // a loop no Agent row started (a plugin's fork): not counted
  ]
  expect(splitOf(xs as any, 0, 20_000)).toEqual([3000, 0, 1000, 0, 8000, 0, 0])
})
