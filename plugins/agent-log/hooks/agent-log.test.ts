// Pane tests share the module's state (level, folds, finished agents shown): a test that changes one sets it back before it ends.
import { test, expect, mock, type TestBody } from 'claude-code/testing'
import { ASKED, costOf, scrub, ctxOf, harnessOf, hookName, markAgain, modelName, outsideOf, pack, pickRuns, rootOf, routine, runNames, speaker, withSilent, splitOf, tagOf, unusualOf } from './agent-log'

// the shape hooksOf builds: settings hooks by script name, plugin hooks by plugin. Texts are real rows from the store
const cfg = {
  PreToolUse: [
    { matcher: 'Bash', name: 'guard' }, { matcher: 'Bash', name: 'test-gate' }, { matcher: 'Bash', name: 'install-cooldown' },
    { matcher: 'Edit|Write|MultiEdit', name: 'contract-guard' }, { matcher: 'Bash', name: 'context-mode', plugin: true },
  ],
  PostToolUse: [{ matcher: 'Edit|Write|MultiEdit', name: 'lint-feedback' }, { matcher: 'Edit|Write', name: 'context-mode', plugin: true }],
  SessionStart: [
    { matcher: '', name: 'install-check' }, { matcher: '', name: 'unicode-scan' }, { matcher: '', name: 'preflight-context' },
    { matcher: 'compact|resume', name: 'session-context' }, { matcher: '', name: 'herdr-agent-state' },
    { matcher: '', name: 'codex', plugin: true }, { matcher: '', name: 'context-mode', plugin: true },
  ],
  Stop: [{ matcher: '', name: 'plan-followed' }],
}

test('silent run names every hook whose matcher fits the target', () => {
  expect(hookName(cfg, 'PreToolUse', 'Bash')).toBe('guard, test-gate, install-cooldown, context-mode')
  expect(hookName(cfg, 'SessionStart', 'clear')).toBe('install-check, unicode-scan, preflight-context, herdr-agent-state, codex, context-mode')
})

test('no fitting hook is empty, so the event can be skipped', () => {
  expect(hookName(cfg, 'PreToolUse', 'SendUserMessage')).toBe('')
  expect(hookName(cfg, 'PostToolBatch')).toBe('')
})

test('text is credited to the hook it names', () => {
  expect(hookName(cfg, 'SessionStart', 'clear', 'SessionStart:clear hook success: install-check: 1 problem(s) with symlinks')).toBe('install-check')
  expect(hookName(cfg, 'SessionStart', 'clear', 'Preflight (preflight-context hook):\nmachine: desktop')).toBe('preflight-context')
  expect(hookName(cfg, 'PreToolUse', 'Bash', 'guard.sh blocked this command: rm')).toBe('guard')
  expect(hookName(cfg, 'PreToolUse', 'Edit', 'contract-guard: a /sprint implement phase is active')).toBe('contract-guard')
})

test('text naming no settings hook is a plugin hook\'s', () => {
  expect(hookName(cfg, 'PreToolUse', 'Bash', '<context_guidance>\n  <tip>\n    When you intend to PROCESS')).toBe('context-mode')
  expect(hookName(cfg, 'SessionStart', 'resume', '<context_window_protection>\n  <priority_instructions>')).toBe('codex, context-mode') // both plugins hook SessionStart, the text names neither
})

// live misattributions: text below the first line quoting other hooks, and a hook's path naming its folder
test('only the first line names a settings hook', () => {
  expect(hookName(cfg, 'SessionStart', 'resume', 'SessionStart:resume hook success: State carried across the context boundary (session-context hook):\nbranch: main\n M hooks/security/unicode-scan.md')).toBe('session-context')
  expect(hookName(cfg, 'SessionStart', 'resume', 'SessionStart hook additional context: \n<context_window_protection>\n  EXTERNAL=( "herdr-agent-state.sh" )\n  Tell user: "context-mode knowledge base preserved."')).toBe('context-mode')
  expect(hookName(cfg, 'PreToolUse', 'Bash', 'PreToolUse:Bash hook error: [$HOME/.claude/hooks/guard/test-gate.sh]: test-gate: \'unit\' failing')).toBe('test-gate')
})

test('unnamed text: the one candidate, else the event', () => {
  expect(hookName(cfg, 'Stop', undefined, 'plan not finished')).toBe('plan-followed')
  expect(hookName({ SessionStart: cfg.SessionStart.filter(h => !h.plugin) }, 'SessionStart', 'clear', 'something')).toBe('SessionStart hook')
  // the engine's own notice, framed as the event's hook, is no plugin's
  expect(hookName(cfg, 'PostToolUse', 'Edit', 'PostToolUse:Edit hook additional context: PostToolUse hook modified /x.py after your edit')).toBe('PostToolUse hook')
})

// a row as the store holds it; only agent and child matter to rootOf
const row = (agent?: string, child?: string) => ({ t: 0, kind: 'tool' as const, name: 'Agent', detail: '', outcome: 'ok', agent, child })

test('a spawned agent\'s rows, and its own spawns\', fold under the top-most Agent row', () => {
  const spawnA = row(undefined, 'A'), spawnB = row('A', 'B')
  const root = rootOf([spawnA, spawnB])
  expect(root(row('A'))).toBe(spawnA)
  expect(root(row('B'))).toBe(spawnA) // a grandchild folds with its parent
  expect(root(spawnB)).toBe(spawnA)
  expect(root(spawnA)).toBe(undefined) // main's own row
  expect(root(row('fork-1'))).toBe(undefined) // a loop no Agent row started
})

test('a cycle in a damaged store stops', () => {
  const p = row('B', 'A'), root = rootOf([p, row('A', 'B')])
  expect(root(row('A'))).toBeDefined()
  expect(root(p)).toBe(p) // the pane's fold skips a row whose root is itself
})

test('the second and later agent of a type is numbered', () => {
  expect(tagOf({}, 'general-purpose')).toBe('general-purpose')
  expect(tagOf({ a: 'general-purpose' }, 'general-purpose')).toBe('general-purpose #2')
  expect(tagOf({ a: 'general-purpose', b: 'general-purpose #2', c: 'scout' }, 'general-purpose')).toBe('general-purpose #3')
  expect(tagOf({ a: 'general-purpose-x' }, 'general-purpose')).toBe('general-purpose')
  expect(tagOf({ a: 'general-purpose' }, 'general-purpose', id => id !== 'a')).toBe('general-purpose') // its own SubagentStart named it first
  expect(tagOf({ a: 'general-purpose', b: 'general-purpose' }, 'general-purpose', id => id === 'x')).toBe('general-purpose') // parallel spawns not yet numbered
  expect(tagOf({ b: 'general-purpose #2' }, 'general-purpose')).toBe('general-purpose #3') // the first one's name was dropped with its rows
})

test('cost counts cached input as input', () => {
  expect(costOf({ input_tokens: 10, cache_read_input_tokens: 2000, cache_creation_input_tokens: 490, output_tokens: 300 })).toBe('2.5k tok in · 300 tok out')
  expect(costOf(undefined)).toBe('')
})

