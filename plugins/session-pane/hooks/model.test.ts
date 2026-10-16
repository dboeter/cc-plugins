import { test, expect } from 'claude-code/testing'
import { cells, fitList } from './views'
import { alertsOf, applyGoal, bandOf, goalPrompt, goalWorthy, titleOf, checkOf, sparkOf, checksOf, contextLabel, doingOf, empty, insightOf, isNoise, isQuery, mergeShellEdits, NEARLY_FULL, progOf, recapNotes, questionOf, recordTurn, reduce, replay, scrub, segmentsOf, snapshotOf, statusOf, turnsLeft, whoOf, type Seen } from './model'

const ENGINE = { plugin: 'engine', tier: 'core' }
let t = 0
const seen = (ev: string, ph: 'enter' | 'exit', e: any, r?: any, who = 'engine'): Seen => ({ ev, ph, e, r, who, t: ++t })
const call = (tool: string, input: any, r: any, extra: any = {}) => {
  const e = { tool, tool_use_id: `u${++t}`, ...input, ...extra }
  return [seen('tool.call', 'enter', e, undefined, 'claude'), seen('tool.call', 'exit', e, r, 'claude')]
}
const fold = (m = empty(), ...xs: (Seen | Seen[])[]) => { for (const x of xs.flat()) reduce(m, x); return m }

test('who: you, claude, engine, hook, plugin', () => {
  expect(whoOf('prompt.submit', ENGINE, { text: 'hi', origin: { kind: 'composer' } })).toBe('you')
  expect(whoOf('tool.call', ENGINE, { tool: 'Bash' })).toBe('claude')
  expect(whoOf('classic.PreToolUse', ENGINE, {})).toBe('hook')
  expect(whoOf('tool.call', { plugin: 'x', tier: 'user' }, {})).toBe('plugin:x')
  expect(whoOf('session.start', ENGINE, {})).toBe('engine')
})

test('noise and queries are told apart; session.measure is kept', () => {
  expect(isNoise('ui.render') && isNoise('clock.every') && isNoise('prompt.edit') && isNoise('tool.describe')).toBe(true)
  expect(isNoise('session.measure') || isNoise('tool.call')).toBe(false)
  expect(['state.get', 'fs.read', 'ui.panes', 'session.usage', 'session.messages'].every(isQuery)).toBe(true)
  expect(['state.set', 'fs.write', 'tool.call'].some(isQuery)).toBe(false)
})

test('text helpers: scrub, program, check name', () => {
  expect(scrub('curl -H "Authorization: Bearer abc123"')).toBe('curl -H "Authorization: Bearer ***"')
  expect(progOf('FOO=1 timeout 30 npx tsc -p .')).toBe('tsc')
  expect(progOf('npm run test -- --watch')).toBe('npm test')
  expect(checkOf('cd app && npm test')).toBe('Tests')
  expect(checkOf('npx tsc --noEmit')).toBe('Type check')
  expect(checkOf('claude plugin test ~/x')).toBe('Tests')
  expect(checkOf('git status')).toBe(undefined)
  expect(checkOf('npm run build')).toBe(undefined)
})

test('insight: what failed, in one to three lines', () => {
  const ts = insightOf('npx tsc -p .', 'Exit code 2\nsrc/a.ts(4,7): error TS2322: Type x\nsrc/b.ts(1,1): error TS2304: Cannot find y')
  expect(ts.exit).toBe(2)
  expect(ts.text).toBe('tsc: 2 errors in 2 files\na.ts(4,7)  TS2322 Type x\nb.ts(1,1)  TS2304 Cannot find y')
  expect(insightOf('npm test', 'Exit code 1\n FAIL src/a.test.ts\nTests: 1 failed, 3 passed').text).toMatch(/^npm test\nFAIL src\/a\.test\.ts/)
})

test('activity words', () => {
  expect(doingOf('Read', { file_path: '/w/src/confirmation.tsx' })).toBe('Reading confirmation.tsx')
  expect(doingOf('Bash', { command: 'npm test' })).toBe('Running tests')
  expect(doingOf('Bash', { command: 'ls', description: 'List the folder' })).toBe('List the folder')
  expect(doingOf('mcp__github__create_issue', {})).toBe('Using github: create_issue')
  expect(questionOf({ questions: [{ question: 'Which style?', options: [{ label: 'Modal' }, { label: 'Inline' }] }] })).toBe('Which style? (Modal / Inline)')
})

