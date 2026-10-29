import { test, expect } from 'claude-code/testing'
import { DAY, RULES, file, mount, world } from './pane-helpers'

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

test('the cursor starts on the first row, the only one with actions; j and k move it, x forgets its value', async ($, on) => {
  const { store } = world(on, THREE)
  const m = await mount($)
  expect([(await m.find({ key: 'cdown' }))?.props.hotkey, (await m.find({ key: 'cup' }))?.props.hotkey]).toEqual(['j', 'k'])
  expect(await actions(m)).toEqual([`forget-${ph('EMAIL')}`])
  expect((await m.find({ key: `forget-${ph('EMAIL')}` }))?.props.hotkey).toBe('x')
  await m.press({ key: 'cdown' })
  expect(await actions(m)).toEqual([`forget-${ph('EMAIL', 2)}`])
  await m.press({ key: 'cdown' })
  await m.press({ key: 'cdown' }) // past the last row it stays there
  expect(await actions(m)).toEqual([`forget-${ph('API_KEY')}`])
  await m.press({ key: 'cup' })
  await m.press({ key: `forget-${ph('EMAIL', 2)}` })
  expect(Object.keys((store.get('vault:s1') as any).ph)).toEqual([ph('EMAIL'), ph('API_KEY')])
  // the cursor goes on to the next row
  expect(await actions(m)).toEqual([`forget-${ph('API_KEY')}`])
  expect(await m.find({ text: /forgot .*refused/ })).toBeDefined()
})

test('clicking a placeholder puts the cursor on its row', async ($, on) => {
  world(on, THREE)
  const m = await mount($)
  await m.press({ key: `pick-${ph('API_KEY')}` })
  expect(await actions(m)).toEqual([`forget-${ph('API_KEY')}`])
  expect((await line(m, ph('API_KEY'))).startsWith('›')).toBe(true)
})

test('on a narrow pane the value truncates; the placeholder and the cursor\'s actions do not shrink', async ($, on) => {
  const KEY = 'PRIV' + 'ATE KEY-----'
  world(on, { 'vault:s1': { at: 39 * DAY, n: { PRIVATE_KEY: 1 }, ph: { [ph('PRIVATE_KEY')]: `-----BEGIN RSA ${KEY}\nMIIEowIBAAKCAQEA\nabc+/=` }, by: { [ph('PRIVATE_KEY')]: 'env file: .env' } } })
  const m = await mount($, { bodyColumns: 30 })
  const [left, acts] = kids(await m.find({ key: ph('PRIVATE_KEY') })) as any[]
  expect(left.props.flexShrink).toBe(1)
  const [, pick, value] = kids(left) as any[]
  expect([pick.props.flexShrink, value.props.flexShrink]).toEqual([0, 1])
  expect(kids(value)[0]).toMatchObject({ type: 'Text', props: { wrap: 'truncate-end' } })
  expect([acts.props.flexShrink, keys(acts)]).toEqual([0, [`reveal-${ph('PRIVATE_KEY')}`, `forget-${ph('PRIVATE_KEY')}`]])
})

test('a multi-line value stays on its line, cut or revealed with v', async ($, on) => {
  const KEY = 'PRIV' + 'ATE KEY-----'
  world(on, { 'vault:s1': { at: 39 * DAY, n: { PRIVATE_KEY: 1 }, ph: { [ph('PRIVATE_KEY')]: `-----BEGIN RSA ${KEY}\r\nMIIEowIBAAKCAQEA\nabc+/=` }, by: { [ph('PRIVATE_KEY')]: 'env file: .env' } } })
  const m = await mount($)
  expect(await line(m, ph('PRIVATE_KEY'))).not.toMatch(/[\r\n]|MIIEow/)
  expect((await m.find({ key: `reveal-${ph('PRIVATE_KEY')}` }))?.props.hotkey).toBe('v')
  await m.press({ key: `reveal-${ph('PRIVATE_KEY')}` })
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

test('empty, the tab says what the model will see', async ($, on) => {
  world(on)
  expect(await (await mount($)).find({ text: /the model will see ⟦LABEL_n⟧ · your tools get the real value/ })).toBeDefined()
})

test('empty, with no file rule, no settings pattern and env files off: no rule is on', async ($, on) => {
  world(on, {}, { [RULES]: file([], { envFiles: false }) })
  expect(await (await mount($)).find({ text: /nothing masked: no rule is on \(r\)/ })).toBeDefined()
})

// empty with one thing that masks: nothing masked yet
const yet = async ($: any) => {
  const m = await mount($)
  return [!!(await m.find({ text: /nothing masked yet/ })), !!(await m.find({ text: /no rule is on/ }))]
}

test('empty, with a settings pattern: nothing masked yet', { options: { patterns: ['zz_[0-9]+'] } }, async ($, on) => {
  world(on, {}, { [RULES]: file([], { envFiles: false }) })
  expect(await yet($)).toEqual([true, false])
})

test('empty, with a file rule on: nothing masked yet', async ($, on) => {
  world(on, {}, { [RULES]: file([{ pattern: 'acme_[a-z0-9]{8}', replacement: 'SECRET', enabled: true }], { envFiles: false }) })
  expect(await yet($)).toEqual([true, false])
})

test('empty, with env files on: nothing masked yet', async ($, on) => {
  world(on, {}, { [RULES]: file([]) })
  expect(await yet($)).toEqual([true, false])
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
