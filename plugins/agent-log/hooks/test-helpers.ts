// What the agent-log test files share: a store stub, its flush, a pane and a row builder. agent-log.test.ts keeps its own
import type { TestBody } from 'claude-code/testing'

type Engine = Parameters<TestBody>[0] // a test's `$`
export const wait = (ms: number) => new Promise(res => (globalThis as any).setTimeout(res, ms)) // no DOM or node lib in this tsconfig
// a store the test reads back: what agent-log wrote, by key. session.end flushes the log's last second. panes: [] for a closed
// pane, so the band shows the note. id: a function for a test that switches session
export const capture = (on: any, id: string | (() => string), panes = [{ id: 'agent-log' }]) => {
  const db: Record<string, any> = {}
  on('session.id', () => ({ value: typeof id === 'function' ? id() : id }))
  on('agent.list', () => ({ value: [] }))
  on('config.list', () => ({ value: [] }))
  on('ui.panes', () => ({ value: panes }))
  on('store.get', (_$: any, e: any) => ({ value: db[e.key] }))
  on('store.set', (_$: any, e: any) => { db[e.key] = e.value; return { value: undefined } })
  on('store.delete', (_$: any, e: any) => { delete db[e.key]; return { value: undefined } })
  on('store.keys', () => ({ value: Object.keys(db) }))
  on('session.end', (_$: any, e: any) => ({ sessionId: e.sessionId }))
  return db
}
export const flushed = async ($: any, id: string, db: Record<string, any>) => { await $.session.end({ reason: 'other', sessionId: id }); return (db[`r:${id}`]?.entries ?? []) as any[] }
export const pane = ($: Engine, cols = 160) => $.ui.mount({ plugin: 'agent-log', surface: 'terminal', component: 'Pane', requestId: 'agent-log', props: { title: 'Agent log', isFocused: false, placement: 'dock', bodyColumns: cols, scroll: { offset: 0, bodyRows: 40 } } as any })
// a row for splitOf: main's Agent row carries the agent it spawned as child; that agent's rows carry it as agent
export const x = (t: number, kind: string, ms: number | undefined, extra: object = {}) => ({ t, kind, name: 'Read', detail: '', outcome: '', ms, ...extra })
