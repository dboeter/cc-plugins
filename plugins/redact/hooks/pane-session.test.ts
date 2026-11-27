import { test, expect } from 'claude-code/testing'
import { DAY, RULES, file, mount, ring, world } from './pane-helpers'
import { EXAMPLES } from './redact'

// The pane's Session tab: one line per vault entry under its source, the row cursor, and its empty states.
// Fixtures split as in redact.test.ts, so no literal is secret-shaped.
const GH = 'ghp_' + 'a'.repeat(36)
const ph = (label: string, n = 1) => `⟦${label}_${n}⟧`

// an element's own children, from a find (top level) or nested in a tree (in props)
const kids = (el: any): unknown[] => el?.children ?? el?.props?.children ?? []
const strings = (el: any): string[] => kids(el).flatMap(c => typeof c === 'string' ? [c] : c && typeof c === 'object' ? strings(c) : [])
const keys = (el: any): string[] => kids(el).flatMap(c => c && typeof c === 'object' ? [(c as any).props?.key, ...keys(c)].filter(Boolean) : [])

const TWO = { 'vault:s1': { at: 39 * DAY, n: { API_KEY: 1, SECRET: 1 }, ph: { [ph('API_KEY')]: GH, [ph('SECRET')]: 'hunter2isgood' }, by: { [ph('SECRET')]: 'rule: pass' } } }
// two values from one rule and one from another, the rule's second added last
const THREE = { 'vault:s1': { at: 39 * DAY, n: { EMAIL: 2, API_KEY: 1 }, ph: { [ph('EMAIL')]: 'a@b.co', [ph('API_KEY')]: GH, [ph('EMAIL', 2)]: 'c@d.co' },
  by: { [ph('EMAIL')]: 'rule: Email', [ph('API_KEY')]: 'env file: .env', [ph('EMAIL', 2)]: 'rule: Email' } } }
// a row as drawn: its Texts with the placeholder Button's label in place
const drawn = (el: any): string[] => kids(el).flatMap(c => typeof c === 'string' ? [c] : (c as any)?.type === 'Button' ? [(c as any).props.label] : c && typeof c === 'object' ? drawn(c) : [])
const line = async (m: any, p: string) => drawn(await m.find({ key: p })).join('')
// the placeholder of the row the cursor (›) is on
const at = async (m: any) => { for (const b of await m.findAll({ type: 'Button' })) { const k: string = b.props.key; if (k?.startsWith('pick-') && (await line(m, k.slice(5))).startsWith('›')) return k.slice(5) } }
const hotkeys = async (m: any) => Object.fromEntries((await m.findAll({ type: 'Button' })).filter((x: any) => x.props.hotkey && !/^tab-|^raw$|^help$/.test(x.props.key)).map((x: any) => [x.props.hotkey, x.props.key]))
const actions = async (m: any) => (await m.findAll({ type: 'Button' })).map((b: any) => b.props.key).filter((k: string) => /^(forget|reveal)-⟦/.test(k))

test('values sit under a header naming what masked them, a source once, in the vault\'s order', async ($, on) => {
  world(on, THREE)
  const m = await mount($)
  const heads = await m.findAll({ type: 'Text', text: /^(rule: Email|env file: \.env)$/ })
  expect(heads.map((t: any) => t.text)).toEqual(['rule: Email', 'env file: .env'])
  expect(keys(await m.find({ key: 'by-rule: Email' })).filter(k => k.startsWith('⟦'))).toEqual([ph('EMAIL'), ph('EMAIL', 2)])
  expect(await m.find({ text: /→/ })).toBeUndefined()
})

test('placeholders are padded to the widest, so every value starts in one column', async ($, on) => {
  world(on, THREE)
  const m = await mount($)
  const [first, other] = [await line(m, ph('EMAIL')), await line(m, ph('API_KEY'))]
  expect(first.startsWith(`› ${ph('EMAIL')}    `)).toBe(true)
  expect(other.startsWith(`  ${ph('API_KEY')}  ghp_`)).toBe(true)
  expect(other.indexOf('ghp_')).toBe(first.indexOf('@') - 1)
})

