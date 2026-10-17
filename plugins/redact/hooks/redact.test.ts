import { test, expect, mock } from 'claude-code/testing'
import { fresh, labelOf, mask, restore } from './redact'

// Fixtures are split so no literal matches ~/dotagents/scripts/git-hooks/lib/secret-content.ere,
// which dotagents' pre-push gate runs over every added line (this file came from there), and
// so the live plugin leaves this file readable (and so editable): split inside the name or
// keyword, as in 'DB_PASS' + 'WORD=…', never at the separator. Code-shaped negatives need no split.
const GH = 'ghp_' + 'a'.repeat(36)
const ANT = 'sk-ant-' + 'api03-' + 'abcdefghijklmnopqrstuv'
const KEY = 'PRIV' + 'ATE KEY-----'
const PEM = '-----BEGIN OPENSSH ' + KEY + '\nb3BlbnNzaC1rZXk\n-----END OPENSSH ' + KEY
const ACME = 'acme' + '_k3y9x2q7'

// A placeholder, spelled with escapes so no file of this plugin holds one a restore would fill in.
const ph = (label: string, n = 1) => `⟦${label}_${n}⟧`
// masked with a vault of its own
const m1 = (s: string, extra?: Parameters<typeof mask>[2]) => mask(s, fresh(), extra)

test('a value becomes a placeholder named by its rule, the name stays', () => {
  expect(m1(`GITHUB_TOKEN=${GH}`)).toBe(`GITHUB_TOKEN=${ph('API_KEY')}`)
  expect(m1(`key ${ANT}`)).toBe(`key ${ph('API_KEY')}`)
  expect(m1(PEM)).toBe(ph('PRIVATE_KEY'))
  expect(m1('Authorization: Bea' + 'rer abc.def')).toBe('Authorization: Bearer ' + ph('TOKEN'))
  expect(m1('https://me:hunt' + 'er2@host/x')).toBe(`https://me:${ph('PASSWORD')}@host/x`)
  expect(m1('"api_' + 'key": "abc123"')).toBe(`"api_key": "${ph('SECRET')}"`)
  expect(m1('DB_PASS' + 'WORD=hunter2 ok')).toBe(`DB_PASSWORD=${ph('SECRET')} ok`)
  expect(m1('mysql --pass' + 'word hunter2')).toBe(`mysql --password ${ph('SECRET')}`)
  expect(m1('mail me.x+tag' + '@mail.example.co.uk.')).toBe(`mail ${ph('EMAIL')}.`)
})

test('an address that is a password or an assigned secret keeps that label', () => {
  expect(m1('https://me:hunt' + 'er2@example.com/x')).toBe(`https://me:${ph('PASSWORD')}@example.com/x`)
  expect(m1('"pass' + 'word": "me@example.com"')).toBe(`"password": "${ph('SECRET')}"`)
  expect(m1('git --tok' + 'en me@example.com')).toBe(`git --token ${ph('SECRET')}`)
})

test('a key cut short is masked through its body, and no further', () => {
  const head = '-----BEGIN RSA ' + KEY
  expect(m1(`${head}\nMIIEowIBAAKCAQEA\nabc+/=`)).toBe(ph('PRIVATE_KEY'))
  expect(m1(`${head}\nMIIEow\nsome prose`)).toBe(`${ph('PRIVATE_KEY')}\nsome prose`)
  expect(m1(`"k": "${head}\\nMIIEow\\nabc`)).toBe(`"k": "${ph('PRIVATE_KEY')}`)
  expect(m1(`${head} names the format`)).toBe(`${head} names the format`)
})

test('vendor token shapes are masked', () => {
  for (const t of [
    'sk_' + 'live_' + 'a'.repeat(24), 'gl' + 'pat-' + 'a'.repeat(20), 'hf' + '_' + 'a'.repeat(34),
    'np' + 'm_' + 'a'.repeat(36), 'dckr' + '_pat_' + 'a'.repeat(20), 'S' + 'G.' + 'a'.repeat(20) + '.' + 'b'.repeat(20),
    'ya' + '29.' + 'a'.repeat(20), 'AS' + 'IA' + 'A'.repeat(16),
  ]) expect(m1(`x ${t} y`)).toBe(`x ${ph('API_KEY')} y`)
})

test('a value is masked whole and nothing past it', () => {
  expect(m1('PASS' + 'WORD="two words" x')).toBe(`PASSWORD="${ph('SECRET')}" x`)
  expect(m1('mysql --pass' + 'word=hunter2')).toBe(`mysql --password=${ph('SECRET')}`)
  expect(m1('curl "h/?access_to' + 'ken=abc&next=1"')).toBe(`curl "h/?access_token=${ph('SECRET')}&next=1"`)
  expect(m1('fn(to' + 'ken=abc), next')).toBe(`fn(token=${ph('SECRET')}), next`)
  expect(m1('pass' + 'word: admin')).toBe(`password: ${ph('SECRET')}`)
  expect(m1('to' + 'ken = abc123')).toBe(`token = ${ph('SECRET')}`)
})