test('a new session fabricates nothing', () => {
  const m = empty()
  expect(statusOf(m).kind).toBe('new')
  expect(checksOf(m).line).toBe('')
  expect(contextLabel(m.context.percent).label).toBe('Room to begin')
})

test('prompts: yours count; slash commands and other plugins\' do not', () => {
  const m = fold(empty(),
    seen('prompt.submit', 'exit', { text: '/session-pane' }, {}, 'you'),
    seen('prompt.submit', 'exit', { text: 'Add a confirmation step before deleting a project.' }, {}, 'you'),
    seen('prompt.submit', 'exit', { text: 'Also make the button red' }, {}, 'you'),
    seen('prompt.submit', 'exit', { text: 'from a plugin' }, {}, 'plugin:x'))
  expect(m.prompts).toBe(2)
})

test('right now: a turn is just Working; a failure says what failed, mid-turn and after', () => {
  const m = fold(empty(), seen('turn.start', 'enter', { text: 'go', turnId: 't1' }), seen('tool.call', 'enter', { tool: 'Read', tool_use_id: 'r1', file_path: '/w/a.ts' }, undefined, 'claude'))
  expect(statusOf(m)).toEqual({ kind: 'working', label: 'Working' }) // what it is doing is the spinner's to say
  fold(m, call('Bash', { command: 'npm test' }, { result: {}, text: 'Exit code 1\n FAIL a.test.ts', isError: true }))
  expect(statusOf(m)).toEqual({ kind: 'failed', label: 'Tests failed, Claude is investigating', detail: 'npm test\nFAIL a.test.ts' })
})

test('needs input: a question or a permission prompt, until its call returns', () => {
  const m = fold(empty(), seen('turn.start', 'enter', {}))
  const q = { tool: 'AskUserQuestion', tool_use_id: 'q1', questions: [{ question: 'Modal or inline?', options: [{ label: 'Modal' }, { label: 'Inline' }] }] }
  reduce(m, seen('tool.call', 'enter', q, undefined, 'claude'))
  expect(statusOf(m)).toEqual({ kind: 'input', label: 'Needs your input', detail: 'Modal or inline? (Modal / Inline)' })
  reduce(m, seen('tool.call', 'exit', q, { result: {}, text: 'Modal' }, 'claude'))
  expect(statusOf(m).kind).toBe('working')
  const input = { command: 'rm -rf dist', description: 'Remove the build folder' }
  reduce(m, seen('tool.check', 'exit', { tool: 'Bash', tool_use_id: 'b1', input }, { decision: 'ask' }))
  expect(statusOf(m).kind).toBe('working') // asked of the mode's decider: the classifier may answer it
  reduce(m, seen('classic.PermissionRequest', 'exit', { tool_name: 'Bash', tool_input: input }, {}, 'hook'))
  expect(statusOf(m).detail).toBe('Allow: Remove the build folder?') // no hook answered: the dialog is up
  reduce(m, seen('tool.call', 'exit', { tool: 'Bash', tool_use_id: 'b1', command: 'rm -rf dist' }, { deny: 'no' }, 'claude'))
  expect(statusOf(m).kind).toBe('working')
})

test('a permission the classifier or a settings hook answers never asks you', () => {
  const m = fold(empty(), seen('turn.start', 'enter', {}))
  reduce(m, seen('tool.check', 'exit', { tool: 'Bash', tool_use_id: 'c1', input: { command: 'touch a' } }, { decision: 'ask' }))
  reduce(m, seen('tool.call', 'exit', { tool: 'Bash', tool_use_id: 'c1', command: 'touch a' }, { result: {}, text: '' }, 'claude')) // auto mode: no request
  reduce(m, seen('tool.check', 'exit', { tool: 'Bash', tool_use_id: 'c2', input: { command: 'touch b' } }, { decision: 'ask' }))
  reduce(m, seen('classic.PermissionRequest', 'exit', { tool_name: 'Bash', tool_input: { command: 'touch b' } }, { decision: { behavior: 'allow' } }, 'hook'))
  expect(statusOf(m).kind).toBe('working')
  reduce(m, seen('tool.call', 'exit', { tool: 'Bash', tool_use_id: 'c2', command: 'touch b' }, { result: {}, text: '' }, 'claude'))
  expect(m.asking).toEqual({})
})

