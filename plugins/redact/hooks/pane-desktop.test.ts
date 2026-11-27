import { test, expect } from 'claude-code/testing'
import { EXAMPLES } from './redact'
import { DAY, PROPS, RULES, file, mount, world } from './pane-helpers'

// The desktop app: the pane laid out for a window rather than a grid of cells, its minimized
// widget, the right-click menu on a selection, and the chip beside the message box.
// Fixtures split as in redact.test.ts, so no literal is secret-shaped.
const GH = 'ghp_' + 'a'.repeat(36)
const PASS = 'hunter2' + 'isgood'
const ph = (label: string, n = 1) => `⟦${label}_${n}⟧`
const ON = EXAMPLES.map(r => ({ ...r, enabled: true }))
const TWO = { 'vault:s1': { at: 39 * DAY, n: { API_KEY: 1, SECRET: 1 }, ph: { [ph('API_KEY')]: GH, [ph('SECRET')]: PASS }, by: { [ph('SECRET')]: 'rule: pass' } } }

const texts = async (m: any): Promise<string[]> => (await m.findAll({ type: "Text" })).map((t: any) => t.text as string)
const toasted = (on: any) => {
  const toasts: string[] = []
  on('ui.toast', (_$: any, e: any) => { toasts.push(e.text); return { value: undefined } as any })
  return toasts
}

test('desktop: sections are headings, with no rule of ─ drawn to a width of cells', async ($, on) => {
  world(on, TWO, { [RULES]: file(ON) })
  const m = await mount($, { surface: 'desktop' })
  await m.press({ key: 'tab-rules' })
  const all = await texts(m)
  expect(all.some(t => t.includes('─'))).toBe(false)
  expect((await m.findAll({ type: 'Text', text: 'Rules' })).some((t: any) => t.props.size === 'heading')).toBe(true)
  expect(await m.find({ type: 'Text', text: '2 of 2 on' })).toBeDefined()
})

test('desktop: no row cursor, no key line and no key hints; each row keeps its own buttons', async ($, on) => {
  world(on, TWO, { [RULES]: file(EXAMPLES) })
  const m = await mount($, { surface: 'desktop', isFocused: false })
  const session = await texts(m)
  expect(session).not.toContain('› ')
  expect(session.some(t => /↑↓|click the pane|\(r\)|[Pp]ress [a-z]\b/.test(t))).toBe(false)
  expect(await m.find({ key: 'cur-forget' })).toBeUndefined()
  expect(await m.find({ key: `forget-${ph('API_KEY')}` })).toBeDefined()
  expect(await m.find({ key: 'forget-all' })).toBeDefined()
  await m.press({ key: 'tab-rules' })
  expect(await m.find({ key: 'rule-turn' })).toBeUndefined()
  expect(await m.find({ key: 'turn-0' })).toBeDefined()
  expect(await m.find({ key: 'remove-0' })).toBeDefined()
  expect(await texts(m)).not.toContain('› ')
})

test('desktop: the status says what masks without a key to press', async ($, on) => {
  world(on, {}, { [RULES]: file(EXAMPLES) })
  const m = await mount($, { surface: 'desktop' })
  expect((await texts(m)).find(t => /^[●○] /.test(t))).toBe('● On: env files only, no rules')
})

test('desktop: still placeholders and lengths, never a value', async ($, on) => {
  world(on, TWO, { [RULES]: file(ON) })
  const m = await mount($, { surface: 'desktop' })
  const all = (await texts(m)).join('\n')
  expect(all).not.toContain(GH)
  expect(all).not.toContain(PASS)
  expect(all).toContain('40 chars')
})

const widget = ($: any) => $.ui.mount({ plugin: 'redact', surface: 'desktop', component: 'Pane', requestId: 'redact', props: { ...PROPS, placement: 'widget', anchoredEdges: ['bottom', 'right'] } })

test('widget: a glance of the status and the count, no buttons, no value, no rule text', async ($, on) => {
  world(on, TWO, { [RULES]: file(ON) })
  const m = await widget($)
  const all = (await texts(m)).join('\n')
  expect(all).toContain('● redact')
  expect(all).toContain('2 masked')
  expect(all).toContain('2 rules')
  expect(all).not.toContain(GH)
  expect(all).not.toContain(PASS)
  expect(all).not.toContain('chars')
  expect(await m.find({ type: 'Button' })).toBeUndefined()
})

