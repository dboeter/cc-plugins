import { test, expect } from 'claude-code/testing'
import { EXAMPLES } from './redact'
import { RULES, file, mount, world } from './pane-helpers'

// The rules tab: what is on comes first, a rule shows the placeholder it writes, and the env
// files line names the folder they are read in.

// the pane on its rules tab
const rulesTab = async ($: any) => {
  const m = await mount($)
  await m.press({ key: 'tab-rules' })
  return m
}

test('the rules tab reads Rules, Env files, From settings, then Test', async ($, on) => {
  world(on, {}, { [RULES]: file(EXAMPLES) })
  const m = await rulesTab($)
  const titles = (await m.findAll({ type: 'Text', text: /^(?:Rules|Env files|From settings|Test)$/ })).filter((x: any) => x.props.weight === 'semibold').map((x: any) => x.text)
  expect(titles).toEqual(['Rules', 'Env files', 'From settings', 'Test'])
})

test("a rule shows the placeholder it writes, its number as n", async ($, on) => {
  world(on, {}, { [RULES]: file([{ name: 'Vendor tokens', pattern: 'tok_[0-9]+', replacement: 'API_KEY', enabled: true }]) })
  const m = await rulesTab($)
  expect(await m.find({ text: /^1\. Vendor tokens$/ })).toBeDefined()
  expect(await m.find({ text: /^ → ⟦API_KEY_n⟧$/ })).toBeDefined()
  expect(await m.find({ text: / as API_KEY/ })).toBeUndefined()
})

test('a pattern from settings shows its placeholder too, SECRET when it names none', { options: { patterns: ['ACME: acme_[a-z0-9]{8}', 'x_[0-9]+'] } }, async ($, on) => {
  world(on, {}, { [RULES]: file([]) })
  const m = await rulesTab($)
  expect((await m.findAll({ text: /^ → ⟦/ })).map((x: any) => x.text)).toEqual([' → ⟦ACME_n⟧', ' → ⟦SECRET_n⟧'])
})

// the Text a Button draws as its glyph, and its color props
const glyph = async (m: any, key: string) => (await m.find({ key }))?.children.find((c: any) => typeof c === 'object')?.props
test('red marks only errors: the remove and clear ✗ are dim, a skipped rule and a broken file stay red', async ($, on) => {
  const { files } = world(on, {}, { [RULES]: file([{ pattern: 'tok_[0-9]+', replacement: 'API_KEY' }, { pattern: 'zz_[0-9]+', replacement: 'zz' }]) })
  const m = await rulesTab($)
  expect(await glyph(m, 'remove-0')).toMatchObject({ dimColor: true })
  expect((await glyph(m, 'remove-0')).color).toBeUndefined()
  await m.input({ key: 'test', text: 'tok_12', kind: 'submit' })
  expect(await glyph(m, 'clear-test')).toMatchObject({ dimColor: true })
  expect((await glyph(m, 'clear-test')).color).toBeUndefined()
  expect((await m.find({ type: 'Text', text: /^ skipped: replacement is not capitals/ }))?.props.color).toBe('red')
  files.set(RULES, '{ broken')
  await m.press({ key: 'tab-rules' }) // redrawn, it reads the file again
  expect((await m.find({ type: 'Text', text: /^redact-rules\.json .*masking with the last rules read until it is fixed by hand$/ }))?.props.color).toBe('red')
})

test('the env files line names the folder the session started in, ~ for the home folder', async ($, on) => {
  world(on, {}, { [RULES]: file(EXAMPLES) }, '/h/app')
  expect(await (await rulesTab($)).find({ text: /^secret-looking values from \.env files in ~\/app$/ })).toBeDefined()
})

test('a folder outside the home folder shows whole, and one that only starts like it is not shortened', async ($, on) => {
  world(on, {}, { [RULES]: file(EXAMPLES) }, '/hx/app')
  expect(await (await rulesTab($)).find({ text: /^secret-looking values from \.env files in \/hx\/app$/ })).toBeDefined()
})

