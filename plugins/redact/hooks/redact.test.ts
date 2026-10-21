import { test, expect, mock } from 'claude-code/testing'
import { EXAMPLES, composeEnvFiles, envValues, fresh, mask, migrate, restore } from './redact'

// Fixtures are split so no literal matches ~/dotagents/scripts/git-hooks/lib/secret-content.ere,
// which dotagents' pre-push gate runs over every added line (this file came from there), and
// so the live plugin leaves this file readable (and so editable): split inside the name or
// keyword, as in 'DB_PASS' + 'WORD=…', never at the separator. Code-shaped negatives need no split.
const GH = 'ghp_' + 'a'.repeat(36)
const ANT = 'sk-ant-' + 'api03-' + 'abcdefghijklmnopqrstuv'
const ACME = 'acme' + '_k3y9x2q7'
const MAIL = 'ann' + '@example.com'

// A placeholder, spelled with escapes so no file of this plugin holds one a restore would fill in.
const ph = (label: string, n = 1) => `⟦${label}_${n}⟧`
// the same, escaped: restore writes it as the literal placeholder
const esc = (label: string, n = 1) => `⟦!${label}_${n}⟧`
type Patterns = Parameters<typeof mask>[2]
// the examples as patterns, on; a pattern of a regex, a label and options
const EX: Patterns = EXAMPLES.map(r => ({ re: new RegExp(r.pattern, 'gd'), label: r.replacement }))
const pat = (src: string, label = 'SECRET', o: object = {}) => ({ re: new RegExp(src, 'gd'), label, ...o })
// masked with a vault of its own
const m1 = (s: string, patterns: Patterns = EX) => mask(s, fresh(), patterns)

test('the examples mask a vendor token or an email address under their label, the text around it stays', () => {
  expect(m1(`GITHUB_TOKEN=${GH}`)).toBe(`GITHUB_TOKEN=${ph('API_KEY')}`)
  expect(m1(`key ${ANT}`)).toBe(`key ${ph('API_KEY')}`)
  expect(m1('mail me.x+tag' + '@mail.example.co.uk.')).toBe(`mail ${ph('EMAIL')}.`)
})

test('vendor token shapes are masked', () => {
  for (const t of [
    'sk_' + 'live_' + 'a'.repeat(24), 'gl' + 'pat-' + 'a'.repeat(20), 'hf' + '_' + 'a'.repeat(34),
    'np' + 'm_' + 'a'.repeat(36), 'dckr' + '_pat_' + 'a'.repeat(20), 'S' + 'G.' + 'a'.repeat(20) + '.' + 'b'.repeat(20),
    'ya' + '29.' + 'a'.repeat(20), 'AS' + 'IA' + 'A'.repeat(16),
  ]) expect(m1(`x ${t} y`)).toBe(`x ${ph('API_KEY')} y`)
})

test('what the examples could misread is left alone', () => {
  for (const s of [
    'max_tokens: 1000', 'git status: clean', 'DB_PASS' + 'WORD=hunter2',
    'git@github.com:dboeter/cc-plugins.git', 'npm i react@18.2.0 @types/node', 'ssh root@localhost',
    'daanb@desktop:~$', 'icon@2x.png', '@app.route("/")', 'a'.repeat(65) + '@example.com',
  ]) expect(m1(s)).toBe(s)
})

test('distinct values get distinct numbers, and a value keeps its placeholder', () => {
  const h = fresh()
  const other = 'bob' + '@example.com'
  expect(mask(`${MAIL} ${other} ${MAIL}`, h, EX)).toBe(`${ph('EMAIL', 1)} ${ph('EMAIL', 2)} ${ph('EMAIL', 1)}`)
  expect(mask(`${GH} then ${other}`, h, EX)).toBe(`${ph('API_KEY', 1)} then ${ph('EMAIL', 2)}`)
})

test('a value once matched is masked wherever it comes back, as a whole word, with no rule on', () => {
  const h = fresh()
  mask('PASS=hunter2isgood', h, [pat('(?<=PASS=)\\S+')])
  expect(mask('login hunter2isgood ok', h, [])).toBe(`login ${ph('SECRET')} ok`)
  expect(mask('(hunter2isgood)', h, [])).toBe(`(${ph('SECRET')})`)
  expect(mask('hunter2isgoods and xhunter2isgood', h, [])).toBe('hunter2isgoods and xhunter2isgood')
})

test("a rule's options: strong, min and prose", () => {
  // strong: 8 or more characters of two kinds out of letters, digits and symbols
  const strong = [pat('(?<pre>bearer )(?<v>\\S+)', 'TOKEN', { strong: true })]
  expect(m1('bearer 12345678', strong)).toBe('bearer 12345678')
  expect(m1('bearer abcdefghij', strong)).toBe('bearer abcdefghij')
  expect(m1('bearer 1234-5678', strong)).toBe(`bearer ${ph('TOKEN')}`)
  // min: that long, and not of lowercase letters only
  const min = [pat('(?<pre>pw=)(?<v>\\S+)', 'SECRET', { min: 4 })]
  for (const s of ['pw=ab1', 'pw=letmein']) expect(m1(s, min)).toBe(s)
  expect(m1('pw=letme1n', min)).toBe(`pw=${ph('SECRET')}`)
  expect(m1('pw=Letmein', min)).toBe(`pw=${ph('SECRET')}`)
  // prose: a match after a colon with words after it on the line stays
  const prose = [pat('(?<pre>pw: )(?<v>\\S+)', 'SECRET', { prose: true })]
  expect(m1('pw: a password here', prose)).toBe('pw: a password here')
  expect(m1('pw: hunter2', prose)).toBe(`pw: ${ph('SECRET')}`)
})

test("your patterns leave a placeholder whole, so restore gives the text back", () => {
  const h = fresh()
  const s = `key ${GH} and ABCDE 42`
  const masked = mask(s, h, [...EX, { re: /[A-Z]{4,}/g, label: 'SECRET' }, { re: /\d+/g, label: 'SECRET' }])
  expect(masked).toBe(`key ${ph('API_KEY')} and ${ph('SECRET', 1)} ${ph('SECRET', 2)}`)
  expect(restore(masked, h)).toBe(s)
  const escaped = `doc ${esc('API_KEY', 42)}`
  expect(mask(escaped, h, [...EX, { re: /[A-Z]{4,}/g, label: 'SECRET' }, { re: /\d+/g, label: 'SECRET' }])).toBe(escaped)
})

