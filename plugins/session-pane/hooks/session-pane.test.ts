import { test, expect, mock } from 'claude-code/testing'

const PROPS = (cols: number) => ({ title: 'Session', isFocused: true, bodyColumns: cols, placement: 'dock', scroll: { offset: 0, bodyRows: 60 } }) as any

test('events fold into the pane; /session-pane opens it, nothing opens it unasked; pages navigate', async ($, on) => {
  const store: Record<string, unknown> = {}
  const opened: unknown[] = []
  const clock = mock.clock(on)
  on('session.id', () => ({ value: 'S1' }))
  on('session.messages', () => ({ value: [] }) as any)
  on('store.get', (_$, e: any) => ({ value: store[e.key] }) as any)
  on('store.set', (_$, e: any) => { store[e.key] = e.value; return { value: undefined } as any })
  // a shell edit: the repo has a file dirty from before, one the sed call wrote and one written after the call ended
  let sedAt = 0
  on('process.run', (_$, e: any) => ({ value: { exitCode: 0, stdout: e.argv[1] === 'rev-parse' ? '/w\n' : 'old.ts\0sed.ts\0late.ts\0', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as any)
  on('fs.stat', (_$, e: any) => ({ value: { kind: 'file', size: 1, mtimeMs: e.path === '/w/sed.ts' ? sedAt : e.path === '/w/late.ts' ? Date.now() + 60_000 : 0, isLink: false } }) as any)
  on('model.complete', () => ({ value: { isAnswered: true, text: '{"changed":true,"title":"Confirm before deleting","keep":["No new dependencies"],"done":""}', usage: {} } }) as any)
  on('ui.open', (_$, e) => { opened.push(e); return { value: { isPlaced: true } } as any })
  on('ui.panes', () => ({ value: [] }))
  on('command.register', () => ({ value: undefined }) as any)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000, tokens: 500, percent: 50, breakdown: { categories: [{ name: 'System prompt', tokens: 300, kind: 'used', color: 'promptBorder', isDeferred: false }, { name: 'Messages', tokens: 200, kind: 'used', color: 'claude', isDeferred: false }] } }, rateLimits: [] } }) as any)
  on('tool.call', (_$, e: any) => e.tool === 'Write'
    ? { result: { type: 'create', filePath: e.file_path, content: 'x', structuredPatch: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+x'] }], originalFile: null }, text: 'ok' } as any
    : e.command.startsWith('sed') ? (sedAt = Date.now(), { result: {}, text: '' } as any)
    : { result: {}, text: 'Exit code 1\n FAIL a.test.ts', isError: true } as any)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  expect(opened.length).toBe(0) // never unasked
  await $.prompt.submit({ text: 'Add a confirmation step before deleting a project', wait: false, origin: { kind: 'composer' } } as any).catch(() => {})
  await $.tool.call({ tool: 'Write', tool_use_id: 'w1', file_path: '/w/confirm.tsx', content: 'x' } as any)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b0', command: 'sed -i s/a/b/ sed.ts', description: 'Patch' } as any)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'npm test', description: 'Run tests' } as any)
  await clock.advance(2000) // flush: state written, goal call started
  await clock.advance(2000) // the goal call's answer lands

  const r: any = await $.command.run({ command: 'session-pane', args: '' } as any)
  expect(String(r?.text)).toBe('Session pane shown')
  expect(opened.length).toBe(1)

  const p = await $.ui.mount({ plugin: 'session-pane', surface: 'terminal', component: 'Pane', requestId: 'session-pane', props: PROPS(44) })
  expect(await p.find({ text: /Confirm before deleting ›/ })).toBeDefined()
  expect(await p.find({ text: /Tests failed · needs your input/ })).toBeDefined()
  expect(await p.find({ text: /2 files changed ›/ })).toBeDefined()
  expect(await p.find({ text: /tokens/i })).toBe(undefined) // no token counts on the overview

  await p.press({ key: 'goal' })
  expect(await p.find({ text: /No new dependencies/ })).toBeDefined()
  expect(await p.find({ text: /From: Your opening message/ })).toBeDefined()
  await p.press({ key: 'back' })

  await p.press({ key: 'chg' })
  expect(await p.find({ text: /New\s+\/w\/confirm\.tsx/ })).toBeDefined()
  expect(await p.find({ text: /Edited \/w\/sed\.ts \(by a command\)/ })).toBeDefined()
  expect(await p.find({ text: /old\.ts/ })).toBe(undefined) // dirty before the call: not its doing
  expect(await p.find({ text: /late\.ts/ })).toBe(undefined) // written after the call ended: not its doing either
  expect(await p.find({ text: /Browser review: not done/ })).toBeDefined()
  await p.press({ key: 'f-/w/confirm.tsx' })
  expect(await p.find({ type: 'Code' })).toBeDefined()
  await p.press({ key: 'back' })
  await p.press({ key: 'back' })

  await p.press({ key: 'ctx' })
  expect(await p.find({ text: /Conversation \(estimate\)/ })).toBeDefined()
  expect(await p.find({ text: /Instructions/ })).toBeDefined()
  expect(await p.find({ text: /\/w\/confirm\.tsx/ })).toBeDefined()
})