test('changes: Write create is New, Edit is Edited, later edits keep New; failed and staged edits do not count', () => {
  const m = fold(empty(),
    call('Write', { file_path: '/w/new.tsx', content: 'x' }, { result: { type: 'create', filePath: '/w/new.tsx', structuredPatch: [] }, text: 'ok' }),
    call('Edit', { file_path: '/w/old.ts', old_string: 'a', new_string: 'b' }, { result: { filePath: '/w/old.ts', structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }] }, text: 'ok' }),
    call('Edit', { file_path: '/w/new.tsx', old_string: 'x', new_string: 'y' }, { result: { filePath: '/w/new.tsx', structuredPatch: [] }, text: 'ok' }),
    call('Edit', { file_path: '/w/bad.ts' }, { result: 'String not found', text: 'String not found', isError: true }),
    call('Write', { file_path: '/w/held.ts' }, { result: { type: 'update', filePath: '/w/held.ts', staged: true, structuredPatch: [] }, text: 'held' }))
  expect(m.files.map(f => [f.path, f.isNew])).toEqual([['/w/new.tsx', true], ['/w/old.ts', false]])
  expect(m.files[1]!.hunks?.[0]!.lines).toEqual(['-a', '+b'])
  m.running = false
  expect(statusOf(m)).toEqual({ kind: 'review', label: 'Waiting for you', detail: 'Changes available to review', next: undefined })
  expect(checksOf(m).line).toBe("Checks haven't run yet")
})

test('subagent edits count', () => {
  const m = fold(empty(), seen('turn.start', 'enter', {}), call('Edit', { file_path: '/w/s.ts' }, { result: { filePath: '/w/s.ts', structuredPatch: [] }, text: 'ok' }, { agentId: 'a1' }))
  expect(m.files.length).toBe(1)
})

test("a subagent's reads and attachments are its own context, not the main conversation's", () => {
  const m = fold(empty(),
    call('Read', { file_path: '/w/sub.ts' }, { result: {}, text: 'x'.repeat(4000) }, { agentId: 'a1' }),
    call('Edit', { file_path: '/w/s.ts', new_string: 'y'.repeat(400) }, { result: { filePath: '/w/s.ts', structuredPatch: [] }, text: 'ok' }, { agentId: 'a1' }),
    seen('prompt.attachment', 'exit', { type: 'nested_memory', text: 'Contents of /w/sub/CLAUDE.md:', agentId: 'a1' }, { text: 'Contents of /w/sub/CLAUDE.md:' }))
  expect(m.sources).toEqual([])
  expect(m.est).toEqual({ conversation: 0, files: 0, results: 0 })
  expect(m.files.map(f => f.path)).toEqual(['/w/s.ts']) // its changes still count
})

test("another plugin's tool call: its changes and checks count, its output is not in the context", () => {
  const m = fold(empty(), seen('turn.start', 'enter', {}), call('Read', { file_path: '/w/a.ts' }, { result: {}, text: 'a' }))
  const e = { tool: 'Bash', tool_use_id: 'p1', command: 'npm test' }
  fold(m, seen('tool.call', 'enter', e, undefined, 'plugin:x'), seen('tool.call', 'exit', e, { result: {}, text: 'Exit code 1\n FAIL a.test.ts', isError: true }, 'plugin:x'))
  expect(m.est.results).toBe(0)
  expect(checksOf(m).line).toBe('Tests failed')
})

test('a refused turn says so', () => {
  const m = fold(empty(), seen('prompt.submit', 'exit', { text: 'go' }, {}, 'you'), seen('turn.start', 'enter', {}), seen('turn.complete', 'enter', { reason: 'refusal', isAborted: false, answer: '' }))
  expect(statusOf(m)).toEqual({ kind: 'idle', label: 'Stopped', detail: 'Claude declined the last request' })
})

