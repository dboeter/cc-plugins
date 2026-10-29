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
const firstText = async (m: any) => (await m.findAll({ type: 'Text' }))[0]

test('the status line, first on every tab, counts the rules on and the env files, the values left to the Session tab', async ($, on) => {
  world(on, HOLDS_GH, { [RULES]: file(ON) })
  const m = await mount($)
  for (const tab of ['tab-session', 'tab-rules', 'tab-help']) {
    await m.press({ key: tab })
    const top = await firstText(m)
    expect(top.text).toBe('● masking: 2 rules + env files')
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
  expect(top.text).toBe('○ nothing masked: no rule is on (r)')
  expect(top.props).toMatchObject({ color: 'warning', wrap: 'wrap' })
})

test('with no rule on but the env files on, the status line says masking, no warning', async ($, on) => {
  world(on, {}, { [RULES]: file(EXAMPLES) })
  const m = await mount($)
  const top = await firstText(m)
  expect(top.text).toBe('● masking: env files')
  expect(top.props).toMatchObject({ color: 'green' })
  expect(await m.find({ text: /no rule is on/ })).toBeUndefined()
})

test('rules turned on that all fail to read count as none on: the status line warns, the marker counts them', async ($, on) => {
  world(on, {}, { [RULES]: file([{ pattern: '(', replacement: 'X', enabled: true }, { pattern: 'zz_[0-9]+', replacement: 'zz', enabled: true }], { envFiles: false }) })
  const m = await mount($)
  const top = await firstText(m)
  expect(top.text).toBe('○ nothing masked: no rule is on (r)')
  expect(top.props).toMatchObject({ color: 'warning' })
  expect((await m.find({ text: /^⚠ 2 rules invalid$/ }))?.props.color).toBe('red')
})

test('the tabs: Session keeps its count, Rules carries none', async ($, on) => {
  world(on, HOLDS_GH, { [RULES]: file(ON) })
  const m = await mount($)
  expect((await m.find({ key: 'tab-session' }))?.props.label).toMatch(/^Session \(1\)/)
  expect((await m.find({ key: 'tab-rules' }))?.props.label).toMatch(/^Rules[ •]$/)
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
  expect(before).toBe('[real values] placeholders ')
  expect(await m.find({ text: /^transcript shows:$/ })).toBeDefined()
  expect(await state('\\[real values\\]')).toMatchObject({ weight: 'bold' })
  expect(await state(' placeholders ')).toMatchObject({ dimColor: true })
  await m.press({ key: 'raw' })
  expect([...(await m.find({ key: 'raw' }))?.text].length).toBe([...before].length)
  expect(await state('\\[placeholders\\]')).toMatchObject({ weight: 'bold' })
  expect(await state(' real values ')).toMatchObject({ dimColor: true })
  expect(await (await mount($, { surface: 'mobile' })).find({ key: 'raw' })).toBeUndefined()
})
