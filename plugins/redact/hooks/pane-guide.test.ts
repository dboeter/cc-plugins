import { test, expect } from 'claude-code/testing'

// The world beneath the plugin, as in redact.test.ts: one session, a store, HOME at /h and no files.
const world = (on: any) => {
  const store = new Map<string, unknown>()
  on('session.id', () => ({ value: 's1' }))
  on('store.get', (_$: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_$: any, e: any) => { store.set(e.key, e.value); return { value: undefined } })
  on('store.delete', (_$: any, e: any) => { store.delete(e.key); return { value: undefined } })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('env.get', (_$: any, e: any) => ({ value: e.name === 'HOME' ? '/h' : undefined }))
  on('fs.exists', () => ({ value: false }))
  on('fs.read', (_$: any, e: any) => { throw new Error(`ENOENT ${e.path}`) })
}
const PROPS = { title: 'redact', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 } } as any
const mount = ($: any) => $.ui.mount({ plugin: 'redact', surface: 'terminal', component: 'Pane', requestId: 'redact', props: PROPS })

test('the guide opens with How it works and lists forget under Placeholders & escaping', async ($, on) => {
  world(on)
  const m = await mount($)
  await m.press({ key: 'tab-help' })
  const titles = await m.findAll({ type: 'Text', text: /^(How it works|Rule format|Placeholders & escaping|Where real values go)$/ })
  expect(titles.map((t: any) => t.text)).toEqual(['How it works', 'Rule format', 'Placeholders & escaping', 'Where real values go'])
  expect(await m.find({ type: 'Text', text: /^ {2}forget {8}drops a value from the vault; a call naming its placeholder is refused/ })).toBeDefined()
})