test('the cursor follows the focus ring as the arrows move it; x on the key line forgets its row; no j or k', async ($, on) => {
  const { store } = world(on, THREE)
  const m = await mount($)
  expect(await at(m)).toBe(ph('EMAIL'))
  expect((await m.find({ key: `pick-${ph('EMAIL')}` }))?.props.autoFocus).toBe(true)
  expect(await hotkeys(m)).toEqual({ x: 'cur-forget' })
  // every row draws the same stops, so the arrows walk them in a fixed order
  expect(await actions(m)).toEqual([`forget-${ph('EMAIL')}`, `forget-${ph('EMAIL', 2)}`, `forget-${ph('API_KEY')}`])
  await ring($, 'tab-rules') // a stop that is no row leaves the cursor where it was
  expect(await at(m)).toBe(ph('EMAIL'))
  await ring($, `pick-${ph('API_KEY')}`)
  expect(await at(m)).toBe(ph('API_KEY'))
  await ring($, `forget-${ph('EMAIL', 2)}`) // a row's ✗ is on its row too
  expect(await at(m)).toBe(ph('EMAIL', 2))
  await ring($, 'forget-all') // the key line's forget all is no row: x still forgets the row you were on
  expect(await at(m)).toBe(ph('EMAIL', 2))
  await m.press({ key: 'cur-forget' })
  expect(Object.keys((store.get('vault:s1') as any).ph)).toEqual([ph('EMAIL'), ph('API_KEY')])
  expect(await at(m)).toBe(ph('API_KEY')) // the cursor goes on to the next row
  expect(await m.find({ text: /forgot .*no longer use/ })).toBeDefined()
})

test('clicking a placeholder puts the cursor on its row', async ($, on) => {
  world(on, THREE)
  const m = await mount($)
  await m.press({ key: `pick-${ph('API_KEY')}` })
  expect((await line(m, ph('API_KEY'))).startsWith('›')).toBe(true)
})

test('on a narrow pane the value truncates; the placeholder and the row\'s ✗ do not shrink', async ($, on) => {
  const KEY = 'PRIV' + 'ATE KEY-----'
  world(on, { 'vault:s1': { at: 39 * DAY, n: { PRIVATE_KEY: 1 }, ph: { [ph('PRIVATE_KEY')]: `-----BEGIN RSA ${KEY}\nMIIEowIBAAKCAQEA\nabc+/=` }, by: { [ph('PRIVATE_KEY')]: 'env file: .env' } } })
  const m = await mount($, { bodyColumns: 30 })
  const [left, acts] = kids(await m.find({ key: ph('PRIVATE_KEY') })) as any[]
  expect(left.props.flexShrink).toBe(1)
  const [, pick, value] = kids(left) as any[]
  expect([pick.props.flexShrink, value.props.flexShrink]).toEqual([0, 1])
  expect(kids(value)[0]).toMatchObject({ type: 'Text', props: { wrap: 'truncate-end' } })
  expect([acts.props.flexShrink, keys(acts)]).toEqual([0, [`forget-${ph('PRIVATE_KEY')}`]])
})

test('a multi-line value stays on its line, cut or revealed with v', async ($, on) => {
  const KEY = 'PRIV' + 'ATE KEY-----'
  world(on, { 'vault:s1': { at: 39 * DAY, n: { PRIVATE_KEY: 1 }, ph: { [ph('PRIVATE_KEY')]: `-----BEGIN RSA ${KEY}\r\nMIIEowIBAAKCAQEA\nabc+/=` }, by: { [ph('PRIVATE_KEY')]: 'env file: .env' } } })
  const m = await mount($)
  expect(await line(m, ph('PRIVATE_KEY'))).not.toMatch(/[\r\n]|MIIEow/)
  expect((await m.find({ key: 'cur-reveal' }))?.props.hotkey).toBe('v')
  await m.press({ key: 'cur-reveal' })
  expect(await line(m, ph('PRIVATE_KEY'))).toContain(`-----BEGIN RSA ${KEY}⏎MIIEowIBAAKCAQEA⏎abc+/=`)
})

test('the Session tab carries the count; forget all shows with more than one value', async ($, on) => {
  world(on, TWO)
  const m = await mount($)
  expect((await m.find({ key: 'tab-session' }))?.props.label).toContain('(2)')
  expect(await m.find({ key: 'forget-all' })).toBeDefined()
  expect(await m.find({ text: /forgets a value/ })).toBeUndefined()
  await m.press({ key: `forget-${ph('API_KEY')}` })
  expect(await m.find({ key: 'forget-all' })).toBeUndefined()
})

test('a value with no recorded rule sits under rule unknown', async ($, on) => {
  world(on, TWO)
  expect(await (await mount($)).find({ text: /^rule unknown$/ })).toBeDefined()
})

