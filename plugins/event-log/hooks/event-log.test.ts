// Tests share the module's state (pending rows, seq, the current chunk): the storage test runs last and reads what it wrote.
import { test, expect, mock } from 'claude-code/testing'
import { enter, isNoise, isQuery, lineOf, linesOf, pack, peekOf, ser, tally, whoOf, type Row, scrub } from './event-log'

const ENGINE = { plugin: 'engine', tier: 'core' }

test('ser marks cycles, caps strings, scrubs secrets, names bytes and functions', () => {
  const a: any = { name: 'a' }
  a.self = a
  expect(JSON.parse(ser(a))).toEqual({ name: 'a', self: '[cycle]' })
  const shared = { x: 1 }
  expect(JSON.parse(ser({ p: shared, q: shared }))).toEqual({ p: { x: 1 }, q: { x: 1 } }) // shared, not a cycle
  const long = JSON.parse(ser({ s: 'x'.repeat(16 * 1024 + 5) })).s
  expect(long.endsWith('…(+5 chars)')).toBe(true)
  expect(JSON.parse(ser({ c: 'curl -H "Authorization: Bearer abc123"' })).c).toBe('curl -H "Authorization: Bearer ***"')
  expect(JSON.parse(ser({ b: new Uint8Array(7), f: () => 1 }))).toEqual({ b: '[bytes 7]', f: '[fn]' })
  expect(JSON.parse(ser(new Error('boom')))).toEqual({ name: 'Error', message: 'boom' })
})

test('peek takes the most telling string, prefixed by the tool', () => {
  expect(peekOf({ tool: 'Bash', command: 'ls\n  -la', description: 'list' })).toBe('Bash ls -la')
  expect(peekOf({ message: { role: 'user', content: [{ type: 'text', text: 'hello there' }] } })).toBe('hello there')
  expect(peekOf({ seq: 1 })).toBe('')
  expect(peekOf('x'.repeat(500)).length).toBe(160)
})

test('who: you, claude, hook, plugin, engine', () => {
  expect(whoOf('prompt.submit', ENGINE, { text: 'hi', origin: { kind: 'composer' } })).toBe('you')
  expect(whoOf('ui.close', ENGINE, { id: 'x', origin: { kind: 'person' } })).toBe('you')
  expect(whoOf('command.run', ENGINE, { command: 'x', origin: { kind: 'task-notification' } })).toBe('engine')
  expect(whoOf('turn.step', ENGINE, {}, 'enter')).toBe('engine') // the request
  expect(whoOf('turn.step', ENGINE, {}, 'exit')).toBe('claude') // the model's response
  expect(whoOf('tool.call', ENGINE, { tool: 'Bash' })).toBe('claude')
  expect(whoOf('session.append', ENGINE, { message: { type: 'assistant' } })).toBe('claude')
  expect(whoOf('session.append', ENGINE, { message: { type: 'user' } })).toBe('engine')
  expect(whoOf('classic.PreToolUse', ENGINE, {})).toBe('hook')
  expect(whoOf('tool.call', { plugin: 'skins', tier: 'user' }, { tool: 'Bash' })).toBe('plugin:skins')
  expect(whoOf('session.start', ENGINE, {})).toBe('engine')
})

test('noise is counted, not stored; this pane\'s own redraws are not even counted', () => {
  expect(isNoise('ui.render') && isNoise('clock.every') && isNoise('tool.describe')).toBe(true)
  expect(isNoise('tool.call')).toBe(false)
  expect(enter('ui.render', ENGINE, { component: 'Pane', requestId: 'event-log' })).toBe(undefined)
  expect(tally()).toBe(undefined)
  enter('ui.render', ENGINE, { component: 'Pane', requestId: 'other' })
  enter('ui.render', ENGINE, {})
  enter('prompt.edit', ENGINE, {})
  const t = tally()!
  expect(t.ph).toBe('tally')
  expect(t.peek).toBe('3 counted')
  expect(JSON.parse(t.data!)).toEqual({ 'ui.render': 2, 'prompt.edit': 1 })
  expect(tally()).toBe(undefined) // a flush's tally clears the counts
})

test('ui.* and a plugin\'s read-only calls are counted per plugin, not stored; ui.fault stays a row', () => {
  const SKINS = { plugin: 'skins', tier: 'user' }
  expect(enter('state.get', SKINS, { key: 'custom' })).toBe(undefined)
  expect(enter('ui.panes', SKINS, {})).toBe(undefined)
  expect(enter('ui.press', ENGINE, {})).toBe(undefined)
  expect(isNoise('ui.fault')).toBe(false)
  expect(JSON.parse(tally()!.data!)).toEqual({ 'state.get (skins)': 1, 'ui.panes (skins)': 1, 'ui.press': 1 })
})

test('read-only queries are told apart, so they never redraw the pane', () => {
  expect(['state.get', 'agent.list', 'fs.read', 'ui.panes', 'session.id', 'store.keys'].every(isQuery)).toBe(true)
  expect(['state.set', 'fs.write', 'session.append', 'session.start', 'tool.call'].some(isQuery)).toBe(false)
})

