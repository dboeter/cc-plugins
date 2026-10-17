import { test, expect } from 'claude-code/testing'
import { actionOf, ago, groupOf, infoOf, killOf, statusOf, type HerdrAgent, type Session } from './session-tree'

const s = (sessionId: string, cwd: string, startedAt: number): Session => ({ sessionId, cwd, startedAt, name: sessionId, kind: 'interactive', status: 'idle' })

test('sessions group under their repo root, roots by path, newest first', () => {
  const roots: Record<string, string> = { '/r/b': '/r/b', '/r/b/sub': '/r/b', '/r/a': '/r/a' }
  const groups = groupOf([s('1', '/r/b', 1), s('2', '/r/a', 2), s('3', '/r/b/sub', 3)], cwd => roots[cwd])
  expect(groups.map(g => [g.root, g.sessions.map(x => x.sessionId)])).toEqual([['/r/a', ['2']], ['/r/b', ['3', '1']]])
})

test('state and status read as herdr statuses', () => {
  expect(statusOf({ ...s('1', '/', 0), status: 'busy' })).toBe('working')
  expect(statusOf({ ...s('1', '/', 0), status: 'idle' })).toBe('idle')
  expect(statusOf({ ...s('1', '/', 0), pid: 7, kind: 'background', status: 'idle', state: 'done' })).toBe('done') // a finished background session keeps its status beside its state
  expect(statusOf({ ...s('1', '/', 0), pid: 7, kind: 'background', status: undefined, state: 'paused' })).toBe('unknown')
  expect(statusOf({ ...s('1', '/', 0), kind: 'background', status: undefined, state: 'blocked' })).toBe('exited') // no pid: its last state is stale
})

test('a transcript tail gives the latest branch, model, typed prompt and reply', () => {
  const rows = [
    { type: 'user', gitBranch: 'main', timestamp: '2026-10-12T10:00:00Z', message: { content: 'first ask' } },
    { type: 'assistant', timestamp: '2026-10-12T10:01:00Z', message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use' }, { type: 'text', text: 'Done.\nmore' }] } },
    { type: 'user', isMeta: true, message: { content: 'caveat' } },
    { type: 'user', message: { content: '<command-name>/clear</command-name>' } },
    { type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: '' }] } },
    { type: 'user', gitBranch: 'feat', timestamp: '2026-10-12T10:05:00Z', message: { content: 'second ask' } },
  ]
  const tail = '{"cut off mid-row\n' + rows.map(r => JSON.stringify(r)).join('\n')
  expect(infoOf(tail)).toEqual({ branch: 'feat', model: 'claude-opus-5-5', lastPrompt: 'second ask', lastReply: 'Done.\nmore', activeAt: Date.parse('2026-10-12T10:05:00Z') })
})

test('a running background session is stopped, an exited one removed, an interactive one killed, this one never', () => {
  const bg: Session = { id: 'aa', cwd: '/', kind: 'background', startedAt: 0, sessionId: 'BG', name: 'bg' }
  expect(killOf({ ...bg, pid: 7 }, 'ME')).toBe('stop')
  expect(killOf(bg, 'ME')).toBe('rm')
  expect(killOf({ ...s('T', '/', 0), pid: 9 }, 'ME')).toBe('kill')
  expect(killOf(s('T', '/', 0), 'ME')).toBe(undefined) // no pid to signal
  expect(killOf({ ...s('ME', '/', 0), pid: 9 }, 'ME')).toBe(undefined)
})

test('age reads in the largest whole unit', () => {
  expect(ago(0, 59 * 60_000)).toBe('59m')
  expect(ago(0, 3 * 3_600_000)).toBe('3h')
  expect(ago(0, 2 * 86_400_000)).toBe('2d')
})