test('ordinary output and code that names a secret are left alone', () => {
  for (const s of [
    'max_tokens: 1000', 'use_token: true', 'git status: clean', 'total 42',
    'const token = await getToken();', '  password: string;', 'def f(password: str):',
    'tokens = text.split(" ")', "API_KEY = os.environ['API_KEY']", 'token = self.token',
    'f(token=token, x=1)', '  GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}', 'TOKEN="${GITHUB_TOKEN:-}"',
    'token = ""', 'Bearer $TOKEN', 'postgres://me:$PW@host',
    'git@github.com:dboeter/cc-plugins.git', 'npm i react@18.2.0 @types/node', 'ssh root@localhost',
    'daanb@desktop:~$', 'icon@2x.png', '@app.route("/")', 'a'.repeat(65) + '@example.com',
  ]) expect(m1(s)).toBe(s)
})

test('distinct values get distinct numbers, and a value keeps its placeholder', () => {
  const h = fresh()
  const a = 'to' + 'ken=abc', b = 'to' + 'ken=xyz'
  expect(mask(`${a} ${b} ${a}`, h)).toBe(`token=${ph('SECRET', 1)} token=${ph('SECRET', 2)} token=${ph('SECRET', 1)}`)
  expect(mask(`${GH} then ${b}`, h)).toBe(`${ph('API_KEY', 1)} then token=${ph('SECRET', 2)}`)
})

test('a value once matched is masked wherever it comes back, as a whole word', () => {
  const h = fresh()
  mask('DB_PASS' + 'WORD=hunter2', h)
  expect(mask('login hunter2 ok', h)).toBe(`login ${ph('SECRET')} ok`)
  expect(mask('hunter22 and xhunter2', h)).toBe('hunter22 and xhunter2')
})

test('masking twice is masking once', () => {
  const h = fresh()
  const s = `PASS${'WORD'}="two words" https://me:hunt${'er2'}@host --tok${'en'} abc "api_${'key'}": "q" ${GH} ${PEM}`
  const once = mask(s, h)
  const numbers = { ...h.v.n }
  expect(mask(once, h)).toBe(once)
  expect(h.v.n).toEqual(numbers)
})

test('restore puts every value back, and names the placeholders it does not hold', () => {
  const h = fresh()
  const s = `GITHUB_TOKEN=${GH}\n${PEM}\nDB_PASS${'WORD'}="a b" again ${GH}`
  const masked = mask(s, h)
  expect(masked).not.toContain('aaaa')
  expect(restore(masked, h)).toBe(s)
  const missing = new Set<string>()
  expect(restore(`x ${ph('API_KEY', 9)}`, h, missing)).toBe(`x ${ph('API_KEY', 9)}`)
  expect([...missing]).toEqual([ph('API_KEY', 9)])
})

test('a pattern of yours is labelled by its first named group, SECRET without one', () => {
  expect(labelOf('(?<acme_key>acme_[a-z0-9]{8})')).toBe('ACME_KEY')
  expect(labelOf('(?<=ACME=)\\S+')).toBe('SECRET')
  expect(labelOf('(?<_x>a)')).toBe('SECRET')
  expect(m1(`id ${ACME} ok`, [{ re: /(?<ACME>acme_[a-z0-9]{8})/g, label: 'ACME' }])).toBe(`id ${ph('ACME')} ok`)
})

test('a pattern that can match empty inserts no placeholders', () => {
  expect(m1('hello', [{ re: /x*/g, label: 'SECRET' }])).toBe('hello')
  expect(m1('a xx b', [{ re: /x*/g, label: 'SECRET' }])).toBe(`a ${ph('SECRET')} b`)
})

// The world beneath the plugin in a test: one session, a clock, a store whose contents a test
// reads, and the prompt as it entered (`entered()`). Registered before the test's first call on `$`.
const world = (on: any, entries: Record<string, unknown> = {}) => {
  const store = new Map(Object.entries(entries))
  let last = ''
  mock.clock(on, { now: 40 * DAY })
  on('session.id', () => ({ value: 's1' }))
  on('store.get', (_$: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_$: any, e: any) => { store.set(e.key, e.value); return { value: undefined } })
  on('store.delete', (_$: any, e: any) => { store.delete(e.key); return { value: undefined } })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('prompt.submit', (_$: any, e: any) => { last = e.text; return { text: e.text } })
  const entered = async ($: any, text: string) => { await $.prompt.submit({ text, origin: { kind: 'composer' } }); return last }
  return { store, entered }
}
const DAY = 24 * 3600 * 1000
const HOLDS_GH = { 'vault:s1': { at: 39 * DAY, n: { API_KEY: 1 }, ph: { [ph('API_KEY')]: GH } } }