const row = (o: Partial<Row>): Row => ({ seq: 1, t: 0, ph: 'enter', ev: 'tool.call', who: 'claude', peek: 'Bash ls', ...o })

test('an exit merges into its enter, across its own batch; past nested events it points back', () => {
  const merged = linesOf([row({ seq: 1 }), row({ seq: 2, ph: 'exit', enter: 1, ms: 340 })])
  expect(merged.length).toBe(1)
  expect(merged[0]!.text).toMatch(/tool\.call {2}Bash ls · 340ms ok$/)
  const apart = linesOf([row({ seq: 1 }), row({ seq: 2, ev: 'classic.PreToolUse', who: 'hook', peek: '' }), row({ seq: 3, ph: 'exit', enter: 1, ms: 5, err: true })])
  expect(apart.map(l => l.rows.length)).toEqual([1, 1, 1])
  expect(apart[2]!.text).toMatch(/↳ tool\.call 5ms threw/)
  expect(linesOf(apart.flatMap(l => l.rows), 'hook').length).toBe(1)
  expect(linesOf([row({ who: 'plugin:skins' })], 'plugin').length).toBe(1)
  // a concurrent batch: every enter before any exit, each exit still lands on its own enter's line
  const ev = 'prompt.attachment', who = 'engine'
  const batch = linesOf([1, 2, 3].map(s => row({ seq: s, ev, who, peek: `a${s}` })).concat([3, 1, 2].map(s => row({ seq: s + 3, ph: 'exit', ev, who, enter: s, ms: s * 10 }))))
  expect(batch.map(l => l.text.replace(/^\S+ {2}/, ''))).toEqual([1, 2, 3].map(s => `engine      prompt.attachment  a${s} · ${s * 10}ms ok`))
})

test('a line is one JSON object; data spliced raw, a huge payload cut to a head', () => {
  const l = lineOf(row({ data: ser({ command: 'ls' }) }))
  expect(l.endsWith('\n')).toBe(true)
  expect(JSON.parse(l).data).toEqual({ command: 'ls' })
  const big = JSON.parse(lineOf(row({ data: JSON.stringify('x'.repeat(300 * 1024)) }))).data
  expect(big.truncated).toBeGreaterThan(300 * 1024)
})

test('chunks rotate before a line would cross the limit', () => {
  const c = { n: 1, buf: '' }
  expect(pack(c, ['aaaa\n', 'bbbb\n'], 12)).toEqual([])
  const done = pack(c, ['cccc\n', 'dddd\n'], 12)
  expect(done).toEqual([{ n: 1, text: 'aaaa\nbbbb\n' }])
  expect(c).toEqual({ n: 2, buf: 'cccc\ndddd\n' })
  expect(pack({ n: 1, buf: '' }, ['x'.repeat(50)], 12)).toEqual([]) // an oversized line still lands in an empty chunk
})

// the same rules as agent-log's scrub (three copies kept in step: redact, agent-log, event-log)
test('scrub masks common secret shapes and leaves code alone', () => {
  for (const [raw, out] of [['export API_KEY="abc123def"', 'export API_KEY="***"'], ['{"api_key": "abc123def"}', '{"api_key": "***"}'],
    ['token ghp_' + 'a'.repeat(36), 'token ***'], ['curl -u admin:s3cretpw https://h', 'curl -u admin:*** https://h'],
    ['mysql -ps3cretpw', 'mysql -p***'], ['Authorization: Basic dXNlcjpwYXNz', 'Authorization: Basic ***'],
    ['DB_PASS=hunter2', 'DB_PASS=***'], ['https://hooks.slack.com/services/T0/B0/XXXX', 'https://hooks.slack.com/services/***'],
    ['https://x.io/f?X-Amz-Signature=fe5f80&x=1', 'https://x.io/f?X-Amz-Signature=***&x=1']])
    expect(scrub(raw!)).toBe(out!)
  for (const kept of ['const token = getToken()', 'TOKEN=$GITHUB_TOKEN', 'git push -u origin main']) expect(scrub(kept)).toBe(kept)
})