test('the pane draws herdr-agent-tree rows: a repo per group, a glyph per status, ▶ on this session; a folded group sums them up', async ($, on) => {
  const list: Session[] = [
    { pid: 7, id: 'aa', cwd: '/r/b', kind: 'background', startedAt: 1, sessionId: 'B1', name: 'bg job', state: 'blocked' },
    { pid: 1, cwd: '/r/b/sub', kind: 'interactive', startedAt: 2, sessionId: 'B2', name: 'this one', status: 'busy' },
    { pid: 9, cwd: '/r/c', kind: 'interactive', startedAt: 3, sessionId: 'C1', name: 'other one', status: 'idle' },
  ]
  const ran: string[] = []
  const tail = JSON.stringify({ type: 'user', gitBranch: 'main', message: { content: 'fix the thing' } })
  on('session.id', () => ({ value: 'B2' }))
  on('process.run', ($, e) => {
    ran.push(e.argv.join(' '))
    const out = { claude: JSON.stringify(list), git: e.argv[2] === '/r/c' ? '/r/c\n' : '/r/b\n', find: '/p/B1.jsonl\n', tail }[e.argv[0]] ?? ''
    return { value: { exitCode: 0, stderr: '', stdout: e.argv[1] === 'agents' || e.argv[0] !== 'claude' ? out : '' } } as any
  })
  const m = await $.ui.mount({ plugin: 'session-tree', surface: 'terminal', component: 'Pane', requestId: 'session-tree', props: { title: 'Sessions', isFocused: false, bodyColumns: 41, placement: 'dock', scroll: { offset: 0, bodyRows: 40 } } as any })
  expect(await m.find({ type: 'Button', text: /^1  b$/ })).toBeDefined() // open: the rows carry the statuses
  expect(await m.find({ type: 'Button', text: /^▶ ├ ◐ this one$/ })).toBeDefined()
  expect(await m.find({ type: 'Button', text: /^ {2}└ ● bg job$/ })).toBeDefined()
  expect(await m.find({ text: /^3 sessions$/ })).toBeDefined()
  await m.press({ key: 'f/r/b' })
  expect(await m.find({ type: 'Button', text: /^1  b ● 1 ◐ 1$/ })).toBeDefined() // folded: the counts sum up the hidden rows
  expect(await m.find({ type: 'Button', text: /bg job/ })).toBe(undefined)
  await m.press({ key: 'f/r/b' }) // module state: unfolded again for any test below
  // ⋯ opens the info block; stop takes two presses
  expect(await m.find({ type: 'Button', text: /^stop$/ })).toBe(undefined)
  await m.press({ key: 'iB1' })
  expect(await m.find({ text: /^ {6}id aa · pid 7 · background$/ })).toBeDefined() // the last row: no rail below it
  expect(await m.find({ text: /^ {6}main$/ })).toBeDefined()
  expect(await m.find({ text: /^ {6}› fix the thing$/ })).toBeDefined()
  expect(await m.find({ type: 'Button', text: /^stop$/ })).toBeDefined()
  await m.press({ key: 'kB1' })
  expect(await m.find({ type: 'Button', text: /^press again to stop$/ })).toBeDefined()
  expect(ran.some(c => c.startsWith('claude stop'))).toBe(false)
  await m.press({ key: 'kB1' })
  expect(ran).toContain('claude stop aa')
  expect(await m.find({ text: /id aa/ })).toBe(undefined) // stopped: the block closes
  // an interactive session is killed by its pid, re-read from the list first; this session has no kill
  await m.press({ key: 'iB2' })
  expect(await m.find({ type: 'Button', key: 'kB2' })).toBe(undefined)
  await m.press({ key: 'iC1' })
  await m.press({ key: 'kC1' })
  expect(await m.find({ type: 'Button', text: /^press again to kill$/ })).toBeDefined()
  await m.press({ key: 'kC1' })
  expect(ran).toContain('kill -TERM 9')
})

test('a press focuses the herdr pane a session runs in, else attaches a background one in a new tab', () => {
  const pane = (sessionId: string, pane_id: string, workspace_id: string, cwd: string): HerdrAgent => ({ agent_session: { value: sessionId }, pane_id, workspace_id, cwd })
  const bg: Session = { id: 'aa', cwd: '/r/b/sub', kind: 'background', startedAt: 1, sessionId: 'BG', name: 'bg job', state: 'blocked' }
  const term = s('T', '/r/c', 1)
  const herdr = [pane('ME', 'w1:p1', 'w1', '/r/a'), pane('T', 'w2:p4', 'w2', '/r/c')]
  expect(actionOf(s('ME', '/r/a', 1), 'ME', '/r/a', herdr)).toEqual({ kind: 'here' })
  expect(actionOf(term, 'ME', '/r/c', herdr)).toEqual({ kind: 'focus', pane: 'w2:p4' })
  expect(actionOf(bg, 'ME', '/r/b', [...herdr, pane('BG', 'w3:p9', 'w3', '/r/b')])).toEqual({ kind: 'focus', pane: 'w3:p9' }) // attached in a pane already
  expect(actionOf(bg, 'ME', '/r/b', herdr)).toEqual({ kind: 'attach', workspace: 'w1' }) // no pane in its repo: our workspace
  expect(actionOf(bg, 'ME', '/r/b', [...herdr, pane('X', 'w5:p2', 'w5', '/r/b')])).toEqual({ kind: 'attach', workspace: 'w5' }) // a pane in its repo: that one's
  expect(actionOf(bg, 'ME', '/r/b', [])).toEqual({ kind: 'copy' }) // this session in no herdr pane
  expect(actionOf(term, 'ME', '/r/c', [herdr[0]])).toEqual({ kind: 'elsewhere' }) // an interactive session in another terminal
})