test('a prompt is masked before it enters the session, its values kept in the vault', async ($, on) => {
  const { store, entered } = world(on)
  expect(await entered($, `deploy with GITHUB_TOKEN=${GH}`)).toBe(`deploy with GITHUB_TOKEN=${ph('API_KEY')}`)
  expect((store.get('vault:s1') as any).ph).toEqual({ [ph('API_KEY')]: GH })
})

test('every row the model reads is masked; an image stays, a response is left as made', async ($, on) => {
  world(on)
  const session = mock.session(on)
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }
  await $.session.append({ door: 'tool-result', origin: { kind: 'tool', tool: 'Bash' }, uuid: 'u1',
    message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: `GITHUB_TOKEN=${GH}` }, image] }] } } as any)
  await $.session.append({ door: 'response', origin: { kind: 'model', model: 'm' }, uuid: 'u2',
    message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'pass' + 'word: example' }] } } as any)
  const [row, reply] = session.appended() as any[]
  expect(row.message.content[0].content).toEqual([{ type: 'text', text: `GITHUB_TOKEN=${ph('API_KEY')}` }, image])
  expect(reply.message.content[0].text).toBe('pass' + 'word: example')
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
  world(on)
  on('prompt.context', () => ({ blocks: [{ name: 'claudeMd', text: `deploy key ${GH}` }, { name: 'userEmail', text: 'The address is me' + '@example.com.' }, { name: 'currentDate', text: '2026-10-17' }] }) as any)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' }, { id: 'env', text: 'DB_PASS' + 'WORD=hunter2', scope: 'session' }] }) as any)
  on('prompt.attachment', () => ({ text: 'the file says DB_PASS' + 'WORD=hunter2' }))
  on('tool.describe', (_$: any, e: any) => ({ description: e.description }))
  const ctx: any = await $.prompt.context({ blocks: [] } as any)
  expect(ctx.blocks.map((b: any) => b.text)).toEqual([`deploy key ${ph('API_KEY')}`, `The address is ${ph('EMAIL')}.`, '2026-10-17'])
  const sys: any = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] } as any)
  expect(sys.sections.map((s: any) => s.text)).toEqual(['You are Claude.', `DB_PASSWORD=${ph('SECRET')}`])
  expect(((await $.prompt.attachment({ type: 'file', text: 'x', origin: { kind: 'engine' } } as any)) as any).text).toBe(`the file says DB_PASSWORD=${ph('SECRET')}`)
  const described = async (tool: string) => ((await $.tool.describe({ tool, description: `call with --tok${'en'} abc123` } as any)) as any).description
  expect(await described('mcp__x__post')).toBe(`call with --token ${ph('SECRET', 2)}`)
  expect(await described('Bash')).toBe(`call with --token abc123`)
})

