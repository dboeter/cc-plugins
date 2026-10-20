import { test, expect, mock } from 'claude-code/testing'
import { BUILTIN, defaults, fresh, HEADER, mask, migrate, restore } from './redact'

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
// the same, escaped: restore writes it as the literal placeholder
const esc = (label: string, n = 1) => `⟦!${label}_${n}⟧`
// masked with a vault of its own
const m1 = (s: string, extra?: Parameters<typeof mask>[2]) => mask(s, fresh(), extra)

test('a value becomes a placeholder named by its rule, the name stays', () => {
  expect(m1(`GITHUB_TOKEN=${GH}`)).toBe(`GITHUB_TOKEN=${ph('API_KEY')}`)
  expect(m1(`key ${ANT}`)).toBe(`key ${ph('API_KEY')}`)
  expect(m1(PEM)).toBe(ph('PRIVATE_KEY'))
  expect(m1('Authorization: Bea' + 'rer abc123.def456')).toBe('Authorization: Bearer ' + ph('TOKEN'))
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
  expect(m1('curl "h/?access_to' + 'ken=ab12&next=1"')).toBe(`curl "h/?access_token=${ph('SECRET')}&next=1"`)
  expect(m1('fn(to' + 'ken=ab12), next')).toBe(`fn(token=${ph('SECRET')}), next`)
  expect(m1('pass' + 'word: admin1')).toBe(`password: ${ph('SECRET')}`)
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

test('a context rule leaves a value under 4 characters, and a name: followed by prose', () => {
  for (const s of [
    'TO' + 'KEN: a token-shaped value', 'PASS' + 'WORD: passwords in URLs', 'SEC' + 'RET: values after --password',
    'API_' + 'KEY: vendor tokens', 'to' + 'ken=x', 'https://me:p' + 'w1@host', 'mysql --pass' + 'word abc',
  ]) expect(m1(s)).toBe(s)
  expect(m1('pass' + 'word: hunt' + 'er2 # dev')).toBe(`password: ${ph('SECRET')} # dev`)
  expect(m1('DB_PASS' + 'WORD=letme1n now')).toBe(`DB_PASSWORD=${ph('SECRET')} now`)
  expect(m1('https://me:hunt' + 'er2@host')).toBe(`https://me:${ph('PASSWORD')}@host`)
})

test('distinct values get distinct numbers, and a value keeps its placeholder', () => {
  const h = fresh()
  const a = 'to' + 'ken=ab12', b = 'to' + 'ken=wx34'
  expect(mask(`${a} ${b} ${a}`, h)).toBe(`token=${ph('SECRET', 1)} token=${ph('SECRET', 2)} token=${ph('SECRET', 1)}`)
  expect(mask(`${GH} then ${b}`, h)).toBe(`${ph('API_KEY', 1)} then token=${ph('SECRET', 2)}`)
})

test('a value once matched is masked wherever it comes back, as a whole word, weak ones and misread words too', () => {
  const h = fresh()
  mask('DB_PASS' + 'WORD=hunter2isgood', h)
  expect(mask('login hunter2isgood ok', h)).toBe(`login ${ph('SECRET')} ok`)
  expect(mask('(hunter2isgood)', h)).toBe(`(${ph('SECRET')})`)
  expect(mask('hunter2isgoods and xhunter2isgood', h)).toBe('hunter2isgoods and xhunter2isgood')
  mask('API_TO' + 'KEN=hunter2', h)
  expect(mask('login hunter2 ok', h)).toBe(`login ${ph('SECRET', 2)} ok`)
  mask('to' + 'ken: Password', h)
  expect(mask('Password reset', h)).toBe(`${ph('SECRET', 3)} reset`)
})

test('a strong-only rule masks 8 or more characters of two kinds: letters, digits, symbols', () => {
  const h = fresh()
  expect(mask('Bea' + 'rer 12345678', h)).toBe('Bearer 12345678')
  expect(mask('Bea' + 'rer 1234-5678', h)).toBe(`Bearer ${ph('TOKEN')}`)
})

test('prose, types and markup that a rule could misread mask nothing', () => {
  const h = fresh()
  expect(mask('the bea' + 'rer of this letter', h)).toBe('the bearer of this letter')
  expect(mask('Bea' + 'rer abcdefghij', h)).toBe('Bearer abcdefghij')
  expect(mask('api_' + 'key: Promise<String>', h)).toBe('api_key: Promise<String>')
  expect(mask('**Pass' + 'word:**', h)).toBe('**Password:**')
  expect(mask('git://user:' + '...@host', h)).toBe('git://user:...@host')
  expect(h.byValue.size).toBe(0)
})

test("your patterns leave a placeholder whole, so restore gives the text back", () => {
  const h = fresh()
  const s = `key ${GH} and ABCDE 42`
  const masked = mask(s, h, [...defaults, { re: /[A-Z]{4,}/g, label: 'SECRET' }, { re: /\d+/g, label: 'SECRET' }])
  expect(masked).toBe(`key ${ph('API_KEY')} and ${ph('SECRET', 1)} ${ph('SECRET', 2)}`)
  expect(restore(masked, h)).toBe(s)
  const escaped = `doc ${esc('API_KEY', 42)}`
  expect(mask(escaped, h, [...defaults, { re: /[A-Z]{4,}/g, label: 'SECRET' }, { re: /\d+/g, label: 'SECRET' }])).toBe(escaped)
})

test('a placeholder the vault does not hold reads escaped, and restore writes the escape as the literal', () => {
  const h = fresh()
  expect(mask(`doc names ${ph('API_KEY', 7)}`, h)).toBe(`doc names ${esc('API_KEY', 7)}`)
  expect(mask(`doc names ${esc('API_KEY', 7)}`, h)).toBe(`doc names ${esc('API_KEY', 7)}`)
  const missing = new Set<string>()
  expect(restore(`doc names ${esc('API_KEY', 7)}`, h, missing)).toBe(`doc names ${ph('API_KEY', 7)}`)
  expect(missing.size).toBe(0)
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
  on('fs.stat', (_$: any, e: any) => ({ value: { kind: 'file', size: 0, mtimeMs: 0, isLink: e.path in links, realPath: links[e.path] ?? e.path } }))
  on('prompt.submit', (_$: any, e: any) => { last = e.text; return { text: e.text } })
  const entered = async ($: any, text: string) => { await $.prompt.submit({ text, origin: { kind: 'composer' } }); return last }
  return { store, files, entered }
}
const DAY = 24 * 3600 * 1000
// the patterns file, and the patterns of a file redact wrote, past the built-in rules it starts with
const PATTERNS = '/h/.claude/redact-patterns.txt'
const lines = (t: string) => t.split('\n').filter(l => l && !l.startsWith('#'))
const yours = (files: Map<string, string>) => lines(files.get(PATTERNS) ?? '')
// the built-in rules as the file of the last older version held them: each under its name and
// note, its options after ` #!`, then the line that said where yours go
const OLD_MARK = '# ---- built-in rules: edit or delete any; keep this line, or they are added back ----'
const legacy = (rules = BUILTIN) => '# redact patterns: what redact hides from the model, in every project.\n#\n' + OLD_MARK + '\n\n' + rules.map(r => {
  const [head, src] = [r.line.slice(0, r.line.indexOf(': ')), r.line.slice(r.line.indexOf(': ') + 2)]
  const [label, ...o] = head.split(' ')
  return `# ${r.name}\n#   ${r.note}\n${src}  #! ${['label=' + label, ...o.map(x => x === 'i' ? 'ignore-case' : x)].join(' ')}\n\n`
}).join('') + '# ---- your patterns: add them below ----\n\n'
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
  const { files } = world(on)
  const args: string[] = []
  on('command.run', (_$: any, e: any) => { args.push(e.args); return { text: 'ran' } })
  on('skill.prompt', () => ({ text: `use GITHUB_TOKEN=${GH}` }))
  await $.command.run({ command: 'deploy', args: '--tok' + 'en abc123' } as any)
  expect(args).toEqual([`--token ${ph('SECRET')}`])
  expect(((await $.skill.prompt({ skill: 'ship', text: 'x' } as any)) as any).text).toBe(`use GITHUB_TOKEN=${ph('API_KEY')}`)
  await $.command.run({ command: 'redact', args: 'add to' + 'ken=(?<ACME>\\w+)' } as any)
  expect(yours(files)).toEqual(['to' + 'ken=(?<ACME>\\w+)'])
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
  const toasts: string[] = []
  on('ui.toast', (_$: any, e: any) => { toasts.push(e.text); return { value: undefined } as any })
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
  const { store } = world(on, { 'vault:old': { at: 1, n: {}, ph: {} }, 'vault:s1': { at: 39 * DAY, n: {}, ph: {} }, patterns: [] })
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect([...store.keys()]).toEqual(['vault:s1', 'patterns'])
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

test('the status line counts what this session masked', async ($, on) => {
  const { entered } = world(on)
  const statuses = statusLine(on)
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await entered($, `GITHUB_TOKEN=${GH} and DB_PASS` + 'WORD=hunter2')
  await entered($, 'nothing here')
  expect(statuses).toEqual(['redact: 0 masked', 'redact: 2 masked'])
})

test('a masking failure that drops context, system prompt sections or a reminder is toasted', async ($, on) => {
  on('session.id', () => ({ value: 's1' }))
  on('store.get', () => { throw new Error('store down') })
  const toasts: string[] = []
  on('ui.toast', (_$: any, e: any) => { toasts.push(e.text); return { value: undefined } as any })
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

test('/redact add keeps a pattern that masks from the next message on, /redact remove drops it', async ($, on) => {
  const { files, entered } = world(on)
  const opened: any[] = []
  on('ui.open', (_$: any, e: any) => { opened.push(e); return { value: { isPlaced: true } } as any })
  const toasts: string[] = []
  on('ui.toast', (_$: any, e: any) => { toasts.push(e.text); return { value: undefined } as any })
  // the reply is a toast; the command prints nothing the model could read
  const run = async (args: string) => {
    const n = toasts.length
    expect(((await $.command.run({ command: 'redact', args } as any)) as any).text).toBeUndefined()
    return toasts.length > n ? toasts.at(-1)!.replace(/^redact: /, '') : undefined
  }
  expect(await run('add ACME: acme_[a-z0-9]{8}')).toContain('added as #1')
  expect(await run('add x_[0-9]+')).toBe('added as #2: it masks from the next message on')
  expect(yours(files)).toEqual(['ACME: acme_[a-z0-9]{8}', 'x_[0-9]+'])
  expect(files.get(PATTERNS)).toStartWith(HEADER)
  expect(await entered($, `id ${ACME} ok`)).toBe(`id ${ph('ACME')} ok`)
  expect(await run('add ACME: acme_[a-z0-9]{8}')).toContain('already there')
  expect(await run('add (')).toContain('not added')
  expect(await run('add X bogus: x')).toBe('not added: unknown option bogus')
  expect(await run('add x  #! i')).toContain('not added: options go before the regex')
  expect(await run('remove 3')).toBe('no such pattern')
  expect(await run('remove 1')).toBe('removed #1')
  expect(await run('remove x_[0-9]+')).toBe('removed #1')
  expect(await run('remove x_[0-9]+')).toBe('no such pattern')
  expect(await run('show')).toBeUndefined()
  expect(opened).toMatchObject([{ id: 'redact', focus: true }])
  expect(await run('list')).toContain('usage')
})

test('a /redact line keeps its arguments out of the rows the model reads', async ($, on) => {
  world(on)
  const session = mock.session(on)
  const line = '<command-name>/redact</command-name>\n<command-message>redact</command-message>\n<command-args>add acme_[0-9]+</command-args>'
  await $.session.append({ door: 'command', origin: { kind: 'composer' }, uuid: 'u1',
    message: { type: 'user', role: 'user', content: [{ type: 'text', text: line }] } } as any)
  const [row] = session.appended() as any[]
  expect(row.message.content[0].text).toBe('<command-name>/redact</command-name>\n<command-message>redact</command-message>\n<command-args></command-args>')
})

test('a new patterns file holds the header alone; the pane lists the built-in rules, on', async ($, on) => {
  const { files } = world(on)
  const m = await mount($)
  await m.press({ key: 'tab-patterns' })
  expect(files.get(PATTERNS)).toBe(HEADER)
  expect(await m.find({ text: /^  Private key blocks/ })).toBeDefined()
  expect(await m.find({ text: /^  A token after "Bearer"$/ })).toBeDefined()
  expect(await m.find({ text: / bearer · as TOKEN/ })).toBeDefined()
  expect(await m.find({ text: /7 of 7 on/ })).toBeDefined()
  expect(await m.find({ text: /none yet/ })).toBeDefined()
})

test('a built-in rule turns off and on, from the pane, the prompt or the file', async ($, on) => {
  const { files, entered } = world(on)
  const toasts: string[] = []
  on('ui.toast', (_$: any, e: any) => { toasts.push(e.text); return { value: undefined } as any })
  const mail = 'ann' + '@example.com'
  expect(await entered($, `mail ${mail}`)).toBe(`mail ${ph('EMAIL')}`)
  await $.command.run({ command: 'redact', args: 'off email' } as any)
  expect(toasts.at(-1)).toBe('redact: email off: from the next message on')
  expect(files.get(PATTERNS)).toBe(HEADER + 'off email\n')
  const other = 'bob' + '@example.com'
  expect(await entered($, `mail ${other}`)).toBe(`mail ${other}`)
  await $.command.run({ command: 'redact', args: 'off email' } as any)
  expect(toasts.at(-1)).toBe('redact: already off: email')
  await $.command.run({ command: 'redact', args: 'off nope' } as any)
  expect(toasts.at(-1)).toContain('no such rule: nope')
  const m = await mount($)
  await m.press({ key: 'tab-patterns' })
  expect(await m.find({ text: /6 of 7 on/ })).toBeDefined()
  await m.press({ key: 'turn-email' })
  expect(files.get(PATTERNS)).toBe(HEADER)
  expect(await entered($, `mail ${other}`)).toBe(`mail ${ph('EMAIL', 2)}`)
  // an off line naming no rule is marked, and turns nothing off
  files.set(PATTERNS, HEADER + 'off emails\n')
  await m.unmount()
  expect(await (await mount($)).find({ text: /skipped: no built-in rule emails/ })).toBeDefined()
})
test('a file of the last format drops its unchanged rules, turns a deleted or edited one off, and moves options before the regex', async ($, on) => {
  const kept = BUILTIN.filter(r => r.id !== 'email' && r.id !== 'bearer')
  const edited = legacy(kept).replace('label=API_KEY', 'label=KEY')
  const { files, entered } = world(on, {}, { [PATTERNS]: edited + '# mine\n(?<pre>id=)(?<v>\\w+)  #! label=ID min=4 ignore-case\n(?<acme>acme_[a-z0-9]{8})\n' })
  const mail = 'ann' + '@example.com'
  expect(await entered($, `id=Ab12 ${ACME} ${mail} ${GH}`)).toBe(`id=${ph('ID')} ${ph('ACME')} ${mail} ${ph('KEY')}`)
  const vendor = BUILTIN.find(r => r.id === 'vendor-token')!
  expect(files.get(PATTERNS)).toBe(HEADER + 'off vendor-token\noff bearer\noff email\n\n'
    + `# ${vendor.name}\n#   ${vendor.note}\n${vendor.line.replace('API_KEY', 'KEY')}\n\n`
    + '# mine\nID min=4 i: (?<pre>id=)(?<v>\\w+)\nACME: (?<acme>acme_[a-z0-9]{8})\n')
  // the file of this repo's user: every rule unchanged, nothing of their own
  expect(migrate(legacy())).toBe(HEADER)
  expect(migrate(HEADER + 'x\n')).toBeUndefined()
  // no header, options in the old place: moved, every rule left on
  expect(migrate('acme_[a-z]+  #! label=ACME ignore-case\n')).toBe(HEADER + 'ACME i: acme_[a-z]+\n')
})
test('a file from before the rules moved keeps its patterns and every rule on', async ($, on) => {
  const old = '# redact: your patterns, one JavaScript regex a line, masked on top of the built-in rules,\n#\n#\n#\n#\n#\n'
  const { files, entered } = world(on, {}, { [PATTERNS]: old + 'acme_[a-z0-9]{8}\n' })
  expect(await entered($, `GITHUB_TOKEN=${GH} id ${ACME}`)).toBe(`GITHUB_TOKEN=${ph('API_KEY')} id ${ph('SECRET')}`)
  expect(files.get(PATTERNS)).toBe(HEADER + 'SECRET: acme_[a-z0-9]{8}\n')
})
test('a pattern masks its v group under its label, with its options; an unknown option is skipped', async ($, on) => {
  const { entered } = world(on, {}, { [PATTERNS]: HEADER + 'ID min=4: (?<pre>id=)(?<v>\\w+)\nZZ bogus: zz_[0-9]+\n' })
  expect(await entered($, 'id=Ab12 id=Ab1 id=abcd zz_12')).toBe(`id=${ph('ID')} id=Ab1 id=abcd zz_12`)
  const m = await mount($)
  expect(await m.find({ text: /1 skipped/ })).toBeDefined()
  await m.press({ key: 'tab-patterns' })
  expect(await m.find({ text: /skipped: unknown option bogus/ })).toBeDefined()
})
test('the pane lists every pattern by its label, and adds and removes your own', async ($, on) => {
  const { files } = world(on, {}, { [PATTERNS]: HEADER + 'FIRST: first_[0-9]+\n' })
  const m = await mount($)
  await m.press({ key: 'tab-patterns' })
  expect(await m.find({ text: /1\. FIRST: first_/ })).toBeDefined()
  expect(await m.find({ text: / as FIRST/ })).toBeDefined()
  await m.input({ key: 'add', text: 'acme_[a-z0-9]{8}', kind: 'submit' })
  expect(files.get(PATTERNS)).toBe(HEADER + 'FIRST: first_[0-9]+\nacme_[a-z0-9]{8}\n')
  expect(await m.find({ text: /added as #2/ })).toBeDefined()
  expect(await m.find({ text: /in \/h\/\.claude\/redact-patterns\.txt/ })).toBeDefined()
  await m.press({ key: 'remove-0' })
  expect(files.get(PATTERNS)).toBe(HEADER + 'acme_[a-z0-9]{8}\n')
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

test('the pane names the rule or pattern that masked each value; the model reads it masked back', async ($, on) => {
  const { store, entered } = world(on, {}, { [PATTERNS]: HEADER + 'acme_[a-z0-9]{8}\n' })
  const session = mock.session(on)
  await entered($, `GITHUB_TOKEN=${GH} id ${ACME}`)
  expect((store.get('vault:s1') as any).by).toEqual({
    [ph('API_KEY')]: expect.stringMatching(/^built-in rule: Vendor tokens/), [ph('SECRET')]: 'your pattern: acme_[a-z0-9]{8}' })
  const m = await mount($)
  expect(await m.find({ text: new RegExp(`${ph('SECRET')} ${ACME}`) })).toBeDefined()
  expect(await m.find({ text: /masked by your pattern: acme_/ })).toBeDefined()
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
  world(on, {}, { [PATTERNS]: 'x'.repeat(60) })
  const m = await $.ui.mount({ plugin: 'redact', surface: 'terminal', component: 'Pane', requestId: 'redact', props: { ...PROPS, bodyColumns: 30 } })
  await m.press({ key: 'tab-patterns' })
  expect(await m.find({ key: 'remove-0' })).toBeDefined()
})

test('/redact show clears the last note', async ($, on) => {
  world(on)
  on('ui.open', () => ({ value: { isPlaced: true } }) as any)
  const m = await mount($)
  await m.press({ key: 'tab-patterns' })
  await m.input({ key: 'add', text: 'acme_[a-z0-9]{8}', kind: 'submit' })
  expect(await m.find({ text: /added as #1/ })).toBeDefined()
  await $.command.run({ command: 'redact', args: 'show' } as any)
  await m.unmount()
  expect(await (await mount($)).find({ text: /added as #/ })).toBeUndefined()
})

test('a settings pattern that does not compile is marked; mobile, with no field, points to /redact add', { options: { patterns: ['('] } }, async ($, on) => {
  world(on)
  const m = await mount($, 'mobile')
  expect(await m.find({ text: /skipped/ })).toBeDefined()
  await m.press({ key: 'tab-patterns' })
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
  world(on, {}, { [PATTERNS]: 'acme_[a-z0-9]{8}\n' })
  on('tool.call', async () => ({ result: {} } as any))
  expect(((await $.tool.call({ tool: 'Read', file_path: PATTERNS } as any)) as any).deny).toBeUndefined()
})

test('the model cannot read or change the patterns file, however it names it; the folder stays listable', { options: { guard: true } }, async ($, on) => {
  world(on, {}, { [PATTERNS]: 'acme_[a-z0-9]{8}\n' }, { '/h/notes/p.txt': PATTERNS, '/h/claude-link': '/h/.claude' })
  on('tool.call', async () => ({ result: {} } as any))
  const denied = async (input: any) => typeof ((await $.tool.call(input)) as any).deny === 'string'
  expect(await denied({ tool: 'Read', file_path: PATTERNS })).toBe(true)
  expect(await denied({ tool: 'Read', file_path: '/h/notes/p.txt' })).toBe(true) // a link to it
  expect(await denied({ tool: 'Edit', file_path: '/H/.Claude/Redact-Patterns.TXT', old_string: 'a', new_string: 'b' })).toBe(true)
  expect(await denied({ tool: 'Write', file_path: PATTERNS, content: '' })).toBe(true)
  expect(await denied({ tool: 'Grep', pattern: 'acme', path: '/h/.claude' })).toBe(true)
  expect(await denied({ tool: 'Grep', pattern: 'acme', path: '/h/claude-link' })).toBe(true)
  expect(await denied({ tool: 'Grep', pattern: 'acme', path: '/h' })).toBe(true)
  expect(await denied({ tool: 'Grep', pattern: 'acme', path: '/h/.claude/projects' })).toBe(false)
  expect(await denied({ tool: 'Read', file_path: '/h/.claude/CLAUDE.md' })).toBe(false)
  expect(await denied({ tool: 'Write', file_path: '/h/repo/README.md', content: 'see ~/.claude/redact-patterns.txt' })).toBe(false)
  for (const command of ['cat ~/.claude/redact-patterns.txt', 'cat ~/.claude/*', 'cp ~/.claude/redact-* /tmp', 'grep -r acme ~/.claude', 'tar czf x.tgz ~/.claude/'])
    expect([command, await denied({ tool: 'Bash', command })]).toEqual([command, true])
  for (const command of ['ls ~/.claude', 'cat ~/.claude/CLAUDE.md', 'grep -r acme ~/.claude/projects', 'grep redact-patterns README.md',
    'grep -rn claude .', 'rg claude src/', 'find ~/dotagents/claude -name x', 'cp ~/dotagents/claude/* /tmp'])
    expect([command, await denied({ tool: 'Bash', command })]).toEqual([command, false])
})

test('the patterns file is read by hand-written lines: comments, blanks and spaces are skipped', async ($, on) => {
  const { files, entered } = world(on, {}, { [PATTERNS]: HEADER + '# mine\n\n  acme_[a-z0-9]{8}  \r\n# x_[0-9]+\nTAG: #tag[0-9]+\n' })
  expect(await entered($, `id ${ACME} x_12 #tag42`)).toBe(`id ${ph('SECRET')} x_12 ${ph('TAG')}`)
  // added by hand in another editor: the next masking reads it
  files.set(PATTERNS, files.get(PATTERNS) + 'x_[0-9]+\n')
  expect(await entered($, 'x_12')).toBe(ph('SECRET', 2))
  // /redact keeps the comments; a pattern typed with a leading # is written with a label
  await $.command.run({ command: 'redact', args: 'add #id[0-9]+' } as any)
  await $.command.run({ command: 'redact', args: 'remove 1' } as any)
  expect(files.get(PATTERNS)).toBe(HEADER + '# mine\n\n# x_[0-9]+\nTAG: #tag[0-9]+\nx_[0-9]+\nSECRET: #id[0-9]+\n')
  await $.command.run({ command: 'redact', args: 'remove #id[0-9]+' } as any)
  expect(files.get(PATTERNS)).toBe(HEADER + '# mine\n\n# x_[0-9]+\nTAG: #tag[0-9]+\nx_[0-9]+\n')
})
test('patterns an older version kept in the store move into the file once', async ($, on) => {
  const { store, files, entered } = world(on, { patterns: ['acme_[a-z0-9]{8}'] })
  expect(await entered($, `id ${ACME}`)).toBe(`id ${ph('SECRET')}`)
  expect(store.has('patterns')).toBe(false)
  expect(files.get(PATTERNS)).toBe(HEADER + 'SECRET: acme_[a-z0-9]{8}\n')
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

test('a context rule leaves a value of lowercase letters alone, a word a doc puts there', () => {
  for (const s of ['pass' + 'word=letmein', 'to' + 'ken: value', '--pass' + 'word pattern', 'https://me:hunt' + 'er@host'])
    expect(m1(s)).toBe(s)
  expect(m1('pass' + 'word=letme1n')).toBe(`password=${ph('SECRET')}`)
  expect(m1('pass' + 'word=Letmein')).toBe(`password=${ph('SECRET')}`)
})

test('the pane opens on This session, a long value cut to its ends until revealed, and forgets all at once', async ($, on) => {
  const head = '-----BEGIN RSA ' + KEY
  const pem = `${head}\nMIIEowIBAAKCAQEA\nabc+/=`
  const { store } = world(on, { 'vault:s1': { at: 39 * DAY, n: { API_KEY: 1, PRIVATE_KEY: 1 }, ph: { [ph('API_KEY')]: GH, [ph('PRIVATE_KEY')]: pem } } })
  const m = await mount($)
  expect(await m.find({ text: /^This session$/ })).toBeDefined()
  expect(await m.find({ text: /^Yours$/ })).toBeUndefined()
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

test('tabs switch between This session, Patterns and Guide, and test previews masking on submit or /redact test without saving', async ($, on) => {
  const { store } = world(on, {}, { [PATTERNS]: HEADER + 'acme_[a-z0-9]{8}\n' })
  on('ui.open', () => ({ value: { isPlaced: true } }) as any)
  const toasts: string[] = []
  on('ui.toast', (_$: any, e: any) => { toasts.push(e.text); return { value: undefined } as any })
  await $.command.run({ command: 'redact', args: `test id ${ACME} ok` } as any)
  expect(toasts.at(-1)).toContain(`→ id ${ph('SECRET')} ok`)
  const m = await mount($)
  expect(await m.find({ text: /^Test$/ })).toBeDefined()
  expect(await m.find({ text: /^Yours$/ })).toBeDefined()
  expect(await m.find({ text: new RegExp(`→ id ${ph('SECRET')} ok`) })).toBeDefined()
  expect(await m.find({ text: /masked by your pattern: acme_/ })).toBeDefined()
  await m.press({ key: 'clear-test' })
  expect(await m.find({ text: new RegExp(`→ id ${ph('SECRET')} ok`) })).toBeUndefined()
  await m.input({ key: 'test', text: `key ${GH}`, kind: 'submit' })
  expect(await m.find({ text: new RegExp(`→ key ${ph('API_KEY')}`) })).toBeDefined()
  expect(store.get('vault:s1')).toBeUndefined()
  await m.press({ key: 'tab-help' })
  expect(await m.find({ text: /^Pattern format$/ })).toBeDefined()
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

test('a short value with a line break shows its size alone, none of its characters', async ($, on) => {
  world(on, { 'vault:s1': { at: 39 * DAY, n: { SECRET: 1 }, ph: { [ph('SECRET')]: 'ab\ncd12' } } })
  const m = await mount($)
  expect(await m.find({ text: /\(2 lines, 7 chars\)/ })).toBeDefined()
  expect(await m.find({ text: /cd12/ })).toBeUndefined()
})
