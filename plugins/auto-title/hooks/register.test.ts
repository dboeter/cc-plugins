import { test, expect } from 'claude-code/testing'

type Reply = { isAnswered: true; text: string } | { isAnswered: false; reason: string }

const stub = (on: any, text: string | Reply, modelError?: string) => {
  const reply: Reply = typeof text === 'string' ? { isAnswered: true, text } : text
  const seen = { haiku: 0, renamed: 0, toasts: [] as string[] }
  on('classic.SessionStart', () => ({}))
  on('classic.UserPromptSubmit', () => ({}))
  on('model.complete', () => {
    seen.haiku++
    if (modelError) throw new Error(modelError)
    return { value: { ...reply, usage: { input_tokens: 1, output_tokens: 1 } } }
  })
  on('command.run', { command: 'rename' }, () => {
    seen.renamed++
    return { text: '' }
  })
  on('ui.toast', (_$: any, e: any) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  return seen
}

test('titles the first prompt after /clear via sessionTitle, once, without /rename', async ($, on) => {
  const seen = stub(on, '"Fix login redirect bug."\n')
  await $.classic.SessionStart({ source: 'clear' })
  const first = await $.classic.UserPromptSubmit({ prompt: 'the login redirect loops' })
  expect(first.sessionTitle).toBe('Fix login redirect bug')
  const second = await $.classic.UserPromptSubmit({ prompt: 'and another thing' })
  expect(second.sessionTitle).toBe(undefined)
  expect(seen.haiku).toBe(1)
  expect(seen.renamed).toBe(0)
})

test('skips slash commands and resume', async ($, on) => {
  const seen = stub(on, 'Title')
  await $.classic.SessionStart({ source: 'resume' })
  await $.classic.UserPromptSubmit({ prompt: 'hello' })
  await $.classic.SessionStart({ source: 'startup' })
  await $.classic.UserPromptSubmit({ prompt: '/model' })
  expect(seen.haiku).toBe(0)
  const r = await $.classic.UserPromptSubmit({ prompt: 'hello' })
  expect(r.sessionTitle).toBe('Title')
})

test('caps a long reply to 5 words and 40 chars', async ($, on) => {
  stub(on, 'Investigating extraordinarily complicated authentication middleware regressions today')
  await $.classic.SessionStart({ source: 'clear' })
  const t = (await $.classic.UserPromptSubmit({ prompt: 'x' })).sessionTitle!
  expect(t.split(' ').length <= 5 && t.length <= 40).toBe(true)
})

test('an unanswered reply sets no title and toasts the reason', async ($, on) => {
  const seen = stub(on, { isAnswered: false, reason: 'api-error' })
  await $.classic.SessionStart({ source: 'startup' })
  const r = await $.classic.UserPromptSubmit({ prompt: 'hello' })
  expect(r.sessionTitle).toBe(undefined)
  expect(seen.toasts).toEqual(['auto-title: no title (api-error)'])
})

test('a blank reply sets no title and toasts', async ($, on) => {
  const seen = stub(on, '""')
  await $.classic.SessionStart({ source: 'startup' })
  const r = await $.classic.UserPromptSubmit({ prompt: 'hello' })
  expect(r.sessionTitle).toBe(undefined)
  expect(seen.toasts).toEqual(['auto-title: no title (blank)'])
})

test('after /compact a session with a title keeps it', async ($, on) => {
  const seen = stub(on, 'Title')
  await $.classic.SessionStart({ source: 'compact' })
  const r = await $.classic.UserPromptSubmit({ prompt: 'hello', session_title: 'My title' })
  expect(seen.haiku).toBe(0)
  expect(r.sessionTitle).toBe(undefined)
})

test('after /compact an untitled session is named', async ($, on) => {
  stub(on, 'Title')
  await $.classic.SessionStart({ source: 'compact' })
  const r = await $.classic.UserPromptSubmit({ prompt: 'hello' })
  expect(r.sessionTitle).toBe('Title')
})

test('a failing model call toasts and lets the prompt through', async ($, on) => {
  const seen = stub(on, 'Title', 'boom')
  await $.classic.SessionStart({ source: 'startup' })
  const r = await $.classic.UserPromptSubmit({ prompt: 'hello' })
  expect(r.sessionTitle).toBe(undefined)
  expect(seen.toasts.length).toBe(1)
  expect(seen.toasts[0]!.startsWith('auto-title: no title')).toBe(true)
})