test('checks: pass, fail with what failed, stale after an edit', () => {
  const m = fold(empty(), seen('prompt.submit', 'exit', { text: 'go' }, {}, 'you'), call('Edit', { file_path: '/w/a.ts' }, { result: { filePath: '/w/a.ts', structuredPatch: [] }, text: 'ok' }),
    call('Bash', { command: 'npm test' }, { result: {}, text: 'Exit code 1\n FAIL src/a.test.ts', isError: true }))
  expect(checksOf(m).line).toBe('Tests failed')
  expect(statusOf(m)).toEqual({ kind: 'failed', label: 'Tests failed', detail: 'npm test\nFAIL src/a.test.ts' })
  m.running = true
  expect(statusOf(m).label).toBe('Tests failed, Claude is investigating')
  reduce(m, call('Edit', { file_path: '/w/a.ts' }, { result: { filePath: '/w/a.ts', structuredPatch: [] }, text: 'ok' })[1]!)
  expect(checksOf(m)).toEqual({ line: '', failed: false, rerun: 'Rerun needed: Tests' })
  expect(statusOf(m).kind).toBe('working') // a stale failure is not the current state
  fold(m, call('Bash', { command: 'npm test' }, { result: {}, text: 'ok' }), call('Bash', { command: 'npx tsc' }, { result: {}, text: '' }))
  expect(checksOf(m)).toEqual({ line: 'Type check, Tests passed', failed: false, rerun: '' })
  reduce(m, call('Edit', { file_path: '/w/a.ts' }, { result: { filePath: '/w/a.ts', structuredPatch: [] }, text: 'ok' })[1]!)
  fold(m, call('Bash', { command: 'npx tsc' }, { result: {}, text: '' }))
  expect(checksOf(m)).toEqual({ line: 'Type check passed', failed: false, rerun: 'Rerun needed: Tests' }) // named, not "others"
  fold(m, call('Bash', { command: 'npm test' }, { result: {}, text: 'Exit code 1\n FAIL a.test.ts', isError: true }))
  expect(checksOf(m)).toEqual({ line: 'Tests failed; Type check passed', failed: true, rerun: '' }) // a failure never hides a pass
})

test("checks: a pipeline's exit code is its last program's, so a check followed by another is judged by its output", () => {
  const piped = fold(empty(), call('Bash', { command: 'npm test 2>&1 | tail -5' }, { result: {}, text: ' FAIL src/a.test.ts\nTests: 1 failed, 3 passed' }))
  expect(checksOf(piped).line).toBe('Tests failed')
  expect(piped.checks[0]!.line).toBe('npm test\nFAIL src/a.test.ts\nTests: 1 failed, 3 passed')
  const chained = fold(empty(), call('Bash', { command: 'npm test && npm run build' }, { result: {}, text: 'Exit code 2\nTests: 0 failed, 3 passed\nbuild: error', isError: true }))
  expect(checksOf(chained).line).toBe('Tests passed') // the build failed, not the tests
  const tsc = fold(empty(), call('Bash', { command: 'npx tsc --noEmit; echo done' }, { result: {}, text: 'src/a.ts(1,1): error TS2304: Cannot find y\ndone' }))
  expect(checksOf(tsc).line).toBe('Type check failed')
  const grep = fold(empty(), call('Bash', { command: 'npm test | grep -c FAIL' }, { result: {}, text: 'Exit code 1\n0', isError: true }))
  expect(checksOf(grep).line).toBe('Tests passed') // grep found no failure
})

test('shell edits merge as Edited, without duplicating a tool edit', () => {
  const m = fold(empty(), call('Write', { file_path: '/w/n.ts' }, { result: { type: 'create', filePath: '/w/n.ts', structuredPatch: [] }, text: 'ok' }))
  expect(mergeShellEdits(m, ['/w/n.ts', '/w/sed.ts', 'relative', ''], 99)).toBe(true)
  expect(m.files.map(f => [f.path, f.isNew, !!f.byShell])).toEqual([['/w/sed.ts', false, true], ['/w/n.ts', true, false]])
  expect(mergeShellEdits(m, ['/w/sed.ts'], 99)).toBe(false) // the same scan again: nothing new
  expect(m.files.length).toBe(2)
})

test('recap notes: the files changed, nothing for a new session', () => {
  const m = fold(empty(), call('Write', { file_path: '/w/n.ts' }, { result: { type: 'create', filePath: '/w/n.ts', structuredPatch: [] }, text: 'ok' }))
  expect(recapNotes(empty())).toBe('')
  expect(recapNotes(m)).toBe('Files changed:\n- /w/n.ts (new)')
})

