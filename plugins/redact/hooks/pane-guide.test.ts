import { test, expect } from 'claude-code/testing'
import { mount, world } from './pane-helpers'

// Help is a toggle on each tab (h), off by default; /redact help opens Session with it on.
test('help is off by default; h shows it on Rules too, with how to write a rule', async ($, on) => {
  world(on)
  const m = await mount($)
  expect((await m.find({ key: 'help' }))?.props).toMatchObject({ label: 'help', hotkey: 'h' })
  await m.press({ key: 'tab-rules' })
  expect(await m.find({ text: /^Writing a rule$/ })).toBeUndefined()
  await m.press({ key: 'help' })
  expect(await m.find({ text: /^Writing a rule$/ })).toBeDefined()
})

test('/redact help opens Session with help on; /redact guide too', async ($, on) => {
  world(on)
  on('ui.open', () => ({ value: { isPlaced: true } }) as any)
  for (const word of ['help', 'guide']) {
    await $.command.run({ command: 'redact', args: word } as any)
    const m = await mount($)
    expect(await m.find({ text: /^How redact works$/ })).toBeDefined()
    await m.press({ key: 'help' })
    await m.unmount()
  }
})
