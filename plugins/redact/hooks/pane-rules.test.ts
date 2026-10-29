import { test, expect, mock } from 'claude-code/testing'
import { EXAMPLES } from './redact'

// The rules tab: what is on comes first, a rule shows the placeholder it writes, and the env
// files line names the folder they are read in.

// The world beneath the plugin, as redact.test.ts has it: one session, a clock, a store and
// files, HOME at /h, and the session's folder at `cwd`.
const world = (on: any, given: Record<string, string> = {}, cwd = '/p') => {
  const store = new Map<string, unknown>()
  const files = new Map(Object.entries(given))
  mock.clock(on, { now: 40 * DAY })
  on('session.id', () => ({ value: 's1' }))
  on('session.cwd', () => ({ value: cwd }))
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
const file = (rules: unknown[]) => JSON.stringify({ rules }, null, 2) + '\n'
const PROPS = { title: 'redact', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 } } as any
// the pane on its rules tab
const rulesTab = async ($: any) => {
  const m = await $.ui.mount({ plugin: 'redact', surface: 'terminal', component: 'Pane', requestId: 'redact', props: PROPS })
  await m.press({ key: 'tab-rules' })
  return m
}

test('the rules tab reads Rules, Env files, From settings, then Test', async ($, on) => {
  world(on, { [RULES]: file(EXAMPLES) })
  const m = await rulesTab($)
  const titles = (await m.findAll({ text: /^(?:Rules|Env files|From settings|Test)$/ })).map((x: any) => x.text)
  expect(titles).toEqual(['Rules', 'Env files', 'From settings', 'Test'])
})

test("a rule shows the placeholder it writes, its number as n", async ($, on) => {
  world(on, { [RULES]: file([{ name: 'Vendor tokens', pattern: 'tok_[0-9]+', replacement: 'API_KEY', enabled: true }]) })
  const m = await rulesTab($)
  expect(await m.find({ text: /^  1\. Vendor tokens$/ })).toBeDefined()
  expect(await m.find({ text: /^ → ⟦API_KEY_n⟧$/ })).toBeDefined()
  expect(await m.find({ text: / as API_KEY/ })).toBeUndefined()
})

test('a pattern from settings shows its placeholder too, SECRET when it names none', { options: { patterns: ['ACME: acme_[a-z0-9]{8}', 'x_[0-9]+'] } }, async ($, on) => {
  world(on, { [RULES]: file([]) })
  const m = await rulesTab($)
  expect((await m.findAll({ text: /^ → ⟦/ })).map((x: any) => x.text)).toEqual([' → ⟦ACME_n⟧', ' → ⟦SECRET_n⟧'])
})

// the Text a Button draws as its glyph, and its color props
const glyph = async (m: any, key: string) => (await m.find({ key }))?.children.find((c: any) => typeof c === 'object')?.props
test('red marks only errors: the remove and clear ✗ are dim, a skipped rule and a broken file stay red', async ($, on) => {
  const { files } = world(on, { [RULES]: file([{ pattern: 'tok_[0-9]+', replacement: 'API_KEY' }, { pattern: 'zz_[0-9]+', replacement: 'zz' }]) })
  const m = await rulesTab($)
  expect(await glyph(m, 'remove-0')).toMatchObject({ dimColor: true })
  expect((await glyph(m, 'remove-0')).color).toBeUndefined()
  await m.input({ key: 'test', text: 'tok_12', kind: 'submit' })
  expect(await glyph(m, 'clear-test')).toMatchObject({ dimColor: true })
  expect((await glyph(m, 'clear-test')).color).toBeUndefined()
  expect((await m.find({ type: 'Text', text: /^ skipped: replacement is not capitals/ }))?.props.color).toBe('red')
  files.set(RULES, '{ broken')
  await m.press({ key: 'tab-rules' }) // redrawn, it reads the file again
  expect((await m.find({ type: 'Text', text: /^  redact-rules\.json .*masking with the last rules read until it is fixed by hand$/ }))?.props.color).toBe('red')
})

test('the env files line names the folder the session started in, ~ for the home folder', async ($, on) => {
  world(on, { [RULES]: file(EXAMPLES) }, '/h/app')
  expect(await (await rulesTab($)).find({ text: /^  secret-looking values from \.env files in ~\/app$/ })).toBeDefined()
})

test('a folder outside the home folder shows whole, and one that only starts like it is not shortened', async ($, on) => {
  world(on, { [RULES]: file(EXAMPLES) }, '/hx/app')
  expect(await (await rulesTab($)).find({ text: /^  secret-looking values from \.env files in \/hx\/app$/ })).toBeDefined()
})
