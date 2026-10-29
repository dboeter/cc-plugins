// What the pane-*.test.ts files share, as redact.test.ts has it: the world beneath the plugin and
// the pane mounted. redact.test.ts keeps its own.
import { mock } from 'claude-code/testing'

export const DAY = 24 * 3600 * 1000
export const RULES = '/h/.claude/redact-rules.json'
// a rules file of these rules, its other keys (envFiles) beside them
export const file = (rules: unknown[], rest: object = {}) => JSON.stringify({ rules, ...rest }, null, 2) + '\n'

// One session, a clock, a store of `entries` and files of `given`, HOME at /h, and the session's
// folder at `cwd`.
export const world = (on: any, entries: Record<string, unknown> = {}, given: Record<string, string> = {}, cwd = '/p') => {
  const store = new Map(Object.entries(entries))
  const files = new Map(Object.entries(given))
  mock.clock(on, { now: 40 * DAY })
  on('session.id', () => ({ value: 's1' }))
  on('session.cwd', () => ({ value: cwd }))
  on('store.get', (_$: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_$: any, e: any) => { store.set(e.key, e.value); return { value: undefined } })
  on('store.delete', (_$: any, e: any) => { store.delete(e.key); return { value: undefined } })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('env.get', (_$: any, e: any) => ({ value: e.name === 'HOME' ? '/h' : undefined }))
  on('fs.exists', (_$: any, e: any) => ({ value: files.has(e.path) }))
  on('fs.read', (_$: any, e: any) => { if (!files.has(e.path)) throw new Error(`ENOENT ${e.path}`); return { value: files.get(e.path) } })
  on('fs.write', (_$: any, e: any) => { files.set(e.path, e.text); return { value: undefined } })
  on('fs.stat', (_$: any, e: any) => ({ value: { kind: 'file', size: files.get(e.path)?.length ?? 0, mtimeMs: 0, isLink: false, realPath: e.path } }))
  return { store, files }
}

export const PROPS = { title: 'redact', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 } } as any
export const mount = ($: any, { surface = 'terminal', bodyColumns = 80 } = {}) =>
  $.ui.mount({ plugin: 'redact', surface, component: 'Pane', requestId: 'redact', props: { ...PROPS, bodyColumns } })
