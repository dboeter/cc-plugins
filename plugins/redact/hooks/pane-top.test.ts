import { test, expect, mock } from 'claude-code/testing'
import { EXAMPLES } from './redact'

// The pane's top bar: the status line, the tabs, the invalid-rules marker and the draw switch.
// The helpers are copied from redact.test.ts; its fixtures are split the same way, so no literal
// matches the pre-push secret gate and the live plugin leaves this file readable.
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
// a rules file of these rules, its other keys (envFiles) beside them
const file = (rules: unknown[], rest: object = {}) => JSON.stringify({ rules, ...rest }, null, 2) + '\n'
const ON = EXAMPLES.map(r => ({ ...r, enabled: true }))
const HOLDS_GH = { 'vault:s1': { at: 39 * DAY, n: { API_KEY: 1 }, ph: { [ph('API_KEY')]: GH } } }
const PROPS = { title: 'redact', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 } } as any
const mount = ($: any, surface = 'terminal') => $.ui.mount({ plugin: 'redact', surface, component: 'Pane', requestId: 'redact', props: PROPS })
const firstText = async (m: any) => (await m.findAll({ type: 'Text' }))[0]

test('the status line, first on every tab, counts the rules on, the env files and the values hidden', async ($, on) => {
  world(on, HOLDS_GH, { [RULES]: file(ON) })
  const m = await mount($)
  for (const tab of ['tab-session', 'tab-rules', 'tab-help']) {
    await m.press({ key: tab })
    const top = await firstText(m)
    expect(top.text).toBe('● masking: 2 rules + env files · 1 value hidden from the model')
    expect(top.props).toMatchObject({ color: 'green', wrap: 'wrap' })
  }
})

test('the status line counts a settings pattern as a rule and drops the parts that are off or zero', { options: { patterns: ['ACME: acme_[a-z0-9]{8}'] } }, async ($, on) => {
  world(on, {}, { [RULES]: file(EXAMPLES, { envFiles: false }) })
  expect((await firstText(await mount($))).text).toBe('● masking: 1 rule')
})

test('with no rule on and the env files off, the status line warns that nothing is masked', async ($, on) => {
  world(on, HOLDS_GH, { [RULES]: file(EXAMPLES, { envFiles: false }) })
  const top = await firstText(await mount($))
  expect(top.text).toBe('○ nothing is masked: turn on a rule (r)')
  expect(top.props).toMatchObject({ color: 'warning', wrap: 'wrap' })
})

test('with no rule on but the env files on, the status line says masking, no warning', async ($, on) => {
  world(on, {}, { [RULES]: file(EXAMPLES) })
  const m = await mount($)
  const top = await firstText(m)
  expect(top.text).toBe('● masking: env files')
  expect(top.props).toMatchObject({ color: 'green' })
  expect(await m.find({ text: /nothing is masked/ })).toBeUndefined()
})

test('rules turned on that all fail to read count as none on: the status line warns, the marker counts them', async ($, on) => {
  world(on, {}, { [RULES]: file([{ pattern: '(', replacement: 'X', enabled: true }, { pattern: 'zz_[0-9]+', replacement: 'zz', enabled: true }], { envFiles: false }) })
  const m = await mount($)
  const top = await firstText(m)
  expect(top.text).toBe('○ nothing is masked: turn on a rule (r)')
  expect(top.props).toMatchObject({ color: 'warning' })
  expect((await m.find({ text: /^⚠ 2 rules invalid$/ }))?.props.color).toBe('red')
})

test('the tabs: This session keeps its count, Rules carries none', async ($, on) => {
  world(on, HOLDS_GH, { [RULES]: file(ON) })
  const m = await mount($)
  expect((await m.find({ key: 'tab-session' }))?.props.label).toMatch(/^This session \(1\)/)
  expect((await m.find({ key: 'tab-rules' }))?.props.label).toMatch(/^Rules[ •]$/)
})

test('a rule that does not read is marked in red as invalid, no longer as skipped', async ($, on) => {
  world(on, {}, { [RULES]: file([...ON, { pattern: '(' }]) })
  const m = await mount($)
  const marker = await m.find({ text: /^⚠ 1 rule invalid$/ })
  expect(marker?.props.color).toBe('red')
  expect(await m.find({ text: /✗ \d+ skipped/ })).toBeUndefined()
})

test('the draw switch reads show: real values · placeholders, the state drawn now bold, d flips it', async ($, on) => {
  world(on, HOLDS_GH)
  const m = await mount($)
  const state = async (title: string) => (await m.find({ text: new RegExp(`^${title}$`) }))?.props
  const raw = await m.find({ key: 'raw' })
  expect(raw?.props.hotkey).toBe('d')
  expect(raw?.text).toMatch(/real values · placeholders/)
  expect(await m.find({ text: /^show:$/ })).toBeDefined()
  expect(await state('real values')).toMatchObject({ weight: 'bold' })
  expect(await state('placeholders')).toMatchObject({ dimColor: true })
  await m.press({ key: 'raw' })
  expect(await state('placeholders')).toMatchObject({ weight: 'bold' })
  expect(await state('real values')).toMatchObject({ dimColor: true })
  expect(await (await mount($, 'mobile')).find({ key: 'raw' })).toBeUndefined()
})