test('nearly full: a recap is drafted by a fork, reviewed, then handed to the compaction', async ($, on) => {
  const compacted: any[] = []
  const clock = mock.clock(on)
  on('session.id', () => ({ value: 'S2' }))
  on('session.messages', () => ({ value: [] }) as any)
  on('store.get', () => ({ value: undefined }) as any)
  on('store.set', () => ({ value: undefined }) as any)
  on('ui.open', () => ({ value: { isPlaced: true } }) as any)
  on('ui.panes', () => ({ value: [] }))
  on('command.register', () => ({ value: undefined }) as any)
  on('model.fork', () => ({ value: { isAnswered: true, text: 'Goal: confirm before deleting\nStill to do: tests', usage: {} } }) as any)
  on('session.compact', (_$, e: any) => { compacted.push(e); return { messages: [{ role: 'user', text: 'Summary', toolUses: [] }] } as any })
  on('session.measure', () => ({ changed: ['context'] }) as any)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.session.measure({ context: { window: 1000, tokens: 900, percent: 90 }, rateLimits: [{ kind: 'five_hour', percentUsed: 10 }], changed: ['context'] } as any).catch(() => {})
  await clock.advance(2000)
  const p = await $.ui.mount({ plugin: 'session-pane', surface: 'terminal', component: 'Pane', requestId: 'session-pane', props: PROPS(44) })
  expect(await p.find({ text: /Nearly full · 90%/ })).toBeDefined()
  await p.press({ key: 'recap' })
  await p.press({ key: 'draft' })
  expect(await p.find({ text: /Still to do: tests/ })).toBeDefined()
  await p.press({ key: 'use' })
  expect(compacted.length).toBe(1)
  expect(compacted[0].instructions).toMatch(/Goal: confirm before deleting/)
  expect(await p.find({ text: /summarised with this recap/ })).toBeDefined()
  await clock.advance(2000) // the pane's own compaction folds in like any other
  await p.press({ key: 'back' })
  await p.press({ key: 'ctx' })
  expect(await p.find({ text: /Earlier conversation summary/ })).toBeDefined()
})

