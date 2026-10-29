import { test, expect } from 'claude-code/testing'
import { mount, world } from './pane-helpers'

test('the guide opens with How it works and lists forget under Placeholders & escaping', async ($, on) => {
  world(on)
  const m = await mount($)
  await m.press({ key: 'tab-help' })
  const titles = await m.findAll({ type: 'Text', text: /^(How it works|Rule format|Placeholders & escaping|Where real values go)$/ })
  expect(titles.map((t: any) => t.text)).toEqual(['How it works', 'Rule format', 'Placeholders & escaping', 'Where real values go'])
  expect(await m.find({ type: 'Text', text: /^ {2}forget {8}drops a value from the vault; a call naming its placeholder is refused/ })).toBeDefined()
})