test("a command's arguments are masked before it runs, a skill's text before the model reads it; /redact's own are not", async ($, on) => {
  const { store } = world(on)
  const args: string[] = []
  on('command.run', (_$: any, e: any) => { args.push(e.args); return { text: 'ran' } })
  on('skill.prompt', () => ({ text: `use GITHUB_TOKEN=${GH}` }))
  await $.command.run({ command: 'deploy', args: '--tok' + 'en abc123' } as any)
  expect(args).toEqual([`--token ${ph('SECRET')}`])
  expect(((await $.skill.prompt({ skill: 'ship', text: 'x' } as any)) as any).text).toBe(`use GITHUB_TOKEN=${ph('API_KEY')}`)
  await $.command.run({ command: 'redact', args: 'add to' + 'ken=(?<ACME>\\w+)' } as any)
  expect(store.get('patterns')).toEqual(['to' + 'ken=(?<ACME>\\w+)'])
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

test('a placeholder the vault does not hold refuses the call', async ($, on) => {
  world(on, HOLDS_GH)
  let ran = false
  on('tool.call', async () => { ran = true; return { result: {} } as any })
  const r: any = await $.tool.call({ tool: 'Write', file_path: '/a', content: `k=${ph('API_KEY', 3)}` } as any)
  expect(r.deny).toContain(ph('API_KEY', 3))
  expect(ran).toBe(false)
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
  const { store } = world(on, { 'vault:old': { at: 1, n: {}, ph: {} }, 'vault:s1': { at: 39 * DAY, n: {}, ph: {} }, patterns: [] })
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect([...store.keys()]).toEqual(['vault:s1', 'patterns'])
})

test('a pattern from the options is masked too', { options: { patterns: ['acme_[a-z0-9]{8}'] } }, async ($, on) => {
  const { entered } = world(on)
  expect(await entered($, `id ${ACME} ok`)).toBe(`id ${ph('SECRET')} ok`)
})

test('a pattern that does not compile is skipped and toasted once, the rest stay on', { options: { patterns: ['(', '(?<ACME>acme_[a-z0-9]{8})'] } }, async ($, on) => {
  const { entered } = world(on)
  const toasts: string[] = []
  on('ui.toast', (_$: any, e: any) => { toasts.push(e.text); return { value: undefined } as any })
  on('tool.call', { tool: 'Bash' }, async () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  for (let i = 0; i < 2; i++) await $.tool.call({ tool: 'Bash', command: 'env' })
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toContain('skipped pattern #1')
  expect(await entered($, `id ${ACME} ok`)).toBe(`id ${ph('ACME')} ok`)
})

const PROPS = { title: 'Redact rules', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 } } as any
const mount = ($: any, surface = 'terminal') => $.ui.mount({ plugin: 'redact', surface, component: 'Pane', requestId: 'redact', props: PROPS })

test('/redact add keeps a pattern that masks from the next message on, /redact remove drops it', async ($, on) => {
  const { store, entered } = world(on)
  const opened: any[] = []
  on('ui.open', (_$: any, e: any) => { opened.push(e); return { value: { isPlaced: true } } as any })
  const run = async (args: string) => ((await $.command.run({ command: 'redact', args } as any)) as any).text
  expect(await run('add acme_[a-z0-9]{8}')).toContain('added as #1')
  expect(store.get('patterns')).toEqual(['acme_[a-z0-9]{8}'])
  expect(await entered($, `id ${ACME} ok`)).toBe(`id ${ph('SECRET')} ok`)
  expect(await run('add acme_[a-z0-9]{8}')).toContain('already there')
  expect(await run('add (')).toContain('not added')
  expect(await run('remove 2')).toBe('no such pattern')
  expect(await run('remove 1')).toBe('removed #1')
  expect(await run('show')).toBe('redact rules shown')
  expect(opened).toMatchObject([{ id: 'redact', focus: true }])
  expect(await run('list')).toContain('usage')
})

test('the pane lists every rule by its label, and adds and removes your own', async ($, on) => {
  const { store } = world(on, { patterns: ['(?<FIRST>first_[0-9]+)'] })
  const m = await mount($)
  expect(await m.find({ text: /TOKEN: the value after "Bearer"/ })).toBeDefined()
  expect(await m.find({ text: /1\. \(\?<FIRST>first_/ })).toBeDefined()
  expect(await m.find({ text: / as FIRST/ })).toBeDefined()
  await m.input({ key: 'add', text: 'acme_[a-z0-9]{8}', kind: 'submit' })
  expect(store.get('patterns')).toEqual(['(?<FIRST>first_[0-9]+)', 'acme_[a-z0-9]{8}'])
  expect(await m.find({ text: /added as #2/ })).toBeDefined()
  await m.press({ key: 'remove-0' })
  expect(store.get('patterns')).toEqual(['acme_[a-z0-9]{8}'])
})

test('a settings pattern that does not compile is marked; mobile, with no field, points to /redact add', { options: { patterns: ['('] } }, async ($, on) => {
  world(on)
  const m = await mount($, 'mobile')
  expect(await m.find({ text: /skipped/ })).toBeDefined()
  expect(await m.find({ key: 'add' })).toBeUndefined()
  expect(await m.find({ text: /\/redact add/ })).toBeDefined()
})

test('the model cannot change what decides the masking: the store file, its settings entries', async ($, on) => {
  world(on)
  const cfg = { model: 'opus', enabledPlugins: { 'redact@dboeter': true }, pluginConfigs: { 'redact@dboeter': { options: { patterns: ['x'] } } } }
  const text = JSON.stringify(cfg, null, 2)
  on('fs.read', (_$: any, e: any) => ({ value: e.path.endsWith('/settings.json') ? text : '' }) as any)
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

// Crafted shapes that took quadratic time before the repeats were bounded (seconds at these
// sizes, past the 10 s hook budget well before 1 MB). Sized so a regression fails here.
test('crafted output is masked in linear time', () => {
  const fill = (unit: string, n: number) => unit.repeat(Math.ceil(n / unit.length))
  for (const [s, what] of [
    [fill('to' + 'ken', 1e5), 'one word full of a secret name, or an address with no @'],
    [fill('-ey' + 'Jabc', 2e5), 'JWT-like starts'],
    [fill('-----BEGIN RSA ' + KEY + '\nabc\n', 1e6), 'unterminated BEGIN lines'],
  ] as const) {
    const t = Date.now()
    m1(s)
    expect([what, Date.now() - t < 1000]).toEqual([what, true])
  }
})