test('context: measure, sources, attachments, compaction', () => {
  const m = fold(empty(),
    seen('session.measure', 'enter', { context: { percent: 87, window: 200000, tokens: 174000 }, rateLimits: [{ percentUsed: 3 }], cost: { usd: 1.2 }, changed: ['context'] }),
    seen('prompt.context', 'exit', {}, { blocks: [], instructionFiles: [{ path: '/w/CLAUDE.md', kind: 'project', content: '' }] }),
    call('Read', { file_path: '/w/a.ts', offset: 10, limit: 20 }, { result: {}, text: 'x'.repeat(400) }),
    call('Read', { file_path: '/w/b.ts' }, { result: {}, text: 'y'.repeat(400) }),
    seen('prompt.attachment', 'exit', { type: 'edited_text_file', text: 'Note: /w/b.ts changed on disk.' }, { text: 'Note: /w/b.ts changed on disk.' }),
    seen('prompt.attachment', 'exit', { type: 'nested_memory', text: 'Contents of /w/sub/CLAUDE.md:' }, { text: undefined }))
  expect(m.onPlan).toBe(true)
  expect(contextLabel(m.context.percent).label).toBe('Nearly full')
  expect(m.context.percent! >= NEARLY_FULL).toBe(true)
  expect(m.sources.map(s => [s.label, s.note])).toEqual([['/w/b.ts', 'changed'], ['/w/a.ts', 'excerpt'], ['w/CLAUDE.md', 'loaded']]) // the dropped attachment is not listed
  reduce(m, seen('session.compact', 'exit', { trigger: 'auto', messages: [] }, { messages: [{ role: 'user', text: 'Summary: keep no new deps', toolUses: [] }] }))
  expect(m.summary).toBe('Summary: keep no new deps')
  expect(m.compactions).toBe(1)
  expect(m.sources.find(s => s.label === '/w/a.ts')?.note).toBe('earlier')
  expect(m.sources[0]!.label).toBe('Earlier conversation summary')
  expect(m.est).toEqual({ conversation: 25, files: 0, results: 0 })
  expect(reduce(m, seen('session.compact', 'exit', { trigger: 'manual', messages: [] }, { skip: 'blocked' }))).toBe(false)
})

test('segments: instructions from the engine, the rest scaled estimate with a confidence', () => {
  const rows = [{ name: 'System prompt', tokens: 3000, kind: 'used' }, { name: 'Memory files', tokens: 1000, kind: 'used' }, { name: 'Messages', tokens: 1000, kind: 'used' }, { name: 'Free space', tokens: 9000, kind: 'free' }]
  const close = segmentsOf({ conversation: 2000, files: 1600, results: 400 }, rows) // 1000 estimated tokens: exact
  expect(close.segments.map(s => s.tokens)).toEqual([4000, 500, 400, 100])
  expect(close.confidence).toBe('close')
  const rough = segmentsOf({ conversation: 400, files: 0, results: 0 }, rows) // 100 estimated vs 1000
  expect(rough.confidence).toBe('rough')
  expect(rough.segments[1]!.tokens).toBe(1000) // scaled to the engine's figure all the same
  expect(segmentsOf({ conversation: 4, files: 0, results: 0 }, undefined).confidence).toBe('none')
})

test('snapshot drops diffs and live waits; replay rebuilds from the transcript', () => {
  const m = fold(empty(), seen('turn.start', 'enter', {}), call('Edit', { file_path: '/w/a.ts' }, { result: { filePath: '/w/a.ts', structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['+x'] }] }, text: 'ok' }))
  m.waits = { q: 'x' }
  m.asking = { b: { tool: 'Bash', input: '{}', text: 'x' } }
  const s = snapshotOf(m)
  expect(s.files[0]!.hunks).toBe(undefined)
  expect(s.waits).toEqual({})
  expect(s.asking).toEqual({})
  expect(s.running).toBe(false)
  expect(m.files[0]!.hunks?.length).toBe(1) // the live model keeps them
  const r = empty()
  replay(r, [
    { role: 'user', text: '<command-name>/clear</command-name>', toolUses: [] },
    { role: 'user', text: 'Add a confirmation step', toolUses: [] },
    { role: 'assistant', text: 'On it', toolUses: [
      { tool_use_id: 'a', tool: 'Write', input: { file_path: '/w/c.tsx', content: 'x' }, result: { type: 'create', filePath: '/w/c.tsx', structuredPatch: [] }, text: 'ok' },
      { tool_use_id: 'b', tool: 'Bash', input: { command: 'npm test' }, text: 'Exit code 1\nFAIL x', isError: true },
    ] },
    { role: 'user', text: '', toolUses: [], toolResults: [{}] },
  ])
  expect(r.prompts).toBe(1)
  expect(r.files.map(f => [f.path, f.isNew])).toEqual([['/w/c.tsx', true]])
  expect(checksOf(r).line).toBe('Tests failed')
})

