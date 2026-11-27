import { test, expect } from 'claude-code/testing'
import { mount, world } from './pane-helpers'

test('Help opens with what redact does, then how to start, how to write a rule, and what is good to know', async ($, on) => {
  world(on)
  const m = await mount($)
  await m.press({ key: 'tab-help' })
  expect((await m.find({ key: 'tab-help' }))?.props.label).toBe('Help')
  const titles = await m.findAll({ type: 'Text', text: /^(What redact does|Getting started|Writing a rule|Good to know)$/ })
  expect(titles.map((t: any) => t.text)).toEqual(['What redact does', 'Getting started', 'Writing a rule', 'Good to know'])
  expect(await m.find({ type: 'Text', text: /^ {2}forget {13}$/ })).toBeDefined()
  expect(await m.find({ type: 'Text', text: /^drops a value: Claude can no longer use its placeholder/ })).toBeDefined()
})