test('a placeholder the vault does not hold reads escaped, and restore writes the escape as the literal', () => {
  const h = fresh()
  expect(mask(`doc names ${ph('API_KEY', 7)}`, h, [])).toBe(`doc names ${esc('API_KEY', 7)}`)
  expect(mask(`doc names ${esc('API_KEY', 7)}`, h, [])).toBe(`doc names ${esc('API_KEY', 7)}`)
  const missing = new Set<string>()
  expect(restore(`doc names ${esc('API_KEY', 7)}`, h, missing)).toBe(`doc names ${ph('API_KEY', 7)}`)
  expect(missing.size).toBe(0)
})

test('masking twice is masking once', () => {
  const h = fresh()
  const patterns = [...EX, pat('(?<=PASS=)\\w+')]
  const once = mask(`PASS=two ${MAIL} ${GH}`, h, patterns)
  const numbers = { ...h.v.n }
  expect(mask(once, h, patterns)).toBe(once)
  expect(h.v.n).toEqual(numbers)
})

test('restore puts every value back, and names the placeholders it does not hold', () => {
  const h = fresh()
  const s = `GITHUB_TOKEN=${GH}\nmail ${MAIL} again ${GH}`
  const masked = mask(s, h, EX)
  expect(masked).not.toContain('aaaa')
  expect(restore(masked, h)).toBe(s)
  const missing = new Set<string>()
  expect(restore(`x ${ph('API_KEY', 9)}`, h, missing)).toBe(`x ${ph('API_KEY', 9)}`)
  expect([...missing]).toEqual([ph('API_KEY', 9)])
})

test('a pattern that can match empty inserts no placeholders', () => {
  expect(m1('hello', [{ re: /x*/g, label: 'SECRET' }])).toBe('hello')
  expect(m1('a xx b', [{ re: /x*/g, label: 'SECRET' }])).toBe(`a ${ph('SECRET')} b`)
})

// The world beneath the plugin in a test: one session, a clock, a store and files whose contents
// a test reads, HOME at /h, and the prompt as it entered (`entered()`). Registered before the
// test's first call on `$`. `links` maps a path to where it lands.
const world = (on: any, entries: Record<string, unknown> = {}, given: Record<string, string> = {}, links: Record<string, string> = {}) => {
  const store = new Map(Object.entries(entries))
  const files = new Map(Object.entries(given))
  let last = ''
  mock.clock(on, { now: 40 * DAY })
  on('session.id', () => ({ value: 's1' }))
  on('store.get', (_$: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_$: any, e: any) => { store.set(e.key, e.value); return { value: undefined } })
  on('store.delete', (_$: any, e: any) => { store.delete(e.key); return { value: undefined } })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('env.get', (_$: any, e: any) => ({ value: e.name === 'HOME' ? '/h' : undefined }))
  on('fs.exists', (_$: any, e: any) => ({ value: files.has(e.path) }))
  on('fs.read', (_$: any, e: any) => { if (!files.has(e.path)) throw new Error(`ENOENT ${e.path}`); return { value: files.get(e.path) } })
  on('fs.write', (_$: any, e: any) => { files.set(e.path, e.text); return { value: undefined } })
  on('fs.stat', (_$: any, e: any) => ({ value: { kind: 'file', size: files.get(e.path)?.length ?? 0, mtimeMs: 0, isLink: e.path in links, realPath: links[e.path] ?? e.path } }))
  on('prompt.submit', (_$: any, e: any) => { last = e.text; return { text: e.text } })
  const entered = async ($: any, text: string) => { await $.prompt.submit({ text, origin: { kind: 'composer' } }); return last }
  return { store, files, entered }
}
const DAY = 24 * 3600 * 1000
// the rules file, a rules file of these rules, and the rules a file holds
const RULES = '/h/.claude/redact-rules.json'
const OLD = '/h/.claude/redact-patterns.txt'
const file = (rules: unknown[]) => JSON.stringify({ rules }, null, 2) + '\n'
const rulesOf = (files: Map<string, string>) => JSON.parse(files.get(RULES)!).rules
// a rules file with both examples on
const ON = EXAMPLES.map(r => ({ ...r, enabled: true }))
const BOTH = { [RULES]: file(ON) }
const HOLDS_GH = { 'vault:s1': { at: 39 * DAY, n: { API_KEY: 1 }, ph: { [ph('API_KEY')]: GH } } }
// the toasts the plugin showed, in order
const toasted = (on: any) => {
  const toasts: string[] = []
  on('ui.toast', (_$: any, e: any) => { toasts.push(e.text); return { value: undefined } as any })
  return toasts
}

test('a prompt is masked before it enters the session, its values kept in the vault', async ($, on) => {
  const { store, entered } = world(on, {}, BOTH)
  expect(await entered($, `deploy with GITHUB_TOKEN=${GH}`)).toBe(`deploy with GITHUB_TOKEN=${ph('API_KEY')}`)
  expect((store.get('vault:s1') as any).ph).toEqual({ [ph('API_KEY')]: GH })
})

test('every row the model reads is masked; an image stays, a response is left as made', async ($, on) => {
  world(on, {}, BOTH)
  const session = mock.session(on)
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }
  await $.session.append({ door: 'tool-result', origin: { kind: 'tool', tool: 'Bash' }, uuid: 'u1',
    message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: `GITHUB_TOKEN=${GH}` }, image] }] } } as any)
  await $.session.append({ door: 'response', origin: { kind: 'model', model: 'm' }, uuid: 'u2',
    message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: `write to ${MAIL}` }] } } as any)
  const [row, reply] = session.appended() as any[]
  expect(row.message.content[0].content).toEqual([{ type: 'text', text: `GITHUB_TOKEN=${ph('API_KEY')}` }, image])
  expect(reply.message.content[0].text).toBe(`write to ${MAIL}`)
})

test('a row the hook fails to mask is withheld, not passed on', async ($, on) => {
  on('session.id', () => ({ value: 's1' }))
  on('store.get', () => { throw new Error('store down') })
  const session = mock.session(on)
  await $.session.append({ door: 'prompt', origin: { kind: 'composer' }, uuid: 'u1',
    message: { type: 'user', role: 'user', content: [{ type: 'text', text: `GITHUB_TOKEN=${GH}` }] } } as any)
  const [row] = session.appended() as any[]
  expect(JSON.stringify(row.message)).not.toContain('aaaa')
  expect(row.message.content[0].text).toContain('withheld')
})

