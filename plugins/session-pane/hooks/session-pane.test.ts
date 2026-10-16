import { test, expect, mock } from 'claude-code/testing'

// waits out the current millisecond: an edit and a check stamped in the same one would leave the check fresh
const tick = () => { const t = Date.now(); while (Date.now() === t) {} }
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
  let asked = 0
  on('model.complete', () => { asked++; return { value: { isAnswered: false, reason: 'unexpected' } } as any })
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
  await clock.advance(2000) // flush: state written
  expect(asked).toBe(0) // no model call of its own, ever

  const r: any = await $.command.run({ command: 'session-pane', args: '' } as any)
  expect(String(r?.text)).toBe('Session pane shown')
  expect(opened.length).toBe(1)

  const p = await $.ui.mount({ plugin: 'session-pane', surface: 'terminal', component: 'Pane', requestId: 'session-pane', props: PROPS(44) })
  expect(await p.find({ text: /Tests failed$/ })).toBeDefined() // Right now: a failure needs you
  expect(await p.find({ key: 'chg' })).toBeDefined()
  expect(await p.find({ text: /2 files/ })).toBeDefined() // the count on the Changes rule
  expect(await p.find({ text: /tokens/i })).toBe(undefined) // no token counts on the overview

  await p.press({ key: 'chg' })
  expect(await p.find({ text: /^New\s+confirm\.tsx$/ })).toBeDefined()
  expect(await p.find({ text: /^Edited\s+sed\.ts \(by a command\)$/ })).toBeDefined()
  expect(await p.find({ text: /old\.ts/ })).toBe(undefined) // dirty before the call: not its doing
  expect(await p.find({ text: /late\.ts/ })).toBe(undefined) // written after the call ended: not its doing either
  expect(await p.find({ text: /Not done. Checks don't show how the page looks/ })).toBeDefined()
  await p.press({ key: 'f-/w/confirm.tsx' })
  expect((await p.find({ type: 'Code' }))?.props.source).toBe('@@ -0,0 +1,1 @@\n+x') // counted: Code's diff format parses no other header
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
  expect(await p.find({ text: /90% used, nearly full/ })).toBeDefined()
  expect((await p.find({ type: 'Text', text: /^[█░]+$/ }))?.text.length).toBe(44) // the bar spans the column
  await p.press({ key: 'recap' })
  await p.press({ key: 'draft' })
  expect(await p.find({ text: /Still to do: tests/ })).toBeDefined()
  expect((await p.find({ type: 'Markdown' }))?.props.text).toMatch(/^Goal: confirm/) // drawn as Claude's replies are
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
  on('command.register', () => ({ value: undefined }) as any)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e: any) => ({ sessionId: e.sessionId }) as any)
  const say = (text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as any).catch(() => {})

  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await say('First session, first message')
  await say('First session, second message')
  await clock.advance(2000)
  expect(store['snap:S1']?.prompts).toBe(2)

  await $.session.end({ reason: 'clear', sessionId: 'S1', resume: { id: 'S1' } } as any) // no session.start follows
  id = 'S2'
  await say('Second session, its only message')
  await clock.advance(2000) // restores S2
  await clock.advance(2000)
  expect(store['snap:S1']?.prompts).toBe(2) // left as it was
  expect(store['snap:S2']?.prompts).toBe(1) // starts over: nothing of S1 carried in

  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'S2', resume: { id: 'S2' } } as any)
  await say('Said after the exit')
  await clock.advance(2000)
  expect(store['snap:S2']?.prompts).toBe(1) // the clock stopped: nothing written
})

