import { test, expect } from 'claude-code/testing'
import { EXAMPLES } from './redact'
import { RULES, file, mount, ring, world } from './pane-helpers'

// The rules tab: what is on comes first, a rule shows the placeholder it writes, and the env
// files line names the folder they are read in.

// the pane on its rules tab
const rulesTab = async ($: any) => {
  const m = await mount($)
  await m.press({ key: 'tab-rules' })
  return m
}

const titles = async (m: any) => (await m.findAll({ type: 'Text', text: /^(?:Rules|Env files|From settings|Test)$/ })).filter((x: any) => x.props.weight === 'semibold').map((x: any) => x.text)

test('the rules tab reads Rules, Test, then Env files; From settings only once the option is set', async ($, on) => {
  world(on, {}, { [RULES]: file(EXAMPLES) })
  expect(await titles(await rulesTab($))).toEqual(['Rules', 'Test', 'Env files'])
})

test('with the patterns option set, From settings follows Env files', { options: { patterns: ['zz_[0-9]+'] } }, async ($, on) => {
  world(on, {}, { [RULES]: file(EXAMPLES) })
  const m = await rulesTab($)
  expect(await titles(m)).toEqual(['Rules', 'Test', 'Env files', 'From settings'])
  expect(await m.find({ type: 'Text', text: /^Always on\./ })).toBeUndefined()
  await m.press({ key: 'help' })
  expect(await m.find({ type: 'Text', text: /^Always on\. Set by the patterns option in settings\.json\.$/ })).toBeDefined()
})

test("a named rule's regex shows under the cursor's row only, with help on", async ($, on) => {
  world(on, {}, { [RULES]: file([{ name: 'One', pattern: 'aa_[0-9]+', replacement: 'A' }, { name: 'Two', pattern: 'bb_[0-9]+', replacement: 'B' }]) })
  const m = await rulesTab($)
  const regexes = async () => (await m.findAll({ type: 'Text', text: /^ +(aa|bb)_\[0-9\]\+$/ })).map((x: any) => x.text.trim())
  expect(await regexes()).toEqual([])
  await m.press({ key: 'help' })
  expect(await regexes()).toEqual(['aa_[0-9]+'])
  await ring($, 'turn-1')
  expect(await regexes()).toEqual(['bb_[0-9]+'])
  await m.unmount()
  expect(await (await mount($, { isFocused: false })).findAll({ type: 'Text', text: /^ +(aa|bb)_/ })).toEqual([])
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
  expect((await m.find({ type: 'Text', text: /^redact-rules\.json .*\. Using the last rules that read until you fix it\.$/ }))?.props.color).toBe('red')
})

test('the env files line names the folder the session started in, ~ for the home folder', async ($, on) => {
  world(on, {}, { [RULES]: file(EXAMPLES) }, '/h/app')
  expect(await (await rulesTab($)).find({ text: /^\.env files in ~\/app$/ })).toBeDefined()
})

test('a folder outside the home folder shows whole, and one that only starts like it is not shortened', async ($, on) => {
  world(on, {}, { [RULES]: file(EXAMPLES) }, '/hx/app')
  expect(await (await rulesTab($)).find({ text: /^\.env files in \/hx\/app$/ })).toBeDefined()
})