test('what the first request carries is masked: context blocks, the system prompt, injected reminders, MCP tool descriptions', async ($, on) => {
  world(on, {}, BOTH)
  const other = 'bob' + '@example.com'
  on('prompt.context', () => ({ blocks: [{ name: 'claudeMd', text: `deploy key ${GH}` }, { name: 'userEmail', text: `The address is ${MAIL}.` }, { name: 'currentDate', text: '2026-10-17' }] }) as any)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' }, { id: 'env', text: `key ${ANT}`, scope: 'session' }] }) as any)
  on('prompt.attachment', () => ({ text: `the file says ${ANT}` }))
  on('tool.describe', (_$: any, e: any) => ({ description: e.description }))
  const ctx: any = await $.prompt.context({ blocks: [] } as any)
  expect(ctx.blocks.map((b: any) => b.text)).toEqual([`deploy key ${ph('API_KEY')}`, `The address is ${ph('EMAIL')}.`, '2026-10-17'])
  const sys: any = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] } as any)
  expect(sys.sections.map((s: any) => s.text)).toEqual(['You are Claude.', `key ${ph('API_KEY', 2)}`])
  expect(((await $.prompt.attachment({ type: 'file', text: 'x', origin: { kind: 'engine' } } as any)) as any).text).toBe(`the file says ${ph('API_KEY', 2)}`)
  const described = async (tool: string) => ((await $.tool.describe({ tool, description: `mail ${other}` } as any)) as any).description
  expect(await described('mcp__x__post')).toBe(`mail ${ph('EMAIL', 2)}`)
  expect(await described('Bash')).toBe(`mail ${other}`)
})

test("a command's arguments are masked before it runs, a skill's text before the model reads it; /redact's own are not", async ($, on) => {
  const { files } = world(on, {}, BOTH)
  const args: string[] = []
  on('command.run', (_$: any, e: any) => { args.push(e.args); return { text: 'ran' } })
  on('skill.prompt', () => ({ text: `use GITHUB_TOKEN=${GH}` }))
  await $.command.run({ command: 'deploy', args: `to ${MAIL}` } as any)
  expect(args).toEqual([`to ${ph('EMAIL')}`])
  expect(((await $.skill.prompt({ skill: 'ship', text: 'x' } as any)) as any).text).toBe(`use GITHUB_TOKEN=${ph('API_KEY')}`)
  await $.command.run({ command: 'redact', args: `add ${'bob' + '@example.com'}` } as any)
  expect(rulesOf(files).at(-1).pattern).toBe('bob' + '@example.com')
})

test('a tool gets the real values back in its input, nested ones too, remote tools included', async ($, on) => {
  world(on, HOLDS_GH)
  const ran: any[] = []
  on('tool.call', async (_$: any, e: any) => { ran.push(e); return { result: {} } as any })
  await $.tool.call({ tool: 'Bash', command: `gh auth login --with-token <<< ${ph('API_KEY')}` })
  await $.tool.call({ tool: 'mcp__x__post', body: { headers: [`Authorization: token ${ph('API_KEY')}`] } } as any)
  await $.tool.call({ tool: 'WebFetch', url: `https://h/?k=${ph('API_KEY')}`, prompt: 'p' } as any)
  expect(ran.map(e => e.command ?? e.body?.headers[0] ?? e.url)).toEqual([`gh auth login --with-token <<< ${GH}`, `Authorization: token ${GH}`, `https://h/?k=${GH}`])
})

test('a placeholder the vault does not hold refuses the call and tells the person; its escape writes the literal', async ($, on) => {
  world(on, HOLDS_GH)
  const toasts = toasted(on)
  const ran: any[] = []
  on('tool.call', async (_$: any, e: any) => { ran.push(e); return { result: {} } as any })
  const r: any = await $.tool.call({ tool: 'Write', file_path: '/a', content: `k=${ph('API_KEY', 3)}` } as any)
  expect(r.deny).toContain(ph('API_KEY', 3))
  expect(r.deny).toContain(esc('API_KEY', 3))
  expect(toasts.some(t => t.includes(ph('API_KEY', 3)))).toBe(true)
  expect(ran.length).toBe(0)
  await $.tool.call({ tool: 'Write', file_path: '/a', content: `k=${esc('API_KEY', 3)}` } as any)
  expect(ran.map(e => e.content)).toEqual([`k=${ph('API_KEY', 3)}`])
})

test('the terminal draws the real values; a remote surface keeps the placeholders', async ($, on) => {
  world(on, HOLDS_GH)
  const drawn: string[] = []
  on('ui.render', { component: 'AssistantMessage' }, ($$: any, e: any) => {
    drawn.push(`${e.surface}: ${e.props.text}`)
    const { Text } = $$.ui.resolve(e)
    return h(Text, {}, e.props.text) as any
  })
  for (const surface of ['terminal', 'mobile'] as const) {
    await $.ui.mount({ plugin: 'redact', surface, component: 'AssistantMessage', requestId: 'm1', props: { text: `uses ${ph('API_KEY')}`, isFirstOfReply: true } as any })
  }
  expect(drawn).toEqual([`terminal: uses ${GH}`, `mobile: uses ${ph('API_KEY')}`])
})

test('a vault untouched for 30 days is dropped at the start of a session', async ($, on) => {
  const { store } = world(on, { 'vault:old': { at: 1, n: {}, ph: {} }, 'vault:s1': { at: 39 * DAY, n: {}, ph: {} }, other: [] })
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect([...store.keys()]).toEqual(['vault:s1', 'other'])
})

test('a pattern from the options is masked too', { options: { patterns: ['acme_[a-z0-9]{8}'] } }, async ($, on) => {
  const { entered } = world(on)
  expect(await entered($, `id ${ACME} ok`)).toBe(`id ${ph('SECRET')} ok`)
})

test('a pattern that does not compile is skipped and named in the status line, the rest stay on', { options: { patterns: ['(', 'ACME: acme_[a-z0-9]{8}'] } }, async ($, on) => {
  const { entered } = world(on)
  const statuses = statusLine(on)
  expect(await entered($, `id ${ACME} ok`)).toBe(`id ${ph('ACME')} ok`)
  expect(statuses.at(-1)).toBe('redact: 1 masked · skipped pattern #1 (/redact show)')
})

// the status lines the plugin set, in order
const statusLine = (on: any) => {
  const lines: (string | undefined)[] = []
  on('ui.status', (_$: any, e: any) => { lines.push(e.text); return { value: undefined } as any })
  return lines
}

test('a new rules file holds the two examples, off: nothing is masked, and the status line says so', async ($, on) => {
  const { files, entered } = world(on)
  const statuses = statusLine(on)
  const toasts = toasted(on)
  on('ui.open', () => ({ value: { isPlaced: true } }) as any)
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(EXAMPLES.map(r => r.enabled)).toEqual([false, false])
  expect(JSON.parse(files.get(RULES)!)).toEqual({ rules: EXAMPLES })
  expect(await entered($, `GITHUB_TOKEN=${GH} ${MAIL}`)).toBe(`GITHUB_TOKEN=${GH} ${MAIL}`)
  expect(statuses).toEqual(['redact: 0 masked · no rules on'])
  await $.command.run({ command: 'redact', args: `test ${MAIL}` } as any)
  expect(toasts.at(-1)).toBe('redact: no rule matched: none is on')
  const m = await mount($)
  await m.press({ key: 'tab-rules' })
  expect(await m.find({ text: /0 of 2 on/ })).toBeDefined()
  expect(await m.find({ text: /^  1\. Example: vendor tokens/ })).toBeDefined()
  expect(await m.find({ text: /^  2\. Example: email addresses$/ })).toBeDefined()
  expect(await m.find({ text: / as EMAIL/ })).toBeDefined()
  expect(await m.find({ text: /○ off/ })).toBeDefined()
})