test("a resumed session with no snapshot is rebuilt from its transcript", async ($, on) => {
  const clock = mock.clock(on)
  on('session.id', () => ({ value: 'S3' }))
  on('session.messages', () => ({ value: [{ role: 'user', text: 'Add a confirmation step before deleting a project', toolUses: [] }] }) as any)
  on('store.get', () => ({ value: undefined }) as any)
  on('store.set', () => ({ value: undefined }) as any)
  on('command.register', () => ({ value: undefined }) as any)
  on('session.usage', () => ({ value: { context: { window: 1000, tokens: 1, percent: 1 }, rateLimits: [] } }) as any)
  on('session.model', () => ({ value: 'opus' }) as any)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await clock.advance(2000)
  const p = await $.ui.mount({ plugin: 'session-pane', surface: 'terminal', component: 'Pane', requestId: 'session-pane', props: PROPS(44) })
  await p.press({ key: 'details' })
  expect(await p.find({ text: /^Messages\s*1$/ })).toBeDefined()
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
  expect(await p.find({ text: /claude-opus-5-5/ })).toBeDefined()
  expect(await p.find({ text: /ago$/ })).toBeDefined()
  expect(await p.find({ text: /\$1\.20 so far/ })).toBeDefined()
  limits = [{ kind: 'five_hour', percentUsed: 10, resetsAt: new Date(Date.now() + 61 * 60_000).toISOString() }]
  await p.press({ key: 'back' })
  await p.press({ key: 'details' })
  expect(await p.find({ text: /5-hour limit/ })).toBeDefined()
  expect(await p.find({ text: /^10% used, resets in 1 hour$/ })).toBeDefined()
  expect(await p.find({ text: /so far/ })).toBe(undefined)
})

test('turns left before auto-compact: worded on the overview, singular for one, hidden without an estimate', async ($, on) => {
  const clock = mock.clock(on)
  let total = 0
  let enabled = true
  on('session.id', () => ({ value: 'S5' }))
  on('session.messages', () => ({ value: [] }) as any)
  on('store.get', () => ({ value: undefined }) as any)
  on('store.set', () => ({ value: undefined }) as any)
  on('command.register', () => ({ value: undefined }) as any)
  on('session.usage', () => ({ value: { context: { window: 200_000, tokens: total, percent: total / 2000, breakdown: { categories: [], totalTokens: total, isAutoCompactEnabled: enabled, autoCompactThreshold: enabled ? 160_000 : undefined } }, rateLimits: [] } }) as any)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  const turn = async (t: number) => { total = t; await $.turn.complete({ reason: 'answer', answer: '' } as any).catch(() => {}); await clock.advance(2000) }
  const p = await $.ui.mount({ plugin: 'session-pane', surface: 'terminal', component: 'Pane', requestId: 'session-pane', props: PROPS(44) })
  await turn(100_000); await turn(110_000)
  expect(await p.find({ text: /Right now/ })).toBe(undefined) // nothing needs you: no block
  expect(await p.find({ text: /Summarising/ })).toBe(undefined) // one growth: no estimate yet
  await turn(120_000)
  expect(await p.find({ text: /^Summarising in ~4 turns$/ })).toBeDefined()
  await turn(145_000) // growths 10k, 10k, 25k: median 10k, 15k left
  expect(await p.find({ text: /^Summarising in ~1 turn$/ })).toBeDefined()
  await turn(158_000) // median 11.5k, 2k left
  expect(await p.find({ text: /^Summarising any moment$/ })).toBeDefined()
  enabled = false
  await turn(159_000)
  expect(await p.find({ text: /Summarising/ })).toBe(undefined) // off: nothing, not 0
})