test('the rules file shows ~ for the home folder, indented by padding so a wrapped line keeps its indent', async ($, on) => {
  world(on, {}, { [RULES]: file(EXAMPLES) })
  const m = await rulesTab($)
  await m.press({ key: 'help' })
  const line = await m.find({ type: 'Text', text: /Saved in ~\/\.claude\/redact-rules\.json, for all projects\.$/ })
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

test('the cursor follows the focus ring onto a rule\'s switch or ✗; t and x on the key line act on its row, x twice; no j or k', async ($, on) => {
  const { files } = world(on, {}, { [RULES]: file(EXAMPLES) })
  const m = await rulesTab($)
  const hotkeys = async () => Object.fromEntries((await m.findAll({ type: 'Button' })).filter((x: any) => x.props.hotkey && !/^tab-|^raw$|^help$/.test(x.props.key)).map((x: any) => [x.props.hotkey, x.props.key]))
  expect(await hotkeys()).toEqual({ a: 'new-rule', t: 'rule-turn', x: 'rule-remove' })
  expect((await m.find({ key: 'turn-0' }))?.props.autoFocus).toBe(true)
  const marked = async () => (await m.findAll({ type: 'Text', text: '› ' })).length
  expect(await marked()).toBe(1)
  await ring($, 'remove-1')
  await ring($, 'help') // a stop that is no row leaves the cursor where it was
  await m.press({ key: 'rule-turn' })
  expect(JSON.parse(files.get(RULES)!).rules.map((r: any) => r.enabled)).toEqual([false, true])
  await m.press({ key: 'rule-remove' })
  expect(await m.find({ text: /^✗ remove\?$/ })).toBeDefined()
  expect((await m.find({ key: 'rule-remove' }))?.props.label).toBe('remove?')
  await ring($, 'turn-0') // moving disarms it
  expect(await m.find({ text: /^✗ remove\?$/ })).toBeUndefined()
  expect(await m.find({ text: /press ✗ again/ })).toBeUndefined()
  await m.press({ key: 'remove-1' }) // a click arms that row and puts the cursor on it
  await m.press({ key: 'rule-remove' })
  expect(JSON.parse(files.get(RULES)!).rules.map((r: any) => r.name)).toEqual([EXAMPLES[0]!.name])
  expect(await marked()).toBe(1)
})

test('unfocused, the pane draws no cursor and swaps the key line for a hint to click', async ($, on) => {
  world(on, {}, { [RULES]: file(EXAMPLES) })
  const m = await mount($, { isFocused: false })
  await m.press({ key: 'tab-rules' })
  expect(await m.find({ type: 'Text', text: '› ' })).toBeUndefined()
  expect(await m.find({ key: 'rule-turn' })).toBeUndefined()
  expect(await m.find({ text: /^click the pane to use keys: ↑↓ move, t on\/off, x remove$/ })).toBeDefined()
})

test('the open tab is bold and underlined, the others dim', async ($, on) => {
  world(on, {}, { [RULES]: file(EXAMPLES) })
  const m = await rulesTab($)
  expect((await m.find({ type: 'Text', text: 'Rules', props: { underline: true } }))?.props).toMatchObject({ weight: 'bold', underline: true })
  expect((await m.find({ key: 'tab-session' }))?.props.dimColor).toBe(true)
})

test('the Env files header carries no state, the switch does; an unset patterns option draws no section', async ($, on) => {
  world(on, {}, { [RULES]: file(EXAMPLES) })
  const m = await rulesTab($)
  expect(await m.find({ type: 'Text', text: /^── Env files ─+$/ })).toBeDefined()
  expect(await m.find({ type: 'Text', text: /From settings|patterns option/ })).toBeUndefined()
  expect(await m.find({ type: 'Text', text: /^── Test ─+$/ })).toBeDefined() // nothing at its end until a sample matches
  expect(await m.find({ type: 'Text', text: /^ *none$/ })).toBeUndefined()
})

test('the test field, its clear and the draw switch disarm a rule\'s ✗ and drop its note', async ($, on) => {
  const { files } = world(on, {}, { [RULES]: file(EXAMPLES) })
  const m = await rulesTab($)
  const armed = async () => [await m.find({ text: /^✗ remove\?$/ }), await m.find({ text: /press ✗ again/ })].filter(Boolean).length
  await m.press({ key: 'remove-0' })
  expect(await armed()).toBe(2)
  await m.input({ key: 'test', text: 'x', kind: 'submit' })
  expect(await armed()).toBe(0)
  await m.press({ key: 'remove-0' })
  await m.press({ key: 'clear-test' })
  expect(await armed()).toBe(0)
  await m.press({ key: 'remove-0' })
  await m.press({ key: 'raw' })
  expect(await armed()).toBe(0)
  await m.press({ key: 'remove-0' }) // armed afresh, not removed
  expect(JSON.parse(files.get(RULES)!).rules).toHaveLength(2)
})

test('a rules file edited between the presses re-arms the ✗ instead of removing the rule now in its place', async ($, on) => {
  const { files } = world(on, {}, { [RULES]: file(EXAMPLES) })
  const m = await rulesTab($)
  await m.press({ key: 'remove-0' })
  files.set(RULES, file([EXAMPLES[1]!, EXAMPLES[0]!])) // no redraw before the second press
  await m.press({ key: 'remove-0' })
  expect(JSON.parse(files.get(RULES)!).rules).toHaveLength(2)
  expect(await m.find({ text: /^✗ remove\?$/ })).toBeDefined()
})

test('off the terminal the key line\'s buttons and the cursor show, never the click-to-focus hint', async ($, on) => {
  world(on, {}, { [RULES]: file(EXAMPLES) })
  const m = await mount($, { surface: 'desktop', isFocused: false })
  await m.press({ key: 'tab-rules' })
  expect(await m.find({ key: 'rule-turn' })).toBeDefined()
  expect(await m.find({ type: 'Text', text: '› ' })).toBeDefined()
  expect(await m.find({ text: /click to focus/ })).toBeUndefined()
})

// The new rule form: what the one-line form packed into `LABEL options: regex`, one control each.
const rulesOfFile = (files: Map<string, string>) => JSON.parse(files.get(RULES)!).rules
const BARE = [{ pattern: 'first_[0-9]+', replacement: 'FIRST', enabled: true }]

test('new rule opens a form: the name shows the placeholder as you type, the switches set the options', async ($, on) => {
  const { files } = world(on, {}, { [RULES]: file(BARE) })
  const m = await rulesTab($)
  expect(await m.find({ key: 'add' })).toBeUndefined()
  expect((await m.find({ key: 'new-rule' }))?.props.hotkey).toBe('a')
  await m.press({ key: 'new-rule' })
  expect(await m.find({ text: /⟦SECRET_n⟧/ })).toBeDefined()
  await m.input({ key: 'new-name', text: 'Employee ID', kind: 'change' })
  expect(await m.find({ text: /⟦EMPLOYEE_ID_n⟧/ })).toBeDefined()
  await m.press({ key: 'new-i' })
  await m.input({ key: 'add', text: String.raw`\be\d{6}\b`, kind: 'submit' })
  expect(rulesOfFile(files).at(-1)).toEqual({ name: 'Employee ID', pattern: String.raw`\be\d{6}\b`, replacement: 'EMPLOYEE_ID', enabled: true, ignoreCase: true })
  expect(await m.find({ text: /^added as rule 2$/ })).toBeDefined()
  expect(await m.find({ key: 'add' })).toBeUndefined() // closed, and empty when opened again
  await m.press({ key: 'new-rule' })
  expect((await m.find({ key: 'add' }))?.props.value ?? '').toBe('')
  expect((await m.find({ key: 'new-name' }))?.props.value ?? '').toBe('')
})

test('min length, mixed characters only and skip prose each set their option; add rule submits', async ($, on) => {
  const { files } = world(on, {}, { [RULES]: file(BARE) })
  const m = await rulesTab($)
  await m.press({ key: 'new-rule' })
  await m.input({ key: 'add', text: String.raw`x_\w+`, kind: 'change' })
  await m.input({ key: 'new-min', text: '6', kind: 'change' })
  await m.press({ key: 'new-strong' })
  await m.press({ key: 'new-prose' })
  await m.press({ key: 'new-add' })
  expect(rulesOfFile(files).at(-1)).toEqual({ pattern: String.raw`x_\w+`, replacement: 'SECRET', enabled: true, min: 6, strong: true, prose: true })
})

test('a regex that does not compile keeps the form and its text, and says why as you type', async ($, on) => {
  const { files, clock } = world(on, {}, { [RULES]: file(BARE) })
  const m = await rulesTab($)
  await m.press({ key: 'new-rule' })
  await m.input({ key: 'add', text: '(', kind: 'change' })
  expect(await m.find({ text: /^ *not a valid regex/ })).toBeDefined()
  await m.input({ key: 'add', text: '(', kind: 'submit' })
  expect(rulesOfFile(files)).toHaveLength(1)
  expect(await m.find({ text: /^not added/ })).toBeDefined()
  // drawn empty, as Enter left the terminal's field, then with the text again
  expect((await m.find({ key: 'add' }))?.props.value).toBe('')
  await clock.advance(50)
  expect((await m.find({ key: 'add' }))?.props.value).toBe('(')
})

test('a pasted one-line rule still reads; a typed name and switches win over it', async ($, on) => {
  const { files } = world(on, {}, { [RULES]: file(BARE) })
  const m = await rulesTab($)
  await m.press({ key: 'new-rule' })
  await m.input({ key: 'add', text: 'ACME min=4: acme_[0-9]+', kind: 'submit' })
  expect(rulesOfFile(files).at(-1)).toEqual({ pattern: 'acme_[0-9]+', replacement: 'ACME', enabled: true, min: 4 })
  await m.press({ key: 'new-rule' })
  await m.input({ key: 'new-name', text: 'Mine', kind: 'change' })
  await m.press({ key: 'new-i' })
  await m.input({ key: 'add', text: 'ACME: zz_[0-9]+', kind: 'submit' })
  expect(rulesOfFile(files).at(-1)).toEqual({ name: 'Mine', pattern: 'zz_[0-9]+', replacement: 'MINE', enabled: true, ignoreCase: true })
})

test('a switch shows what a pasted line sets, and turning it off takes the option off', async ($, on) => {
  const { files } = world(on, {}, { [RULES]: file(BARE) })
  const m = await rulesTab($)
  await m.press({ key: 'new-rule' })
  await m.input({ key: 'add', text: String.raw`ACME strong prose: acme_\w+`, kind: 'change' })
  const state = async () => (await Promise.all(['new-i', 'new-strong', 'new-prose'].map(k => m.find({ key: k })))).map(b => b?.props.label)
  expect(await state()).toEqual(['ignore case off', 'mixed characters only on', 'skip prose on'])
  await m.press({ key: 'new-strong' })
  expect(await state()).toEqual(['ignore case off', 'mixed characters only off', 'skip prose on'])
  await m.input({ key: 'add', text: String.raw`ACME strong prose: acme_\w+`, kind: 'submit' })
  expect(rulesOfFile(files).at(-1)).toEqual({ pattern: String.raw`acme_\w+`, replacement: 'ACME', enabled: true, prose: true })
})

test('the form counts what the pattern matches in the test sample', async ($, on) => {
  world(on, {}, { [RULES]: file(BARE) })
  const m = await rulesTab($)
  await m.input({ key: 'test', text: 'ids e123456 and e654321', kind: 'submit' })
  await m.press({ key: 'new-rule' })
  await m.input({ key: 'add', text: String.raw`\be\d{6}\b`, kind: 'change' })
  expect(await m.find({ text: /^ *masks 2 values in your test sample$/ })).toBeDefined()
})

test('the count follows the switches: it counts what the rule would mask, not what the regex matches', async ($, on) => {
  world(on, {}, { [RULES]: file(BARE) })
  const m = await rulesTab($)
  await m.input({ key: 'test', text: 'ids tok_aaaaaaaa and tok_a1b2c3d4', kind: 'submit' })
  await m.press({ key: 'new-rule' })
  await m.input({ key: 'add', text: String.raw`tok_(?<v>\w+)`, kind: 'change' })
  expect(await m.find({ text: /^ *masks 2 values in your test sample$/ })).toBeDefined()
  await m.press({ key: 'new-strong' })
  expect(await m.find({ text: /^ *masks 1 value in your test sample$/ })).toBeDefined()
})

test('a duplicate rule or a min length that is no number keeps the form open with its text', async ($, on) => {
  const { files, clock } = world(on, {}, { [RULES]: file(BARE) })
  const m = await rulesTab($)
  await m.press({ key: 'new-rule' })
  await m.input({ key: 'new-name', text: 'First', kind: 'change' }) // its label FIRST, as rule 1 has
  await m.input({ key: 'add', text: 'first_[0-9]+', kind: 'submit' })
  expect(await m.find({ text: /^already there, as rule 1$/ })).toBeDefined()
  await clock.advance(50)
  expect((await m.find({ key: 'add' }))?.props.value).toBe('first_[0-9]+')
  await m.input({ key: 'new-min', text: 'six', kind: 'change' })
  await m.input({ key: 'add', text: 'zz_[0-9]+', kind: 'submit' })
  expect(await m.find({ text: /^not added: min length is not a whole number$/ })).toBeDefined()
  expect(JSON.parse(files.get(RULES)!).rules).toHaveLength(1)
})

test('a name with no letter to start a label masks as SECRET; cancel closes the form and drops the draft', async ($, on) => {
  world(on, {}, { [RULES]: file(BARE) })
  const m = await rulesTab($)
  await m.press({ key: 'new-rule' })
  await m.input({ key: 'new-name', text: '123', kind: 'change' })
  expect(await m.find({ text: /⟦SECRET_n⟧/ })).toBeDefined()
  await m.input({ key: 'add', text: 'zz', kind: 'change' })
  await m.press({ key: 'new-cancel' })
  expect(await m.find({ key: 'add' })).toBeUndefined()
  await m.press({ key: 'new-rule' })
  expect((await m.find({ key: 'add' }))?.props.value ?? '').toBe('')
})
