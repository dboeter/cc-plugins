// The pane's state contract: the reduced session (model), which page is shown (view), whether the help lines are open
// (help), the path the diff page shows (diff), the recap being drafted (recap), whether the pane is open (shown) and a rerun of stale checks (rerun). Self-contained: model.ts imports these
export type Hunk = { oldStart: number; newStart: number; lines: string[] }
export type FileChange = { path: string; isNew: boolean; t: number; hunks?: Hunk[]; byShell?: true }
// canRerun: cmd is the command exactly as run (scrub and the length cap left it alone), so the pane may run it again
export type Check = { name: string; ok: boolean; line: string; t: number; cmd: string; canRerun?: true }
// A subagent this session started (agent.spawn), followed by the agentId its loop's events carry. tokens: its turn's
// usage, known once it finished
export type Agent = { id: string; name: string; type?: string; status: 'running' | 'done' | 'stopped'; doing?: string; calls: number; tokens?: number; t: number }
// How much of a source the next response can see. full / excerpt: read in this window; earlier: read before a summary;
// unrestored: the engine said it was not brought back; changed: edited on disk since it was read
export type SourceNote = 'full' | 'excerpt' | 'earlier' | 'unrestored' | 'changed' | 'summary' | 'loaded'
export type Source = { key: string; group: 'instructions' | 'files' | 'conversation'; label: string; note: SourceNote; t: number }
// keep: what to keep in mind, each with the message it came from. done: what finished looks like. isDraft: the title is
// the first sentence of your opening message, until the small model has condensed it
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
  // you. It becomes a wait once the permission request passes unanswered, as the dialog opens. input: a digest of the
  // call's input, only for matching it to that request
  asking: Record<string, { tool: string; input: string; text: string }>
  files: FileChange[]
  checks: Check[] // the newest of each name
  lastEdit: number // when the newest file change landed; a check older than it is stale
  context: { percent?: number; window?: number; tokens?: number }
  // the window's tokens as each of your turns ended, since the last summary, newest last; and where auto-compact starts,
  // absent when it is off or not yet read. Together they predict the turns left before auto-compact (turnsLeft)
  turnTokens: number[]
  compactAt?: number
  est: Est
  sources: Source[]
  summary?: string // the newest compaction's summary text
  compactions: number
  cost?: number // USD
  agents: Agent[] // newest first
  onPlan: boolean // rateLimits reported: a subscription, where a dollar figure means nothing to the person
}
export type View = 'overview' | 'context' | 'changes' | 'diff' | 'recap' | 'details'
export type Rerun = { busy: boolean; note?: string; at?: number } // at: when the note was written; a check run after it retires it
export type Recap = { status: 'idle' | 'drafting' | 'ready' | 'applying' | 'applied' | 'failed'; text: string; note?: string }

declare module 'claude-code' {
  interface PluginState {
    'session-pane': { model: SessionModel; view: View; help: boolean; diff: string; recap: Recap; shown: boolean; rerun: Rerun }
  }
}