test('hidden pane: the band and one toast between turns say a check failed; the spinner warns of auto-compact', async ($, on) => {
  const clock = mock.clock(on)
  const toasts: string[] = []
  let total = 0
  let panes: { id: string }[] = []
  on('session.id', () => ({ value: 'S6' }))
  on('session.messages', () => ({ value: [] }) as any)
  on('store.get', () => ({ value: undefined }) as any)
  on('store.set', () => ({ value: undefined }) as any)
  on('command.register', () => ({ value: undefined }) as any)
  on('ui.toast', (_$, e) => { toasts.push(e.text); return { value: undefined } as any })
  on('ui.open', () => { panes = [{ id: 'session-pane' }]; return { value: { isPlaced: true } } as any })
  on('ui.close', () => { panes = []; return { value: undefined } as any })
  on('ui.panes', () => ({ value: panes }) as any)
  on('session.usage', () => {
    const tokens = total
    return { value: { context: { window: 200_000, tokens, percent: tokens / 2000, breakdown: { categories: [], totalTokens: tokens, isAutoCompactEnabled: true, autoCompactThreshold: 160_000 } }, rateLimits: [] } } as any
  })
  on('tool.call', () => ({ result: {}, text: 'Exit code 1\n FAIL a.test.ts', isError: true }) as any)
  // beneath the plugins: the band holds another mod's line; the spinner draws its word and suffix
  on('ui.render', ($, e: any) => {
    const { Text } = $.ui.resolve(e) as any
    return e.component === 'Spinner' ? Text({ key: 'spin', children: [e.props.word + e.props.suffix] }) : Text({ key: 'theirs', children: ['other mod'] })
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  const BAND = { isWorking: false, hasSurvey: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 } } as any
  const band = await $.ui.mount({ plugin: 'session-pane', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ text: /Session/ })).toBe(undefined) // nothing needs you: no band

  await $.turn.start({ turnId: 't1' } as any).catch(() => {})
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'npm test', description: 'Run tests' } as any)
  await clock.advance(2000)
  expect(toasts.length).toBe(0) // mid-turn: Claude's to fix
  const turn = async (t: number) => { total = t; await $.turn.complete({ reason: 'answer', answer: '' } as any).catch(() => {}); await clock.advance(2000) }
  await turn(100_000)
  expect(toasts).toEqual(['Tests failed: /session-pane shows what failed'])
  expect(await band.find({ text: /✗ Tests failed/ })).toBeDefined()
  expect(await band.find({ text: /^other mod$/ })).toBeDefined() // another mod's line stays, under ours
  expect(await band.find({ text: /^\/session-pane ✗ Tests failed$/ })).toBeDefined() // the way in first
  await turn(130_000); await turn(150_000)
  expect(toasts.length).toBe(1) // still failing: announced once

  // growths 30k, 20k: median 25k, 10k left -> any moment
  const spin = await $.ui.mount({ plugin: 'session-pane', surface: 'terminal', component: 'Spinner', props: { word: 'Working', message: null, suffix: '…', mode: 'thinking' } as any })
  expect((await spin.find({ type: 'Text' }))?.text).toBe('Working… · summarising any moment')
  const bare = await $.ui.mount({ plugin: 'session-pane', surface: 'terminal', component: 'Spinner', props: { word: 'Working…', message: null, suffix: '', mode: 'thinking' } as any })
  expect((await bare.find({ type: 'Text' }))?.text).toBe('Working…summarising any moment') // the test's spinner joins word and suffix bare: no ' · ' dangling in front

  await $.command.run({ command: 'session-pane', args: '' } as any)
  expect(await band.find({ text: /✗ Tests failed/ })).toBe(undefined) // the pane shows it: the band steps aside
})

test('subagents: named under Right now while they run, with their usage on Session details; a finish is no main turn', async ($, on) => {
  const clock = mock.clock(on)
  let summaries = 0
  on('session.id', () => ({ value: 'S7' }))
  on('session.messages', () => ({ value: [] }) as any)
  on('store.get', () => ({ value: undefined }) as any)
  on('store.set', () => ({ value: undefined }) as any)
  on('command.register', () => ({ value: undefined }) as any)
  on('session.usage', (_$, e: any) => { if (e?.breakdown === 'summary') summaries++; return { value: { context: { window: 1000, tokens: 1, percent: 1 }, rateLimits: [] } } as any })
  on('session.model', () => ({ value: 'opus' }) as any)
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }) as any)
  on('tool.call', () => ({ result: {}, text: '' }) as any)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ prompt: 'Map the hooks', description: 'Map hooks', subagentType: 'scout' } as any).catch(() => {})
  await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: '/w/model.ts', agentId: 'a1' } as any)
  await clock.advance(2000)
  const p = await $.ui.mount({ plugin: 'session-pane', surface: 'terminal', component: 'Pane', requestId: 'session-pane', props: PROPS(44) })
  expect(await p.find({ text: /^◐ Map hooks · Reading model\.ts$/ })).toBeDefined()
  expect(await p.find({ text: /1 background agent working/ })).toBeDefined() // no main turn running: not waiting for you
  await $.turn.complete({ turnId: 'x', agentId: 'a1', reason: 'answer', answer: 'done', usage: { input_tokens: 9000, output_tokens: 3000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as any).catch(() => {})
  await clock.advance(2000)
  expect(summaries).toBe(0) // a subagent's finish records no turn for the turns-left estimate
  expect(await p.find({ text: /◐/ })).toBe(undefined)
  await p.press({ key: 'details' })
  expect(await p.find({ text: /^Map hooks \(scout\)$/ })).toBeDefined()
  expect(await p.find({ text: /^Finished, 1 tool call, 12k tokens$/ })).toBeDefined()
})