test('the * hook wraps each event in enter/exit rows, flushed after the chunk a reload left, seq continued', async ($, on) => {
  const files: Record<string, string> = {}
  const clock = mock.clock(on)
  mock.env(on, { HOME: '/h' })
  on('session.id', () => ({ value: 'S1' }))
  // a hot reload: the session's last chunk on disk ends at seq 41
  const prior = '{"seq":41,"t":0,"ph":"enter","ev":"x","who":"engine","peek":"","data":null}\n'
  on('fs.list', () => ({ value: [{ name: '0001.jsonl', kind: 'file', size: 9, mtimeMs: 0, isLink: false }, { name: '0002.jsonl', kind: 'file', size: 9, mtimeMs: 0, isLink: false }] }) as any)
  on('fs.read', () => ({ value: prior }) as any)
  on('fs.write', (_$, e: any) => { files[e.path] = e.text; return { value: undefined } })
  on('ui.panes', () => ({ value: [] }))
  on('command.register', () => ({ value: undefined }) as any)
  let release = () => {}
  const gate = new Promise<void>(r => { release = r })
  on('tool.call', async () => { await gate; return { result: 'ok', text: 'done' } as any }) // held open across a flush
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/w', surface: null, isInteractive: false })
  const call$ = $.tool.call({ tool: 'Bash', tool_use_id: 'u1', command: 'ls', description: 'list' } as any)
  await clock.advance(2000) // flush: the call's enter row
  release()
  await call$
  await clock.advance(2000) // flush: its exit row
  const text = files['/h/.claude/event-log/S1/0002.jsonl']!
  expect(typeof text).toBe('string')
  expect(text.startsWith(prior)).toBe(true)
  const rows = text.trim().split('\n').map(l => JSON.parse(l))
  const seqs = rows.map(r => r.seq)
  expect(seqs[0]).toBe(41)
  expect(seqs.every((s, i) => i === 0 || s === seqs[i - 1] + 1)).toBe(true)
  const call = rows.findIndex(r => r.ev === 'tool.call' && r.ph === 'enter')
  const end = rows.findIndex(r => r.ev === 'tool.call' && r.ph === 'exit')
  expect(call).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(call)
  expect(rows[end].enter).toBe(rows[call].seq) // the enter was flushed before its exit was made
  expect(rows[call].data.command).toBe('ls')
  expect(rows[end].data.text).toBe('done')
  expect(rows.some(r => r.ev === 'session.start')).toBe(true)
  // the pane: the call's enter, its nested hook, its exit; pressing it opens its payload, back returns to the list
  const m = await $.ui.mount({ plugin: 'event-log', surface: 'terminal', component: 'Pane', requestId: 'event-log', props: { title: 'Event log', isFocused: false, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 40 } } as any })
  expect(await m.find({ type: 'Button', text: /command\.register/ })).toBe(undefined) // the log's own $ calls are not logged
  expect(await m.find({ type: 'Button', text: /classic\.PreToolUse {2}Bash ls · \d+ms ok$/ })).toBeDefined() // nested, merged
  expect(await m.find({ type: 'Button', text: /↳ tool\.call \d+ms ok {2}done$/ })).toBeDefined()
  const line = await m.find({ type: 'Button', text: /tool\.call {2}Bash ls$/ })
  expect(line).toBeDefined()
  await m.press({ key: line!.key! })
  expect(await m.find({ text: /"command": "ls"/ })).toBeDefined()
  await m.press({ key: 'back' })
  expect(await m.find({ type: 'Button', text: /tool\.call {2}Bash ls/ })).toBeDefined()
})

test('a reload leaves the pane closed, a filter keeps it closed, and past maxMB nothing more is written', { options: { maxMB: 0.001 } }, async ($, on) => {
  const files: Record<string, string> = {}
  const opened: unknown[] = []
  const clock = mock.clock(on)
  mock.env(on, { HOME: '/h' })
  on('session.id', () => ({ value: 'S2' }))
  // a reload: the session's log is already on disk
  on('fs.list', () => ({ value: [{ name: '0001.jsonl', kind: 'file', size: 9, mtimeMs: 0, isLink: false }] }) as any)
  on('fs.read', () => ({ value: '{"seq":7,"t":0,"ph":"enter","ev":"x","who":"engine","peek":"","data":null}\n' }) as any)
  on('fs.write', (_$, e: any) => { files[e.path] = e.text; return { value: undefined } })
  on('ui.open', (_$, e) => { opened.push(e); return { value: { isPlaced: true } } as any })
  on('ui.panes', () => ({ value: [] }))
  const toasts: string[] = []
  on('ui.toast', (_$: any, e: any) => { toasts.push(e.text); return { value: undefined } as any })
  on('command.register', () => ({ value: undefined }) as any)
  on('tool.call', () => ({ result: 'ok', text: 'done' }) as any)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  expect(opened.length).toBe(0)
  const r: any = await $.command.run({ command: 'eventlog', args: 'you' } as any)
  expect(opened.length).toBe(0)
  expect(r?.text).toBeUndefined() // the reply is a toast, never the conversation's
  expect(toasts.join()).toMatch(/pane hidden/)
  const sent: any = await $.prompt.submit({ text: '/eventlog you', command: { name: 'eventlog', args: 'you' }, origin: { kind: 'composer' } } as any)
  expect(sent?.drop).toBeTruthy() // nor its line
  await $.tool.call({ tool: 'Bash', tool_use_id: 'u2', command: 'x'.repeat(2000), description: 'big' } as any)
  await clock.advance(2000)
  expect(Object.keys(files)).toEqual([]) // over the 0.001 MB cap at the first flush: nothing written
  await $.command.run({ command: 'eventlog', args: 'all' } as any)
  const m = await $.ui.mount({ plugin: 'event-log', surface: 'terminal', component: 'Pane', requestId: 'event-log', props: { title: 'Event log', isFocused: false, bodyColumns: 200, placement: 'dock', scroll: { offset: 0, bodyRows: 40 } } as any })
  expect(await m.find({ text: /log full at 0\.001 MB, no longer writing/ })).toBeDefined()
})
