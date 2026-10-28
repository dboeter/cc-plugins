import { test, expect } from 'claude-code/testing'
import { ASKED, splitOf } from './agent-log'
import { x } from './test-helpers' // a grandchild's rows carry its own id as agent

test('a foreground agent\'s permission prompt, decision waits and hooks split as main\'s own do', () => {
  const xs = [
    x(0, 'tool', 30_000, { name: 'Agent', child: 'A' }), // foreground: the call holds 0-30000
    x(1000, 'step', 1500, { agent: 'A' }), // its model: agents
    x(3000, 'tool', 1000, { name: 'Bash', agent: 'A', wait: 20_000, waitFor: ASKED }), // 3000-23000 you, then its run: agents
    x(24_000, 'tool', 500, { name: 'Edit', agent: 'A', wait: 1000, waitFor: 'the permission decision (config)' }), // 24000-25000 permission: no request of its closed inside
    x(26_000, 'hook', 500, { agent: 'A' }), // 25500-26000 hooks
    x(27_000, 'tool', 100, { name: 'Bash', agent: 'B', wait: 1000, waitFor: ASKED }), // a grandchild's prompt: 27000-28000 you
    x(28_500, 'tool', undefined, { name: 'Bash', agent: 'A', wait: 1000, waitFor: 'the auto-mode classifier', status: 'denied' }), // 28500-29500 permission
  ]
  expect(splitOf([...xs, x(26_500, 'tool', 1000, { name: 'Agent', agent: 'A', child: 'B' })] as any, 0, 30_000)).toEqual([21_000, 2000, 500, 0, 6500, 0, 0])
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

test('a subagent\'s decision wait during which its own request closed stays agents; a hook-decided or config wait without one is permission', () => {
  const agent = x(0, 'tool', 30_000, { name: 'Agent', child: 'A' })
  const wait = (extra: object) => x(10_000, 'tool', 100, { name: 'Edit', agent: 'A', wait: 5000, ...extra }) // 10000-15000
  const config = { waitFor: 'the permission decision (config)' }
  expect(splitOf([agent, x(9000, 'step', 3000, { agent: 'A' }), wait(config)] as any, 0, 30_000)).toEqual([0, 0, 0, 0, 30_000, 0, 0]) // its request closed at 12000
  expect(splitOf([agent, x(9000, 'step', 3000, { agent: 'B' }), wait(config)] as any, 0, 30_000)).toEqual([0, 5000, 0, 0, 25_000, 0, 0]) // another loop's request
  expect(splitOf([agent, wait(config)] as any, 0, 30_000)).toEqual([0, 5000, 0, 0, 25_000, 0, 0])
  expect(splitOf([agent, wait({ waitFor: 'the permission decision (hook)' })] as any, 0, 30_000)).toEqual([0, 5000, 0, 0, 25_000, 0, 0])
})
