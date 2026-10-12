// The pane's state contract: the reduced session (model), which page is shown (view), whether the help lines are open
// (help), the path the diff page shows (diff) and the recap being drafted (recap). Self-contained: model.ts imports these
export type Hunk = { oldStart: number; newStart: number; lines: string[] }
export type FileChange = { path: string; isNew: boolean; t: number; hunks?: Hunk[]; byShell?: true }
export type Check = { name: string; ok: boolean; line: string; t: number; cmd: string }
// How much of a source the next response can see. full / excerpt: read in this window; earlier: read before a summary;
// unrestored: the engine said it was not brought back; changed: edited on disk since it was read
export type SourceNote = 'full' | 'excerpt' | 'earlier' | 'unrestored' | 'changed' | 'summary' | 'loaded'
export type Source = { key: string; group: 'instructions' | 'files' | 'conversation'; label: string; note: SourceNote; t: number }
export type Todo = { content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm: string }
// keep: what to keep in mind, each with the message it came from. done: what finished looks like. isDraft: the title is
// the first sentence of your prompt, until the small model has condensed it
export type Goal = { title: string; keep: { text: string; from: string }[]; done?: string; from: string; text: string; isDraft: boolean }
export type Est = { conversation: number; files: number; results: number } // characters, since the last summary
export type SessionModel = {
  sessionId?: string // whose model this is: a restored value from another session is ignored
  goal?: Goal
  prompts: number // your prompts this session
  lastPrompt?: string
  running: boolean
  ended?: 'answer' | 'aborted' | 'refusal' | 'error'
  waits: Record<string, string> // tool_use_id -> what Claude is waiting on you for
  // tool_use_id -> a call whose check said ask: put to the mode's decider, which is the auto-mode classifier as often as
  // you. It becomes a wait once the permission request passes unanswered, as the dialog opens
  asking: Record<string, { tool: string; input: string; text: string }>
  activity?: string
  todos: Todo[]
  files: FileChange[]
  checks: Check[] // the newest of each name
  lastEdit: number // when the newest file change landed; a check older than it is stale
  context: { percent?: number; window?: number; tokens?: number }
  est: Est
  sources: Source[]
  summary?: string // the newest compaction's summary text
  compactions: number
  cost?: number // USD
  onPlan: boolean // rateLimits reported: a subscription, where a dollar figure means nothing to the person
}
export type View = 'overview' | 'goal' | 'context' | 'changes' | 'diff' | 'recap' | 'details'
export type Recap = { status: 'idle' | 'drafting' | 'ready' | 'applying' | 'applied' | 'failed'; text: string; note?: string }

declare module 'claude-code' {
  interface PluginState {
    'session-pane': { model: SessionModel; view: View; help: boolean; diff: string; recap: Recap }
  }
}
