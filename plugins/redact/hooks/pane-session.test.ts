import { test, expect, mock } from 'claude-code/testing'

// The pane's This session tab: one line per vault entry, a hint line, and its empty states.
// Helpers copied from redact.test.ts; fixtures split as there, so no literal is secret-shaped.
const GH = 'ghp_' + 'a'.repeat(36)
const ph = (label: string, n = 1) => `⟦${label}_${n}⟧`

const world = (on: any, entries: Record<string, unknown> = {}, given: Record<string, string> = {}) => {
  const store = new Map(Object.entries(entries))
  const files = new Map(Object.entries(given))
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
  on('fs.stat', (_$: any, e: any) => ({ value: { kind: 'file', size: files.get(e.path)?.length ?? 0, mtimeMs: 0, isLink: false, realPath: e.path } }))
  return { store, files }
}
const DAY = 24 * 3600 * 1000
const RULES = '/h/.claude/redact-rules.json'
const rulesFile = (rules: unknown[], extra: object = {}) => JSON.stringify({ rules, ...extra }, null, 2) + '\n'
const PROPS = { title: 'redact', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 } } as any
const mount = ($: any, bodyColumns = 80) => $.ui.mount({ plugin: 'redact', surface: 'terminal', component: 'Pane', requestId: 'redact', props: { ...PROPS, bodyColumns } })

// an element's own children, from a find (top level) or nested in a tree (in props)
const kids = (el: any): unknown[] => el?.children ?? el?.props?.children ?? []
const strings = (el: any): string[] => kids(el).flatMap(c => typeof c === 'string' ? [c] : c && typeof c === 'object' ? strings(c) : [])
const keys = (el: any): string[] => kids(el).flatMap(c => c && typeof c === 'object' ? [(c as any).props?.key, ...keys(c)].filter(Boolean) : [])

const TWO = { 'vault:s1': { at: 39 * DAY, n: { API_KEY: 1, SECRET: 1 }, ph: { [ph('API_KEY')]: GH, [ph('SECRET')]: 'hunter2isgood' }, by: { [ph('SECRET')]: 'rule: pass' } } }

test('each vault entry is one line: placeholder → value, then its source, then ✗', async ($, on) => {
  world(on, TWO)
  const m = await mount($)
  const row = await m.find({ key: ph('SECRET') })
  expect(row?.props.flexDirection).not.toBe('column')
  const parts = kids(row) as any[]
  const at = (s: string) => parts.findIndex(c => strings(c).join('').includes(s) || keys(c).includes(s))
  expect(strings(parts[0]).join('')).toBe(`  ${ph('SECRET')}  →  hunter2isgood`)
  expect(at('rule: pass')).toBeGreaterThan(0)
  expect(at(`forget-${ph('SECRET')}`)).toBeGreaterThan(at('rule: pass'))
  expect(await m.find({ text: /masked by/ })).toBeUndefined()
})

test('on a narrow pane the value truncates; the source, cut to a third of the pane, and ✗ do not shrink', async ($, on) => {
  const KEY = 'PRIV' + 'ATE KEY-----'
  world(on, { 'vault:s1': { at: 39 * DAY, n: { PRIVATE_KEY: 1 }, ph: { [ph('PRIVATE_KEY')]: `-----BEGIN RSA ${KEY}\nMIIEowIBAAKCAQEA\nabc+/=` }, by: { [ph('PRIVATE_KEY')]: 'env file: .env' } } })
  const m = await mount($, 30)
  const [value, ...rest] = kids(await m.find({ key: ph('PRIVATE_KEY') })) as any[]
  expect(value.props.flexShrink).toBe(1)
  expect(kids(value)[0]).toMatchObject({ type: 'Text', props: { wrap: 'truncate-end' } })
  // the reveal, the source and the forget, each on the value's line and never shrunk
  expect(rest.map(c => [keys(c)[0] ?? strings(c).join(''), c.props.flexShrink])).toEqual([
    [`reveal-${ph('PRIVATE_KEY')}`, 0], ['env file:…', 0], [`forget-${ph('PRIVATE_KEY')}`, 0]])
})

test('a multi-line value stays on its line, cut or revealed, with its source and ✗', async ($, on) => {
  const KEY = 'PRIV' + 'ATE KEY-----'
  world(on, { 'vault:s1': { at: 39 * DAY, n: { PRIVATE_KEY: 1 }, ph: { [ph('PRIVATE_KEY')]: `-----BEGIN RSA ${KEY}\r\nMIIEowIBAAKCAQEA\nabc+/=` }, by: { [ph('PRIVATE_KEY')]: 'env file: .env' } } })
  const m = await mount($)
  const row = async () => {
    const parts = kids(await m.find({ key: ph('PRIVATE_KEY') })) as any[]
    return { value: strings(parts[0]).join(''), rest: parts.slice(1).map(c => keys(c)[0] ?? strings(c).join('')) }
  }
  const cut = await row()
  expect(cut.value).not.toMatch(/[\r\n]/)
  expect(cut.rest).toEqual([`reveal-${ph('PRIVATE_KEY')}`, 'env file: .env', `forget-${ph('PRIVATE_KEY')}`])
  await m.press({ key: `reveal-${ph('PRIVATE_KEY')}` })
  const open = await row()
  expect(open.value).toBe(`  ${ph('PRIVATE_KEY')}  →  -----BEGIN RSA ${KEY}⏎MIIEowIBAAKCAQEA⏎abc+/=`)
  expect(open.rest).toEqual(cut.rest)
})