test('the status line counts what this session masked', async ($, on) => {
  const { entered } = world(on, {}, BOTH)
  const statuses = statusLine(on)
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await entered($, `GITHUB_TOKEN=${GH} and ${MAIL}`)
  await entered($, 'nothing here')
  expect(statuses).toEqual(['redact: 0 masked', 'redact: 2 masked'])
})

test('a masking failure that drops context, system prompt sections or a reminder is toasted', async ($, on) => {
  on('session.id', () => ({ value: 's1' }))
  on('store.get', () => { throw new Error('store down') })
  const toasts = toasted(on)
  on('prompt.context', () => ({ blocks: [{ name: 'claudeMd', text: 'x' }] }) as any)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' }, { id: 'env', text: 'x', scope: 'session' }] }) as any)
  on('prompt.attachment', () => ({ text: 'x' }))
  expect(((await $.prompt.context({ blocks: [] } as any)) as any).blocks).toEqual([])
  expect(((await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] } as any)) as any).sections.map((s: any) => s.id)).toEqual(['intro'])
  expect(((await $.prompt.attachment({ type: 'file', text: 'x', origin: { kind: 'engine' } } as any)) as any).text).toBe(null)
  expect(toasts).toHaveLength(3)
  expect(toasts[0]).toContain("the first request's context")
  expect(toasts[1]).toContain('only its shared sections')
  expect(toasts[2]).toContain('an injected file')
})

test('two missing placeholders are refused in the plural', async ($, on) => {
  world(on, HOLDS_GH)
  const r: any = await $.tool.call({ tool: 'Write', file_path: '/a', content: `${ph('API_KEY', 2)} ${ph('API_KEY', 3)}` } as any)
  expect(r.deny).toContain(`${ph('API_KEY', 2)}, ${ph('API_KEY', 3)} are no placeholders this session's`)
})

const PROPS = { title: 'Redact rules', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 } } as any
const mount = ($: any, surface = 'terminal') => $.ui.mount({ plugin: 'redact', surface, component: 'Pane', requestId: 'redact', props: PROPS })
// /redact with these arguments: its reply is a toast, and the command prints nothing the model could read
const runner = ($: any, toasts: string[]) => async (args: string) => {
  const n = toasts.length
  expect(((await $.command.run({ command: 'redact', args } as any)) as any).text).toBeUndefined()
  return toasts.length > n ? toasts.at(-1)!.replace(/^redact: /, '') : undefined
}

test('/redact add keeps a rule, on, that masks from the next message on; /redact remove drops it', async ($, on) => {
  const { files, entered } = world(on)
  const opened: any[] = []
  on('ui.open', (_$: any, e: any) => { opened.push(e); return { value: { isPlaced: true } } as any })
  const run = runner($, toasted(on))
  expect(await run('add ACME: acme_[a-z0-9]{8}')).toContain('added as #3')
  expect(await run('add x_[0-9]+')).toBe('added as #4: it masks from the next message on')
  expect(rulesOf(files).slice(2)).toEqual([
    { pattern: 'acme_[a-z0-9]{8}', replacement: 'ACME', enabled: true }, { pattern: 'x_[0-9]+', replacement: 'SECRET', enabled: true }])
  expect(await entered($, `id ${ACME} ok`)).toBe(`id ${ph('ACME')} ok`)
  expect(await run('add ACME: acme_[a-z0-9]{8}')).toBe('already there, as #3')
  expect(await run('add (')).toContain('not added')
  expect(await run('add X bogus: x')).toBe('not added: unknown option bogus')
  expect(await run('remove 5')).toContain('no such rule')
  expect(await run('remove 3')).toBe('removed #3')
  expect(await run('remove x_[0-9]+')).toBe('removed #3')
  expect(await run('remove x_[0-9]+')).toContain('no such rule')
  expect(rulesOf(files)).toEqual(EXAMPLES)
  expect(await run('show')).toBeUndefined()
  expect(opened).toMatchObject([{ id: 'redact', focus: true }])
  expect(await run('list')).toContain('usage')
})

test('a rule turns on and off, from the prompt by number or name, the pane or the file', async ($, on) => {
  const { files, entered } = world(on)
  const run = runner($, toasted(on))
  const other = 'bob' + '@example.com'
  expect(await entered($, `mail ${MAIL}`)).toBe(`mail ${MAIL}`)
  expect(await run('on 2')).toBe('#2 on: from the next message on')
  expect(rulesOf(files)[1]).toEqual({ ...EXAMPLES[1], enabled: true })
  expect(await entered($, `mail ${MAIL}`)).toBe(`mail ${ph('EMAIL')}`)
  expect(await run('on 2')).toBe('already on: #2')
  expect(await run('off nope')).toContain('no such rule')
  expect(await run('off Example: email addresses')).toBe('#2 off: from the next message on')
  expect(await entered($, `mail ${other}`)).toBe(`mail ${other}`)
  const m = await mount($)
  await m.press({ key: 'tab-rules' })
  await m.press({ key: 'turn-0' })
  expect(rulesOf(files)[0].enabled).toBe(true)
  expect(await entered($, `key ${GH}`)).toBe(`key ${ph('API_KEY')}`)
  // turned on by hand
  files.set(RULES, file([{ ...EXAMPLES[1], enabled: true }]))
  expect(await entered($, `mail ${other}`)).toBe(`mail ${ph('EMAIL', 2)}`)
})

test('a rule added to the file by hand masks from the next message on, on with no enabled; /redact keeps the other keys', async ($, on) => {
  const { files, entered } = world(on)
  expect(await entered($, `id ${ACME}`)).toBe(`id ${ACME}`)
  files.set(RULES, file([...EXAMPLES, { name: 'Acme keys', pattern: 'acme_[a-z0-9]{8}', replacement: 'ACME' }]))
  expect(await entered($, `id ${ACME}`)).toBe(`id ${ph('ACME')}`)
  files.set(RULES, JSON.stringify({ note: 'mine', rules: [] }))
  await $.command.run({ command: 'redact', args: 'add x_[0-9]+' } as any)
  expect(JSON.parse(files.get(RULES)!)).toEqual({ note: 'mine', rules: [{ pattern: 'x_[0-9]+', replacement: 'SECRET', enabled: true }] })
})