test('stale checks rerun on a press, through the tool call, and come back fresh; a refused one says why', async ($, on) => {
  const clock = mock.clock(on)
  const ran: string[] = []
  let refuse = false
  on('session.id', () => ({ value: 'S8' }))
  on('session.messages', () => ({ value: [] }) as any)
  on('store.get', () => ({ value: undefined }) as any)
  on('store.set', () => ({ value: undefined }) as any)
  on('command.register', () => ({ value: undefined }) as any)
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as any)
  on('tool.call', (_$, e: any) => {
    if (e.tool === 'Edit') return { result: { filePath: e.file_path, structuredPatch: [] }, text: 'ok' } as any
    if (refuse) return { deny: 'blocked by policy' } as any
    ran.push(e.command)
    return { result: {}, text: 'ok' } as any
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'npm test', description: 'Run tests' } as any)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b2', command: 'API_TOKEN=abc123 tsc -p .', description: 'Types' } as any)
  tick()
  await $.tool.call({ tool: 'Edit', tool_use_id: 'e1', file_path: '/w/a.ts', old_string: 'a', new_string: 'b' } as any)
  await clock.advance(2000)
  const p = await $.ui.mount({ plugin: 'session-pane', surface: 'terminal', component: 'Pane', requestId: 'session-pane', props: PROPS(44) })
  await p.press({ key: 'chg' })
  ran.length = 0
  await p.press({ key: 'rerun' })
  expect(ran).toEqual(['npm test']) // the scrubbed one is never run: what is stored is not what was typed
  await clock.advance(2000)
  expect(await p.find({ text: /Tests passed$/ })).toBeDefined()
  expect(await p.find({ text: /Type check passed before the last change/ })).toBeDefined()
  expect(await p.find({ key: 'rerun' })).toBe(undefined) // nothing left it may run

  tick()
  await $.tool.call({ tool: 'Edit', tool_use_id: 'e2', file_path: '/w/a.ts', old_string: 'b', new_string: 'c' } as any)
  await clock.advance(2000)
  refuse = true
  await p.press({ key: 'rerun' })
  expect(await p.find({ text: /Tests was not rerun: blocked by policy/ })).toBeDefined()
})

test('a recap still drafting when /clear starts a new session never lands in it', async ($, on) => {
  const clock = mock.clock(on)
  let id = 'S9'
  let answer: (v: any) => void = () => {}
  on('session.id', () => ({ value: id }))
  on('session.messages', () => ({ value: [] }) as any)
  on('store.get', () => ({ value: undefined }) as any)
  on('store.set', () => ({ value: undefined }) as any)
  on('command.register', () => ({ value: undefined }) as any)
  on('model.fork', () => new Promise(r => { answer = r }) as any)
  on('session.end', (_$, e: any) => ({ sessionId: e.sessionId }) as any)
  on('session.measure', () => ({ changed: ['context'] }) as any)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.session.measure({ context: { window: 1000, tokens: 900, percent: 90 }, rateLimits: [], changed: ['context'] } as any).catch(() => {})
  await clock.advance(2000)
  const p = await $.ui.mount({ plugin: 'session-pane', surface: 'terminal', component: 'Pane', requestId: 'session-pane', props: PROPS(44) })
  await p.press({ key: 'recap' })
  void p.press({ key: 'draft' })
  await clock.advance(10)
  await $.session.end({ reason: 'clear', sessionId: 'S9', resume: { id: 'S9' } } as any)
  id = 'S10'
  answer({ value: { isAnswered: true, text: 'Goal: the old session', usage: {} } })
  await clock.advance(2000) // restores S10
  await $.session.measure({ context: { window: 1000, tokens: 900, percent: 90 }, rateLimits: [], changed: ['context'] } as any).catch(() => {})
  await clock.advance(2000)
  await p.press({ key: 'recap' }) // the new session's recap page
  expect(await p.find({ key: 'draft' })).toBeDefined() // nothing drafted for it yet
  expect(await p.find({ text: /the old session/ })).toBe(undefined)
  expect(await p.find({ key: 'use' })).toBe(undefined)
})