test('the rules file shows ~ for the home folder, indented by padding so a wrapped line keeps its indent', async ($, on) => {
  world(on, {}, { [RULES]: file(EXAMPLES) })
  const m = await rulesTab($)
  const line = await m.find({ type: 'Text', text: /^in ~\/\.claude\/redact-rules\.json, for every project/ })
  expect(line?.props.wrap).toBe('wrap')
  expect(await m.find({ type: 'Text', text: /\/h\/\.claude/ })).toBeUndefined()
})

test('the pane leaves the last column free: a header ends there, and the right-aligned rows with it', async ($, on) => {
  world(on, {}, { [RULES]: file(EXAMPLES) })
  const m = await rulesTab($)
  const header = await m.find({ type: 'Text', text: /^── Rules ─+ 0 of 2 on ──$/ })
  expect([...header.text].length).toBe(79)
  expect((await m.findAll({ type: 'Box' }))[0]?.props.width).toBe(79)
})

test('j and k walk a cursor over the rules; t and x on the key line act on its row, x twice; no row has a key', async ($, on) => {
  const { files } = world(on, {}, { [RULES]: file(EXAMPLES) })
  const m = await rulesTab($)
  const hotkeys = async () => Object.fromEntries((await m.findAll({ type: 'Button' })).filter((x: any) => x.props.hotkey && !/^tab-|^raw$/.test(x.props.key)).map((x: any) => [x.props.hotkey, x.props.key]))
  expect(await hotkeys()).toEqual({ j: 'rdown', k: 'rup', t: 'rule-turn', x: 'rule-remove' })
  const marked = async () => (await m.findAll({ type: 'Text', text: '› ' })).length
  expect(await marked()).toBe(1)
  await m.press({ key: 'rdown' })
  await m.press({ key: 'rdown' }) // stops at the last
  await m.press({ key: 'rule-turn' })
  expect(JSON.parse(files.get(RULES)!).rules.map((r: any) => r.enabled)).toEqual([false, true])
  await m.press({ key: 'rule-remove' })
  expect(await m.find({ text: /^✗ remove\?$/ })).toBeDefined()
  expect((await m.find({ key: 'rule-remove' }))?.props.label).toBe('remove?')
  await m.press({ key: 'rup' }) // moving disarms it
  expect(await m.find({ text: /^✗ remove\?$/ })).toBeUndefined()
  expect(await m.find({ text: /press ✗ again/ })).toBeUndefined()
  await m.press({ key: 'remove-1' }) // a click arms that row and puts the cursor on it
  await m.press({ key: 'rule-remove' })
  expect(JSON.parse(files.get(RULES)!).rules.map((r: any) => r.name)).toEqual([EXAMPLES[0]!.name])
})

test('unfocused, the pane draws no cursor and swaps the key line for a hint to click', async ($, on) => {
  world(on, {}, { [RULES]: file(EXAMPLES) })
  const m = await mount($, { isFocused: false })
  await m.press({ key: 'tab-rules' })
  expect(await m.find({ type: 'Text', text: '› ' })).toBeUndefined()
  expect(await m.find({ key: 'rdown' })).toBeUndefined()
  expect(await m.find({ text: /^click to focus for keys: j\/k move, t on\/off, x remove$/ })).toBeDefined()
})

test('the open tab is bold and underlined, the others dim', async ($, on) => {
  world(on, {}, { [RULES]: file(EXAMPLES) })
  const m = await rulesTab($)
  expect((await m.find({ type: 'Text', text: 'Rules', props: { underline: true } }))?.props).toMatchObject({ weight: 'bold', underline: true })
  expect((await m.find({ key: 'tab-session' }))?.props.dimColor).toBe(true)
})

test('the Env files header carries no state, the switch does; an empty From settings says how to fill it, once', async ($, on) => {
  world(on, {}, { [RULES]: file(EXAMPLES) })
  const m = await rulesTab($)
  expect(await m.find({ type: 'Text', text: /^── Env files ─+$/ })).toBeDefined()
  expect(await m.find({ type: 'Text', text: /^── From settings ─+$/ })).toBeDefined()
  expect(await m.find({ type: 'Text', text: /^none; the patterns option in settings\.json adds always-on rules$/ })).toBeDefined()
  expect(await m.find({ type: 'Text', text: /^── Test ─+$/ })).toBeDefined() // nothing at its end until a sample matches
  expect(await m.find({ type: 'Text', text: /^ *none$/ })).toBeUndefined()
})
