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

test('desktop: help names no key either, on either tab', async ($, on) => {
  world(on, TWO, { [RULES]: file(EXAMPLES) })
  const m = await mount($, { surface: 'desktop' })
  await m.press({ key: 'help' })
  for (const tab of ['tab-session', 'tab-rules']) {
    await m.press({ key: tab })
    expect((await texts(m)).filter(t => /↑↓|click the pane|\([a-z]\)|[Pp]ress [a-z]\b/.test(t))).toEqual([])
  }
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
  expect(toasts.at(-1)).toMatch(new RegExp(`masked as ${ph('SECRET').replace(/[[\]⟦⟧]/g, '.')}: this exact text, as a whole word, from now on.*already sent`))
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

test('menu: no mask row for a placeholder, a selection with one, one with no letter or digit, or one under 4 characters', async ($, on) => {
  world(on, TWO)
  for (const text of [ph('API_KEY'), `key ${ph('API_KEY')} and more`, '...', '  ', 'the', ' a '])
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

// ---- After the council review

test('desktop: no button carries a hotkey, as no key is named', async ($, on) => {
  world(on, TWO, { [RULES]: file(EXAMPLES) })
  const m = await mount($, { surface: 'desktop' })
  for (const tab of ['tab-session', 'tab-rules']) {
    await m.press({ key: tab })
    expect((await m.findAll({ type: 'Button' })).filter((b: any) => b.props.hotkey)).toEqual([])
  }
})

test('test preview runs against the vault: a held value masks, a held placeholder stays, and the field is left empty off the terminal', async ($, on) => {
  world(on, TWO, { [RULES]: file(EXAMPLES, { envFiles: false }) })
  on('ui.open', () => ({ value: { isPlaced: true } }) as any)
  await (await menu($, { selection: { text: `use ${PASS} and ${ph('API_KEY')}` } })).press({ key: 'redact-test' })
  const m = await mount($, { surface: 'desktop' })
  // masked in the field, an edit beside the placeholder would test as masked where the real text is not
  expect((await m.find({ key: 'test' }))?.props.value).toBe('')
  const all = (await texts(m)).join('\n')
  expect(all).toContain(`Claude gets: use ${ph('SECRET')} and ${ph('API_KEY')}`)
  expect(all).not.toContain(PASS)
  // the held value counts as a match; the placeholder the sample carried does not
  expect(all).toContain('1 matched')
})

test('/redact test answers as the pane does: a held value masks in the toast too', async ($, on) => {
  world(on, TWO, { [RULES]: file(EXAMPLES, { envFiles: false }) })
  on('ui.open', () => ({ value: { isPlaced: true } }) as any)
  const toasts = toasted(on)
  await $.command.run({ command: 'redact', args: `test login ${PASS}` } as any)
  expect(toasts.at(-1)).toContain(`login ${ph('SECRET')}`)
  expect(toasts.at(-1)).not.toContain(PASS)
})

test('chip: a warning too long for the gutter says less rather than vanishing', async ($, on) => {
  world(on, {}, { [RULES]: '{ not json' })
  expect((await (await chip($, 'desktop', 14)).find({ type: 'Text', text: / redact off$/ }))?.props.color).toBe('warning')
})

test('menu: a pick the vault cannot save is taken out again, and the toast says not masked', async ($, on) => {
  const { store } = world(on, {}, { [RULES]: file(EXAMPLES, { envFiles: false }) }, '/p', 'disk full')
  const toasts = toasted(on)
  let sent = ''
  on('prompt.submit', (_$: any, e: any) => { sent = e.text; return { text: e.text } })
  await (await menu($, { selection: { text: PASS } })).press({ key: 'redact-mask' })
  // the kit reports a hook that throws as no implementation, so the reason's words are its own
  expect(toasts.at(-1)).toMatch(/^redact: not masked, the vault could not be read or saved \(.+\)$/)
  expect(store.get('vault:s1')).toBeUndefined()
  // and a second press tries again rather than saying it is already masked
  await (await menu($, { selection: { text: PASS } })).press({ key: 'redact-mask' })
  expect(toasts.at(-1)).toMatch(/^redact: not masked/)
  // the vault is left as it was, clean: a prompt that masks nothing still goes
  const r: any = await $.prompt.submit({ text: 'plain words', origin: { kind: 'composer' } } as any)
  expect(r?.drop).toBeUndefined()
  expect(sent).toBe('plain words')
})

test('widget: a pick while it shows updates its count', async ($, on) => {
  world(on, {}, { [RULES]: file(ON) })
  const w = await widget($)
  expect((await texts(w)).join('\n')).toContain('0 masked')
  await (await menu($, { selection: { text: PASS } })).press({ key: 'redact-mask' })
  expect((await texts(w)).join('\n')).toContain('1 masked')
})

test('menu: no mask row for part of a placeholder', async ($, on) => {
  world(on, TWO)
  expect(await (await menu($, { selection: { text: 'API_KEY_1⟧ failed' } })).find({ key: 'redact-mask' })).toBeUndefined()
})

test('chip: a broken rules file says so as a warning', async ($, on) => {
  world(on, {}, { [RULES]: '{ not json' })
  expect((await (await chip($, 'desktop')).find({ type: 'Text', text: /rules broken/ }))?.props.color).toBe('warning')
})

// ---- Round 3: no value the vault holds is drawn off the terminal, however it stands in a sample

const testOn = async ($: any, on: any, sample: string, entries: Record<string, unknown> = TWO) => {
  world(on, entries, { [RULES]: file(EXAMPLES, { envFiles: false }) })
  on('ui.open', () => ({ value: { isPlaced: true } }) as any)
  await (await menu($, { selection: { text: sample } })).press({ key: 'redact-test' })
  const m = await mount($, { surface: 'desktop' })
  return { m, all: (await texts(m)).join('\n'), field: (await m.find({ key: 'test' }))?.props.value }
}

test('a held value inside a word: hidden in the field and the preview, and a warning that Claude gets it as is', async ($, on) => {
  const { all, field } = await testOn($, on, `tok_${PASS}`)
  expect(field).toBe('')
  expect(all).not.toContain(PASS)
  expect(all).toContain(`Claude gets: tok_${ph('SECRET')}`)
  expect(all).toMatch(/Claude gets it as it is/)
})

test('a held placeholder beside its raw value: the new match still counts', async ($, on) => {
  const { all } = await testOn($, on, `${ph('SECRET')} then ${PASS}`)
  expect(all).toContain('1 matched')
})

test('a control character inside a held value is drawn as a mark, never joining the value', async ($, on) => {
  const V = 'demo' + '-4242x'
  const held = { 'vault:s1': { at: 39 * DAY, n: { SECRET: 1 }, ph: { [ph('SECRET')]: V } } }
  const { all, field } = await testOn($, on, 'demo\u0000-4242x', held)
  expect(all).not.toContain(V)
  expect(field ?? '').not.toContain(V)
  expect(all).toContain('demo�-4242x')
})

// ---- Round 4: every drawing off the terminal hides held values, and no cleanup step forms one

test('desktop: a rule written around a held value (\\bV\\b) shows its placeholder on Rules and in the Session heading', async ($, on) => {
  const src = `\\b${PASS}\\b`
  world(on, { 'vault:s1': { at: 39 * DAY, n: { SECRET: 1 }, ph: { [ph('SECRET')]: PASS }, by: { [ph('SECRET')]: `rule: ${src}` } } },
    { [RULES]: file([{ pattern: src, enabled: true }]) })
  const m = await mount($, { surface: 'desktop' })
  expect((await texts(m)).join('\n')).not.toContain(PASS)
  await m.press({ key: 'help' })
  await m.press({ key: 'tab-rules' })
  expect((await texts(m)).join('\n')).not.toContain(PASS)
})

test('the /redact test toast hides a held value inside a word and says Claude gets it as is', async ($, on) => {
  world(on, TWO, { [RULES]: file(ON) })
  on('ui.open', () => ({ value: { isPlaced: true } }) as any)
  const toasts = toasted(on)
  await $.command.run({ command: 'redact', args: `test tok_${PASS} and ${GH}` } as any)
  expect(toasts.at(-1)).not.toContain(PASS)
  expect(toasts.at(-1)).toMatch(/Claude gets it as it is/)
})

test('a held value holding � is not formed by drawing a control character as �', async ($, on) => {
  const V = 'demo' + '�-4242x'
  const held = { 'vault:s1': { at: 39 * DAY, n: { SECRET: 1 }, ph: { [ph('SECRET')]: V } } }
  const { all, field } = await testOn($, on, 'demo\u0000-4242x', held)
  expect(all).not.toContain(V)
  expect(field ?? '').not.toContain(V)
})

test('line ends: a CRLF sample draws as lines, not as �', async ($, on) => {
  const { all } = await testOn($, on, 'one\r\ntwo', {})
  expect(all).toContain('Claude gets: one\ntwo')
  expect(all).not.toContain('�')
})