// the pane over a seeded store: agent A still running, B (background) finished during turn 2
test('a spawned agent\'s rows fold under its Agent row, which shows the agent\'s state', async ($, on) => {
  const t0 = Date.now() - 60000 // the running agent's cell counts from its Agent row's time
  const tool = (t: number, turn: number, detail: string, extra: object = {}) => ({ t: t0 + t, turn, kind: 'tool', name: 'Bash', detail, outcome: 'ok', status: 'ok', ms: 10, ...extra })
  const entries = [
    tool(1, 1, 'general-purpose: probe A', { name: 'Agent', child: 'A', ms: 100 }),
    tool(2, 1, 'general-purpose: probe B', { name: 'Agent', child: 'B', ms: 100 }),
    tool(3, 1, 'list files A', { agent: 'A' }),
    tool(4, 2, 'main work'),
    tool(5, 2, 'list files B', { agent: 'B' }),
    { t: t0 + 6, turn: 2, kind: 'turn', name: 'turn', detail: '', outcome: '1.0k tok in · 10 tok out', status: 'ok', agent: 'B', ms: 80000, peek: 'B done' },
    tool(7, 2, 'general-purpose: probe C', { name: 'Agent', child: 'C', ms: 100 }), // answered without a tool call: nothing to fold
    { t: t0 + 8, turn: 2, kind: 'turn', name: 'turn', detail: '', outcome: '', status: 'ok', agent: 'C', ms: 2000 },
  ]
  on('session.id', () => ({ value: 'S' }))
  on('agent.list', () => ({ value: [{ id: 'A', type: 'general-purpose', description: 'probe A', status: 'running' }, { id: 'B', type: 'general-purpose', description: 'probe B', status: 'completed' }] }))
  on('config.list', () => ({ value: [] }))
  mock.store(on, { 'r:S': { entries, seen: {}, turn: 2, names: { A: 'general-purpose', B: 'general-purpose #2' } } })
  const m = await $.ui.mount({ plugin: 'agent-log', surface: 'terminal', component: 'Pane', requestId: 'agent-log', props: { title: 'Agent log', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 } } as any })
  expect(await m.find({ text: /^general-purpose: probe A$/ })).toBeDefined() // the type is an identifier: never recased
  expect(await m.find({ text: /List files A/ })).toBe(undefined) // folded
  expect(await m.find({ text: /List files B/ })).toBe(undefined) // folded, though logged in turn 2
  expect(await m.find({ text: /^● 1m00s$/ })).toBeDefined() // A still runs: its time counts up, a minute in
  expect(await m.find({ text: /1m20s/ })).toBeDefined() // B's run, not its 100ms launch
  // the header lists A as a log row: its name and task, its run counting up as on its Agent row
  expect(await m.find({ type: 'Button', text: /^general-purpose: probe A$/ })).toBeDefined()
  expect((await m.findAll({ type: 'Text', text: /^● 1m00s$/ })).length).toBe(2)
  expect(await m.find({ type: 'Button', text: /^general-purpose #2: probe B$/ })).toBe(undefined) // finished: folded into the toggle row
  await m.press({ key: 'fdone' }) // B has finished: the header lists it once finished ones are shown
  expect(await m.find({ type: 'Button', text: /^general-purpose #2: probe B$/ })).toBeDefined() // and tells it from A
  const folds = await m.findAll({ type: 'Button', text: /^▸$/ })
  expect(folds.length).toBe(2) // A and B; C's turn end opens no fold
  await m.press({ key: folds[0]!.key! })
  expect(await m.find({ text: /List files A/ })).toBeDefined()
  expect(await m.find({ type: 'Button', text: /^input & result$|^reply: / })).toBe(undefined) // no closing row: the Agent row's inspector holds both
  await m.press({ key: folds[1]!.key! }) // only ▸ opens a fold
  expect(await m.find({ text: /List files B/ })).toBeDefined()
  await m.press({ key: (await m.find({ type: 'Button', text: /^general-purpose: probe B$/ }))!.key! }) // the row: its inspector, the agent's run, cost and answer
  expect(await m.find({ text: '1m20s' })).toBeDefined()
  expect(await m.find({ text: '1.0k tok in · 10 tok out' })).toBeDefined()
  expect(await m.find({ text: 'B done' })).toBeDefined()
  // pressing an agent's header row filters the log to its rows, now flat; the filter's chip clears it
  await m.press({ key: 'back' })
  await m.press({ key: (await m.find({ type: 'Button', text: /^general-purpose: probe A$/ }))!.key! })
  expect(await m.find({ text: /^List files A$/ })).toBeDefined()
  expect(await m.find({ text: /^Main work$/ })).toBe(undefined)
  await m.press({ key: 'fclear' })
  expect(await m.find({ text: /^Main work$/ })).toBeDefined()
  await m.press({ key: 'fdone' }) // module state: finished agents folded again for the tests below
  await m.press({ key: 'folds' }) // and A's and B's folds closed: o closes every fold once all are open
  expect(await m.find({ text: /List files A/ })).toBe(undefined)
})

test('an mcp row reads `tool: arg` as named, a handle before a mode flag; a tool-schema load ranks debug', async ($, on) => {
  on('session.id', () => ({ value: 'T' }))
  on('agent.list', () => ({ value: [] }))
  on('config.list', () => ({ value: [] }))
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  mock.store(on, {})
  await $.tool.call({ tool: 'mcp__plugin_context-mode_context-mode__ctx_execute', language: 'shell', code: 'ls' } as any)
  await $.tool.call({ tool: 'mcp__plugin_context-mode_context-mode__ctx_search', sort: 'timeline', queries: ['hooks', 'plans'] } as any)
  await $.tool.call({ tool: 'mcp__plugin_context-mode_context-mode__ctx_batch_execute', commands: [{ label: 'a', command: 'ls' }] } as any)
  await $.tool.call({ tool: 'ToolSearch', query: 'select:Monitor' } as any)
  const m = await $.ui.mount({ plugin: 'agent-log', surface: 'terminal', component: 'Pane', requestId: 'agent-log', props: { title: 'Agent log', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 } } as any })
  expect(await m.find({ text: /ctx_execute: shell/ })).toBeDefined() // no handle key: the first string
  expect(await m.find({ text: /ctx_search: hooks, plans/ })).toBeDefined() // the handle, not the first string (sort)
  expect(await m.find({ text: /ctx_batch_execute$/ })).toBeDefined() // no string argument: the tool alone
  expect(await m.find({ text: /context-mode/i })).toBe(undefined) // the server is dropped, never recased
  expect(await m.find({ text: /Load tools/ })).toBe(undefined) // debug: below the default level
})

// an engine row as the store holds it, under a name from an older label: the stored text decides. Texts are real rows' first lines
const ctx = (type: string, peek: string, extra: object = {}) => ({ t: 0, turn: 1, kind: 'prompt' as const, name: 'old name', type, detail: '', outcome: '', src: 'engine' as const, bytes: peek.length, peek, ...extra })
const ENV = '# Environment update\n - Primary working directory: /home/u/dotagents/claude (was /home/u/dotagents)'

test('engine context reads its kind and what it is about', () => {
  expect(ctxOf(ctx('environment', ENV))).toEqual(['CWD', ' → claude'])
  expect(ctxOf(ctx('environment', '# Environment update\n - Primary working directory: /mnt/c/My Vault'))).toEqual(['CWD', ' → My Vault']) // no `(was …)`, a space in the path
  expect(ctxOf(ctx('environment', '# Environment update\n - Primary working directory: /home/u/a (was /home/u/very/long/pa'))).toEqual(['CWD', ' → a']) // cut by the PEEK cap
  expect(ctxOf(ctx('environment', '# Environment update\n - Additional working directories: /x'))).toEqual(['env change'])
  expect(ctxOf(ctx('environment', '# Environment\nYou have been invoked in the following environment:'))).toEqual(['environment']) // the first message's block
  expect(ctxOf(ctx('date', 'Today\'s date is 2026-10-09.', { name: 'date change' }))).toEqual(['date']) // logged under the old, wrong label
  expect(ctxOf(ctx('date', 'The date has changed. Today\'s date is now 2026-10-10.'))).toEqual(['date change'])
  expect(ctxOf(ctx('currentDate', 'Today\'s date is 2026-10-09.'))).toEqual(['date'])
})

test('a list delta reads as the list, or what it added or removed', () => {
  expect(ctxOf(ctx('deferred_tools_delta', 'The following deferred tools are now available via ToolSearch.'))).toEqual(['tool list'])
  expect(ctxOf(ctx('deferred_tools_delta', 'The following deferred tools are no longer available (their MCP server disconnected).'))).toEqual(['tools removed'])
  expect(ctxOf(ctx('agent_listing_delta', 'Available agent types for the Agent tool:\n- claude: Catch-all'))).toEqual(['agent list'])
  expect(ctxOf(ctx('agent_listing_delta', 'New agent types are now available for the Agent tool:'))).toEqual(['agents added'])
  expect(ctxOf(ctx('agent_listing_delta', 'The following agent types are no longer available:\n- codex:codex-rescue'))).toEqual(['agents removed'])
  expect(ctxOf(ctx('mcp_instructions_delta', '# MCP Server Instructions\n\nThe following MCP servers have provided instructions'))).toEqual(['MCP instructions'])
  expect(ctxOf(ctx('mcp_instructions_delta', 'The following MCP servers have disconnected. Their instructions above no longer apply:\nskins'))).toEqual(['MCP disconnected'])
})

test('a note about one file is named by it, a CLAUDE.md by its folder', () => {
  expect(ctxOf(ctx('edited_text_file', 'Note: /home/u/hooks/tests/guard cases.tsv changed on disk since you last read it.'))).toEqual(['changed', ': guard cases.tsv'])
  expect(ctxOf(ctx('compact_file_reference', 'Note: /home/u/hooks/security/guard.md was read before the last conversation was summarized'))).toEqual(['not restored', ': guard.md'])
  expect(ctxOf(ctx('file', 'Called the Read tool with the following input: {"file_path":"/home/u/docs/plans/x.md"}\nResult of calling the Read tool:'))).toEqual(['mentioned', ': x.md'])
  expect(ctxOf(ctx('nested_memory', 'Contents of /home/u/dotagents/claude/CLAUDE.md:\n\n@RULES.md'))).toEqual(['memory', ': claude/CLAUDE.md'])
})

test('a kind without a label keeps its stored name, and a hook\'s row the hook\'s', () => {
  expect(ctxOf(ctx('skill_prompt', 'Base directory for this skill', { name: 'skill code-review' }))).toEqual(['skill code-review'])
  expect(ctxOf(ctx('hook_success', 'SessionStart:clear hook success: Preflight', { name: 'preflight-context', src: 'hook' }))).toEqual(['preflight-context']) // not `output`
  expect(ctxOf(ctx('output_style', 'Concise output style is active.', { src: undefined }))).toEqual(['style reminder']) // a row from before src was stored
})

test('a cwd change shows at notice; the context beside it, each entry its own row, does not', async ($, on) => {
  on('session.id', () => ({ value: 'U' }))
  on('agent.list', () => ({ value: [] }))
  on('config.list', () => ({ value: [] }))
  const entries = [
    ctx('environment', ENV),
    ctx('nested_memory', 'Contents of /home/u/dotagents/claude/CLAUDE.md:\n\n@RULES.md'),
    ctx('edited_text_file', 'Note: /home/u/dotagents/claude/x.ts changed on disk since you last read it.'),
  ]
  mock.store(on, { 'r:U': { entries, seen: {}, turn: 1, names: {} } })
  const m = await $.ui.mount({ plugin: 'agent-log', surface: 'terminal', component: 'Pane', requestId: 'agent-log', props: { title: 'Agent log', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 } } as any })
  expect(await m.find({ text: /^CWD → claude$/ })).toBeDefined()
  expect(await m.find({ text: /^Changed: x\.ts$/ })).toBeDefined()
  await m.press({ key: 'lvl' }) // info -> notice
  expect(await m.find({ text: /^CWD → claude$/ })).toBeDefined()
  expect(await m.find({ text: /^Changed: x\.ts$/ })).toBe(undefined)
  await m.press({ key: 'lvl' }) // back to info: the level is module state
})

test('engine context draws one row per entry, nothing folded', async ($, on) => {
  on('session.id', () => ({ value: 'BK' }))
  on('agent.list', () => ({ value: [] }))
  on('config.list', () => ({ value: [] }))
  const entries = [
    ctx('edited_text_file', 'Note: /home/u/x.ts changed on disk since you last read it.'), ctx('nested_memory', 'Contents of /home/u/a/CLAUDE.md:\n\nx'),
    ctx('deferred_tools_delta', 'The following deferred tools are no longer available (their MCP server disconnected).'), ctx('date', 'The date has changed.'),
  ]
  mock.store(on, { 'r:BK': { entries, seen: {}, turn: 1, names: {} } })
  const m = await pane($, 40, 100)
  expect(await m.find({ type: 'Button', text: /^Changed: x\.ts$/ })).toBeDefined()
  expect(await m.find({ type: 'Button', text: /^Tools removed$/ })).toBeDefined()
  expect(await m.find({ type: 'Button', text: /^▸$/ })).toBe(undefined)
})

test('engine context that only composes the request is logged but not shown, its view hidden', async ($, on) => {
  const m = await mountWith($, on, 'HC', [ctx('model', 'You are powered by', { name: 'model' }), ctx('session_context', 'git status'), ctx('skill_listing', 'skills'), call({ detail: 'after' })])
  expect(await m.find({ type: 'Button', text: /^After$/ })).toBeDefined()
  expect(await m.find({ text: /session start|skill list|Engine/ })).toBe(undefined)
  expect(await m.find({ key: 'vcontext' })).toBe(undefined)
  expect(await m.find({ text: /tok/ })).toBe(undefined) // no size anywhere
})

// a store the test reads back: what agent-log wrote, by key. session.end flushes the log's last second
const capture = (on: any, id: string, agents: object[] = []) => {
  const db: Record<string, any> = {}
  on('session.id', () => ({ value: id }))
  on('agent.list', () => ({ value: agents }))
  on('config.list', () => ({ value: [] }))
  on('store.get', (_$: any, e: any) => ({ value: db[e.key] }))
  on('store.set', (_$: any, e: any) => { db[e.key] = e.value; return { value: undefined } })
  on('store.delete', (_$: any, e: any) => { delete db[e.key]; return { value: undefined } })
  on('store.keys', () => ({ value: Object.keys(db) }))
  on('session.end', (_$: any, e: any) => ({ sessionId: e.sessionId }))
  return db
}
const flushed = async ($: any, id: string, db: Record<string, any>) => { await $.session.end({ reason: 'other', sessionId: id }); return (db[`r:${id}`]?.entries ?? []) as any[] }

test('email and date log once, as the attachments that carry them, not also as first-message blocks', async ($, on) => {
  const db = capture(on, 'V')
  on('prompt.context', ($, e) => ({ blocks: e.blocks }))
  on('prompt.attachment', ($, e) => ({ text: e.text }))
  const mem = 'Codebase and user instructions are shown below.\n' + 'x'.repeat(400)
  const email = 'The user\'s email address is u@example.com. Use it only to identify the user.'
  const date = 'Today\'s date is 2026-10-10.'
  const user = `As you answer the user's questions, you can use the following context:\n# userEmail\n${email}\n# gitStatus\nCurrent branch: main`
  await $.prompt.context({ blocks: [{ name: 'claudeMd', text: mem }, { name: 'userEmail', text: email }, { name: 'currentDate', text: date }] })
  await $.prompt.attachment({ type: 'session_context', text: user, origin: { kind: 'engine' } })
  await $.prompt.attachment({ type: 'date', text: date, origin: { kind: 'engine' } })
  const rows = (await flushed($, 'V', db)).filter(x => x.kind === 'prompt')
  expect(rows.map(x => x.type)).toEqual(['claudeMd', 'session_context', 'date']) // no `email`, no second date
  expect(rows.reduce((n, x) => n + x.bytes, 0)).toBe(mem.length + user.length + date.length) // each text counted once
})

// When the plugin chain changes (another plugin loaded, edited or removed), the engine asks a running instance for the whole
// history again, in order, on the next request: the log keeps one row per copy that entered the context
const MEM = { blocks: [{ name: 'claudeMd', text: 'Codebase and user instructions are shown below.' }] } as any
const START = { type: 'hook_success', text: 'SessionStart:startup hook success: Preflight (preflight-context hook):', origin: { kind: 'hook', event: 'SessionStart' } } as any
const ASK = { type: 'hook_success', text: 'UserPromptSubmit hook success: question-mode: Rule for THIS message only', origin: { kind: 'hook', event: 'UserPromptSubmit' } } as any
const MODE = { type: 'auto_mode', text: 'While auto mode is active:', origin: { kind: 'engine' } } as any
const replay = (on: any, id: string, agents: object[] = []) => {
  const db = capture(on, id, agents)
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  on('prompt.context', (_$: any, e: any) => ({ blocks: e.blocks }))
  on('prompt.attachment', (_$: any, e: any) => ({ text: e.text }))
  return db
}
const kinds = (rows: any[]) => rows.filter(x => x.kind === 'prompt').map(x => `${x.type}${x.origin ? ` ${x.origin}` : ''}`)
const ls = (use: string) => ({ tool: 'Bash', tool_use_id: use, command: 'ls', description: 'List' }) as any

test('the whole history asked again of a running instance logs only what is new', async ($, on) => {
  const db = replay(on, 'RP')
  await $.prompt.context(MEM); await $.prompt.attachment(START); await $.prompt.attachment(ASK)
  await $.tool.call(ls('rp1'))
  await $.prompt.attachment(ASK) // the next prompt's
  await $.tool.call(ls('rp2'))
  await $.prompt.context(MEM); for (const a of [START, ASK, ASK]) await $.prompt.attachment(a) // the replay
  await $.prompt.attachment(ASK) // this prompt's, new
  expect(kinds(await flushed($, 'RP', db))).toEqual(['claudeMd', 'hook_success SessionStart', 'hook_success UserPromptSubmit', 'hook_success UserPromptSubmit', 'hook_success UserPromptSubmit'])
})

test('attachments asked again without the first message are a replay too', async ($, on) => {
  const db = replay(on, 'RA')
  await $.prompt.attachment(START); await $.prompt.attachment(ASK)
  await $.tool.call(ls('ra1'))
  for (const a of [START, ASK, ASK]) await $.prompt.attachment(a)
  expect(kinds(await flushed($, 'RA', db))).toEqual(['hook_success SessionStart', 'hook_success UserPromptSubmit', 'hook_success UserPromptSubmit'])
})

test('the first message re-read alone hides its own copy, not an attachment sent with it', async ($, on) => {
  const db = replay(on, 'RC')
  await $.prompt.context(MEM); await $.prompt.attachment(START); await $.prompt.attachment(MODE)
  await $.tool.call(ls('rc1'))
  await $.prompt.context(MEM); await $.prompt.attachment(MODE) // auto mode turned on again: new, though its text is the same
  expect(kinds(await flushed($, 'RC', db))).toEqual(['claudeMd', 'hook_success SessionStart', 'auto_mode', 'auto_mode'])
})

const TIP = { type: 'hook_additional_context', text: 'UserPromptSubmit hook additional context: <context_guidance>', origin: { kind: 'hook', event: 'UserPromptSubmit' } } as any
const by = (agentId: string) => (a: any) => ({ ...a, agentId })

test('a replayed PostToolUse copy leaves the live call its place in the queue', async ($, on) => {
  const db = replay(on, 'RQ')
  on('classic.PostToolUse', (_$: any, e: any) => (e.tool_use_id === 'rqb' ? {} : { additionalContext: [`tip for ${e.tool_use_id}`] }))
  const read = (f: string) => $.tool.call({ tool: 'Read', tool_use_id: `rq${f}`, file_path: `/home/u/${f}.ts` } as any)
  const hook = (f: string) => ($ as any).classic.PostToolUse({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: `rq${f}`, tool_input: {}, tool_response: 'ok' })
  const tip = (f: string) => ({ type: 'hook_additional_context', text: `PostToolUse:Read hook additional context: tip for rq${f}`, origin: { kind: 'hook', event: 'PostToolUse' } }) as any
  await $.prompt.attachment(START)
  await read('x'); await hook('x'); await $.prompt.attachment(tip('x'))
  await Promise.all(['a', 'b'].map(read)); for (const f of ['a', 'b']) await hook(f) // only a's hook adds context
  await $.prompt.attachment(START); await $.prompt.attachment(tip('x')) // the replay
  await $.prompt.attachment(tip('a'))
  expect((await flushed($, 'RQ', db)).filter(x => x.kind === 'prompt' && x.origin === 'PostToolUse').map(x => x.use)).toEqual(['rqx', 'rqa'])
})

test('a fork replayed partway through logs none of the history it inherited again', async ($, on) => {
  const db = replay(on, 'RF'), f = by('F') // no spawn and no list names F: a fork
  await $.prompt.attachment(START); await $.prompt.attachment(ASK)
  await $.tool.call(ls('rf1'))
  await $.prompt.attachment(f(START)); await $.prompt.attachment(f(ASK)) // its first request: main's history
  await $.tool.call({ ...ls('rf2'), agentId: 'F' })
  await $.prompt.attachment(f(TIP))
  for (const a of [START, ASK, TIP]) await $.prompt.attachment(f(a)) // the replay
  await $.prompt.attachment(f(TIP)) // new
  expect(kinds(await flushed($, 'RF', db))).toEqual(['hook_success SessionStart', 'hook_success UserPromptSubmit', 'hook_additional_context UserPromptSubmit', 'hook_additional_context UserPromptSubmit'])
})

test('a subagent whose history opens with a hook tip logs none of it again on a replay', async ($, on) => {
  const db = replay(on, 'RS', [{ id: 'S', type: 'general-purpose', description: 'probe', status: 'running' }]), s = by('S')
  const SUB = { type: 'hook_success', text: 'SubagentStart hook success: you are a subagent', origin: { kind: 'hook', event: 'SubagentStart' } }
  await $.prompt.attachment(s(TIP)); await $.prompt.attachment(s(SUB))
  await $.tool.call({ ...ls('rs1'), agentId: 'S' })
  await $.prompt.attachment(s(TIP)); await $.prompt.attachment(s(SUB)) // the replay
  expect(kinds(await flushed($, 'RS', db))).toEqual(['hook_additional_context UserPromptSubmit', 'hook_success SubagentStart'])
  await $.prompt.attachment(s(TIP)) // new: the replay's tip owes nothing more
  expect(kinds(await flushed($, 'RS', db))).toEqual(['hook_additional_context UserPromptSubmit', 'hook_success SubagentStart', 'hook_additional_context UserPromptSubmit'])
})

test('a subagent\'s PreToolUse hook row is credited to the subagent', async ($, on) => {
  const db = capture(on, 'AT')
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  on('classic.PreToolUse', () => ({ additionalContext: ['tip'] }) as any) // its envelope is the bare call: no loop named
  await $.tool.call({ tool: 'Bash', tool_use_id: 'at1', command: 'ls', description: 'List', agentId: 'A' } as any)
  const rows = await flushed($, 'AT', db)
  expect(rows.find(x => x.kind === 'hook')?.agent).toBe('A')
  expect(rows.find(x => x.kind === 'tool')?.agent).toBe('A')
})

test('controls pack into rows of the width, in order, two cells apart', () => {
  expect(pack([6, 8, 10, 10], 40)).toEqual([[0, 1, 2, 3]]) // 6+2+8+2+10+2+10 = 40
  expect(pack([6, 8, 10, 10], 30)).toEqual([[0, 1, 2], [3]])
  expect(pack([50, 4], 30)).toEqual([[0], [1]]) // too wide for any row: a row of its own
})

// a pane over 30 shell rows in one turn: `Step 1` … `Step 30`, none folding
const PANE_PROPS = { title: 'Agent log', isFocused: false, placement: 'dock' }
// a session's handlers and store: these entries stored under its key, or an empty store for a test that logs through the hooks
const session = (on: any, id: string, entries?: object[], { turn = 1, names = {}, agents = [] as object[] } = {}) => {
  on('session.id', () => ({ value: id }))
  on('agent.list', () => ({ value: agents }))
  on('config.list', () => ({ value: [] }))
  on('ui.panes', () => ({ value: [{ id: 'agent-log' }] })) // the pane is up: /agentlog sets the level, it does not toggle it shut
  mock.store(on, entries ? { [`r:${id}`]: { entries, seen: {}, turn, names } } : {})
}
type Engine = Parameters<TestBody>[0] // a test's `$`
const pane = ($: Engine, bodyRows = 60, bodyColumns = 120) => $.ui.mount({ plugin: 'agent-log', surface: 'terminal', component: 'Pane', requestId: 'agent-log', props: { ...PANE_PROPS, bodyColumns, scroll: { offset: 0, bodyRows } } as any })
// the level is module state, set by /agentlog (`l` toggles only info and notice): a test that changes it goes back to info before it ends
const toLevel = async ($: Engine, m: any, level: 'debug' | 'info' | 'notice' | 'error') => {
  await ($ as any).command.run({ command: 'agentlog', args: `level ${level}`, origin: { kind: 'composer' }, presentation: 'text' })
  await m.redraw()
}
const steps = () => Array.from({ length: 30 }, (_, i) => ({ t: Date.now() - 60000 + i, turn: 1, kind: 'tool', name: 'Bash', detail: `step ${i + 1}`, outcome: 'ok', status: 'ok', ms: 10 }))
const ctlRows = async (m: any) => { let n = 0; while (await m.find({ key: `ctl${n}` })) n++; return n }

test('the log draws only the rows that fit under the header, which never scrolls', async ($, on) => {
  on('session.id', () => ({ value: 'W' }))
  on('agent.list', () => ({ value: [] }))
  on('config.list', () => ({ value: [] }))
  mock.store(on, { 'r:W': { entries: steps(), seen: {}, turn: 1, names: {} } })
  const m = await $.ui.mount({ plugin: 'agent-log', surface: 'terminal', component: 'Pane', requestId: 'agent-log', props: { ...PANE_PROPS, bodyColumns: 100, scroll: { offset: 0, bodyRows: 12 } } as any })
  expect((await m.find({ type: 'Box' }))!.children.length).toBe(12) // two rows of controls, rule (no main row: no agent running), then 9 of the 31 log rows
  expect(await m.find({ text: /^Step 30$/ })).toBeDefined() // following: the newest
  expect(await m.find({ text: /^#1$/ })).toBeDefined() // the window starts mid-turn: its header pinned on the first line
  expect(await m.find({ text: /^Step 23$/ })).toBeDefined()
  expect(await m.find({ text: /^Step 22$/ })).toBe(undefined)
  expect(await m.find({ key: 'jump' })).toBe(undefined)
  // back from the inspector centres the row it opened from; not at the end, the jump row takes the last row
  await m.press({ key: (await m.find({ type: 'Button', text: /^Step 23$/ }))!.key! })
  await m.press({ key: 'back' })
  expect(await m.find({ text: /^Step 23$/ })).toBeDefined()
  expect(await m.find({ text: /^Step 30$/ })).toBe(undefined)
  expect(await m.find({ key: 'jump' })).toBeDefined()
  expect((await m.find({ type: 'Box' }))!.children.length).toBe(12)
  await m.press({ key: 'jump' })
  expect(await m.find({ text: /^Step 30$/ })).toBeDefined()
  // back onto the newest row keeps following: no jump row
  await m.press({ key: (await m.find({ type: 'Button', text: /^Step 30$/ }))!.key! })
  await m.press({ key: 'back' })
  expect(await m.find({ text: /^Step 30$/ })).toBeDefined()
  expect(await m.find({ key: 'jump' })).toBe(undefined)
})

test('the controls take as many rows as the width needs, never clipping one', async ($, on) => {
  on('session.id', () => ({ value: 'C' }))
  on('agent.list', () => ({ value: [] }))
  on('config.list', () => ({ value: [] }))
  mock.store(on, { 'r:C': { entries: steps(), seen: {}, turn: 1, names: {} } })
  const props = (bodyColumns: number) => ({ ...PANE_PROPS, bodyColumns, scroll: { offset: 0, bodyRows: 20 } }) as any
  const m = await $.ui.mount({ plugin: 'agent-log', surface: 'terminal', component: 'Pane', requestId: 'agent-log', props: props(100) })
  expect(await ctlRows(m)).toBe(2) // `a: all•  m: model  h: harness  u: outside  l: level info    o: unfold  i: keys  ^↑↓ turn  j: ↓`, then `k: ↑  s: setup`
  // a: all•, m: model, h: harness, u: outside, l: level info (padded to `level notice`), o: unfold, i: keys, ^↑↓ turn, j: ↓, k: ↑, s: the setup's label
  const bare = [7, 9, 11, 11, 15, 9, 7, 8, 4, 4, String((await m.find({ key: 'fsetup' }))!.props.label).length + 3]
  for (const cols of [50, 30]) {
    await m.redraw(props(cols))
    expect(await ctlRows(m)).toBe(pack(bare, cols - 1).length)
    for (const k of ['vall', 'vmodel', 'vharness', 'voutside', 'lvl', 'folds', 'legend', 'tprev', 'tnext', 'cdown', 'cup', 'fsetup']) expect(await m.find({ key: k })).toBeDefined()
  }
  expect(await ctlRows(m)).toBe(5) // 30 columns: two views; harness and outside; level and folds; keys, the prompt jumps and the cursor; the setup
})

test('k and j move a row cursor the window keeps in view; e goes back to the newest', async ($, on) => {
  session(on, 'CU', steps())
  const m = await pane($, 12, 100) // 9 log rows: Step 22-30
  await m.press({ key: 'cup' }) // the cursor starts on the window's last row: Step 30
  for (let i = 0; i < 9; i++) await m.press({ key: 'cup' }) // up to Step 21, above the window
  expect(await m.find({ text: /^Step 21$/ })).toBeDefined()
  expect(await m.find({ text: /^Step 30$/ })).toBe(undefined) // the window moved up with it
  expect(await m.find({ key: 'jump' })).toBeDefined()
  await m.press({ key: 'cdown' }) // Step 22: in view, the window stays
  expect(await m.find({ text: /^Step 21$/ })).toBeDefined()
  await m.press({ key: 'jump' }) // e: the newest, the cursor starts over
  expect(await m.find({ text: /^Step 30$/ })).toBeDefined()
  await m.press({ key: 'cup' })
  expect(await m.find({ key: 'jump' })).toBe(undefined) // a cursor on the last page leaves the window following
  // in the inspector j and k step to its next and previous row, as n and p do; on a page they do nothing
  await m.press({ key: (await m.find({ type: 'Button', text: /^Step 25$/ }))!.key! })
  await m.press({ key: 'cdown' })
  expect(await m.find({ text: /^step 26$/ })).toBeDefined()
  await m.press({ key: 'cup' }); await m.press({ key: 'cup' })
  expect(await m.find({ text: /^step 24$/ })).toBeDefined()
  await m.press({ key: 'back' }) // the cursor on the row back lands on
  await m.press({ key: 'legend' }); await m.press({ key: 'cdown' }); await m.press({ key: 'legend' })
  expect(await m.find({ text: /^Step 24$/ })).toBeDefined() // the page's way back follows the newest again
})

test('ctrl+↑↓ (the turn ↑↓ buttons) put the previous or next prompt\'s turn header at the top', async ($, on) => {
  on('session.id', () => ({ value: 'T' }))
  on('agent.list', () => ({ value: [] }))
  on('config.list', () => ({ value: [] }))
  // three turns of ten: rows #1, Step 1-10, gap, #2, Step 11-20, gap, #3, Step 21-30
  const entries = steps().map((x, i) => ({ ...x, turn: Math.floor(i / 10) + 1 }))
  mock.store(on, { 'r:T': { entries, seen: {}, turn: 3, names: {} } })
  const m = await $.ui.mount({ plugin: 'agent-log', surface: 'terminal', component: 'Pane', requestId: 'agent-log', props: { ...PANE_PROPS, bodyColumns: 100, scroll: { offset: 0, bodyRows: 13 } } as any })
  expect(await m.find({ text: /^Step 30$/ })).toBeDefined()
  expect(await m.find({ text: /^Step 21$/ })).toBe(undefined) // 10 rows show: #3 pinned over Step 22-30
  await m.press({ key: 'tprev' })
  expect(await m.find({ text: /^#3$/ })).toBeDefined()
  expect(await m.find({ text: /^Step 21$/ })).toBeDefined() // #3 is the top row, no longer pinned
  expect(await m.find({ text: /^Step 30$/ })).toBe(undefined)
  await m.press({ key: 'tprev' })
  expect(await m.find({ text: /^#2$/ })).toBeDefined()
  expect(await m.find({ text: /^Step 10$/ })).toBe(undefined) // #2 is the top row
  await m.press({ key: 'tnext' })
  expect(await m.find({ text: /^#3$/ })).toBeDefined()
  expect(await m.find({ text: /^#2$/ })).toBe(undefined)
  await m.press({ key: 'tnext' }) // past the last prompt: the end, following
  expect(await m.find({ text: /^Step 30$/ })).toBeDefined()
  expect(await m.find({ key: 'jump' })).toBe(undefined)
})

// lookups in hooks/, three by default: `Explore hooks ×3`
const reads = (t0: number, extra: object = {}, files = ['a', 'b', 'c']) => files.map((f, i) => ({ t: t0 + i, turn: 1, kind: 'tool', name: 'Read', detail: `/home/u/hooks/${f}.ts`, outcome: 'ok', status: 'ok', ms: 10, ...extra }))
// an Agent row that spawned agent A, then A's reads: the one fold the log keeps
const spawn = (t0: number, files = ['a', 'b', 'c']) => [{ t: t0, turn: 1, kind: 'tool', name: 'Agent', detail: 'scout: look around', outcome: 'ok', status: 'ok', ms: 10, child: 'A' }, ...reads(t0 + 1, { agent: 'A' }, files)]
// the line a row sits on in the pane's body, the header's rows counted (3 at 100 columns with no agent running: two of controls, the rule): the same line
// before and after means it did not move
const lineOf = async (m: any, k: string) => (await m.find({ type: 'Box' }))!.children.findIndex((c: any) => c.props?.key === k)

test('a fold opens where it was pressed, its rows on tree guides, each opening its inspector', async ($, on) => {
  // #1, Step 1-25, the Agent row's fold, Step 26-30: following, 9 rows show (Step 23-25, the fold, Step 26-30)
  const s = steps(), entries = [...s.slice(0, 25), ...spawn(s[24]!.t), ...s.slice(25).map(x => ({ ...x, t: x.t + 4 }))]
  session(on, 'F', entries, { names: { A: 'scout' } })
  const m = await pane($, 13, 100)
  const fold = await m.find({ type: 'Button', text: /^▸$/ })
  expect(fold).toBeDefined()
  const row = fold!.key!.slice(1), at = await lineOf(m, row)
  expect(await m.find({ text: /^Step 23$/ })).toBeDefined()
  await m.press({ key: fold!.key! })
  // the fold kept its line: Step 23 still tops the window; following would have pinned Step 30 and dropped Step 23-25
  expect(await lineOf(m, row)).toBe(at)
  expect(await m.find({ text: /^Step 23$/ })).toBeDefined()
  expect(await m.find({ text: /^Read c\.ts$/ })).toBeDefined()
  expect((await m.findAll({ type: 'Text', text: /^├ $/ })).length).toBe(2) // the agent's reads, the last on └
  expect((await m.findAll({ type: 'Text', text: /^└ $/ })).length).toBe(1)
  expect(await m.find({ text: /^Step 30$/ })).toBe(undefined)
  expect(await m.find({ key: 'jump' })).toBeDefined()
  await m.press({ key: (await m.find({ type: 'Button', text: /^Read a\.ts$/ }))!.key! }) // a row without ▸: its inspector
  expect(await m.find({ text: /^Read call by the / })).toBeDefined()
  await m.press({ key: 'folds' }) // o in the inspector closes the fold, but must not move the window back centres
  await m.press({ key: 'back' })
  expect(await m.find({ text: /^Read a\.ts$/ })).toBe(undefined)
  expect(await lineOf(m, row)).toBe(3 + 1 + 5) // the closed fold that holds Read a.ts, centred: 5 of the 10 log rows above it, under #1 pinned
})

test('a fold\'s last call with a wait above it: the guide runs on to the call, which closes it', async ($, on) => {
  const s = spawn(Date.now() - 60000), last = s.length - 1
  s[last] = { ...s[last]!, wait: 400, waitFor: 'the auto-mode classifier' } as any
  session(on, 'FW', s, { names: { A: 'scout' } })
  const m = await pane($)
  await m.press({ key: (await m.find({ type: 'Button', text: /^▸$/ }))!.key! })
  expect(await m.find({ type: 'Button', text: /^Waiting for the auto-mode classifier$/ })).toBeDefined()
  expect((await m.findAll({ type: 'Text', text: /^├ $/ })).length).toBe(3) // two reads and the wait
  expect((await m.findAll({ type: 'Text', text: /^└ $/ })).length).toBe(1) // the call alone
})

test('the header hangs each agent under its parent on the log\'s tree guides', async ($, on) => {
  const run = (id: string, description: string, parentId?: string) => ({ id, type: 'general-purpose', description, status: 'running', parentId })
  session(on, 'H', [], { agents: [run('A', 'implement'), run('A1', 'scout', 'A'), run('A2', 'review', 'A'), run('B', 'docs')] })
  const m = await pane($)
  await m.press({ key: 'fdone' }) // three agent rows until the list opens
  // main, then A (more follow: ├), its children on A's line carried on (│), B last (└)
  const rails = (await m.findAll({ type: 'Text', text: /^[│├└ ]+$/ })).map(t => String(t.text)).filter(t => /[│├└]/.test(t))
  expect(rails).toEqual(['├ ', '│ ├ ', '│ └ ', '└ '])
})

test('opening the newest fold while following shows it, its row staying on screen', async ($, on) => {
  const s = steps().slice(0, 25), entries = [...s, ...spawn(s[24]!.t + 1)] // the fold is the last row, on the last line
  session(on, 'N', entries, { names: { A: 'scout' } })
  const m = await pane($, 12, 100)
  const fold = await m.find({ type: 'Button', text: /^▸$/ })
  await m.press({ key: fold!.key! })
  expect(await lineOf(m, fold!.key!.slice(1))).toBeGreaterThanOrEqual(3) // still drawn, not under the jump row
  expect(await m.find({ text: /^Read c\.ts$/ })).toBeDefined() // the window moved down just far enough to show the fold
  expect(await m.find({ key: 'jump' })).toBe(undefined) // which put it at the end: following
  await m.press({ key: fold!.key! })
})

test('o keeps the turn header at the window\'s top in place, though folds above it open', async ($, on) => {
  // #1, the fold, Step 1-3, gap, #2, Step 4-20
  const entries = [...reads(Date.now() - 70000), ...steps().slice(0, 20).map((x, i) => ({ ...x, turn: i < 3 ? 1 : 2 }))]
  session(on, 'H', entries, { turn: 2 })
  const m = await pane($, 12, 100)
  await m.press({ key: 'tprev' })
  expect(await lineOf(m, 'turn2')).toBe(3) // the first log row
  await m.press({ key: 'folds' })
  expect(await lineOf(m, 'turn2')).toBe(3)
  await m.press({ key: 'folds' })
})

test('o from inside an open fold keeps the fold\'s row at the window\'s top', async ($, on) => {
  // #1, Step 1, the fold of ten, Step 2-16
  const s = steps().slice(0, 16), entries = [s[0]!, ...spawn(s[0]!.t, [...'abcdefghij']), ...s.slice(1).map(x => ({ ...x, t: x.t + 11 }))]
  session(on, 'I', entries, { names: { A: 'scout' } })
  const m = await pane($, 12, 100)
  await m.press({ key: 'tprev' })
  const row = (await m.find({ type: 'Button', text: /^▸$/ }))!.key!.slice(1)
  await m.press({ key: 'folds' })
  await m.press({ key: 'tprev' }) // #1 on top: #1, Step 1, the fold, Read a-e
  await m.press({ key: (await m.find({ type: 'Button', text: /^Read e\.ts$/ }))!.key! })
  await m.press({ key: 'back' }) // Read e.ts centred: Read a.ts tops the window, inside the fold
  expect(await m.find({ text: /^Step 1$/ })).toBe(undefined)
  expect(await lineOf(m, row)).toBe(-1) // its row is above the window
  await m.press({ key: 'folds' })
  expect(await lineOf(m, row)).toBe(4) // the window's top, under #1 pinned
})

test('o opens and closes every fold', async ($, on) => {
  session(on, 'G', spawn(Date.now() - 1000), { names: { A: 'scout' } })
  const m = await pane($, 40, 100)
  expect(await m.find({ type: 'Button', text: /^unfold$/ })).toBeDefined()
  await m.press({ key: 'folds' })
  expect(await m.find({ text: /^Read a\.ts$/ })).toBeDefined()
  expect(await m.find({ type: 'Button', text: /^fold/ })).toBeDefined()
  await m.press({ key: 'folds' })
  expect(await m.find({ text: /^Read a\.ts$/ })).toBe(undefined)
})

test('a PreToolUse hook\'s context, sent with the request after the call, sits above the call it ran before, linked', async ($, on) => {
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  on('classic.PreToolUse', (_$, e: any) => (e.tool === 'Read' ? { additionalContext: [`tip for ${e.file_path}`] } : {}) as any)
  on('prompt.attachment', (_$, e: any) => ({ text: e.text }))
  session(on, 'P')
  await Promise.all([$.tool.call({ tool: 'Read', tool_use_id: 'ua', file_path: '/home/u/a.ts' } as any), $.tool.call({ tool: 'Bash', tool_use_id: 'uc', command: 'ls', description: 'List files' } as any)])
  await $.prompt.attachment({ type: 'hook_additional_context', text: 'PreToolUse:Read hook additional context: tip for a', origin: { kind: 'hook', event: 'PreToolUse' } } as any)
  await $.tool.call({ tool: 'Read', tool_use_id: 'ub', file_path: '/home/u/b.ts' } as any)
  await $.prompt.attachment({ type: 'hook_additional_context', text: 'PreToolUse:Read hook additional context: tip for b', origin: { kind: 'hook', event: 'PreToolUse' } } as any)
  const m = await pane($, 40, 100)
  expect(await m.find({ type: 'Button', text: /^▸$/ })).toBe(undefined) // nothing folds
  const labels = (await m.findAll({ type: 'Button' })).map(b => String(b.text))
  const at = (re: RegExp) => labels.findIndex(l => re.test(l))
  const tips = labels.flatMap((l, i) => / context$/.test(l) ? [i] : [])
  expect(tips.length).toBe(2)
  expect(tips[0]!).toBeLessThan(at(/^Read a\.ts$/))
  expect(at(/^Read a\.ts$/)).toBeLessThan(at(/^List files$/))
  expect(at(/^List files$/)).toBeLessThan(tips[1]!)
  expect(tips[1]!).toBeLessThan(at(/^Read b\.ts$/))
  expect((await m.findAll({ type: 'Text', text: '╭' })).length).toBe(2) // each on a bracket with the call below it
  expect((await m.findAll({ type: 'Text', text: '╰' })).length).toBe(2)
  expect(at(/tip for|PreToolUse:Read hook/)).toBe(-1) // what it said stays in the inspector
})

test('a call\'s hook rows sit around it, linked: PreToolUse above, the rest below', async ($, on) => {
  const pre = (name: string, extra: object = {}) => hookRow({ name, use: 'ue', ...extra })
  const m = await mountWith($, on, 'EV', [
    { t: T0, turn: 1, kind: 'tool', name: 'Edit', detail: 'x.ts', outcome: '', use: 'ue', ms: 10 },
    pre('guard'), pre('test-gate'), pre('contract-guard'),
    hookRow({ name: 'lint-feedback', origin: 'PostToolUse', use: 'ue', outcome: 'block', status: 'feedback' }),
  ])
  await toLevel($, m, 'debug') // a fast hook that changed nothing ranks debug
  const labels = (await m.findAll({ type: 'Button' })).map(b => String(b.text))
  const at = (re: RegExp) => labels.findIndex(l => re.test(l))
  for (const n of ['guard', 'test-gate', 'contract-guard']) { expect(at(new RegExp(`^${n}$`))).toBeGreaterThan(-1); expect(at(new RegExp(`^${n}$`))).toBeLessThan(at(/^Edit x\.ts$/)) } // by name alone: the side says the event, the call the tool
  expect(at(/^Edit x\.ts$/)).toBeLessThan(at(/^lint-feedback$/))
  // one bracket: opened by the first hook, the call marked between, closed by the last
  for (const [g, n] of [['╭', 1], ['│', 2], ['├', 1], ['╰', 1]] as const) expect((await m.findAll({ type: 'Text', text: g })).length).toBe(n)
  expect(await m.find({ type: 'Button', text: /^▸$/ })).toBe(undefined)
  await toLevel($, m, 'info')
})

test('a call\'s row keeps its own time; each of its hooks times its own row', async ($, on) => {
  const m = await mountWith($, on, 'SUM', [
    { t: T0, turn: 1, kind: 'tool', name: 'Edit', detail: 'x.ts', outcome: '', use: 'us', ms: 5500 }, // spans its PreToolUse hook
    hookRow({ name: 'guard', use: 'us', ms: 100 }),
    hookRow({ name: 'file-change-log', origin: 'PostToolUse', use: 'us', ms: 100 }),
  ])
  await toLevel($, m, 'debug')
  expect(await m.find({ text: /^5\.5s$/ })).toBeDefined()
  expect((await m.findAll({ type: 'Text', text: /^· 0\.1s$/ })).length).toBe(2)
  await toLevel($, m, 'info')
})

const wait = (ms: number) => new Promise(res => (globalThis as any).setTimeout(res, ms)) // no DOM or node lib in this tsconfig
test('a call\'s row goes where it began, not where it ended: a slow call reads before a parallel one that finished first', async ($, on) => {
  on('tool.call', async (_$, e: any) => { if (e.command === 'sleep') await wait(60); return { result: 'ok', text: 'ok' } })
  session(on, 'O')
  await $.tool.call({ tool: 'Bash', tool_use_id: 'uw', command: 'true', description: 'Warm up' } as any) // the first call on $ loads the plugins: the slow call must not pay that while the fast one waits
  const slow = $.tool.call({ tool: 'Bash', tool_use_id: 'us', command: 'sleep', description: 'Slow call' } as any)
  await wait(10)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'uf', command: 'ls', description: 'Fast call' } as any)
  await slow
  await $.tool.call({ tool: 'Bash', tool_use_id: 'ul', command: 'pwd', description: 'Later call' } as any)
  const m = await pane($, 40, 100)
  const labels = (await m.findAll({ type: 'Button' })).map(b => String(b.text))
  const at = (re: RegExp) => labels.findIndex(l => re.test(l))
  expect(at(/^Slow call$/)).toBeGreaterThan(-1)
  expect(at(/^Slow call$/)).toBeLessThan(at(/^Fast call$/))
  expect(at(/^Fast call$/)).toBeLessThan(at(/^Later call$/))
})

// rows as the store holds them, for the tests below
const T0 = Date.now() - 60000
const hookRow = (extra: object) => ({ t: T0, turn: 1, kind: 'hook', name: 'h', origin: 'PreToolUse', detail: 'Bash', outcome: '', src: 'hook', ms: 50, ...extra })
const call = (extra: object) => ({ t: T0, turn: 1, kind: 'tool', name: 'Bash', detail: 'x', outcome: 'ok', status: 'ok', ms: 10, ...extra })
const mountWith = ($: Engine, on: any, id: string, entries: object[], turn = 1, bodyRows = 60) => (session(on, id, entries, { turn }), pane($, bodyRows))
const GUARD = 'PreToolUse:Bash hook error: [$HOME/.claude/hooks/security/guard.sh]: guard.sh blocked this command: rm -rf'

test('a hook\'s block marks the call it refused with one ⊘; the hook\'s own row above it, linked, names it', async ($, on) => {
  const m = await mountWith($, on, 'B1', [
    hookRow({ name: 'guard', outcome: 'block', peek: GUARD, use: 'u1' }),
    call({ detail: 'Clean up', cmd: 'rm -rf x', outcome: 'error', status: 'denied', peek: GUARD, use: 'u1' }),
  ])
  expect((await m.findAll({ type: 'Text', text: /^⊘/ })).length).toBe(2) // the call's and its hook's: refused, not broke: ⊘, not ✗
  expect((await m.find({ type: 'Text', text: '⊘ <0.1s' }))?.props).toMatchObject({ color: 'cyan' }) // the hook's: the glyph says it refused, not the colour alone
  expect(await m.find({ type: 'Text', text: /^✗/ })).toBe(undefined)
  expect(await m.find({ type: 'Button', text: /^Clean up$/ })).toBeDefined() // the hook on its bracket names the refuser
  expect((await m.find({ type: 'Button', text: /^guard$/ }))?.props.dimColor).toBeFalsy() // by name, bright; its reason in the inspector
  expect((await m.findAll({ type: 'Text', text: '╭' })).length).toBe(1)
})

test('a PreToolUse block marks its call denied', async ($, on) => {
  on('classic.PreToolUse', () => ({ deny: 'guard.sh blocked this command' }) as any)
  on('tool.call', () => ({ isError: true, text: GUARD }) as any)
  session(on, 'B2')
  await $.tool.call({ tool: 'Bash', tool_use_id: 'u9', command: 'rm -rf x', description: 'Clean up' } as any)
  const m = await pane($)
  expect(await m.find({ type: 'Button', text: /^rm$/ })).toBe(undefined) // a refused call never ran: no output to boil down
  await m.press({ key: (await m.find({ type: 'Button', text: /^Clean up$/ }))!.key! })
  expect(await m.find({ text: /refused before it ran/ })).toBeDefined()
  await m.press({ key: 'back' })
})

test('a block after the fact is feedback: ↩, not ✗', async ($, on) => {
  const m = await mountWith($, on, 'E1', [hookRow({ name: 'lint-feedback', origin: 'PostToolUse', detail: 'Edit', outcome: 'block', ms: 300, peek: 'x.py:3:1: F821 undefined name' })])
  expect(await m.find({ type: 'Text', text: '↩ 0.3s' })).toBeDefined() // ranked notice: shown at info
  expect(await m.find({ type: 'Text', text: /^✗/ })).toBe(undefined)
})

test('a slow SessionStart hook is not flagged; a slow ConfigChange hook is', async ($, on) => {
  const m = await mountWith($, on, 'G1', [
    hookRow({ name: 'context-mode', origin: 'SessionStart', detail: 'clear', ms: 2000 }),
    call({ detail: 'between' }),
    hookRow({ name: 'config-change-guard', origin: 'ConfigChange', detail: 'user_settings', ms: 2100 }),
  ])
  await toLevel($, m, 'debug')
  expect(await m.find({ type: 'Text', text: '· 2.0s' })).toBeDefined() // changed nothing: dim ·, no ◷
  expect(await m.find({ type: 'Text', text: '◷ 2.0s' })).toBe(undefined)
  expect(await m.find({ type: 'Text', text: '◷ 2.1s' })).toBeDefined() // slow: ◷, apart from an interrupt's ⚠
  await toLevel($, m, 'info')
})

test('hook text draws a row each time; text the session already logged ranks info', async ($, on) => {
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  on('prompt.attachment', (_$, e: any) => ({ text: e.text }))
  session(on, 'D1')
  const tip = { type: 'hook_additional_context', text: 'UserPromptSubmit hook additional context: <rules>\nRule for this message', origin: { kind: 'hook', event: 'UserPromptSubmit' } } as any
  await $.prompt.attachment(tip)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'd1', command: 'ls', description: 'List' } as any)
  await $.prompt.attachment(tip)
  await $.prompt.attachment(tip)
  const m = await pane($)
  expect((await m.findAll({ type: 'Button', text: /^UserPromptSubmit hook context$/ })).length).toBe(3)
  await toLevel($, m, 'notice') // only the first
  expect((await m.findAll({ type: 'Button', text: /^UserPromptSubmit hook context/ })).length).toBe(1)
  await toLevel($, m, 'info')
})

test('a cwd change back to where the session began ranks info', async ($, on) => {
  const env = (d: string) => `# Environment update\n - Primary working directory: /home/u/${d} (was /x)`
  on('prompt.attachment', (_$, e: any) => ({ text: e.text }))
  const m = await mountWith($, on, 'D2', [{ t: T0, turn: 0, kind: 'session', name: 'start', detail: '/home/u/repo', outcome: '' }])
  for (const d of ['sub', 'repo']) await $.prompt.attachment({ type: 'environment', text: env(d), origin: { kind: 'engine' } } as any)
  await toLevel($, m, 'notice')
  expect(await m.find({ text: /^CWD → sub$/ })).toBeDefined()
  expect(await m.find({ text: /^CWD → repo$/ })).toBe(undefined)
  await toLevel($, m, 'info')
})

test('the first session.start of a process is the session beginning; a later one, a reload, ranks debug and is not home', async ($, on) => {
  session(on, 'RL')
  on('session.start', (_$, e: any) => ({ cwd: e.cwd }))
  on('prompt.attachment', (_$, e: any) => ({ text: e.text }))
  await $.session.start({ cwd: '/home/u/repo', surface: null, isInteractive: false } as any)
  await $.session.start({ cwd: '/home/u/repo/sub', surface: null, isInteractive: false } as any)
  await $.prompt.attachment({ type: 'environment', text: '# Environment update\n - Primary working directory: /home/u/sub (was /x)', origin: { kind: 'engine' } } as any)
  const m = await pane($, 40, 100)
  expect(await m.find({ type: 'Button', text: /^Session init in repo$/ })).toBeDefined()
  expect(await m.find({ type: 'Button', text: /^Plugin reloaded$/ })).toBe(undefined) // debug
  await toLevel($, m, 'notice')
  expect(await m.find({ text: /^CWD → sub$/ })).toBeDefined() // home stays repo, not the reload's cwd
  await toLevel($, m, 'debug')
  expect(await m.find({ type: 'Button', text: /^Plugin reloaded$/ })).toBeDefined()
  await toLevel($, m, 'info')
})

test('turns count from your first prompt; rows before it head `start`', async ($, on) => {
  const m = await mountWith($, on, 'C1', [call({ turn: 0, detail: 'before' }), call({ detail: 'after' })])
  expect(await m.find({ text: /^start$/ })).toBeDefined()
  expect(await m.find({ text: /^#1$/ })).toBeDefined()
})

test('a turn header shows its prompt\'s first words, a slash command its name; never stored', async ($, on) => {
  const db = capture(on, 'TW')
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  await $.prompt.submit({ text: 'Implement the following plan:\nmore', origin: { kind: 'composer' }, wait: false } as any)
  await $.tool.call(ls('tw1'))
  await $.prompt.submit({ text: '/review the diff', command: { name: 'review', args: 'the diff' }, origin: { kind: 'composer' }, wait: false } as any)
  await $.tool.call(ls('tw2'))
  const m = await pane($, 40, 100)
  expect(await m.find({ text: /^ Implement the following…/ })).toBeDefined() // four words within 24 characters
  expect(await m.find({ text: /^ \/review/ })).toBeDefined()
  expect(await m.find({ text: /the diff/ })).toBe(undefined) // a command's arguments are your own typing
  expect(JSON.stringify(await flushed($, 'TW', db))).not.toContain('Implement')
})

test('/agentlog stays out of the conversation: its line is dropped, its reply a toast', async ($, on) => {
  const toasts: string[] = []
  on('ui.toast', (_$: any, e: any) => { toasts.push(e.text); return { value: undefined } as any })
  on('ui.panes', () => ({ value: [] }) as any)
  on('ui.open', () => ({ value: { isPlaced: true } }) as any)
  const r: any = await ($ as any).command.run({ command: 'agentlog', args: 'nope', origin: { kind: 'composer' }, presentation: 'text' })
  expect(r?.text).toBeUndefined()
  expect(toasts.join()).toMatch(/^usage: \/agentlog/)
  const sent: any = await $.prompt.submit({ text: '/agentlog nope', command: { name: 'agentlog', args: 'nope' }, origin: { kind: 'composer' }, wait: false } as any)
  expect(sent?.drop).toBeTruthy()
})

test('a command with no description keeps its case; a description is capitalised', async ($, on) => {
  const m = await mountWith($, on, 'I1', [call({ detail: 'wc -l x.ts', cmd: 'cd /a && wc -l x.ts' }), call({ detail: 'count lines', cmd: 'wc -l y.ts' })])
  expect(await m.find({ type: 'Button', text: /^wc -l x\.ts$/ })).toBeDefined()
  expect(await m.find({ type: 'Button', text: /^Count lines$/ })).toBeDefined()
})

test('a call\'s hook text is linked to it while the call is drawn, unlinked when the level hides the call', async ($, on) => {
  const m = await mountWith($, on, 'A2', [
    call({ name: 'Read', detail: '/home/u/a.ts', use: 'r1' }),
    { t: T0, turn: 1, kind: 'prompt', name: 'context-mode', type: 'hook_additional_context', origin: 'PreToolUse', detail: '', outcome: '', src: 'hook', bytes: 60, peek: 'PreToolUse:Read hook additional context: tip for reads', use: 'r1' },
  ])
  expect(await m.find({ type: 'Button', text: /^context-mode context$/ })).toBeDefined()
  expect((await m.findAll({ type: 'Text', text: '╭' })).length).toBe(1)
  await toLevel($, m, 'notice') // the Read is hidden, its hook text is not
  expect(await m.find({ type: 'Button', text: /^Read a\.ts$/ })).toBe(undefined)
  expect(await m.find({ type: 'Button', text: /^context-mode context on PreToolUse$/ })).toBeDefined() // unlinked, it names its event again
  expect((await m.findAll({ type: 'Text', text: '╭' })).length).toBe(0)
  await toLevel($, m, 'info')
})

test('a hook\'s row reads by its name and event, never by what it said', async ($, on) => {
  const m = await mountWith($, on, 'H2', [
    hookRow({ name: 'question-mode', origin: 'UserPromptSubmit', detail: '', outcome: 'context x1 ~10 tok', ms: 2000, peek: 'UserPromptSubmit hook success: question-mode: Rule for THIS message' }),
    hookRow({ name: 'context-mode', origin: 'ConfigChange', detail: '', outcome: 'context x1 ~10 tok', ms: 2000, peek: 'SessionStart hook additional context: \n<context_window_protection>\n  <priority_instructions>\n    Every byte a tool returns' }),
  ])
  await toLevel($, m, 'debug')
  expect(await m.find({ type: 'Button', text: /^question-mode on UserPromptSubmit$/ })).toBeDefined()
  expect(await m.find({ type: 'Button', text: /^context-mode on ConfigChange$/ })).toBeDefined()
  expect(await m.find({ text: /Rule for THIS|Every byte/ })).toBe(undefined) // their text stays in the inspector
  await toLevel($, m, 'info')
})

test('PostToolUse context goes with the call whose hook added it, not the newest of that tool', async ($, on) => {
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  on('classic.PostToolUse', (_$, e: any) => (e.tool_use_id === 'qa' ? { additionalContext: ['tip for a'] } : {}) as any)
  on('prompt.attachment', (_$, e: any) => ({ text: e.text }))
  session(on, 'Q1')
  await Promise.all(['a', 'b'].map(f => $.tool.call({ tool: 'Read', tool_use_id: `q${f}`, file_path: `/home/u/${f}.ts` } as any)))
  for (const f of ['a', 'b']) await ($ as any).classic.PostToolUse({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: `q${f}`, tool_input: {}, tool_response: 'ok' }) // a tool.call in a test raises no PostToolUse
  await $.tool.call({ tool: 'Bash', tool_use_id: 'qc', command: 'ls', description: 'List' } as any)
  await $.prompt.attachment({ type: 'hook_additional_context', text: 'PostToolUse:Read hook additional context: tip for a', origin: { kind: 'hook', event: 'PostToolUse' } } as any)
  const m = await pane($)
  // each call's inspector lists its call's hooks
  await m.press({ key: (await m.find({ type: 'Button', text: /^Read a\.ts$/ }))!.key! })
  expect(await m.find({ text: /PostToolUse hook/ })).toBeDefined()
  await m.press({ key: 'back' })
  await m.press({ key: (await m.find({ type: 'Button', text: /^Read b\.ts$/ }))!.key! })
  expect(await m.find({ text: /PostToolUse hook/ })).toBe(undefined)
  await m.press({ key: 'back' })
})

test('the first copy of a hook text in the log\'s order is the one that is not `again`', () => {
  const tip = (t: number): any => ({ t, turn: 1, kind: 'prompt' as const, name: 'context-mode', detail: '', outcome: '', src: 'hook' as const, bytes: 3, peek: 'tip' })
  const later = tip(2), x = tip(1)
  const xs = [later]
  markAgain(xs, later)
  expect(later.again).toBe(undefined)
  xs.unshift(x) // x went in above the copy logged before it
  markAgain(xs, x)
  expect(x.again).toBe(undefined)
  expect(later.again).toBe(true)
  xs.shift() // x evicted: the copy after it is the first now, as push re-marks on eviction
  markAgain(xs, x)
  expect(later.again).toBe(undefined)
})

test('a hook row steps with its call in the inspector, and back lands on it', async ($, on) => {
  const read = (f: string, use: string) => call({ name: 'Read', detail: `/home/u/${f}.ts`, use })
  const tipOf = (use: string) => hookRow({ name: 'context-mode', detail: 'Read', outcome: 'context x1 ~10 tok', peek: `tip ${use}`, use })
  const m = await mountWith($, on, 'K1', [read('a', 'k1'), tipOf('k1'), read('b', 'k2'), tipOf('k2'), ...steps()], 1, 14)
  await toLevel($, m, 'debug') // the hook rows are in the log, above their calls
  await m.press({ key: 'tprev' }) // the turn's header on top: the reads are in view, the newest rows are not
  await m.press({ key: (await m.find({ type: 'Button', text: /^Read a\.ts$/ }))!.key! })
  await m.press({ key: 'prev' }) // its PreToolUse hook, drawn above it
  expect(await m.find({ text: /tip k1/ })).toBeDefined()
  await m.press({ key: 'back' })
  expect(await m.find({ type: 'Button', text: /^context-mode$/ })).toBeDefined()
  expect(await m.find({ text: /^Step 30$/ })).toBe(undefined)
  await toLevel($, m, 'info')
})

test('feedback reads as feedback in the inspector', async ($, on) => {
  const m = await mountWith($, on, 'E2', [hookRow({ name: 'lint-feedback', origin: 'PostToolUse', detail: 'Edit', outcome: 'block', ms: 300, peek: 'F821 undefined name' })])
  await m.press({ key: (await m.find({ type: 'Button', text: /^lint-feedback/ }))!.key! })
  expect(await m.find({ text: /sent feedback to the model/ })).toBeDefined()
  expect(await m.find({ text: /^feedback$/ })).toBeDefined()
  await m.press({ key: 'back' })
})

test('a PostToolUse attachment left out of the request still spends its call\'s place in the queue', async ($, on) => {
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  on('classic.PostToolUse', () => ({ additionalContext: ['tip'] }) as any)
  on('prompt.attachment', (_$, e: any) => ({ text: /dropped/.test(e.text) ? null : e.text }))
  session(on, 'Q2')
  await Promise.all(['a', 'b'].map(f => $.tool.call({ tool: 'Read', tool_use_id: `p${f}`, file_path: `/home/u/${f}.ts` } as any)))
  for (const f of ['a', 'b']) await ($ as any).classic.PostToolUse({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: `p${f}`, tool_input: {}, tool_response: 'ok' })
  await $.prompt.attachment({ type: 'hook_additional_context', text: 'PostToolUse:Read hook additional context: dropped', origin: { kind: 'hook', event: 'PostToolUse' } } as any)
  await $.prompt.attachment({ type: 'hook_additional_context', text: 'PostToolUse:Read hook additional context: tip for b', origin: { kind: 'hook', event: 'PostToolUse' } } as any)
  const m = await pane($)
  await m.press({ key: (await m.find({ type: 'Button', text: /^Read a\.ts$/ }))!.key! })
  expect(await m.find({ text: /added text/ })).toBe(undefined) // a's tip was dropped: its hook ran, no text went to the model
  await m.press({ key: 'back' })
  await m.press({ key: (await m.find({ type: 'Button', text: /^Read b\.ts$/ }))!.key! })
  expect(await m.find({ text: /PostToolUse hook \(added text\)/ })).toBeDefined()
  await m.press({ key: 'back' })
})

test('a call\'s inspector says who decided it: a rule, you after an ask, or the mode, a hook or the tool', async ($, on) => {
  const verdict: Record<string, object> = { d0: { decision: 'allow' }, da: { decision: 'allow', rule: 'Bash(git push:*)' }, db: { decision: 'ask' }, dc: { decision: 'allow' } }
  on('tool.check', (_$, e: any) => ({ ...verdict[e.tool_use_id] }) as any)
  on('telemetry.log', () => ({ value: undefined }))
  on('tool.call', async (_$, e: any) => {
    await ($ as any).tool.check({ tool: e.tool, input: {}, tool_use_id: e.tool_use_id })
    if (e.tool_use_id === 'db') await ($ as any).telemetry.log({ to: 'collector', event: 'tool_decision', attributes: { tool_use_id: 'db', source: 'user_temporary' } })
    return { result: 'ok', text: 'ok' }
  })
  session(on, 'DC')
  await $.tool.call({ tool: 'Bash', tool_use_id: 'd0', command: 'true', description: 'Warm up' } as any) // the first call on $ loads the plugins
  await $.tool.call({ tool: 'Bash', tool_use_id: 'da', command: 'git push', description: 'Push' } as any)
  await $.tool.call({ tool: 'Edit', tool_use_id: 'db', file_path: '/home/u/a.ts' } as any)
  await $.tool.call({ tool: 'Read', tool_use_id: 'dc', file_path: '/home/u/a.ts' } as any)
  const m = await pane($)
  for (const [row, said] of [[/^Push$/, 'allowed by rule Bash(git push:*)'], [/^Edit a\.ts$/, 'asked you; you allowed it once'], [/^Read a\.ts$/, 'allowed by the mode, a hook or the tool itself']] as const) {
    await m.press({ key: (await m.find({ type: 'Button', text: row }))!.key! })
    expect(await m.find({ text: said })).toBeDefined()
    await m.press({ key: 'back' })
  }
})

test('the gap between a call\'s check and its decision is the call\'s inspector\'s, not its time; a wait on the model\'s message draws no line', async ($, on) => {
  on('tool.check', () => ({ decision: 'ask' }))
  on('telemetry.log', () => ({ value: undefined }))
  on('tool.call', async (_$, e: any) => {
    await ($ as any).tool.check({ tool: e.tool, input: {}, tool_use_id: e.tool_use_id }) // a test's tool.call raises no tool.check
    if (e.tool_use_id === 'wa') { // the model still streams: the call is decided as main's request closes
      await wait(150)
      await ($ as any).telemetry.log({ to: 'collector', event: 'tool_decision', attributes: { tool_use_id: 'wa', source: 'config' } })
      await wait(5) // as probed: the engine records main's request just after the decision
      await ($ as any).telemetry.log({ to: 'collector', event: 'api_request', attributes: { query_source: 'repl_main_thread' } })
    } else await ($ as any).telemetry.log({ to: 'collector', event: 'tool_decision', attributes: { tool_use_id: e.tool_use_id, source: 'config' } })
    return { result: 'ok', text: 'ok' }
  })
  session(on, 'W')
  await $.tool.call({ tool: 'Bash', tool_use_id: 'ww', command: 'true', description: 'Warm up' } as any) // the first call on $ loads the plugins
  await $.tool.call({ tool: 'Edit', tool_use_id: 'wa', file_path: '/home/u/a.ts' } as any)
  await $.tool.call({ tool: 'Edit', tool_use_id: 'wb', file_path: '/home/u/a.ts' } as any)
  const m = await pane($)
  const edits = await m.findAll({ type: 'Button', text: /^Edit a\.ts$/ })
  expect(edits.length).toBe(2) // a row each: nothing folds
  await m.press({ key: edits[0]!.key! })
  expect(await m.find({ text: /, before it ran$/ })).toBeDefined()
  expect(await m.find({ text: 'asked; your settings decided' })).toBeDefined() // the collector's decision source: not you
  await m.press({ key: 'back' })
  const rows = (await m.findAll({ type: 'Button' })).map(b => String(b.text))
  expect(rows.filter(l => /^Waiting for/.test(l))).toEqual([]) // the first waited on the model's message: the model's time, no line
  await m.press({ key: (await m.find({ type: 'Button', text: /^Edit a\.ts$/ }))!.key! })
  expect(await m.find({ text: /, before it ran$/ })).toBeDefined()
  await m.press({ key: 'back' })
})

test('auto mode\'s classifier refusing a call is a denial that names it, not a failure', async ($, on) => {
  const db = capture(on, 'AC')
  on('tool.check', () => ({ decision: 'ask' }))
  on('telemetry.log', () => ({ value: undefined }))
  on('tool.call', async (_$, e: any) => {
    if (e.tool_use_id !== 'ac1') return { result: 'ok', text: 'ok' }
    await ($ as any).tool.check({ tool: e.tool, input: {}, tool_use_id: e.tool_use_id })
    await wait(120) // the classifier's model request
    await ($ as any).telemetry.log({ to: 'collector', event: 'tool_decision', attributes: { tool_use_id: 'ac1', decision: 'reject', source: 'config' } }) // as a rule's
    return { result: '', isError: true, text: 'Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Auto-Mode Bypass]. If you have other tasks that don\'t depend on this action, continue working on those.' }
  })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'acw', command: 'true', description: 'Warm up' } as any) // the first call on $ loads the plugins
  await $.tool.call({ tool: 'Agent', tool_use_id: 'ac1', subagent_type: 'general-purpose', description: 'Count entries', prompt: 'ls' } as any)
  const row = (await flushed($, 'AC', db)).find(x => x.use === 'ac1')
  expect(row).toMatchObject({ status: 'denied', outcome: 'deny', via: 'classifier', waitFor: 'the auto-mode classifier', peek: 'the auto-mode classifier refused it: Auto-Mode Bypass' })
  expect(row.insight).toBe(undefined)
})

test('a model id reads as its family and version', () => {
  expect(modelName('claude-opus-5-5')).toBe('Opus 5.5')
  expect(modelName('claude-sonnet-5-5-20261001')).toBe('Sonnet 5.5')
  expect(modelName('claude-opus-4-20250514')).toBe('Opus 4') // a date is no minor version
  expect(modelName('claude-3-5-sonnet-20241022')).toBe('Sonnet 3.5')
  expect(modelName('claude-haiku-4-5[1m]')).toBe('Haiku 4.5')
  expect(modelName('us.anthropic.claude-fable-5-1-v1:0')).toBe('Fable 5.1')
  expect(modelName('my-gateway-model')).toBe('my-gateway-model')
})

test('a turn\'s time splits by what held it, each instant once', () => {
  const x = (t: number, kind: string, ms: number, extra: object = {}) => ({ t, kind, name: 'Read', detail: '', outcome: '', ms, ...extra })
  const xs = [
    x(0, 'step', 4000), // 0-3000 model: from 3000 the Read holds it
    x(3000, 'tool', 2000), // 3000-5000 tools
    x(5000, 'tool', 1000, { name: 'Bash', wait: 1000, waitFor: ASKED }), // 5000-6000 you, then its run 6000-7000
    x(6800, 'hook', 300), // 6500-6800, inside the Bash run: hooks
    x(7000, 'tool', 2000, { name: 'Agent', wait: 500, waitFor: 'the permission decision (config)' }), // 7000-7500 permission, then 7500-9500 agents
    x(8000, 'step', 1000, { agent: 'A' }), // a subagent's request sits inside its Agent call: not counted again
    x(9500, 'event', 300, { name: 'compacted' }), // 9500-9800 compact
    x(12000, 'step', 1000), // after the turn
  ]
  expect(splitOf(xs as any, 0, 10000)).toEqual([1000, 500, 300, 300, 2000, 2700, 3000]) // you, permission, hooks, compact, agents, tools, model; 200 other
})

test('a turn notes as unusual when it ran over twice the usual, or hooks or a permission decision held it longest', () => {
  const split = (o: Partial<Record<'you' | 'permission' | 'hooks' | 'tools' | 'model', number>>) => [o.you ?? 0, o.permission ?? 0, o.hooks ?? 0, 0, 0, o.tools ?? 0, o.model ?? 0]
  expect(unusualOf(4, split({ model: 40_000 }), 41_200, [10_000, 12_000, 14_000])).toBe('#4 took 41.2s, 3× the usual')
  expect(unusualOf(4, split({ model: 40_000 }), 41_200, [10_000, 12_000])).toBe(undefined) // two earlier turns: no usual yet
  expect(unusualOf(2, split({ hooks: 12_000, model: 6_000 }), 20_000, [])).toBe('#2: hooks 12.0s of 20.0s')
  expect(unusualOf(2, split({ permission: 9_000, tools: 4_000 }), 15_000, [])).toBe('#2: permission 9.0s of 15.0s')
  expect(unusualOf(2, split({ you: 30_000, model: 5_000 }), 36_000, [])).toBe(undefined) // your time is not a fault
  expect(unusualOf(2, split({ hooks: 6_000 }), 8_000, [])).toBe(undefined) // under 10 s: never noted
})

test('the pane never opens by itself; a turn that ended unusually says so in the band above the prompt until the pane opens', async ($, on) => {
  const turns = [1, 2, 3].map(n => ({ t: Date.now() - (5 - n) * 60_000, turn: n, kind: 'turn', name: 'turn', detail: '', outcome: '', status: 'ok', ms: 10_000 }))
  // session() minus its open pane: this one starts closed
  on('session.id', () => ({ value: 'BN' }))
  on('agent.list', () => ({ value: [] }))
  on('config.list', () => ({ value: [] }))
  mock.store(on, { 'r:BN': { entries: turns, seen: {}, turn: 4, names: {} } })
  let up = false
  on('ui.panes', () => ({ value: up ? [{ id: 'agent-log' }] : [] }) as any)
  on('ui.open', () => { up = true; return { value: { isPlaced: true } } as any })
  on('ui.render', ($, e: any) => { const { Text } = $.ui.resolve(e) as any; return Text({ key: 'theirs', children: ['other mod'] }) }) // another mod's band line, beneath
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.complete', () => ({ text: '' }))
  await ($ as any).session.start({ cwd: '/w', surface: 'terminal', isInteractive: true, source: 'startup' })
  expect(up).toBe(false)
  await ($ as any).turn.complete({ reason: 'answer', answer: '', durationMs: 40_000, usage: undefined })
  const BAND = { isWorking: false, hasSurvey: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 } } as any
  const band = await $.ui.mount({ plugin: 'agent-log', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ text: /^#\d+ took 40\.0s, 4× the usual$/ })).toBeDefined()
  expect(await band.find({ text: 'other mod' })).toBeDefined() // theirs stays, below ours
  expect(await (await $.ui.mount({ plugin: 'agent-log', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND, isWorking: true } })).find({ text: /the usual/ })).toBe(undefined) // mid-turn: hidden
  await ($ as any).command.run({ command: 'agentlog', args: '', origin: { kind: 'composer' }, presentation: 'text' })
  expect(up).toBe(true)
  expect(await (await $.ui.mount({ plugin: 'agent-log', surface: 'terminal', component: 'AbovePrompt', props: BAND })).find({ text: /the usual/ })).toBe(undefined) // read: gone
})

// a model request as the engine streams it, the test's hook standing in for the API: thinking, text, then a call
const STEP = { turnId: 'e7d91f2f-e937', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 3 }
const BILL = { to: 'collector', event: 'api_request', attributes: { input_tokens: 2, cache_read_tokens: 9000, cache_creation_tokens: 100, output_tokens: 50, cost_usd: 0.0123, request_id: 'req_1', query_source: 'repl_main_thread' } }
const stepper = (on: any, bill?: () => Promise<unknown>) => on('turn.step', async function* (_$: any, e: any) {
  await wait(30) // no engine chunk: the kit has no engine stream to resolve its ref in
  yield { kind: 'thinking', index: 0, text: '**Checking the store**\nThe store holds' }
  await wait(40)
  yield { kind: 'text', index: 1, text: 'Let me look at the store.\nIt is JSON.' }
  yield { kind: 'tool', index: 2, id: 'tu1', name: 'Read' }
  if (bill) await bill() // the collector's record before the stream ends
  return { turnId: e.turnId, index: e.index, answer: 'Let me look at the store.\nIt is JSON.', toolUses: [{ name: 'Read', input: {} }], serverToolUses: [{ id: 's1', name: 'advisor', input: {}, startedAt: 1000, endedAt: 3500 }],
    stopReason: 'tool_use', usage: { input_tokens: 2, output_tokens: 50, cache_read_input_tokens: 9000, cache_creation_input_tokens: 100, model: 'claude-opus-5-5' } }
})
const drain = async (s: any) => { let n: any; while (!(n = await s.next()).done) {} return n.value } // the stream's return value: a test's `$.turn.step` stream has no `result`

test('a model request logs one step row: first token, thinking, reply, calls, and the price its collector record gives', async ($, on) => {
  const db = capture(on, 'ST')
  stepper(on)
  on('telemetry.log', () => ({ value: undefined }))
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  expect((await drain(($ as any).turn.step(STEP))).stopReason).toBe('tool_use') // passed on untouched
  await $.tool.call({ tool: 'Read', tool_use_id: 'tu1', file_path: '/x/a.ts' } as any)
  await ($ as any).telemetry.log(BILL) // after the step: priced late
  const rows = await flushed($, 'ST', db)
  const s = rows.find(x => x.kind === 'step')
  expect(s).toMatchObject({ name: 'claude-opus-5-5', effort: 'high', status: 'ok', stop: 'tool_use', step: 'e7d91f2f:0', tok: [2, 9000, 100, 50], asked: ['Read'], server: [['advisor', 2500]],
    thought: 'Checking the store', peek: 'Let me look at the store.\nIt is JSON.', cost: 0.0123, req: 'req_1' })
  expect(s.ttft).toBeGreaterThanOrEqual(25)
  expect(s.think).toBeGreaterThanOrEqual(35)
  expect(rows.find(x => x.kind === 'tool')?.step).toBe('e7d91f2f:0') // the call knows the request that asked for it
})

test('a collector record that lands before its step ends prices it too', async ($, on) => {
  const db = capture(on, 'SB')
  stepper(on, () => ($ as any).telemetry.log(BILL))
  on('telemetry.log', () => ({ value: undefined }))
  await drain(($ as any).turn.step(STEP))
  expect((await flushed($, 'SB', db)).find(x => x.kind === 'step')).toMatchObject({ cost: 0.0123, req: 'req_1' })
})

test('a stream its reader closes early is an interrupted step', async ($, on) => {
  const db = capture(on, 'SC')
  stepper(on)
  for await (const c of ($ as any).turn.step({ ...STEP, index: 1 })) if (c.kind === 'thinking') break
  const s = (await flushed($, 'SC', db)).find(x => x.kind === 'step')
  expect(s).toMatchObject({ status: 'aborted', step: 'e7d91f2f:1', thought: 'Checking the store' })
  expect(s.tok).toBe(undefined)
})

test('a request that wrote text is a row; one that only called tools hides at info', async ($, on) => {
  const T = Date.now() - 60000
  const step = (t: number, ms: number, step: string, extra: object = {}) => ({ t: T + t, turn: 1, kind: 'step', name: 'claude-opus-5-5', detail: '', outcome: '', status: 'ok', ms, step, stop: 'tool_use', ...extra })
  const m = await mountWith($, on, 'SP', [
    step(0, 4200, 'k0', { thought: 'Checking the hooks', asked: ['Read', 'Read'], ttft: 900, think: 2000, tok: [2, 9000, 100, 50] }),
    ...reads(T + 5000, { step: 'k0' }, ['a', 'b']),
    step(6000, 2000, 'k1', { asked: ['Read'] }),
    ...reads(T + 9000, { step: 'k1' }, ['c']),
    step(10000, 4200, 'k2', { peek: 'The hooks read the store.\nMore', stop: 'end_turn', server: [['advisor', 2500]], cost: 0.0123, effort: 'high' }),
    { t: T + 15500, turn: 1, kind: 'turn', name: 'turn', detail: '', outcome: '', status: 'ok', ms: 15500 },
  ])
  for (const f of ['a', 'b', 'c']) expect(await m.find({ type: 'Button', text: `Read ${f}.ts` })).toBeDefined() // the silent requests between the reads hide
  expect(await m.find({ text: /Thought: Checking the hooks/ })).toBe(undefined)
  expect(await m.find({ text: /model 10\.4s · other 5\.1s/ })).toBeDefined() // the header's split: the reads take under 0.1s
  expect(await m.find({ type: 'Button', text: /^2 hidden ▸$/ })).toBeDefined()
  await m.press({ key: 'th1' }) // `#1` opens the turn: its whole split, which the header cuts to two parts
  expect(await m.find({ text: 'A turn of the main loop ended' })).toBeDefined()
  expect(await m.find({ text: /^model 10\.4s · other 5\.1s/ })).toBeDefined()
  await m.press({ key: 'back' })
  expect(await m.find({ type: 'Button', text: /^Advisor$/ })).toBeDefined() // the advisor's call: a row of its own below the request
  expect(await m.find({ text: '2.5s' })).toBeDefined()
  await m.press({ key: (await m.find({ type: 'Button', text: /^Reply: The hooks read the store\.$/ }))!.key! }) // its reply's first line
  expect(await m.find({ text: /A request to Opus 5\.5 by the main loop, which ended the turn/ })).toBeDefined()
  expect(await m.find({ text: 'claude-opus-5-5 · effort high' })).toBeDefined()
  expect(await m.find({ text: '$0.0123' })).toBeDefined()
  expect(await m.find({ text: 'The hooks read the store.\nMore' })).toBeDefined()
  await m.press({ key: 'back' })
  await m.press({ key: (await m.find({ type: 'Button', text: /^Read a\.ts$/ }))!.key! }) // a call's inspector names the request before it
  expect(await m.find({ text: 'by Opus 5.5 in a 4.2s request: Checking the hooks' })).toBeDefined()
  await m.press({ key: 'back' })
  await toLevel($, m, 'debug') // every request a row: what it thought, else the calls it made
  expect(await m.find({ type: 'Button', text: /^Thought: Checking the hooks$/ })).toBeDefined()
  expect(await m.find({ type: 'Button', text: /^Called Read$/ })).toBeDefined()
  await toLevel($, m, 'info')
})

test('what streams or runs right now is a ● line below the rows, gone once it ends', async ($, on) => {
  session(on, 'LV')
  let thought!: () => void, wrote!: () => void, ran!: () => void
  const gate = new Promise<void>(res => { thought = res }), gate2 = new Promise<void>(res => { ran = res }), gate3 = new Promise<void>(res => { wrote = res })
  on('turn.step', async function* (_$: any, e: any) {
    yield { kind: 'thinking', index: 0, text: 'Weighing the options\nmore' }
    await gate
    yield { kind: 'text', index: 1, text: 'Running the tests' }
    await gate3
    return { turnId: e.turnId, index: e.index, answer: 'Running the tests', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('tool.call', async () => { await gate2; return { result: 'ok', text: 'ok' } })
  const it = ($ as any).turn.step(STEP)[Symbol.asyncIterator]()
  await it.next() // the thinking has streamed: the request is thinking
  const call = $.tool.call({ tool: 'Bash', tool_use_id: 'lv1', command: 'npm test', description: 'Run tests' } as any)
  await wait(20)
  const m = await pane($)
  // no text yet: the request may end as a debug row, hidden at info, so its line would flash and vanish
  expect(await m.find({ text: /^Thinking/ })).toBe(undefined)
  expect(await m.find({ text: /^Run tests$/ })).toBeDefined()
  expect((await m.findAll({ type: 'Text', text: /^● (<0\.1|\d+\.\d)s$/ })).length).toBe(1)
  thought()
  await it.next() // it writes: its row will show, so its line does
  await m.redraw()
  expect(await m.find({ text: /^Writing$/ })).toBeDefined() // generic: what it writes is the row's inspector, once it ends
  expect((await m.findAll({ type: 'Text', text: /^● (<0\.1|\d+\.\d)s$/ })).length).toBe(2)
  wrote(); ran()
  while (!(await it.next()).done) {}
  await call
  await m.redraw()
  expect(await m.find({ text: /^Thinking/ })).toBe(undefined)
  expect(await m.find({ type: 'Text', text: /^● / })).toBe(undefined)
})

test('what the engine reports is a row of its own, whether or not a hook is set on it', async ($, on) => {
  const db = capture(on, 'EV')
  on('env.get', () => ({ value: '/home/u' }))
  on('classic.*', () => ({}) as any)
  const c = ($ as any).classic
  await c.PostModelSwitch({ from_model: 'claude-opus-5-5', to_model: 'claude-sonnet-5-5', requested_model: null, source: 'command', context_tokens: 41000, prompt_cache_warm: false, cache_ttl: '5m', estimated_cache_write_usd: 0.31, pricing: 'catalog' })
  await c.PreCompact({ trigger: 'auto', custom_instructions: null })
  await wait(20)
  await c.PostCompact({ trigger: 'auto', compact_summary: 'We fixed the store.' })
  await c.StopFailure({ error: 'overloaded', error_details: '529 Overloaded' })
  await c.DirectoryAdded({ directory: '/home/u/other', source: 'slash_command' })
  await c.UserPromptExpansion({ expansion_type: 'slash_command', command_name: 'plan', command_args: 'my secret plan', prompt: '/plan my secret plan' })
  await c.CwdChanged({ old_cwd: '/home/u/a', new_cwd: '/home/u/b' }) // the environment update's row tells it
  const rows = (await flushed($, 'EV', db)).filter(x => x.kind === 'event')
  expect(rows.map(x => x.name)).toEqual(['model switch', 'compacted', 'turn failed', 'directory added', 'command'])
  expect(rows[0]).toMatchObject({ detail: 'claude-opus-5-5 → claude-sonnet-5-5', outcome: 'command', peek: '41.0k tokens of context; the prompt cache was cold, so the next request writes it again (~$0.31)' })
  expect(rows[1].ms).toBeGreaterThanOrEqual(15) // PreCompact to PostCompact
  expect(rows[2]).toMatchObject({ detail: 'overloaded', status: 'failed', peek: '529 Overloaded' })
  expect(rows[3].detail).toBe('~/other')
  expect(JSON.stringify(rows[4])).not.toContain('secret') // a command's args are your own typing
})

test('collector records no hook sees become rows; a main or subagent request is its step\'s', () => {
  expect(harnessOf('permission_mode_changed', { from_mode: 'plan', to_mode: 'auto', trigger: 'exit_plan_mode' })).toMatchObject({ kind: 'event', name: 'mode', detail: 'plan → auto', outcome: 'exit_plan_mode' })
  expect(harnessOf('mcp_server_connection', { status: 'connected', server_name: 'skins', transport_type: 'http', duration_ms: '997' })).toMatchObject({ name: 'MCP connected', detail: 'skins', ms: 997, status: 'ok' })
  expect(harnessOf('mcp_server_connection', { status: 'failed', server_name: 'x', error: 'ECONNREFUSED' })).toMatchObject({ name: 'MCP failed', status: 'failed', peek: 'ECONNREFUSED' })
  // a server closing, as every one does when a headless session ends: no failure, and its duration is its life, not a wait
  const closed = harnessOf('mcp_server_connection', { status: 'disconnected', server_name: 'roadmap', transport_type: 'http', duration_ms: '61045' })
  expect(closed).toMatchObject({ name: 'MCP disconnected', status: 'ok', peek: 'connected for 1m01s' })
  expect(closed!.ms).toBe(undefined)
  expect(harnessOf('api_error', { status_code: '529', error: 'Overloaded', attempt: 2, duration_ms: 1200 })).toMatchObject({ name: 'API error', detail: '529 Overloaded', outcome: 'attempt 2', status: 'failed', ms: 1200 })
  expect(harnessOf('api_request', { query_source: 'prompt_suggestion', model: 'claude-haiku-5-5', duration_ms: 900, input_tokens: 5, output_tokens: 3, cost_usd: 0.001 }))
    .toMatchObject({ kind: 'side', name: 'prompt_suggestion', src: 'engine', detail: 'claude-haiku-5-5', ms: 900, tok: [5, 0, 0, 3], cost: 0.001 })
  for (const q of ['repl_main_thread:outputStyle:Concise', 'agent:builtin:general-purpose', 'sdk']) expect(harnessOf('api_request', { query_source: q })).toBe(undefined)
})

test('a settings hook that failed or was cancelled is a red row, though the event changed nothing', async ($, on) => {
  const db = capture(on, 'HF')
  on('telemetry.log', () => ({ value: undefined }))
  on('classic.SessionStart', async () => { // the collector's record lands inside the event's run
    await ($ as any).telemetry.log({ to: 'collector', event: 'hook_execution_complete', attributes: { hook_event: 'SessionStart', hook_name: 'SessionStart:startup', num_hooks: '3', num_success: '2', num_non_blocking_error: '0', num_cancelled: '1' } })
    return {}
  })
  await ($ as any).classic.SessionStart({ source: 'startup' })
  expect((await flushed($, 'HF', db)).find(x => x.kind === 'hook')).toMatchObject({ origin: 'SessionStart', status: 'failed', peek: '1 cancelled' })
})

test('a plugin\'s own model call is a row named by the plugin, with the start of its reply', {
  plugins: [{ name: 'titler', register: on => { on('command.run', { command: 'title' } as any, async ($: any) => { await $.model.complete({ model: 'claude-haiku-5-5', prompt: 'Name this session' }); return { text: 'ok' } }) } }],
}, async ($, on) => {
  const db = capture(on, 'MC')
  on('model.complete', () => ({ value: { isAnswered: true, text: 'Fix the agent log\nmore', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }) as any)
  await ($ as any).command.run({ command: 'title', args: '', origin: { kind: 'composer' }, presentation: 'text' })
  expect((await flushed($, 'MC', db)).find(x => x.kind === 'side')).toMatchObject({ name: 'titler', src: 'plugin', detail: 'claude-haiku-5-5', status: 'ok', tok: [10, 0, 0, 5], peek: 'Fix the agent log\nmore' })
})

test('an event row reads what happened, a failure red; the engine\'s frequent requests hide; the harness view keeps them', async ($, on) => {
  const T = Date.now() - 60000
  const ev = (t: number, name: string, detail: string, extra: object = {}) => ({ t: T + t, turn: 1, kind: 'event', name, detail, outcome: '', ...extra })
  const side = (t: number, name: string, src: string, extra: object = {}) => ({ t: T + t, turn: 1, kind: 'side', name, src, detail: 'claude-haiku-5-5', outcome: '', status: 'ok', ms: 900, ...extra })
  const m = await mountWith($, on, 'EP', [
    ev(0, 'model switch', 'claude-opus-5-5 → claude-sonnet-5-5', { outcome: 'command' }),
    ev(10, 'turn failed', 'overloaded', { status: 'failed', peek: '529 Overloaded' }),
    ev(20, 'compacted', 'auto', { ms: 37600 }),
    ev(30, 'notification', 'idle_prompt'),
    side(40, 'prompt_suggestion', 'engine'),
    side(50, 'auto-title', 'plugin', { ms: 1200, peek: 'Fix the agent log', tok: [10, 0, 0, 5] }),
  ])
  expect(await m.find({ type: 'Button', text: /^Model: Opus 5\.5 → Sonnet 5\.5 \(command\)$/ })).toBeDefined()
  expect(await m.find({ type: 'Button', text: /^Turn failed: overloaded$/ })).toBeDefined()
  expect(await m.find({ type: 'Text', text: /^✗ failed$/ })).toBeDefined()
  expect(await m.find({ type: 'Button', text: /^Compacted: auto$/ })).toBeDefined()
  expect(await m.find({ type: 'Text', text: '37.6s' })).toBeDefined()
  expect(await m.find({ type: 'Button', text: /^Notification/ })).toBe(undefined) // debug
  expect(await m.find({ type: 'Button', text: /^Prompt suggestion$/ })).toBe(undefined) // debug: one after most turns
  await m.press({ key: (await m.find({ type: 'Button', text: /^auto-title$/ }))!.key! })
  expect(await m.find({ text: /A model call the auto-title plugin made/ })).toBeDefined()
  expect(await m.find({ text: '10 in (0 cached, 0 written) · 5 out' })).toBeDefined()
  await m.press({ key: 'back' })
  await m.press({ key: 'vmodel' }) // what the model did: none of these
  expect(await m.find({ type: 'Button', text: /^Turn failed/ })).toBe(undefined)
  await m.press({ key: 'vharness' })
  expect(await m.find({ type: 'Button', text: /^Turn failed/ })).toBeDefined()
  await m.press({ key: 'vharness' }) // back to all: views are module state
})

test('a call whose permission prompt is up says so on its ● line until the decision lands', async ($, on) => {
  session(on, 'PR')
  let decide!: () => void
  const gate = new Promise<void>(res => { decide = res })
  on('classic.*', () => ({}) as any)
  on('telemetry.log', () => ({ value: undefined }))
  on('tool.call', async (_$, e: any) => { if (e.tool_use_id === 'pr1') await gate; return { result: 'ok', text: 'ok' } })
  await $.tool.call({ tool: 'Read', tool_use_id: 'pr0', file_path: '/x/a.ts' } as any) // the first call loads the store: the call below is in flight before its prompt
  const call = $.tool.call({ tool: 'Bash', tool_use_id: 'pr1', command: 'npm test', description: 'Run tests' } as any)
  await wait(20)
  await ($ as any).classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'npm test' } })
  const m = await pane($)
  expect(await m.find({ text: /^Waiting for your permission: Run tests$/ })).toBeDefined()
  await ($ as any).telemetry.log({ to: 'collector', event: 'tool_decision', attributes: { tool_use_id: 'pr1', source: 'user_temporary' } })
  await m.redraw()
  expect(await m.find({ text: /^Run tests$/ })).toBeDefined()
  decide()
  await call
})

// a collector record, as a session exporting OTEL logs it
const collect = ($: any, event: string, attributes: object) => $.telemetry.log({ to: 'collector', event, attributes })

test('the setup button reads what the session runs on, and the controls what broke first, in red; s opens the setup page, a problem its inspector', async ($, on) => {
  session(on, 'SU')
  on('telemetry.log', () => ({ value: undefined }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  stepper(on)
  await collect($, 'plugin_loaded', { 'plugin.name': 'notepad', 'plugin.version': '0.2.0', 'plugin.scope': 'user', has_hooks: 'true', has_mcp: 'false' })
  await collect($, 'plugin_loaded', { 'plugin.name': 'skins', 'plugin.version': '1.0.0', 'plugin.scope': 'project', has_hooks: 'false', has_mcp: 'true' })
  await collect($, 'mcp_server_connection', { status: 'connected', server_name: 'skins', transport_type: 'http', duration_ms: '997' })
  await collect($, 'mcp_server_connection', { status: 'failed', server_name: 'docs', transport_type: 'stdio', error: 'ECONNREFUSED' })
  await collect($, 'hook_execution_complete', { hook_event: 'PostToolUse', hook_name: 'PostToolUse:Edit', num_hooks: '2', num_success: '1', num_non_blocking_error: '1', num_cancelled: '0', total_duration_ms: '420' })
  await collect($, 'api_error', { status_code: '529', error: 'Overloaded', attempt: 1, duration_ms: 1200 })
  await collect($, 'permission_mode_changed', { from_mode: 'default', to_mode: 'acceptEdits', trigger: 'shift_tab' })
  await drain(($ as any).turn.step(STEP)) // main's model and effort
  await ($ as any).session.measure({ context: { tokens: 41000, window: 200000, percent: 20.5 }, rateLimits: [{ kind: 'five_hour', percentUsed: 42 }], cost: { usd: 1.234 }, changed: ['context', 'rateLimits', 'cost'] })
  const m = await pane($, 60, 160)
  expect(await m.find({ type: 'Text', text: /^✗ 1 hook run failed \+2$/ })).toBeDefined() // the first problem, the rest counted: the page lists them
  expect(await m.find({ type: 'Button', text: /^setup Opus 5\.5 high$/ })).toBeDefined() // named for what it opens; the rest is on the page; a limit under 80% says nothing here
  await m.press({ key: 'fsetup' })
  expect(await m.find({ text: 'Opus 5.5 (claude-opus-5-5) · effort high' })).toBeDefined()
  // context, cost, rate limits and the MCP server list are /context, /cost, /status and /mcp's: the page leaves them out
  expect(await m.find({ text: /200\.0k tokens|five hour 42%|\$1\.23|connected over http/ })).toBe(undefined)
  expect(await m.find({ text: 'Problems: 1 hook run failed, 1 API error, 1 MCP server down' })).toBeDefined()
  expect(await m.find({ text: /1 run · 420ms · 1 failed$/ })).toBeDefined() // PostToolUse's, as the collector counted them
  expect(await m.find({ text: '0.2.0 · user · hooks' })).toBeDefined()
  expect(await m.find({ text: /^1 request · / })).toBeDefined() // main's
  await m.press({ key: (await m.find({ type: 'Button', text: /^✗ API error/ }))!.key! })
  expect(await m.find({ text: /A model request failed/ })).toBeDefined()
  await m.press({ key: 'back' }) // to the page it opened from
  expect(await m.find({ text: /^Problems: / })).toBeDefined()
  await m.press({ key: 'back' }) // and to the log
  expect(await m.find({ text: /^Problems: / })).toBe(undefined)
  expect(await m.find({ type: 'Button', text: /^API error: 529 Overloaded/ })).toBeDefined()
})

test('a call reaches outside the project root where its file, its search path, its cd or a home path its command names lies', () => {
  const R = '/home/u/repo', H = '/home/u'
  expect(outsideOf('Read', { path: '/home/u/repo/src/a.ts' }, R, R, H)).toBe(undefined)
  expect(outsideOf('Read', { path: '/home/u/dotagents/claude/RULES.md' }, R, R, H)).toBe('~/dotagents/claude')
  expect(outsideOf('Edit', { path: '../repo-old/a.ts' }, R, R, H)).toBe('~/repo-old') // relative, and a sibling named like the root
  expect(outsideOf('Read', { path: '/tmp/x.log' }, R, R, H)).toBe('/tmp') // a file tool's path counts wherever it lies
  expect(outsideOf('Grep', {}, R, '/home/u/other', H)).toBe('~/other') // no path: the loop's cwd
  expect(outsideOf('Glob', { path: 'src' }, R, R, H)).toBe(undefined)
  expect(outsideOf('Bash', { cmd: 'cd ~/dotagents && git status' }, R, R, H)).toBe('~/dotagents')
  expect(outsideOf('Bash', { cmd: 'cd "$HOME/my dir"; ls' }, R, R, H)).toBe('~/my dir')
  expect(outsideOf('Bash', { cmd: 'cd $PROJECT && make' }, R, R, H)).toBe(undefined) // a variable: not known
  expect(outsideOf('Bash', { cmd: 'npm test' }, R, '/home/u/other', H)).toBe('~/other') // the shell's cwd
  expect(outsideOf('Bash', { cmd: 'git -C /home/u/dotagents log' }, R, R, H)).toBe('~/dotagents')
  expect(outsideOf('Bash', { cmd: 'python3 /tmp/probe/x.py 2>/dev/null' }, R, R, H)).toBe(undefined) // scratch and system paths
  expect(outsideOf('Bash', { cmd: 'cat src/a.ts /home/u/repo/b.ts' }, R, R, H)).toBe(undefined)
  expect(outsideOf('Bash', { cmd: 'curl https://example.com/home/u/x' }, R, R, H)).toBe(undefined) // a URL's path is no file
  for (const p of ['~/.claude', '~/.claude/plans', '/tmp', '/tmp/x', '/var/tmp/x', '/private/tmp/x']) expect(routine(p)).toBe(true)
  for (const p of ['~/.claude-old', '~/dotagents', '/home/u/tmp', '/tmpfoo']) expect(routine(p)).toBe(false)
  expect(outsideOf('WebFetch', {}, R, '/home/u/other', H)).toBe(undefined) // no place
})

// the engine's answers for where the session is
const at = (on: any, root: string, cwd = root) => { on('session.root', () => ({ value: root })); on('session.cwd', () => ({ value: cwd })); on('env.get', () => ({ value: '/home/u' })) }

test('a call outside the project root stores where it reached; one inside stores nothing', async ($, on) => {
  const db = capture(on, 'OUT')
  at(on, '/home/u/repo')
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  await $.tool.call({ tool: 'Read', tool_use_id: 'o1', file_path: '/home/u/dotagents/RULES.md' } as any)
  await $.tool.call({ tool: 'Read', tool_use_id: 'o2', file_path: '/home/u/repo/a.ts' } as any)
  expect((await flushed($, 'OUT', db)).filter(x => x.kind === 'tool').map(x => x.out)).toEqual(['~/dotagents', undefined])
})

test('a row outside the root reads ↗ where; the outside view keeps it and the added directories; the setup page says where the session is', async ($, on) => {
  at(on, '/home/u/repo', '/home/u/repo/sub')
  const m = await mountWith($, on, 'OV', [
    call({ name: 'Read', detail: '/home/u/dotagents/RULES.md', out: '~/dotagents' }),
    call({ t: T0 + 1, detail: 'Run tests' }),
    { t: T0 + 2, turn: 1, kind: 'event', name: 'directory added', detail: '~/other', outcome: 'slash_command' },
    call({ t: T0 + 3, detail: 'Run the probe', out: '/tmp/probe' }),
    call({ t: T0 + 4, name: 'Read', detail: '/home/u/work/clients/acme/projects/dv/a.ts', out: '~/work/clients/acme/projects/dv' }),
    call({ t: T0 + 5, name: 'Read', detail: '/tmp/probe/x.log', out: '/tmp/probe' }),
  ])
  expect(await m.find({ type: 'Button', text: 'Read RULES.md' })).toBeDefined()
  // the place after the action, its ~ path: magenta for another project, dim for scratch; a long one cut from the left
  expect((await m.find({ type: 'Text', text: ' ↗ ~/dotagents' }))?.props).toMatchObject({ color: 'magenta' })
  expect((await m.find({ type: 'Text', text: ' /tmp/probe' }))?.props).toMatchObject({ dimColor: true }) // routine: dim, no ↗
  expect((await m.find({ type: 'Text', text: ' ↗ …/acme/projects/dv' }))?.props).toMatchObject({ color: 'magenta' })
  expect(await m.find({ type: 'Text', text: '↗ 2 other project' })).toBeDefined() // the controls count the two calls into other projects, not /tmp
  await m.press({ key: 'voutside' })
  expect(await m.find({ type: 'Button', text: /^Run tests/ })).toBe(undefined)
  expect(await m.find({ type: 'Button', text: /^Directory added: ~\/other/ })).toBeDefined()
  await m.press({ key: (await m.find({ type: 'Button', text: /^Read RULES\.md/ }))!.key! })
  expect(await m.find({ text: '~/dotagents, outside the session\'s project root' })).toBeDefined()
  await m.press({ key: 'back' })
  await m.press({ key: 'voutside' }) // back to all: views are module state
  await m.press({ key: 'fsetup' })
  expect(await m.find({ text: '~/repo' })).toBeDefined() // root
  expect(await m.find({ text: '~/repo/sub' })).toBeDefined() // cwd
  expect(await m.find({ text: '~/other' })).toBeDefined() // added
  expect(await m.find({ text: '~/dotagents' })).toBeDefined() // calls outside
  await m.press({ key: 'back' })
})

test('the background tasks and crons in flight when main\'s turn ended show on the setup page', async ($, on) => {
  session(on, 'BG')
  on('classic.*', () => ({}) as any)
  await ($ as any).classic.Stop({ stop_hook_active: false, background_tasks: [{ id: 'b1', type: 'shell', status: 'running', description: 'Run the dev server', command: 'npm run dev' }],
    session_crons: [{ id: 'c1', schedule: '*/5 * * * *', recurring: true, prompt: 'check the build\nmore' }] })
  const m = await pane($, 60, 160)
  await m.press({ key: 'fsetup' })
  expect(await m.find({ text: 'Background: in flight when the last turn ended' })).toBeDefined()
  expect(await m.find({ text: 'running: npm run dev' })).toBeDefined()
  expect(await m.find({ text: '*/5 * * * *: check the build' })).toBeDefined()
  await ($ as any).classic.Stop({ stop_hook_active: false, background_tasks: [], session_crons: [] })
  await m.redraw()
  expect(await m.find({ text: 'Background: nothing in flight when the last turn ended' })).toBeDefined()
  await m.press({ key: 'back' })
})

test('a refusal whose decision is recorded after its call ended still reads denied, and by whom', async ($, on) => {
  const db = capture(on, 'LD')
  on('telemetry.log', () => ({ value: undefined }))
  const GUARDED = 'ls in \'/home/u/x\' was blocked. For security, Claude Code may only list files in the allowed working directories for this session: \'/home/u/repo\'.'
  on('tool.call', (_$, e: any) => ({ result: '', isError: true, text: e.tool_use_id === 'ld2' ? GUARDED : 'Permission to use Bash has been denied. IMPORTANT: You *may* attempt to accomplish this action using other tools.' }))
  await $.tool.call({ tool: 'Bash', tool_use_id: 'ld0', command: 'true', description: 'Warm up' } as any) // the first call on $ loads the plugins
  await $.tool.call({ tool: 'Bash', tool_use_id: 'ld1', command: 'ls /x', description: 'List x' } as any)
  await collect($, 'tool_decision', { tool_use_id: 'ld1', decision: 'reject', source: 'config' }) // as a headless session records it: after the call
  await $.tool.call({ tool: 'Bash', tool_use_id: 'ld2', command: 'ls /home/u/x', description: 'List x' } as any) // no record: OTEL export off
  const rows = await flushed($, 'LD', db), row = rows.find(x => x.use === 'ld1')
  expect(row).toMatchObject({ status: 'denied', outcome: 'deny', via: 'config', peek: 'Permission to use Bash has been denied.' })
  expect(row.insight).toBe(undefined)
  expect(rows.find(x => x.use === 'ld2')).toMatchObject({ status: 'denied', peek: 'ls in \'/home/u/x\' was blocked. For security, Claude Code may only list files in the allowed working directories for this session' })
})

test('a row of several hooks draws one row per hook, by name', async ($, on) => {
  const m = await mountWith($, on, 'HK', [
    { t: T0, turn: 1, kind: 'hook', name: 'guard, test-gate, context-mode', origin: 'PreToolUse', detail: 'Bash', outcome: 'ok', status: 'ok', ms: 100 },
  ])
  await toLevel($, m, 'debug') // a fast hook that changed nothing ranks debug
  for (const n of ['guard', 'test-gate', 'context-mode']) expect(await m.find({ type: 'Button', text: `${n} on PreToolUse Bash` })).toBeDefined()
  expect(await m.find({ type: 'Button', text: /hooks on/ })).toBe(undefined)
  await toLevel($, m, 'info')
})

test('each hook of a row of several marks what it did on its own row: + the one that added context, · the silent ones, ✗ one that broke', async ($, on) => {
  const m = await mountWith($, on, 'HM', [
    { t: T0, turn: 1, kind: 'hook', name: 'context-mode, guard, test-gate, install-cooldown', origin: 'PreToolUse', detail: 'Bash', outcome: 'context x1 0.4 KB', ms: 100, peek: 'When you intend to PROCESS the output',
      each: { guard: 20, 'test-gate': 100, 'install-cooldown': 30 }, spoke: ['context-mode'], errs: ['install-cooldown'] },
  ])
  await toLevel($, m, 'debug')
  expect(await m.find({ text: /^\+ —$/ })).toBeDefined() // context-mode: a plugin hook, untimed
  expect(await m.find({ text: /^· <0\.1s$/ })).toBeDefined() // guard
  expect(await m.find({ text: /^· 0\.1s$/ })).toBeDefined() // test-gate
  expect(await m.find({ text: /^✗ <0\.1s$/ })).toBeDefined() // install-cooldown
  await toLevel($, m, 'info')
})

test('a hook hook-timer wraps shows its own time on its row; one it does not wrap shows none', async ($, on) => {
  const m = await mountWith($, on, 'HT', [
    { t: T0, turn: 1, kind: 'hook', name: 'guard, test-gate, context-mode', origin: 'PreToolUse', detail: 'Bash', outcome: 'ok', status: 'ok', ms: 900, each: { guard: 300, 'test-gate': 800 } },
  ])
  await toLevel($, m, 'debug')
  expect(await m.find({ text: /^· 0\.3s$/ })).toBeDefined()
  expect(await m.find({ text: /^· 0\.8s$/ })).toBeDefined()
  expect(await m.find({ text: /^· —$/ })).toBeDefined() // context-mode: a plugin hook, untimed
  await toLevel($, m, 'info')
})

test('a hook of a row of several opens alone: its own text, time and exit; prev and next step through its neighbours', async ($, on) => {
  const m = await mountWith($, on, 'HI', [
    { t: T0, turn: 1, kind: 'hook', name: 'context-mode, test-gate, guard', origin: 'PreToolUse', detail: 'Bash', outcome: 'context x2 0.1 KB', ms: 100, peek: 'use ctx_execute\nrun the tests first',
      each: { 'test-gate': 80, guard: 20 }, spoke: ['context-mode', 'test-gate'], says: { 'context-mode': 'use ctx_execute', 'test-gate': 'run the tests first' }, exits: { guard: 3 }, errs: ['guard'] },
  ])
  await toLevel($, m, 'debug')
  await m.press({ key: (await m.find({ type: 'Button', text: 'test-gate on PreToolUse Bash' }))!.key! })
  expect(await m.find({ text: 'test-gate ran on PreToolUse and added context for the model' })).toBeDefined()
  expect(await m.find({ text: 'run the tests first' })).toBeDefined()
  expect(await m.find({ text: /use ctx_execute/ })).toBe(undefined) // context-mode's, not this hook's
  expect(await m.find({ text: '80ms' })).toBeDefined() // its own, not the chain's 100
  await m.press({ key: 'prev' })
  expect(await m.find({ text: /^context-mode ran on PreToolUse/ })).toBeDefined()
  expect(await m.find({ key: 'prev' })).toBe(undefined) // the first row
  await m.press({ key: 'next' }); await m.press({ key: 'next' })
  expect(await m.find({ text: 'guard ran on PreToolUse and failed with exit 3' })).toBeDefined()
  expect(await m.find({ text: /run the tests first/ })).toBe(undefined)
  expect(await m.find({ key: 'next' })).toBe(undefined) // the last row
  await m.press({ key: 'back' })
  expect(await m.find({ type: 'Button', text: 'guard on PreToolUse Bash' })).toBeDefined()
  await toLevel($, m, 'info')
})

test('hook-timer lines count for the event, call and span they ran in', () => {
  const l = (o: object) => JSON.stringify({ event: 'PreToolUse', use: 'u1', t0: 1000, t1: 1050, say: null, ...o })
  const text = [
    l({ name: 'old', t0: 100, t1: 200 }), // ended before the chain began: reading stops there
    l({ name: 'guard' }), l({ name: 'other-call', use: 'u2' }), l({ name: 'post', event: 'PostToolUse' }),
    'not json', l({ name: 'test-gate', t0: 1010, t1: 1210, say: 'test-gate: run the tests first' }), '',
  ].join('\n')
  const keep = (r: any) => r.event === 'PreToolUse' && r.use === 'u1'
  expect(pickRuns(text, keep, 1000)).toEqual([{ name: 'guard', ms: 50, say: undefined }, { name: 'test-gate', ms: 200, say: 'test-gate: run the tests first' }])
  expect(pickRuns(text, r => r.event === 'Stop', 1000)).toEqual([])
})

test('a wrapped hook is named by its run: text by the run that said it, silence by the runs; unwrapped hooks still by the settings', () => {
  const T = '$HOME/.claude/hooks/hook-timer '
  const cfg = { PreToolUse: [
    { matcher: 'Bash', name: 'guard', cmd: `${T}$HOME/.claude/hooks/security/guard.sh` },
    { matcher: 'Bash', name: 'test-gate', cmd: `${T}$HOME/.claude/hooks/quality/test-gate.sh` },
    { matcher: 'Edit', name: 'contract-guard', cmd: `${T}$HOME/.claude/hooks/quality/contract-guard.sh` },
    { matcher: '', name: 'context-mode', plugin: true, cmd: 'node pretooluse.mjs' },
  ] }
  const runs = [{ name: 'guard', ms: 30 }, { name: 'test-gate', ms: 26, say: 'run the tests first' }]
  expect(runNames(cfg, 'PreToolUse', 'Bash', runs, [])).toBe('guard, test-gate, context-mode') // the runs, then the unwrapped that fit
  expect(runNames(cfg, 'PreToolUse', 'Bash', runs, ['run the tests first, then commit'])).toBe('test-gate') // no name in its text needed
  expect(runNames(cfg, 'PreToolUse', 'Bash', runs, ['context-mode: use ctx_execute'])).toBe('context-mode') // no run said it: by its text
  expect(withSilent(cfg, 'PreToolUse', 'Bash', runs, 'context-mode')).toBe('context-mode, guard, test-gate') // context keeps the hooks that said nothing
  expect(speaker(runs, 'nothing like it')).toBe(undefined)
})

test('each hook outcome has its mark: + context, · nothing, ■ a stop (yellow, not ✗), ⊘ a block', async ($, on) => {
  const m = await mountWith($, on, 'HO', [
    hookRow({ name: 'ctx', origin: 'UserPromptSubmit', detail: '', outcome: 'context x1 ~5 tok', ms: 100 }),
    hookRow({ name: 'quiet', origin: 'Notification', detail: '', ms: 200 }),
    hookRow({ name: 'halt', origin: 'Stop', detail: '', outcome: 'stop', ms: 300 }),
    hookRow({ name: 'guard', outcome: 'block', ms: 400 }),
  ])
  await toLevel($, m, 'debug')
  expect(await m.find({ type: 'Text', text: '+ 0.1s' })).toBeDefined()
  expect(await m.find({ type: 'Text', text: '· 0.2s' })).toBeDefined()
  expect(await m.find({ type: 'Text', text: '■ 0.3s' })).toBeDefined()
  expect(await m.find({ type: 'Text', text: '⊘ 0.4s' })).toBeDefined()
  expect(await m.find({ type: 'Text', text: /^✗/ })).toBe(undefined)
  await toLevel($, m, 'info')
})

// === STORE AND SCRUB ===
// the secret shapes a review found passing the old scrub, each masked with what frames it kept; code-like text stays
test('scrub masks common secret shapes and leaves code alone', () => {
  const masked: [string, string][] = [
    ['export API_KEY="abc123def"', 'export API_KEY="***"'],
    ["DB_PASSWORD='hunter2'", "DB_PASSWORD='***'"],
    ['{"api_key": "abc123def"}', '{"api_key": "***"}'],
    ['token ghp_' + 'a'.repeat(36) + ' end', 'token *** end'],
    ['AKIA' + 'ABCDEFGHIJKLMNOP', '***'],
    ['key sk-' + 'b'.repeat(24), 'key ***'],
    ['curl -u admin:s3cretpw https://h', 'curl -u admin:*** https://h'],
    ['curl --user admin:s3cretpw https://h', 'curl --user admin:*** https://h'],
    ['mysql -u root -ps3cretpw db', 'mysql -u root -p*** db'],
    ['-H "Authorization: Basic dXNlcjpwYXNz"', '-H "Authorization: Basic ***"'],
    ['Authorization: Bearer abcdefgh12345', 'Authorization: Bearer ***'],
    ['git clone https://me:pw123@host/r', 'git clone https://me:***@host/r'],
    ['tool --token abc123', 'tool --token ***'],
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----', '***'],
    ['export DB_PASS=hunter2', 'export DB_PASS=***'],
    ['curl https://hooks.slack.com/services/T0/B0/XXXX', 'curl https://hooks.slack.com/services/***'],
    ['https://b.s3.amazonaws.com/f?X-Amz-Date=1&X-Amz-Signature=fe5f80&x=1', 'https://b.s3.amazonaws.com/f?X-Amz-Date=1&X-Amz-Signature=***&x=1'],
    ['https://x.io/hook?sig=abc123', 'https://x.io/hook?sig=***'],
  ]
  for (const [raw, out] of masked) expect(scrub(raw)).toBe(out)
  for (const kept of ['const token = getToken()', 'TOKEN=$GITHUB_TOKEN', 'cat plugins/agent-log/hooks/agent-log.tsx', 'git push -u origin main', 'self.token = token',
    'max_tokens=4096', 'DB_PASSPORT=x1', 'curl http://localhost:8080/api/health?verbose=1'])
    expect(scrub(kept)).toBe(kept)
  expect(scrub(scrub('export API_KEY="abc123def"'))).toBe('export API_KEY="***"') // a scrubbed text scrubs to itself: peeks of insights scrub twice
})

test('a new session key prunes the store to the 10 newest sessions and drops the unredacted format', async ($, on) => {
  const db = capture(on, 'PN')
  for (let i = 0; i < 12; i++) db[`r:old${i}`] = { entries: [{ t: 1000 + i, kind: 'session', name: 'start', detail: '', outcome: '' }], seen: {} }
  db['s:legacy'] = [{ t: 9999 }]
  on('prompt.attachment', (_$, e) => ({ text: e.text }))
  await $.prompt.attachment({ type: 'date', text: 'Today\'s date is 2026-10-18.', origin: { kind: 'engine' } } as any)
  await flushed($, 'PN', db)
  expect(Object.keys(db).sort()).toEqual(['r:PN', ...[3, 4, 5, 6, 7, 8, 9, 10, 11].map(i => `r:old${i}`)].sort())
})

test('a write the store refuses keeps the rows, says "log not saved", and lands once the store takes it', async ($, on) => {
  mock.clock(on) // the retry timer waits on this clock, so it never fires into a later test
  const db: Record<string, any> = {}
  let full = true
  on('session.id', () => ({ value: 'NS' }))
  on('agent.list', () => ({ value: [] }))
  on('config.list', () => ({ value: [] }))
  ;(on as any)('ui.panes', () => ({ value: [{ id: 'agent-log' }] }))
  on('store.get', (_$: any, e: any) => ({ value: db[e.key] }))
  on('store.set', (_$: any, e: any) => { if (full) throw new Error('store over 4 MiB'); db[e.key] = e.value; return { value: undefined } })
  on('store.delete', (_$: any, e: any) => { delete db[e.key]; return { value: undefined } })
  on('store.keys', () => ({ value: Object.keys(db) }))
  on('session.end', (_$: any, e: any) => ({ sessionId: e.sessionId }))
  on('prompt.attachment', (_$, e) => ({ text: e.text }))
  await $.prompt.attachment({ type: 'date', text: 'Today\'s date is 2026-10-18.', origin: { kind: 'engine' } } as any)
  await flushed($, 'NS', db)
  expect(db['r:NS']).toBe(undefined)
  const m = await pane($, 60, 160)
  expect(await m.find({ type: 'Text', text: /log not saved/ })).toBeDefined()
  full = false
  expect((await flushed($, 'NS', db)).some(r => r.type === 'date')).toBe(true) // still dirty, so the next flush writes it
  await m.redraw()
  expect(await m.find({ type: 'Text', text: /log not saved/ })).toBe(undefined)
})

test('a session\'s key stays inside its share of the store, however large its rows', async ($, on) => {
  const db = capture(on, 'BG')
  const big = (i: number) => ({ t: 1000 + i, turn: 1, kind: 'step', name: 'claude-opus-5-5', detail: '', outcome: '', status: 'ok', peek: 'p'.repeat(300), thought: 't'.repeat(200), cmd: 'c'.repeat(1400) })
  db['r:BG'] = { entries: Array.from({ length: 300 }, (_, i) => big(i)), seen: {}, turn: 1, names: {} }
  on('prompt.attachment', (_$, e) => ({ text: e.text }))
  await $.prompt.attachment({ type: 'date', text: 'Today\'s date is 2026-10-18.', origin: { kind: 'engine' } } as any)
  const rows = await flushed($, 'BG', db)
  expect(JSON.stringify(db['r:BG']).length).toBeLessThanOrEqual(Math.floor((4 * 1024 * 1024 - 256 * 1024) / 10))
  expect(rows.length).toBeLessThan(300)
  expect(rows.at(-1)!.t).toBe(1299) // the oldest went, not the newest (the debug date row goes first, as over `keep`)
})

test('a subagent\'s replay counts leave the store with its last row; main\'s stay', async ($, on) => {
  const db = capture(on, 'SN')
  db['r:SN'] = { entries: [{ t: 1000, turn: 1, kind: 'tool', name: 'Read', detail: 'a', outcome: 'ok', status: 'ok' }], seen: { 'date||| 30': 1, 'skill_listing||gone1|400': 2 }, turn: 1, names: { gone1: 'Explore' } }
  on('prompt.attachment', (_$, e) => ({ text: e.text }))
  await $.prompt.attachment({ type: 'date', text: 'Today\'s date is 2026-10-18.', origin: { kind: 'engine' } } as any)
  await flushed($, 'SN', db)
  expect(Object.keys(db['r:SN'].seen).some(g => g.includes('gone1'))).toBe(false)
  expect(db['r:SN'].seen['date||| 30']).toBe(1)
  expect(db['r:SN'].names).toEqual({})
})

test('a collector failure count marks the event whose target it names, not another', async ($, on) => {
  const db = capture(on, 'HN')
  on('telemetry.log', () => ({ value: undefined }))
  on('classic.SessionStart', async () => {
    await ($ as any).telemetry.log({ to: 'collector', event: 'hook_execution_complete', attributes: { hook_event: 'SessionStart', hook_name: 'SessionStart:resume', num_hooks: '1', num_success: '0', num_non_blocking_error: '1', num_cancelled: '0' } })
    return {}
  })
  await ($ as any).classic.SessionStart({ source: 'startup' })
  expect((await flushed($, 'HN', db)).some(r => r.kind === 'hook' && r.status === 'failed')).toBe(false)
})

test('a hook that broke on an event whose other hooks added context still makes the row a failure, and says what broke', async ($, on) => {
  const db = capture(on, 'HC')
  on('telemetry.log', () => ({ value: undefined }))
  on('classic.SessionStart', async () => {
    await ($ as any).telemetry.log({ to: 'collector', event: 'hook_execution_complete', attributes: { hook_event: 'SessionStart', hook_name: 'SessionStart:startup', num_hooks: '3', num_success: '1', num_non_blocking_error: '2', num_cancelled: '0' } })
    return { additionalContext: ['preflight: machine DIP-P101'] }
  })
  await ($ as any).classic.SessionStart({ hook_event_name: 'SessionStart', source: 'startup' })
  const row = (await flushed($, 'HC', db)).find(r => r.kind === 'hook')
  expect(row?.status).toBe('failed')
  expect(row?.outcome).toMatch(/^context x1/)
  expect(row?.peek).toMatch(/2 failed/)
})

test('a store filled by older, larger sessions frees room for this one on the first write', async ($, on) => {
  const db: Record<string, any> = {}
  const CAP = 4 * 1024 * 1024
  on('session.id', () => ({ value: 'FR' }))
  on('agent.list', () => ({ value: [] }))
  on('config.list', () => ({ value: [] }))
  on('store.get', (_$: any, e: any) => ({ value: db[e.key] }))
  on('store.set', (_$: any, e: any) => { // as the engine's: over 4 MiB of JSON text in all, refused
    const total = Object.entries({ ...db, [e.key]: e.value }).reduce((n, [, v]) => n + JSON.stringify(v).length, 0)
    if (total > CAP) throw new Error('store over 4 MiB'); db[e.key] = e.value; return { value: undefined }
  })
  on('store.delete', (_$: any, e: any) => { delete db[e.key]; return { value: undefined } })
  on('store.keys', () => ({ value: Object.keys(db) }))
  on('session.end', (_$: any, e: any) => ({ sessionId: e.sessionId }))
  on('prompt.attachment', (_$, e) => ({ text: e.text }))
  for (let i = 0; i < 9; i++) db[`r:fat${i}`] = { entries: [{ t: 1000 + i, kind: 'tool', name: 'Bash', detail: 'd'.repeat(450_000), outcome: 'ok' }], seen: {} }
  await $.prompt.attachment({ type: 'date', text: 'Today\'s date is 2026-10-18.', origin: { kind: 'engine' } } as any)
  expect((await flushed($, 'FR', db)).some(r => r.type === 'date')).toBe(true)
  expect(db['r:fat0']).toBe(undefined) // the oldest went
  expect(db['r:fat8']).toBeDefined() // the newest stayed
})