test('turns left: median growth to the threshold; nothing when it cannot say; a summary starts it over', () => {
  const m = empty()
  recordTurn(m, 10_000, 100_000)
  recordTurn(m, 20_000, 100_000)
  expect(turnsLeft(m)).toBe(undefined) // one growth seen: too early
  recordTurn(m, 70_000, 100_000) // one big read: growths 10k and 50k
  recordTurn(m, 80_000, 100_000) // 10k, 50k, 10k: median 10k
  expect(turnsLeft(m)).toBe(2)
  recordTurn(m, 99_000, 100_000)
  expect(turnsLeft(m)).toBe(0) // under a turn's growth left: any moment, from a real estimate
  recordTurn(m, 99_500, undefined)
  expect(turnsLeft(m)).toBe(undefined) // auto-compact off: no estimate, never 0
  const flat = empty()
  for (const t of [50_000, 50_000, 50_000]) recordTurn(flat, t, 100_000)
  expect(turnsLeft(flat)).toBe(undefined) // not growing: no estimate
  reduce(m, { ev: 'session.compact', ph: 'exit', who: 'engine', e: { trigger: 'auto' }, r: { messages: [{ text: 'Summary' }] }, t: 1 })
  expect(m.turnTokens).toEqual([])
})

test('ambient: the band names failed and stale checks and a nearly full window; alerts key each failure once', () => {
  const m = empty()
  expect(bandOf(m)).toEqual([])
  m.checks = [{ name: 'Tests', ok: false, line: 'FAIL', t: 10, cmd: 'npm test' }, { name: 'Types', ok: true, line: '', t: 2, cmd: 'tsc' }]
  m.lastEdit = 5
  expect(bandOf(m).map(p => p.text)).toEqual(['✗ Tests failed', 'Rerun needed: Types'])
  expect([...alertsOf(m).keys()]).toEqual(['fail:Tests'])
  m.context.percent = NEARLY_FULL + 2
  expect(bandOf(m).at(-1)!.text).toBe(`Context ${NEARLY_FULL + 2}% used: prepare a recap`)
  expect([...alertsOf(m).keys()]).toEqual(['fail:Tests', 'full'])
  m.lastEdit = 20 // edited since: the failure says nothing now, so it is no alert, only a rerun
  expect([...alertsOf(m).keys()]).toEqual(['full'])
  expect(bandOf(m)[0]!.text).toBe('Rerun needed: Tests, Types')
})

test('subagents: spawned, busy, finished; a snapshot stops a running one; the turn ending leaves them working', () => {
  const m = fold(empty(), seen('agent.spawn', 'exit', { description: 'Map hooks', subagentType: 'scout' }, { model: 'haiku', agentId: 'a1' }))
  expect(m.agents[0]).toMatchObject({ id: 'a1', name: 'Map hooks', status: 'running', calls: 0 })
  fold(m, call('Grep', { pattern: 'on\\(' }, { text: '' }, { agentId: 'a1' }))
  expect(m.agents[0]!.calls).toBe(1)
  expect(statusOf(m).label).toBe('1 background agent working')
  expect(snapshotOf(m).agents[0]!.status).toBe('stopped')
  fold(m, seen('turn.complete', 'enter', { agentId: 'a1', isAborted: true }))
  expect(m.agents[0]!.status).toBe('stopped')
  expect(reduce(m, seen('turn.complete', 'enter', { agentId: 'nobody' }))).toBe(false) // not one of ours
  const n = fold(empty(), seen('agent.spawn', 'exit', { description: 'B' }, { model: 'haiku', agentId: 'b1' }), seen('classic.SubagentStop', 'enter', { agent_id: 'b1' }))
  expect(n.agents[0]!.status).toBe('done') // its turn.complete missing: SubagentStop ends it
})

test('rerun: only a check stored exactly as typed may run again', () => {
  const m = fold(empty(), call('Bash', { command: 'npm test' }, { text: 'ok' }), call('Bash', { command: 'GH_TOKEN=x tsc' }, { text: 'ok' }))
  expect(m.checks.find(c => c.name === 'Tests')!.canRerun).toBe(true)
  expect(m.checks.find(c => c.name !== 'Tests')!.canRerun).toBe(undefined)
})