test('widget: off says so as a warning', async ($, on) => {
  world(on, {}, { [RULES]: file(EXAMPLES, { envFiles: false }) })
  const m = await widget($)
  const off = await m.find({ type: 'Text', text: /redact off/ })
  expect(off?.props.color).toBe('warning')
})

let menus = 0
const menu = ($: any, props: object) => $.ui.mount({ plugin: 'redact', surface: 'desktop', component: 'ContextMenu', requestId: `menu${++menus}`, props })

test('menu: no selection, no rows', async ($, on) => {
  world(on)
  const m = await menu($, { link: { href: 'https://example.com/' } })
  expect(await m.find({ type: 'Button' })).toBeUndefined()
})

test('menu: test the selection opens the pane on Rules with it as the sample', async ($, on) => {
  world(on, {}, { [RULES]: file(ON) })
  const opened: any[] = []
  on('ui.open', (_$: any, e: any) => { opened.push(e); return { value: { isPlaced: true } } as any })
  const m = await menu($, { selection: { text: `token ${GH} here` } })
  await m.press({ key: 'redact-test' })
  expect(opened).toHaveLength(1)
  const pane = await mount($, { surface: 'desktop' })
  expect((await pane.find({ key: 'test' }))?.props.value).toBe(`token ${GH} here`)
  expect((await texts(pane)).join('\n')).toContain(`Claude gets: token ${ph('API_KEY')} here`)
})

test('menu: mask the selection puts it in the vault, so later text masks it, and says older rows keep it', async ($, on) => {
  const { store } = world(on, {}, { [RULES]: file(EXAMPLES, { envFiles: false }) })
  const toasts = toasted(on)
  let sent = ''
  on('prompt.submit', (_$: any, e: any) => { sent = e.text; return { text: e.text } })
  const m = await menu($, { selection: { text: `  ${PASS}\n` } })
  await m.press({ key: 'redact-mask' })
  expect((store.get('vault:s1') as any).ph[ph('SECRET')]).toBe(PASS)
  expect(toasts.at(-1)).toMatch(new RegExp(`masked as ${ph('SECRET').replace(/[[\]⟦⟧]/g, '.')} from now on.*already sent`))
  await $.prompt.submit({ text: `log in with ${PASS}`, origin: { kind: 'composer' } } as any)
  expect(sent).toBe(`log in with ${ph('SECRET')}`)
})

test('menu: a value already masked is not masked twice', async ($, on) => {
  const { store } = world(on, TWO)
  const toasts = toasted(on)
  const m = await menu($, { selection: { text: PASS } })
  await m.press({ key: 'redact-mask' })
  expect((store.get('vault:s1') as any).n.SECRET).toBe(1)
  expect(toasts.at(-1)).toMatch(/already masked/)
})

test('menu: no mask row for a placeholder, a selection with one, or one with no letter or digit', async ($, on) => {
  world(on, TWO)
  for (const text of [ph('API_KEY'), `key ${ph('API_KEY')} and more`, '...', '  '])
    expect(await (await menu($, { selection: { text } })).find({ key: 'redact-mask' })).toBeUndefined()
})

let chips = 0
const chip = ($: any, surface: 'desktop' | 'terminal', maxColumns = 40) =>
  $.ui.mount({ plugin: 'redact', surface, component: 'BesidePrompt', requestId: `beside${++chips}`, props: { maxColumns, floatRows: 0, floatColumns: 0, isWorking: false, view: {} } })

test('chip: beside the desktop message box, on in green', async ($, on) => {
  world(on, {}, { [RULES]: file(ON) })
  const m = await chip($, 'desktop')
  expect(await m.find({ key: 'redact-chip' })).toBeDefined()
  expect((await m.find({ type: 'Text', text: '●' }))?.props.color).toBe('green')
  expect((await texts(m)).join('')).toContain('● redact')
})

test('chip: off as a warning; none on the terminal (its status line has it), none without room', async ($, on) => {
  world(on, {}, { [RULES]: file(EXAMPLES, { envFiles: false }) })
  expect((await (await chip($, 'desktop')).find({ type: 'Text', text: /redact off/ }))?.props.color).toBe('warning')
  expect(await (await chip($, 'terminal')).find({ key: 'redact-chip' })).toBeUndefined()
  expect(await (await chip($, 'desktop', 4)).find({ key: 'redact-chip' })).toBeUndefined()
})