test('a prompt seen before a transcript rebuild counts once, not again on top of the transcript', async ($, on) => {
  const clock = mock.clock(on)
  on('session.id', () => ({ value: 'S11' }))
  on('session.messages', () => ({ value: [{ role: 'user', text: 'Add a confirmation step before deleting', toolUses: [] }] }) as any)
  on('store.get', () => ({ value: undefined }) as any)
  on('store.set', () => ({ value: undefined }) as any)
  on('command.register', () => ({ value: undefined }) as any)
  on('session.usage', () => ({ value: { context: { window: 1000, tokens: 1, percent: 1 }, rateLimits: [] } }) as any)
  on('session.model', () => ({ value: 'opus' }) as any)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.prompt.submit({ text: 'Add a confirmation step before deleting', wait: false, origin: { kind: 'composer' } } as any).catch(() => {}) // before restore: held in early
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await clock.advance(2000)
  const p = await $.ui.mount({ plugin: 'session-pane', surface: 'terminal', component: 'Pane', requestId: 'session-pane', props: PROPS(44) })
  await p.press({ key: 'details' })
  expect(await p.find({ text: /^Messages\s*1$/ })).toBeDefined()
})

test('goal: nothing asked while hidden; one call on opening for every message since; short replies never ask', async ($, on) => {
  const clock = mock.clock(on)
  const asked: string[] = []
  on('session.id', () => ({ value: 'S12' }))
  on('session.messages', () => ({ value: [] }) as any)
  on('store.get', () => ({ value: undefined }) as any)
  on('store.set', () => ({ value: undefined }) as any)
  on('command.register', () => ({ value: undefined }) as any)
  on('ui.open', () => ({ value: { isPlaced: true } }) as any)
  on('ui.panes', () => ({ value: [] }) as any)
  on('model.complete', (_$, e: any) => { asked.push(e.prompt); return { value: { isAnswered: true, text: '{"changed":true,"title":"Confirm before deleting","keep":["No new dependencies"],"done":""}', usage: {} } } as any })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  const say = (text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as any).catch(() => {})
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await say('Add a confirmation step before deleting a project')
  await say('No new dependencies please')
  await say('yes')
  await clock.advance(2000); await clock.advance(2000)
  expect(asked.length).toBe(0) // hidden: free
  const p = await $.ui.mount({ plugin: 'session-pane', surface: 'terminal', component: 'Pane', requestId: 'session-pane', props: PROPS(44) })
  expect(await p.find({ text: /^Add a confirmation step before deleting…$/ })).toBeDefined() // the free draft, at once
  expect(await p.find({ text: /Goal .* draft/ })).toBeDefined() // said on the rule, not in a line of its own

  await $.command.run({ command: 'session-pane', args: '' } as any)
  await clock.advance(2000)
  expect(asked.length).toBe(1) // one call for all of them
  expect(asked[0]).toMatch(/Add a confirmation step[\s\S]*No new dependencies please[\s\S]*yes/) // 'yes' still rides along: the goal was a draft
  expect(await p.find({ text: /^Confirm before deleting$/ })).toBeDefined()
  expect(await p.find({ text: /^No new dependencies$/ })).toBeDefined() // constraints on one dim line
  expect(await p.find({ text: /Goal .* draft/ })).toBe(undefined)

  await say('ok')
  await clock.advance(2000)
  expect(asked.length).toBe(1) // a short reply after the goal is condensed: never a call
  await say('Now also handle archiving projects')
  await clock.advance(2000)
  expect(asked.length).toBe(2)
})