test('spark: one block per turn, full height at the auto-compact point, nothing under two turns', () => {
  const m = empty()
  recordTurn(m, 20_000, 160_000)
  expect(sparkOf(m)).toBe('')
  recordTurn(m, 80_000, 160_000); recordTurn(m, 160_000, 160_000)
  expect(sparkOf(m)).toBe('▁▄█')
})

test('review fixes: secrets in everyday spellings are scrubbed', () => {
  expect(scrub('OPENAI_KEY=abc123 npm test')).toBe('OPENAI_KEY=*** npm test')
  expect(scrub('export GH_PAT=xyz npm test')).toBe('export GH_PAT=*** npm test')
  expect(scrub('curl -H "Authorization: Basic dXNlcjpwYXNz"')).toBe('curl -H "Authorization: Basic ***"')
  expect(scrub('mysql -u root -pHunter2 db')).toBe('mysql -u root -p*** db')
  expect(scrub('echo sk-proj0123456789abcdef and ghp_0123456789abcdefABCD')).toBe('echo sk-*** and ghp_***')
  expect(scrub('tsc -p . && find . -print')).toBe('tsc -p . && find . -print') // not a password flag outside mysql
})

test('review fixes: python, uv, pnpm exec and make spellings count as checks', () => {
  expect(checkOf('python -m pytest -q')).toBe('Tests')
  expect(checkOf('python3 -m mypy src')).toBe('Type check')
  expect(checkOf('uv run pytest')).toBe('Tests')
  expect(checkOf('poetry run ruff check .')).toBe('Lint')
  expect(checkOf('pnpm exec vitest run')).toBe('Tests')
  expect(checkOf('make test')).toBe('Tests')
  expect(checkOf('make build')).toBe(undefined)
})

test('review fixes: rerun only a check run alone; a shell edit to a listed file makes checks stale', () => {
  const m = fold(empty(),
    call('Bash', { command: 'npm test && rm -rf dist' }, { text: 'ok' }),
    call('Bash', { command: 'cd app && tsc -p .' }, { text: 'ok' }),
    call('Bash', { command: 'CI=1 eslint .' }, { text: 'ok' }))
  expect(m.checks.find(c => c.name === 'Tests')!.canRerun).toBe(undefined) // would remove dist again
  expect(m.checks.find(c => c.name === 'Type check')!.canRerun).toBe(true)
  expect(m.checks.find(c => c.name === 'Lint')!.canRerun).toBe(undefined) // sets a variable

  const n = empty()
  mergeShellEdits(n, ['/w/a.ts'], 10)
  n.checks = [{ name: 'Tests', ok: true, line: '', t: 20, cmd: 'npm test' }]
  expect(mergeShellEdits(n, ['/w/a.ts'], 30)).toBe(true) // already listed, edited again by a command
  expect(n.lastEdit).toBe(30)
  expect(n.files.length).toBe(1)
})

test('review fixes: the band says when code changed and no check ran; prose alone owes none', () => {
  const m = empty()
  mergeShellEdits(m, ['/w/README.md'], 1)
  expect(bandOf(m)).toEqual([])
  mergeShellEdits(m, ['/w/a.ts', '/w/b.ts'], 2)
  expect(bandOf(m)[0]).toEqual({ text: '2 files changed, no checks run', color: 'warning' })
  m.checks = [{ name: 'Tests', ok: true, line: '', t: 3, cmd: 'npm test' }]
  expect(bandOf(m)).toEqual([])
})

test('ui review: whole cells never sum past the width', () => {
  // rounded one by one these are 1+1+1+3 = 6 cells in a width of 4
  expect(cells([0.125, 0.125, 0.125, 0.625], 4).reduce((a, b) => a + b)).toBe(4)
  expect(cells([0.5, 0.2], 10)).toEqual([5, 2])
  expect(cells([1 / 3, 1 / 3, 1 / 3], 10).reduce((a, b) => a + b)).toBe(10)
})

