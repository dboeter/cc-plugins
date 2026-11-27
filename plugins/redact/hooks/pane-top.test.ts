import { test, expect } from 'claude-code/testing'
import { EXAMPLES } from './redact'
import { DAY, RULES, file, mount, world } from './pane-helpers'

// The pane's top bar: the status line, the tabs, the invalid-rules marker and the draw switch.
// Fixtures are split as in redact.test.ts, so no literal matches the pre-push secret gate and the
// live plugin leaves this file readable.
const GH = 'ghp_' + 'a'.repeat(36)
const ph = (label: string, n = 1) => `⟦${label}_${n}⟧`

const ON = EXAMPLES.map(r => ({ ...r, enabled: true }))
const HOLDS_GH = { 'vault:s1': { at: 39 * DAY, n: { API_KEY: 1 }, ph: { [ph('API_KEY')]: GH } } }
// the status line, under the tabs and the invalid-rules marker
const statusText = async (m: any) => (await m.findAll({ type: 'Text' })).find((t: any) => /^[●○] /.test(t.text))

test('the status line, under the tabs on every tab, counts the rules on and the env files, the values left to the Session tab', async ($, on) => {
  world(on, HOLDS_GH, { [RULES]: file(ON) })
  const m = await mount($)
  for (const tab of ['tab-session', 'tab-rules', 'help']) {
    await m.press({ key: tab })
    const top = await statusText(m)
    expect(top.text).toBe('● On: 2 rules and env files')
    expect(top.props).toMatchObject({ color: 'green', wrap: 'wrap' })
  }
})

test('the status line counts a settings pattern as a rule and drops the parts that are off or zero', { options: { patterns: ['ACME: acme_[a-z0-9]{8}'] } }, async ($, on) => {
  world(on, {}, { [RULES]: file(EXAMPLES, { envFiles: false }) })
  expect((await statusText(await mount($))).text).toBe('● On: 1 rule')
})

test('with no rule on and the env files off, the status line says it is off and where to turn a rule on', async ($, on) => {
  world(on, HOLDS_GH, { [RULES]: file(EXAMPLES, { envFiles: false }) })
  const top = await statusText(await mount($))
  expect(top.text).toBe('○ Off: no rules on (r)')
  expect(top.props).toMatchObject({ color: 'warning', wrap: 'wrap' })
})

test('with no rule on but the env files on, the status line says on, and that no rule is on yet', async ($, on) => {
  world(on, {}, { [RULES]: file(EXAMPLES) })
  const top = await statusText(await mount($))
  expect(top.text).toBe('● On: env files only, no rules (r)')
  expect(top.props).toMatchObject({ color: 'green' })
})

test('rules turned on that all fail to read count as none on: the status line warns, the marker counts them', async ($, on) => {
  world(on, {}, { [RULES]: file([{ pattern: '(', replacement: 'X', enabled: true }, { pattern: 'zz_[0-9]+', replacement: 'zz', enabled: true }], { envFiles: false }) })
  const m = await mount($)
  const top = await statusText(m)
  expect(top.text).toBe('○ Off: no rules on (r)')
  expect(top.props).toMatchObject({ color: 'warning' })
  expect((await m.find({ text: /^⚠ 2 rules invalid$/ }))?.props.color).toBe('red')
})

test('the tabs: Session keeps its count, Rules carries none', async ($, on) => {
  world(on, HOLDS_GH, { [RULES]: file(ON) })
  const m = await mount($)
  expect((await m.find({ key: 'tab-session' }))?.props.label).toMatch(/^Session \(1\)/)
  expect((await m.find({ key: 'tab-rules' }))?.props.label).toBe('Rules')
})

test('a rule that does not read is marked in red as invalid, no longer as skipped', async ($, on) => {
  world(on, {}, { [RULES]: file([...ON, { pattern: '(' }]) })
  const m = await mount($)
  const marker = await m.find({ text: /^⚠ 1 rule invalid$/ })
  expect(marker?.props.color).toBe('red')
  expect(await m.find({ text: /✗ \d+ skipped/ })).toBeUndefined()
})

test('the draw switch names the transcript, the state drawn now bracketed and bold, d flips it at one width', async ($, on) => {
  world(on, HOLDS_GH)
  const m = await mount($)
  const state = async (title: string) => (await m.find({ text: new RegExp(`^${title}$`) }))?.props
  const raw = await m.find({ key: 'raw' })
  expect(raw?.props.hotkey).toBe('d')
  const before = raw?.text
  expect(before).toBe("[real values] Claude's view ")
  expect(await m.find({ text: /^Transcript:$/ })).toBeDefined()
  expect(await state('\\[real values\\]')).toMatchObject({ weight: 'bold' })
  expect(await state(" Claude's view ")).toMatchObject({ dimColor: true })
  await m.press({ key: 'raw' })
  expect([...(await m.find({ key: 'raw' }))?.text].length).toBe([...before].length)
  expect(await state("\\[Claude's view\\]")).toMatchObject({ weight: 'bold' })
  expect(await state(' real values ')).toMatchObject({ dimColor: true })
  expect(await (await mount($, { surface: 'mobile' })).find({ key: 'raw' })).toBeUndefined()
})

test('the tabs come first, on a row of their own, the status line under them', async ($, on) => {
  world(on, HOLDS_GH, { [RULES]: file(ON) })
  const m = await mount($)
  const all = await m.findAll({})
  const at = (f: (x: any) => boolean) => all.findIndex(f)
  const status = at(x => x.type === 'Text' && x.text === '● On: 2 rules and env files')
  expect(at(x => (x.props?.key ?? x.key) === 'help')).toBeGreaterThan(-1)
  expect(status).toBeGreaterThan(at(x => (x.props?.key ?? x.key) === 'help'))
  expect(status).toBeLessThan(at(x => x.text === 'Transcript:'))
})