test('empty with no rule, help off: one line that says what to press', async ($, on) => {
  world(on, {}, { [RULES]: file([], { envFiles: false }) })
  const m = await mount($)
  expect(await m.find({ text: 'No rules on yet. Press r to turn one on, or h for help.' })).toBeDefined()
  expect(await m.find({ text: /^How redact works$/ })).toBeUndefined()
})

test('h shows what redact does and how to start, and Good to know, on the Session tab', async ($, on) => {
  world(on, {}, { [RULES]: file([], { envFiles: false }) })
  const m = await mount($)
  await m.press({ key: 'help' })
  expect((await m.find({ key: 'help' }))?.props.label).toBe('hide help')
  expect(await m.find({ text: /^How redact works$/ })).toBeDefined()
  expect(await m.find({ text: /^redact swaps what your rules match for placeholders like ⟦API_KEY_n⟧ before Claude sees it\. Claude's tools still get the real value\./ })).toBeDefined()
  expect(await m.find({ text: /^To start, turn on a rule in Rules \(r\)/ })).toBeDefined()
  expect(await m.find({ text: /^Good to know$/ })).toBeDefined()
  expect(await m.find({ text: /No rules on yet/ })).toBeUndefined()
})

// empty with one thing that masks: nothing masked yet
const yet = async ($: any) => {
  const m = await mount($)
  return [!!(await m.find({ text: /^Nothing masked yet\.$/ })), !!(await m.find({ text: /No rules on yet/ }))]
}

test('empty, with a settings pattern: nothing masked yet', { options: { patterns: ['zz_[0-9]+'] } }, async ($, on) => {
  world(on, {}, { [RULES]: file([], { envFiles: false }) })
  expect(await yet($)).toEqual([true, false])
})

test('empty, with a file rule on: nothing masked yet', async ($, on) => {
  world(on, {}, { [RULES]: file([{ pattern: 'acme_[a-z0-9]{8}', replacement: 'SECRET', enabled: true }], { envFiles: false }) })
  expect(await yet($)).toEqual([true, false])
})

test('empty, with env files on but no rule: what to press, not nothing masked yet', async ($, on) => {
  world(on, {}, { [RULES]: file([]) })
  expect(await yet($)).toEqual([false, true])
})

test('a source with a line break draws in its header as ⏎', async ($, on) => {
  world(on, { 'vault:s1': { at: 39 * DAY, n: { SECRET: 1 }, ph: { [ph('SECRET')]: 'hunter2isgood' }, by: { [ph('SECRET')]: 'rule: first\nsecond' } } })
  expect(await (await mount($)).find({ text: /^rule: first⏎second$/ })).toBeDefined()
})

// an unnamed rule whose regex is the value itself names the value as its source
const LIT = 'tok' + 'en4f9a2c71'
for (const surface of ['mobile', 'desktop'] as const)
  test(`${surface}: a rule's text that holds a value shows its placeholder, on Session and Rules`, async ($, on) => {
    world(on, { 'vault:s1': { at: 39 * DAY, n: { SECRET: 1 }, ph: { [ph('SECRET')]: LIT }, by: { [ph('SECRET')]: `rule: ${LIT}` } } },
      { [RULES]: file([{ pattern: LIT, enabled: true }]) })
    const m = await mount($, { surface })
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
  expect(await (await mount($)).find({ text: new RegExp(`^rule: ${LIT}$`) })).toBeDefined()
})

// A fresh install: the two examples off, env files on (no envFiles key), as a new user meets it.
test('fresh install: the status says env files alone mask, and the tab says what to press', async ($, on) => {
  world(on, {}, { [RULES]: file(EXAMPLES) })
  const m = await mount($)
  expect(await m.find({ text: /^No rules on yet\./ })).toBeDefined()
  expect((await m.findAll({ type: 'Text' })).find((t: any) => /^[●○] /.test(t.text))?.text).toBe('● On: env files only, no rules (r)')
})

test('fresh install with env values seeded: the values, with what to press above them', async ($, on) => {
  world(on, TWO, { [RULES]: file(EXAMPLES) })
  const m = await mount($)
  expect(await m.find({ text: /^No rules on yet\./ })).toBeDefined()
  expect(await m.find({ type: 'Button', props: { label: ph('API_KEY') } })).toBeDefined()
})

test('the help lines that say where real values go name tools, not commands', async ($, on) => {
  world(on, {}, { [RULES]: file(EXAMPLES) })
  const m = await mount($)
  await m.press({ key: 'help' })
  expect(await m.find({ text: /Claude's tools still get the real value/ })).toBeDefined()
  expect(await m.find({ text: /commands Claude runs/i })).toBeUndefined()
})