test('a rules file that does not parse keeps the last rules read, says so, and is never written over', async ($, on) => {
  const { files, entered } = world(on, {}, BOTH)
  const statuses = statusLine(on)
  const run = runner($, toasted(on))
  expect(await entered($, `key ${GH}`)).toBe(`key ${ph('API_KEY')}`)
  files.set(RULES, '{ broken')
  expect(await entered($, `mail ${MAIL}`)).toBe(`mail ${ph('EMAIL')}`)
  expect(statuses.at(-1)).toBe('redact: 2 masked · redact-rules.json is no JSON object with a rules list, last rules kept (/redact rules)')
  expect(await run('add x_[0-9]+')).toContain('not saved')
  expect(files.get(RULES)).toBe('{ broken')
  expect(await (await mount($)).find({ text: /1 skipped/ })).toBeDefined()
})

test('a patterns file of the version before moves into the rules file once: its patterns on, an example on where its rule was', async ($, on) => {
  const old = '# redact: your own patterns\n#\n\noff private-key\noff bearer\noff email\n\n# mine\nID min=4 i: (?<pre>id=)(?<v>\\w+)\nZZ bogus: zz\n'
  const { files, entered } = world(on, {}, { [OLD]: old })
  const toasts = toasted(on)
  expect(await entered($, `id=Ab12 ${GH} ${MAIL}`)).toBe(`id=${ph('ID')} ${ph('API_KEY')} ${MAIL}`)
  expect(rulesOf(files)).toEqual([{ ...EXAMPLES[0], enabled: true }, EXAMPLES[1],
    { name: 'mine', pattern: '(?<pre>id=)(?<v>\\w+)', replacement: 'ID', enabled: true, min: 4, ignoreCase: true }])
  expect(files.get(OLD)).toBe(old)
  expect(toasts).toEqual([expect.stringContaining('url-password, flag, assigned were on and mask nothing now. 1 line that did not read stayed behind.')])
  // every rule off, nothing of their own: the examples, off
  expect(migrate('off ' + ['private-key', 'vendor-token', 'bearer', 'url-password', 'flag', 'assigned', 'email'].join('\noff ')))
    .toEqual({ text: file(EXAMPLES), gone: [], lost: 0 })
})

test('a rule masks its v group under its replacement, with its options; one that does not read is skipped and marked', async ($, on) => {
  const { entered } = world(on, {}, { [RULES]: file([{ pattern: '(?<pre>id=)(?<v>\\w+)', replacement: 'ID', min: 4 }, { pattern: 'zz_[0-9]+', replacement: 'zz' }, { pattern: '(' }]) })
  expect(await entered($, 'id=Ab12 id=Ab1 id=abcd zz_12')).toBe(`id=${ph('ID')} id=Ab1 id=abcd zz_12`)
  const m = await mount($)
  expect(await m.find({ text: /2 skipped/ })).toBeDefined()
  await m.press({ key: 'tab-rules' })
  expect(await m.find({ text: /skipped: replacement is not capitals/ })).toBeDefined()
})

test('the pane lists every rule by its replacement, and adds and removes one', async ($, on) => {
  const { files } = world(on, {}, { [RULES]: file([{ pattern: 'first_[0-9]+', replacement: 'FIRST', enabled: true }]) })
  const m = await mount($)
  await m.press({ key: 'tab-rules' })
  expect(await m.find({ text: /1\. first_/ })).toBeDefined()
  expect(await m.find({ text: / as FIRST/ })).toBeDefined()
  await m.input({ key: 'add', text: 'acme_[a-z0-9]{8}', kind: 'submit' })
  expect(rulesOf(files)).toEqual([{ pattern: 'first_[0-9]+', replacement: 'FIRST', enabled: true }, { pattern: 'acme_[a-z0-9]{8}', replacement: 'SECRET', enabled: true }])
  expect(await m.find({ text: /added as #2/ })).toBeDefined()
  expect(await m.find({ text: /in \/h\/\.claude\/redact-rules\.json/ })).toBeDefined()
  await m.press({ key: 'remove-0' })
  expect(rulesOf(files)).toEqual([{ pattern: 'acme_[a-z0-9]{8}', replacement: 'SECRET', enabled: true }])
})

test('the pane lists what this session masked, the whole value on the terminal only, and forgets one', async ($, on) => {
  const { store } = world(on, HOLDS_GH)
  const ran: any[] = []
  on('tool.call', async (_$: any, e: any) => { ran.push(e); return { result: {} } as any })
  const m = await mount($)
  expect(await m.find({ text: /This session/ })).toBeDefined()
  expect(await m.find({ text: new RegExp(`${ph('API_KEY')} ${GH}`) })).toBeDefined()
  expect(await m.find({ text: /masked by not recorded/ })).toBeDefined()
  await m.press({ key: `forget-${ph('API_KEY')}` })
  expect((store.get('vault:s1') as any)).toMatchObject({ n: { API_KEY: 1 }, ph: {} })
  expect(await m.find({ text: /forgot .*refused/ })).toBeDefined()
  const r: any = await $.tool.call({ tool: 'Bash', command: `echo ${ph('API_KEY')}` })
  expect(r.deny).toContain(ph('API_KEY'))
  const remote = await mount($, 'mobile')
  expect(await remote.find({ text: /ghp_/ })).toBeUndefined()
})

test('the pane names the rule that masked each value; the model reads it masked back', async ($, on) => {
  const { store, entered } = world(on, {}, { [RULES]: file([...ON, { pattern: 'acme_[a-z0-9]{8}', replacement: 'SECRET' }]) })
  const session = mock.session(on)
  await entered($, `GITHUB_TOKEN=${GH} id ${ACME}`)
  expect((store.get('vault:s1') as any).by).toEqual({
    [ph('API_KEY')]: expect.stringMatching(/^rule: Example: vendor tokens/), [ph('SECRET')]: 'rule: acme_[a-z0-9]{8}' })
  const m = await mount($)
  expect(await m.find({ text: new RegExp(`${ph('SECRET')} ${ACME}`) })).toBeDefined()
  expect(await m.find({ text: /masked by rule: acme_/ })).toBeDefined()
  // the pane read back off the screen, as `tmux capture-pane` would return it
  await $.session.append({ door: 'tool-result', origin: { kind: 'tool', tool: 'Bash' }, uuid: 'u1',
    message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: `${ph('API_KEY')} ${GH}\n${ph('SECRET')} ${ACME}` }] } } as any)
  const [row] = session.appended() as any[]
  expect(JSON.stringify(row.message.content)).not.toMatch(/ghp_|acme_[a-z0-9]{8}/)
})