test('no section header: the tab carries the count, ✗ all sits on the hint line', async ($, on) => {
  world(on, TWO)
  const m = await mount($)
  expect(await m.findAll({ type: 'Text', text: /This session|\d+ masked/ })).toEqual([])
  expect((await m.find({ key: 'tab-session' }))?.props.label).toContain('(2)')
  // the Box whose own Text is the hint
  const hint = (await m.findAll({ type: 'Box' })).find((b: any) => kids(b).some((c: any) => c?.type === 'Text' && strings(c).join('') === '  ✗ forgets a value'))
  expect(keys(hint)).toEqual(['forget-all'])
  expect(await m.find({ text: /forget drops one/ })).toBeUndefined()
})

test('a value with no recorded rule reads rule unknown', async ($, on) => {
  world(on, TWO)
  const m = await mount($)
  expect(strings(await m.find({ key: ph('API_KEY') })).join('')).toContain('rule unknown')
  expect(await m.find({ text: /not recorded/ })).toBeUndefined()
})

test('empty, with no file rule, no settings pattern and env files off: no rule is on', async ($, on) => {
  world(on, {}, { [RULES]: rulesFile([], { envFiles: false }) })
  expect(await (await mount($)).find({ text: /nothing masked: no rule is on \(r\)/ })).toBeDefined()
})

// empty with one thing that masks: nothing masked yet
const yet = async ($: any) => {
  const m = await mount($)
  return [!!(await m.find({ text: /nothing masked yet/ })), !!(await m.find({ text: /no rule is on/ }))]
}

test('empty, with a settings pattern: nothing masked yet', { options: { patterns: ['zz_[0-9]+'] } }, async ($, on) => {
  world(on, {}, { [RULES]: rulesFile([], { envFiles: false }) })
  expect(await yet($)).toEqual([true, false])
})

test('empty, with a file rule on: nothing masked yet', async ($, on) => {
  world(on, {}, { [RULES]: rulesFile([{ pattern: 'acme_[a-z0-9]{8}', replacement: 'SECRET', enabled: true }], { envFiles: false }) })
  expect(await yet($)).toEqual([true, false])
})

test('empty, with env files on: nothing masked yet', async ($, on) => {
  world(on, {}, { [RULES]: rulesFile([]) })
  expect(await yet($)).toEqual([true, false])
})

test('a source with a line break draws on its row as ⏎', async ($, on) => {
  world(on, { 'vault:s1': { at: 39 * DAY, n: { SECRET: 1 }, ph: { [ph('SECRET')]: 'hunter2isgood' }, by: { [ph('SECRET')]: 'rule: first\nsecond' } } })
  const parts = kids(await (await mount($)).find({ key: ph('SECRET') })) as any[]
  expect(parts.map(c => keys(c)[0] ?? strings(c).join('')).slice(1)).toEqual(['rule: first⏎second', `forget-${ph('SECRET')}`])
})

// the first example rule's source, unnamed in a file of an older shape: wider than an 80-column pane
const WIDE = 'rule: Example: vendor tokens (sk-, gh*_, github_pat_, AKIA, ASIA, xox*-, AIza, sk_live_, glpat-, npm_, dckr_pat_, SG., hf_, ya29.) and JWTs'
for (const cols of [80, 30])
  test(`a source wider than the pane is cut to a third of it (${cols} columns), so ✗ stays on the row`, async ($, on) => {
    world(on, { 'vault:s1': { at: 39 * DAY, n: { SECRET: 1 }, ph: { [ph('SECRET')]: 'hunter2isgood' }, by: { [ph('SECRET')]: WIDE } } })
    const parts = kids(await (await mount($, cols)).find({ key: ph('SECRET') })) as any[]
    const src = strings(parts[1]).join('')
    expect([...src].length).toBe(Math.max(8, Math.floor(cols / 3)))
    expect(src.endsWith('…') && WIDE.startsWith(src.slice(0, -1))).toBe(true)
    expect(keys(parts[2])).toEqual([`forget-${ph('SECRET')}`])
  })

// an unnamed rule whose regex is the value itself names the value as its source
const LIT = 'tok' + 'en4f9a2c71'
for (const surface of ['mobile', 'desktop'] as const)
  test(`${surface}: a rule's text that holds a value shows its placeholder, on This session and Rules`, async ($, on) => {
    world(on, { 'vault:s1': { at: 39 * DAY, n: { SECRET: 1 }, ph: { [ph('SECRET')]: LIT }, by: { [ph('SECRET')]: `rule: ${LIT}` } } },
      { [RULES]: rulesFile([{ pattern: LIT, enabled: true }]) })
    const m = await $.ui.mount({ plugin: 'redact', surface, component: 'Pane', requestId: 'redact', props: PROPS })
    const all = async () => (await m.findAll({ type: 'Text' })).flatMap(strings).join('\n')
    const session = await all()
    expect(session).toContain(`rule: ${ph('SECRET')}`)
    expect(session).not.toContain(LIT)
    await m.press({ key: 'tab-rules' })
    const rules = await all()
    expect(rules).toContain(`1. ${ph('SECRET')}`)
    expect(rules).not.toContain(LIT)
  })

test('the terminal shows a rule\'s text as written', async ($, on) => {
  world(on, { 'vault:s1': { at: 39 * DAY, n: { SECRET: 1 }, ph: { [ph('SECRET')]: LIT }, by: { [ph('SECRET')]: `rule: ${LIT}` } } })
  expect(strings(await (await mount($)).find({ key: ph('SECRET') })).join('')).toContain(`rule: ${LIT}`)
})