test('backend review: diffs keep the newest changes; an oversized one keeps its head; a waiting call holds no input', () => {
  const hunk = (n: number, mark: string) => ({ oldStart: 1, oldLines: 0, newStart: 1, newLines: n, lines: Array.from({ length: n }, () => `+${mark}`) })
  const edit = (h: any) => call('Edit', { file_path: '/w/a.ts' }, { result: { filePath: '/w/a.ts', structuredPatch: [h] }, text: 'ok' })
  const m = fold(empty(), edit(hunk(300, 'old')), edit(hunk(300, 'new')))
  expect(m.files[0]!.hunks!.map(h => h.lines[0])).toEqual(['+new']) // the old one makes room
  const big = fold(empty(), call('Write', { file_path: '/w/b.ts' }, { result: { type: 'create', filePath: '/w/b.ts', structuredPatch: [hunk(401, 'x')] }, text: 'ok' }))
  expect(big.files[0]!.hunks![0]!.lines.length).toBe(400)

  const a = fold(empty(), seen('tool.check', 'exit', { tool: 'Write', tool_use_id: 'w1', input: { file_path: '/w/s.ts', content: 'API_SECRET=hunter2' } }, { decision: 'ask' }))
  expect(JSON.stringify(a.asking)).not.toContain('hunter2')
  reduce(a, seen('classic.PermissionRequest', 'exit', { tool_name: 'Write', tool_input: { file_path: '/w/s.ts', content: 'API_SECRET=hunter2' } }, {}, 'hook'))
  expect(Object.keys(a.waits)).toEqual(['w1']) // still matched to its permission request
})

test('goal: a free draft from the opening message; the small model condenses, adds constraints, replaces', () => {
  expect(titleOf('Add a confirmation step before deleting a project. Keep it accessible.')).toBe('Add a confirmation step before deleting…')
  const m = fold(empty(),
    seen('prompt.submit', 'exit', { text: '/session-pane' }, {}, 'you'),
    seen('prompt.submit', 'exit', { text: 'Add a confirmation step before deleting a project. No new dependencies please.' }, {}, 'you'))
  expect(m.goal).toMatchObject({ title: 'Add a confirmation step before deleting…', isDraft: true })
  expect(applyGoal(m, 'not json', 'x', 'Your opening message')).toBe(false)
  expect(applyGoal(m, '```json\n{"changed":true,"title":"Confirm before deleting projects","keep":["No new dependencies"],"done":"Deleting asks first"}\n```', 'x', 'Your opening message')).toBe(true)
  expect(m.goal).toMatchObject({ title: 'Confirm before deleting projects', keep: [{ text: 'No new dependencies', from: 'Your opening message' }], done: 'Deleting asks first', isDraft: false })
  expect(applyGoal(m, '{"changed":false,"title":"x","keep":["Keep it accessible","no new dependencies"]}', 'y', 'Your message 2')).toBe(true)
  expect(m.goal!.keep.map(k => k.text)).toEqual(['No new dependencies', 'Keep it accessible'])
  expect(applyGoal(m, '{"changed":true,"title":"Fix the login page","keep":[]}', 'Now fix the login page', 'Your message 3')).toBe(true)
  expect(m.goal!.from).toBe('Your message 3')
})

test('goal efficiency: short replies never cost a call; one prompt carries a batch, clipped, newest kept', () => {
  const m = empty()
  expect(goalWorthy(m, 'yes')).toBe(true) // nothing condensed yet: even a short opening counts
  m.goal = { title: 'T', keep: [], from: 'x', text: 'x', isDraft: false }
  expect(goalWorthy(m, 'yes')).toBe(false)
  expect(goalWorthy(m, 'go on then')).toBe(true)
  const p = goalPrompt(m, ['first message', 'x'.repeat(5000)])
  expect(p.startsWith('Current goal: T\n')).toBe(true)
  expect(p).not.toContain('first message') // the newest fills the room first
  expect(p.length).toBeLessThan(3100)
})

test('goal line: constraints on one line, as many as fit whole, the rest counted', () => {
  expect(fitList(['No new deps', 'Keep it accessible', 'Use the old API'], 50)).toBe('No new deps · Keep it accessible · Use the old API')
  expect(fitList(['No new deps', 'Keep it accessible', 'Use the old API'], 36)).toBe('No new deps · Keep it accessible +1')
  expect(fitList(['No new deps', 'Keep it accessible'], 10)).toBe('No new deps +1') // the line cuts the rest
  expect(fitList(['Only one'], 4)).toBe('Only one')
})