test('the pane toggles the terminal to draw placeholders, as the model reads them', async ($, on) => {
  world(on, HOLDS_GH)
  const statuses = statusLine(on)
  const drawn: string[] = []
  on('ui.render', { component: 'AssistantMessage' }, ($$: any, e: any) => {
    drawn.push(e.props.text)
    const { Text } = $$.ui.resolve(e)
    return h(Text, {}, e.props.text) as any
  })
  let n = 0
  const draw = () => $.ui.mount({ plugin: 'redact', surface: 'terminal', component: 'AssistantMessage', requestId: `m${++n}`, props: { text: `uses ${ph('API_KEY')}`, isFirstOfReply: true } as any })
  const m = await mount($)
  await m.press({ key: 'raw' })
  await draw()
  expect(statuses.at(-1)).toContain('drawn as the model reads it')
  await m.press({ key: 'raw' })
  await draw()
  // the toggle redraws what is mounted, so the first message is drawn again with its value
  expect([drawn[0], drawn.at(-1)]).toEqual([`uses ${ph('API_KEY')}`, `uses ${GH}`])
})

test('a long pattern on a narrow pane keeps its remove button in the tree', async ($, on) => {
  world(on, {}, { [RULES]: file([{ pattern: 'x'.repeat(60), replacement: 'SECRET' }]) })
  const m = await $.ui.mount({ plugin: 'redact', surface: 'terminal', component: 'Pane', requestId: 'redact', props: { ...PROPS, bodyColumns: 30 } })
  await m.press({ key: 'tab-rules' })
  expect(await m.find({ key: 'remove-0' })).toBeDefined()
})

