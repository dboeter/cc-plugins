import { test, expect } from 'claude-code/testing'
import { keyOf } from './notepad'
import { apply, layout, offsetAt, rowOf, topFor, type Editor } from './editor'

const PROPS = { title: 'Notepad', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 10 } } as any
const mount = ($: any, surface: 'terminal' | 'desktop' | 'mobile' | 'vscode' = 'terminal') =>
  $.ui.mount({ plugin: 'notepad', surface, component: 'Pane', requestId: 'notepad', props: PROPS })
// nothing beneath the plugin answers the store in a test: stand one in, and the project root
const engine = (on: any, root: string, store = new Map<string, unknown>()) => {
  on('session.root', () => ({ value: root }))
  on('store.get', (_$: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_$: any, e: any) => { store.set(e.key, e.value); return { value: undefined } })
  return store
}
const click = (m: any, x: number, y: number) => m.pointer({ type: 'down', button: 'left', x, y, in: 'editor' })
const keys = async (m: any, ...ks: string[]) => { for (const key of ks) await m.key({ key, in: 'editor' }) }
const ed = (text: string, cur = text.length): Editor => ({ text, cur })
const k = (key: string, mods: { ctrl?: true } = {}) => ({ key, ...mods })

test('wraps at one column less than the width, so a full line needs no blank row for the cursor', () => {
  expect(layout('abcd\n\nxy', 5)).toEqual([
    { start: 0, len: 4, final: true },
    { start: 5, len: 0, final: true },
    { start: 6, len: 2, final: true },
  ])
  expect(layout('abcdefghij', 5).map(r => r.len)).toEqual([4, 4, 2])
  const rows = layout('abcdefgh', 5)
  expect([rowOf(rows, 4), rowOf(rows, 8)]).toEqual([1, 1]) // a full row's end is the next row's start; a final row's end its own
  expect(offsetAt(rows, 0, 99)).toBe(3)
})

test('keys edit at the cursor: Enter a newline, Backspace and Delete one character, an emoji whole', () => {
  expect(apply(ed('ab', 1), k('return'), 20, 5)).toEqual({ text: 'a\nb', cur: 2 })
  expect(apply(ed('ab', 1), k('backspace'), 20, 5)).toEqual({ text: 'b', cur: 0 })
  expect(apply(ed('ab', 1), k('delete'), 20, 5)).toEqual({ text: 'a', cur: 1 })
  expect(apply(ed('a😀'), k('backspace'), 20, 5)).toEqual({ text: 'a', cur: 1 })
  expect(apply(ed('a😀', 1), k('right'), 20, 5).cur).toBe(3)
  expect(apply(ed('ab', 1), k('x\r\ny\tz'), 20, 5)).toEqual({ text: 'ax\ny  zb', cur: 7 }) // a paste
  expect(apply(ed('ab', 1), k('space'), 20, 5)).toEqual({ text: 'a b', cur: 2 }) // the engine names it, as it does `return`
  expect(apply(ed('ab'), k('f5'), 20, 5)).toEqual(ed('ab'))
  const same = ed('ab')
  expect(apply(same, k('x', { ctrl: true }), 20, 5)).toBe(same)
})

test('up and down keep the column across shorter lines; home, end, ctrl+a and ctrl+e stay on the line', () => {
  const down = apply(ed('abcdef\nx\nabcdef', 4), k('down'), 20, 5)
  expect(down).toEqual({ text: 'abcdef\nx\nabcdef', cur: 8, goal: 4 })
  expect(apply(down, k('down'), 20, 5).cur).toBe(13)
  expect(apply(ed('ab\ncd\nef', 4), k('home'), 20, 5).cur).toBe(3)
  expect(apply(ed('ab\ncd\nef', 4), k('e', { ctrl: true }), 20, 5).cur).toBe(5)
})

test('the view scrolls only as far as the cursor needs', () => {
  const text = 'a\nb\nc\nd\ne\nf'
  expect(topFor(ed(text, 10), 0, 20, 3)).toBe(3)
  expect(topFor(ed(text, 6), 3, 20, 3)).toBe(3)
  expect(topFor(ed(text, 0), 3, 20, 3)).toBe(0)
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: the note opens rendered; a click edits it, keys save it, Preview renders it again`, async ($, on) => {
    const store = engine(on, '/repo/a', new Map([[keyOf('/repo/a'), '# Todo']]))
    const m = await mount($, surface)
    expect(await m.find({ type: 'Markdown', in: 'editor' })).toMatchObject({ props: { text: '# Todo' } })
    await click(m, 3, 0)
    await keys(m, 'return', '-', ' ', 's', 'h', 'i', 'p')
    expect(store.get(keyOf('/repo/a'))).toBe('# Todo\n- ship')
    await click(m, 0, 1) // the cursor to the first row's start
    await keys(m, '>')
    expect(store.get(keyOf('/repo/a'))).toBe('># Todo\n- ship')
    await click(m, 0, 0) // the Preview row
    expect(await m.find({ type: 'Markdown', in: 'editor' })).toMatchObject({ props: { text: '># Todo\n- ship' } })
  })
}

test('another project gets its own empty note, and a click starts it', async ($, on) => {
  const store = engine(on, '/repo/b', new Map([[keyOf('/repo/a'), 'a only']]))
  const m = await mount($)
  expect(await m.find({ text: /Click here to write/, in: 'editor' })).toBeDefined()
  await click(m, 0, 0)
  await keys(m, 'b')
  expect(store.get(keyOf('/repo/b'))).toBe('b')
  expect(store.get(keyOf('/repo/a'))).toBe('a only')
})

test('vscode, which has no Client, edits in the engine field', async ($, on) => {
  const store = engine(on, '/repo/a')
  const m = await mount($, 'vscode')
  await $.ui.input({ plugin: 'notepad', key: 'notes', text: 'v', kind: 'change' })
  expect(store.get(keyOf('/repo/a'))).toBe('v')
  expect(await m.find({ key: 'notes' })).toBeDefined()
})

test('mobile, which has neither, shows the note rendered and read-only', async ($, on) => {
  engine(on, '/repo/a', new Map([[keyOf('/repo/a'), '# a only']]))
  const m = await mount($, 'mobile')
  expect(await m.find({ type: 'Markdown' })).toMatchObject({ props: { text: '# a only' } })
})