test('a /clear starts the pane over on the new session; a real exit stops the clock', async ($, on) => {
  const store: Record<string, any> = {}
  const clock = mock.clock(on)
  let id = 'S1'
  on('session.id', () => ({ value: id }))
  on('session.messages', () => ({ value: [] }) as any)
  on('store.get', (_$, e: any) => ({ value: store[e.key] }) as any)
  on('store.set', (_$, e: any) => { store[e.key] = e.value; return { value: undefined } as any })
  on('model.complete', (_$, e: any) => ({ value: { isAnswered: true, text: JSON.stringify({ changed: true, title: /Second/.test(e.prompt) ? 'Second goal' : 'First goal', keep: [], done: '' }), usage: {} } }) as any)
  on('command.register', () => ({ value: undefined }) as any)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e: any) => ({ sessionId: e.sessionId }) as any)
  const say = (text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as any).catch(() => {})

  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await say('First session goal here please')
  await clock.advance(2000)
  await clock.advance(2000)
  const p = await $.ui.mount({ plugin: 'session-pane', surface: 'terminal', component: 'Pane', requestId: 'session-pane', props: PROPS(44) })
  expect(await p.find({ text: /First goal ›/ })).toBeDefined()

  await $.session.end({ reason: 'clear', sessionId: 'S1', resume: { id: 'S1' } } as any) // no session.start follows
  id = 'S2'
  await say('Second session goal entirely different')
  await clock.advance(2000) // restores S2
  await clock.advance(2000) // its goal call's answer lands
  expect(await p.find({ text: /Second goal ›/ })).toBeDefined()
  expect(await p.find({ text: /First goal/ })).toBe(undefined)
  expect(store['snap:S1']?.goal?.title).toBe('First goal')
  expect(store['snap:S2']?.prompts).toBe(1)

  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'S2', resume: { id: 'S2' } } as any)
  await say('Said after the exit')
  await clock.advance(2000)
  expect(store['snap:S2']?.prompts).toBe(1) // the clock stopped: nothing written
})

test("a resumed session with no snapshot is rebuilt from its transcript, and its draft goal condensed", async ($, on) => {
  const clock = mock.clock(on)
  let asked = 0
  on('session.id', () => ({ value: 'S3' }))
  on('session.messages', () => ({ value: [{ role: 'user', text: 'Add a confirmation step before deleting a project', toolUses: [] }] }) as any)
  on('store.get', () => ({ value: undefined }) as any)
  on('store.set', () => ({ value: undefined }) as any)
  on('command.register', () => ({ value: undefined }) as any)
  on('model.complete', () => { asked++; return { value: { isAnswered: true, text: '{"changed":true,"title":"Confirm before deleting","keep":[],"done":""}', usage: {} } } as any })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await clock.advance(2000)
  await clock.advance(2000)
  expect(asked).toBe(1)
  const p = await $.ui.mount({ plugin: 'session-pane', surface: 'terminal', component: 'Pane', requestId: 'session-pane', props: PROPS(44) })
  expect(await p.find({ text: /Confirm before deleting ›/ })).toBeDefined()
})

test('details: the cost off a subscription, the plan limits on one', async ($, on) => {
  const clock = mock.clock(on)
  let limits: any[] = []
  on('session.id', () => ({ value: 'S4' }))
  on('session.messages', () => ({ value: [] }) as any)
  on('store.get', () => ({ value: undefined }) as any)
  on('store.set', () => ({ value: undefined }) as any)
  on('command.register', () => ({ value: undefined }) as any)
  on('session.model', () => ({ value: 'claude-opus-5-5' }) as any)
  on('session.usage', () => ({ value: { startedAt: Date.UTC(2026, 9, 12, 9), context: { window: 1000, tokens: 100, percent: 10 }, rateLimits: limits, cost: { usd: 1.2 } } }) as any)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await clock.advance(2000)
  const p = await $.ui.mount({ plugin: 'session-pane', surface: 'terminal', component: 'Pane', requestId: 'session-pane', props: PROPS(44) })
  await p.press({ key: 'details' })
  expect(await p.find({ text: /Model: claude-opus-5-5/ })).toBeDefined()
  expect(await p.find({ text: /Started: / })).toBeDefined()
  expect(await p.find({ text: /Cost so far: \$1\.20/ })).toBeDefined()
  limits = [{ kind: 'five_hour', percentUsed: 10 }]
  await p.press({ key: 'back' })
  await p.press({ key: 'details' })
  expect(await p.find({ text: /Plan limit \(five_hour\): 10% used/ })).toBeDefined()
  expect(await p.find({ text: /On a subscription/ })).toBeDefined()
  expect(await p.find({ text: /Cost so far/ })).toBe(undefined)
})