test('/redact show clears the last note', async ($, on) => {
  world(on)
  on('ui.open', () => ({ value: { isPlaced: true } }) as any)
  const m = await mount($)
  await m.press({ key: 'tab-rules' })
  await m.input({ key: 'add', text: 'acme_[a-z0-9]{8}', kind: 'submit' })
  expect(await m.find({ text: /added as #3/ })).toBeDefined()
  await $.command.run({ command: 'redact', args: 'show' } as any)
  await m.unmount()
  expect(await (await mount($)).find({ text: /added as #/ })).toBeUndefined()
})

test('a settings pattern that does not compile is marked; mobile, with no field, points to /redact add', { options: { patterns: ['('] } }, async ($, on) => {
  world(on)
  const m = await mount($, 'mobile')
  expect(await m.find({ text: /skipped/ })).toBeDefined()
  await m.press({ key: 'tab-rules' })
  expect(await m.find({ key: 'add' })).toBeUndefined()
  expect(await m.find({ text: /\/redact add/ })).toBeDefined()
})

// the guard is off by default while redact is developed; these turn it on
test('the model cannot change what decides the masking: the store file, its settings entries', { options: { guard: true } }, async ($, on) => {
  const cfg = { model: 'opus', enabledPlugins: { 'redact@dboeter': true }, pluginConfigs: { 'redact@dboeter': { options: { patterns: ['x'] } } } }
  const text = JSON.stringify(cfg, null, 2)
  world(on, {}, { '/h/.claude/settings.json': text, '/h/dotfiles/claude/settings.json': text })
  on('tool.call', async () => ({ result: {} } as any))
  const denied = async (input: any) => typeof ((await $.tool.call(input)) as any).deny === 'string'
  const store = '/h/.claude/plugins/store/redact_dboeter-1.json'
  const settings = '/h/.claude/settings.json'
  expect(await denied({ tool: 'Write', file_path: store, content: '{}' })).toBe(true)
  expect(await denied({ tool: 'Bash', command: `sed -i d ${store}` })).toBe(true)
  expect(await denied({ tool: 'Bash', command: 'rm ~/.claude/plugins/store/*.json' })).toBe(true)
  expect(await denied({ tool: 'Bash', command: 'rm -rf ~/.claude/plugins/store' })).toBe(true)
  expect(await denied({ tool: 'Bash', command: 'cat ~/.claude/plugins/store/notepad_x-1.json' })).toBe(false)
  // the target of a ~/.claude/settings.json link, named as itself
  expect(await denied({ tool: 'Edit', file_path: '/h/dotfiles/claude/settings.json', old_string: 'true', new_string: 'false' })).toBe(true)
  expect(await denied({ tool: 'Bash', command: `sed -i s/true/false/ /h/dotfiles/claude/settings.json # redact` })).toBe(true)
  // the edit names neither redact nor the option, only the lines it changes
  expect(await denied({ tool: 'Edit', file_path: settings, old_string: '"x"', new_string: '"y"' })).toBe(true)
  expect(await denied({ tool: 'Edit', file_path: settings, old_string: '"opus"', new_string: '"sonnet"' })).toBe(false)
  expect(await denied({ tool: 'Write', file_path: settings, content: JSON.stringify({ model: 'opus' }) })).toBe(true)
  expect(await denied({ tool: 'Write', file_path: settings, content: '{ broken' })).toBe(true)
  expect(await denied({ tool: 'Bash', command: `jq 'del(.pluginConfigs["redact@dboeter"])' ${settings}` })).toBe(true)
  expect(await denied({ tool: 'Bash', command: 'grep -n settings.json plugins/redact/README.md' })).toBe(false)
})

test('without the guard option, a call on redact\'s own files runs', async ($, on) => {
  world(on, {}, { [RULES]: file([]) })
  on('tool.call', async () => ({ result: {} } as any))
  expect(((await $.tool.call({ tool: 'Read', file_path: RULES } as any)) as any).deny).toBeUndefined()
})

test('the model cannot read or change the rules file, however it names it; the folder stays listable', { options: { guard: true } }, async ($, on) => {
  world(on, {}, { [RULES]: file([]) }, { '/h/notes/p.json': RULES, '/h/claude-link': '/h/.claude' })
  on('tool.call', async () => ({ result: {} } as any))
  const denied = async (input: any) => typeof ((await $.tool.call(input)) as any).deny === 'string'
  expect(await denied({ tool: 'Read', file_path: RULES })).toBe(true)
  expect(await denied({ tool: 'Read', file_path: '/h/notes/p.json' })).toBe(true) // a link to it
  expect(await denied({ tool: 'Edit', file_path: '/H/.Claude/Redact-Rules.JSON', old_string: 'a', new_string: 'b' })).toBe(true)
  expect(await denied({ tool: 'Write', file_path: RULES, content: '' })).toBe(true)
  expect(await denied({ tool: 'Grep', pattern: 'acme', path: '/h/.claude' })).toBe(true)
  expect(await denied({ tool: 'Grep', pattern: 'acme', path: '/h/claude-link' })).toBe(true)
  expect(await denied({ tool: 'Grep', pattern: 'acme', path: '/h' })).toBe(true)
  expect(await denied({ tool: 'Grep', pattern: 'acme', path: '/h/.claude/projects' })).toBe(false)
  expect(await denied({ tool: 'Read', file_path: '/h/.claude/CLAUDE.md' })).toBe(false)
  expect(await denied({ tool: 'Write', file_path: '/h/repo/README.md', content: 'see ~/.claude/redact-rules.json' })).toBe(false)
  for (const command of ['cat ~/.claude/redact-rules.json', 'cat ~/.claude/*', 'cp ~/.claude/redact-* /tmp', 'grep -r acme ~/.claude', 'tar czf x.tgz ~/.claude/'])
    expect([command, await denied({ tool: 'Bash', command })]).toEqual([command, true])
  for (const command of ['ls ~/.claude', 'cat ~/.claude/CLAUDE.md', 'grep -r acme ~/.claude/projects', 'grep redact-rules README.md',
    'grep -rn claude .', 'rg claude src/', 'find ~/dotagents/claude -name x', 'cp ~/dotagents/claude/* /tmp'])
    expect([command, await denied({ tool: 'Bash', command })]).toEqual([command, false])
})

// Crafted shapes that took quadratic time before the repeats were bounded (seconds at these
// sizes, past the 10 s hook budget well before 1 MB). Sized so a regression fails here.
test('crafted output is masked in linear time', () => {
  const fill = (unit: string, n: number) => unit.repeat(Math.ceil(n / unit.length))
  for (const [s, what] of [
    [fill('to' + 'ken', 1e5), 'one long word, an address with no @'],
    [fill('-ey' + 'Jabc', 2e5), 'JWT-like starts'],
  ] as const) {
    const t = Date.now()
    m1(s)
    expect([what, Date.now() - t < 1000]).toEqual([what, true])
  }
})

test('the pane opens on This session, a long value cut to its ends until revealed, and forgets all at once', async ($, on) => {
  const KEY = 'PRIV' + 'ATE KEY-----'
  const pem = `-----BEGIN RSA ${KEY}\nMIIEowIBAAKCAQEA\nabc+/=`
  const { store } = world(on, { 'vault:s1': { at: 39 * DAY, n: { API_KEY: 1, PRIVATE_KEY: 1 }, ph: { [ph('API_KEY')]: GH, [ph('PRIVATE_KEY')]: pem } } })
  const m = await mount($)
  expect(await m.find({ text: /^This session$/ })).toBeDefined()
  expect(await m.find({ text: /^Rules$/ })).toBeUndefined()
  expect(await m.find({ text: /-----B…c\+\/= \(3 lines, \d+ chars\)/ })).toBeDefined()
  expect(await m.find({ text: /MIIEow/ })).toBeUndefined()
  await m.press({ key: `reveal-${ph('PRIVATE_KEY')}` })
  expect(await m.find({ text: /MIIEow/ })).toBeDefined()
  await m.press({ key: `reveal-${ph('PRIVATE_KEY')}` })
  expect(await m.find({ text: /MIIEow/ })).toBeUndefined()
  expect(await m.find({ key: `reveal-${ph('API_KEY')}` })).toBeUndefined()
  await m.press({ key: 'forget-all' })
  expect(store.get('vault:s1')).toMatchObject({ n: { API_KEY: 1, PRIVATE_KEY: 1 }, ph: {} })
  expect(await m.find({ text: /forgot 2/ })).toBeDefined()
})

test('tabs switch between This session, Rules and Guide, and test previews masking on submit or /redact test without saving', async ($, on) => {
  const { store } = world(on, {}, { [RULES]: file([...ON, { pattern: 'acme_[a-z0-9]{8}', replacement: 'SECRET' }]) })
  on('ui.open', () => ({ value: { isPlaced: true } }) as any)
  const toasts = toasted(on)
  await $.command.run({ command: 'redact', args: `test id ${ACME} ok` } as any)
  expect(toasts.at(-1)).toContain(`→ id ${ph('SECRET')} ok`)
  const m = await mount($)
  expect(await m.find({ text: /^Test$/ })).toBeDefined()
  expect(await m.find({ text: /^Rules$/ })).toBeDefined()
  expect(await m.find({ text: new RegExp(`→ id ${ph('SECRET')} ok`) })).toBeDefined()
  expect(await m.find({ text: /masked by rule: acme_/ })).toBeDefined()
  await m.press({ key: 'clear-test' })
  expect(await m.find({ text: new RegExp(`→ id ${ph('SECRET')} ok`) })).toBeUndefined()
  await m.input({ key: 'test', text: `key ${GH}`, kind: 'submit' })
  expect(await m.find({ text: new RegExp(`→ key ${ph('API_KEY')}`) })).toBeDefined()
  expect(store.get('vault:s1')).toBeUndefined()
  await m.press({ key: 'tab-help' })
  expect(await m.find({ text: /^Rule format$/ })).toBeDefined()
  expect(await m.find({ text: /^Where real values go$/ })).toBeDefined()
  await m.press({ key: 'tab-session' })
  expect(await m.find({ text: /^This session$/ })).toBeDefined()
})

test('desktop keeps the placeholders: the pane shows lengths and has no draw toggle', async ($, on) => {
  world(on, HOLDS_GH)
  const m = await mount($, 'desktop')
  expect(await m.find({ text: /ghp_/ })).toBeUndefined()
  expect(await m.find({ text: /40 chars/ })).toBeDefined()
  expect(await m.find({ key: 'raw' })).toBeUndefined()
  expect(await (await mount($)).find({ key: 'raw' })).toBeDefined()
})

test('/redact show opens the pane once, though command.run and prompt.submit both see it', async ($, on) => {
  world(on)
  const opened: any[] = []
  on('ui.open', (_$: any, e: any) => { opened.push(e); return { value: { isPlaced: true } } as any })
  await $.command.run({ command: 'redact', args: 'show' } as any)
  await $.prompt.submit({ text: '/redact show', command: { name: 'redact', args: 'show' }, origin: { kind: 'composer' } } as any)
  expect(opened).toHaveLength(1)
  await $.prompt.submit({ text: '/redact', command: { name: 'redact', args: '' }, origin: { kind: 'composer' } } as any)
  expect(opened).toHaveLength(2)
})

test('a /redact line keeps its arguments out of the rows the model reads', async ($, on) => {
  world(on)
  const session = mock.session(on)
  const line = '<command-name>/redact</command-name>\n<command-message>redact</command-message>\n<command-args></command-args>'
  await $.session.append({ door: 'command', origin: { kind: 'composer' }, uuid: 'u1',
    message: { type: 'user', role: 'user', content: [{ type: 'text', text: line }] } } as any)
  const [row] = session.appended() as any[]
  expect(row.message.content[0].text).toBe(line)
})

test('a short value with a line break shows its size alone, none of its characters', async ($, on) => {
  world(on, { 'vault:s1': { at: 39 * DAY, n: { SECRET: 1 }, ph: { [ph('SECRET')]: 'ab\ncd12' } } })
  const m = await mount($)
  expect(await m.find({ text: /\(2 lines, 7 chars\)/ })).toBeDefined()
  expect(await m.find({ text: /cd12/ })).toBeUndefined()
})

test('envValues reads KEY=value lines: export, quotes and comments', () => {
  expect(envValues([
    '# a comment', '', 'export A=one', 'B="two # kept"', "C='three'", 'D=four # gone', 'E=a#b', 'F=', 'G="open',
  ].join('\n'))).toEqual([
    { key: 'A', value: 'one' }, { key: 'B', value: 'two # kept' }, { key: 'C', value: 'three' },
    { key: 'D', value: 'four' }, { key: 'E', value: 'a#b' },
  ])
})

// fs.list over the world's files: the entries right under a folder
const listed = (on: any, files: Map<string, string>) =>
  on('fs.list', (_$: any, e: any) => ({ value: [...files.keys()].filter(p => p.startsWith(e.path + '/') && !p.slice(e.path.length + 1).includes('/'))
    .map(p => ({ name: p.slice(e.path.length + 1), kind: 'file', size: 0, mtimeMs: 0, isLink: false })) }))

test('a session starts with the secret-shaped values of the env files where it starts in the vault, masked with no rule on', async ($, on) => {
  const env = ['GITHUB_TOKEN=' + GH, 'PORT=3000', 'DEBUG=true', 'NODE_ENV=development', 'OTHER=${GITHUB_TOKEN}', 'DB_PASS' + `WORD="${ACME}"`].join('\n')
  const { store, files, entered } = world(on, {}, { '/p/.env': env, '/p/.env.example': `GITHUB_TOKEN=${ANT}`, '/p/sub/.env': `X=${ANT}` })
  listed(on, files)
  const toasts = toasted(on)
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  const vault = store.get('vault:s1') as any
  expect(vault.ph).toEqual({ [ph('GITHUB_TOKEN')]: GH, [ph('DB_PASS' + 'WORD')]: ACME })
  expect(vault.by[ph('GITHUB_TOKEN')]).toBe('.env: GITHUB_TOKEN')
  expect(toasts).toEqual(['redact: 2 values from the env files here masked (/redact show)'])
  expect(await entered($, `use ${GH} on port 3000, debug true`)).toBe(`use ${ph('GITHUB_TOKEN')} on port 3000, debug true`)
  // a second start (a --resume) keeps the placeholders and says nothing
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  expect((store.get('vault:s1') as any).ph).toEqual(vault.ph)
  expect(toasts.length).toBe(1)
})

test('composeEnvFiles reads env_file as a scalar, a flow list, a list and path entries', () => {
  expect(composeEnvFiles([
    'services:', '  web:', '    env_file: ./web.env', '  api:', '    env_file: ["a.env", b.env]',
    '  db:', '    env_file:', '      - ./db.env  # local', '      - path: "./opt.env"', '        required: false',
    '    image: postgres', '  cache:', '    env_file:', '    - cache.env', '    ports: ["6379"]',
  ].join('\n'))).toEqual(['./web.env', 'a.env', 'b.env', './db.env', './opt.env', 'cache.env'])
})

test('the equivalents seed too: .envrc, .dev.vars, *.env, a compose file\'s env_file; templates do not', async ($, on) => {
  const K = (n: number) => 'k3y' + 'Z'.repeat(6) + n
  const { store, files } = world(on, {}, {
    '/p/.envrc': `use flake\nexport A_KEY=${K(1)}\nexport B=$(pass show b-key)`,
    '/p/.dev.vars': `C_KEY=${K(2)}`,
    '/p/.flaskenv': `D_KEY=${K(3)}`,
    '/p/prod.env': `E_KEY=${K(4)}`,
    '/p/example.env': `X_KEY=${K(7)}`,
    '/p/compose.yaml': 'services:\n  web:\n    env_file:\n      - ./config/web.env\n      - config/web.env.example',
    '/p/config/web.env': `F_KEY=${K(5)}`,
    '/p/config/web.env.example': `Y_KEY=${K(8)}`,
  })
  listed(on, files)
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  const vault = store.get('vault:s1') as any
  expect(Object.values(vault.ph).sort()).toEqual([K(1), K(2), K(3), K(4), K(5)])
  expect(vault.by[ph('F_KEY')]).toBe('config/web.env: F_KEY')
})

test('envFiles: false in the rules file turns env seeding off; /redact env on turns it back on, the rules kept', async ($, on) => {
  const { store, files, entered } = world(on, {}, { [RULES]: JSON.stringify({ envFiles: false, rules: ON }), '/p/.env': `A_KEY=${ACME}` })
  listed(on, files)
  const toasts = toasted(on)
  on('session.cwd', () => ({ value: '/p' }))
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  expect(await entered($, `id ${ACME}`)).toBe(`id ${ACME}`)
  expect((store.get('vault:s1') as any)?.ph ?? {}).toEqual({})
  await $.command.run({ command: 'redact', args: 'env on' } as any)
  expect(toasts.at(-1)).toBe('redact: env files on: read from the next prompt on')
  expect(JSON.parse(files.get(RULES)!)).toEqual({ envFiles: true, rules: ON })
  expect(await entered($, `id ${ACME}`)).toBe(`id ${ph('A_KEY')}`)
  await $.command.run({ command: 'redact', args: 'env off' } as any)
  expect(JSON.parse(files.get(RULES)!).envFiles).toBe(false)
  // the pane's switch
  const m = await mount($)
  await m.press({ key: 'tab-rules' })
  expect(await m.find({ text: /Env files/ })).toBeDefined()
  await m.press({ key: 'env' })
  expect(JSON.parse(files.get(RULES)!).envFiles).toBe(true)
})

test('an env file changed during the session is read again before the next prompt; one unchanged is not', async ($, on) => {
  const { store, files, entered } = world(on, {}, { '/p/.env': `A_KEY=${ACME}` })
  listed(on, files)
  on('session.cwd', () => ({ value: '/p' }))
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  // same size and time: taken as unchanged, so not read
  files.set('/p/.env', `A_KEY=${'x'.repeat(ACME.length - 1)}1`)
  expect(await entered($, 'hi')).toBe('hi')
  expect(Object.keys((store.get('vault:s1') as any).ph)).toEqual([ph('A_KEY')])
  files.set('/p/.env', `A_KEY=${ACME}\nB_KEY=${GH}`)
  expect(await entered($, `use ${GH}`)).toBe(`use ${ph('B_KEY')}`)
})
