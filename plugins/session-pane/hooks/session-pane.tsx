import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'
import type { Recap, View } from '../types'
import { applyGoal, empty, GOAL_SYSTEM, goalPrompt, isNoise, isQuery, mergeShellEdits, recapNotes, reduce, replay, snapshotOf, whoOf, type SessionModel, type Seen } from './model'
import { draw, type Act, type Els } from './views'

// A pane that answers four questions about the session: what are we trying to do, what is Claude doing, what can it
// see, and what has changed. One `*` hook folds every event into a SessionModel (model.ts); a 2 s clock writes it to
// $.state, which redraws the pane, and to $.store, so a reload or a resume shows the same pane.
// Sections, in order (search `// ===`): STATE, CAPTURE, FLUSH, GOAL, RECAP, HOOKS

// === STATE ===
const PANE = 'session-pane'
const TITLE = 'Session'
const modelAtom = atom({ plugin: 'session-pane', key: 'model' } as const, empty())
const viewAtom = atom({ plugin: 'session-pane', key: 'view' } as const, 'overview' as View)
const helpAtom = atom({ plugin: 'session-pane', key: 'help' } as const, false)
const diffAtom = atom({ plugin: 'session-pane', key: 'diff' } as const, '')
const recapAtom = atom({ plugin: 'session-pane', key: 'recap' } as const, { status: 'idle', text: '' } as Recap)

let m: SessionModel = empty()
let dirty = false // an event changed m since the last flush
let ready: Promise<void> | undefined // restore has run for this session
let early: Seen[] | undefined = [] // events seen before restore finished, folded again onto what it restores
let sid: string | undefined
let shellSince: number | undefined // when the earliest Bash call that finished since the last scan began
let shellUntil = 0 // when the latest of them ended
let endedSid: string | undefined // the session a /clear or a resume ended: restore waits until the id has moved on
let cleared = false // the session being restored began with a /clear: empty, so every event since is in early
let goalQueue: { text: string; from: string }[] = []
let goalBusy = false
let timer: Timer | undefined

const KEEP_SESSIONS = 20 // snapshots kept in $.store; the oldest goes when a new session writes its first
const SLACK_MS = 2000 // a file's mtime may fall this far outside the calls' span and still count as written by them
const MAX_STATS = 200 // dirty files looked at per scan: a repo with thousands untracked costs no more than this
const snapKey = (id: string) => `snap:${id}`

// === CAPTURE ===
// The * hook: fold the event in before the chain runs and again with its result. It never changes e or the result, never
// writes state (a redraw is an event: writing from here would loop), and a failure of its own never reaches the chain.
// Declared at the top level: the loader only takes a hook it can see declared there
async function capture($: EngineInterface, e: unknown, next: any) {
  if (next.is('engine.create', e)) return next(e) // $ is the empty table there
  const ev: string = next.event
  const origin = next.origin
  // our own $ calls (model.complete, store.set, fs.read) and other plugins' polling never move the pane
  if (origin.plugin === PANE || isNoise(ev) || (origin.plugin !== 'engine' && isQuery(ev))) return next(e)
  const t0 = Date.now()
  fold({ ev, ph: 'enter', who: whoOf(ev, origin, e), e, t: t0 })
  let r: unknown
  try { r = await next(e) } catch (err) {
    fold({ ev, ph: 'exit', who: whoOf(ev, origin, e, 'exit'), e, r: undefined, t: Date.now() }) // a thrown call still stops waiting
    throw err
  } finally {
    if (ev === 'tool.call' && (e as any)?.tool === 'Bash') { shellSince = Math.min(shellSince ?? t0, t0); shellUntil = Date.now() } // scanned by the clock, never here
  }
  fold({ ev, ph: 'exit', who: whoOf(ev, origin, e, 'exit'), e, r, t: Date.now() })
  return r
}

function fold(x: Seen) {
  try {
    if (early) early.push(x)
    if (!reduce(m, x)) return
    dirty = true
    // a goal check per prompt of yours; the call runs from the clock, never inside the chain
    if (x.ev === 'prompt.submit' && x.who === 'you') goalQueue.push({ text: m.lastPrompt ?? '', from: m.prompts === 1 ? 'Your opening message' : `Your message ${m.prompts}` })
  } catch {}
}

// === FLUSH ===
// Brings back this session's model: from $.state after a hot reload (it keeps the diffs), else the $.store snapshot after a
// restart, else the transcript of a resumed session. Events seen meanwhile are folded again on top
async function restore($: EngineInterface): Promise<void> {
  const id = await $.session.id()
  if (id === endedSid) throw new Error('the ended session is still current') // the next flush tries again
  let got: SessionModel | undefined
  const held = await read($, modelAtom).catch(() => undefined)
  if (held?.sessionId === id) got = { ...empty(), ...held } // a field this load added is missing from what the last one held
  if (!got) {
    const snap = await $.store.get(snapKey(id)).catch(() => undefined) as SessionModel | undefined
    if (snap && typeof snap === 'object' && snap.sessionId === id) got = { ...empty(), ...snap }
  }
  if (!got) {
    got = empty()
    const msgs = cleared ? [] : await $.session.messages().catch(() => [])
    if (msgs.length) replay(got, msgs)
  }
  got.sessionId = id
  for (const x of early ?? []) reduce(got, x)
  early = undefined
  cleared = false
  m = got
  sid = id
  dirty = true
  // a draft never condensed (a replayed transcript, a call cut short by a restart) gets its goal call now
  const g = m.goal
  if (g?.isDraft && !goalQueue.some(q => q.text === g.text)) goalQueue.push({ text: g.text, from: g.from })
  // per session: the session after a /clear or a resume needs it again
  await $.command.register({ name: 'session-pane', description: 'Show or hide the session pane: your goal, what Claude is doing, context, and changes so far.' })
    .catch(err => { $.ui.log(`session-pane: /session-pane could not be registered: ${err}`) })
}

let flushing: Promise<void> | undefined
async function flushOnce($: EngineInterface): Promise<void> {
  await (ready ??= restore($).catch(() => { ready = undefined })) // failed (session.id rejected): the next flush tries again
  if (!sid) return
  if (shellSince !== undefined) {
    const since = shellSince
    shellSince = undefined
    // each at its own mtime, not the scan's: a check that ran after the edit stays current
    for (const f of await shellEdits($, since, shellUntil).catch(() => [])) if (mergeShellEdits(m, [f.path], f.t)) dirty = true
  }
  if (goalQueue.length && !goalBusy) void askGoal($)
  if (!dirty) return
  dirty = false
  const plain = JSON.parse(JSON.stringify(m)) as SessionModel // a copy: the live model keeps changing under the write
  await update($, modelAtom, () => plain)
  await remember($, snapshotOf(plain))
}
// Which files a shell command wrote is not in any event: the Bash call carries its command and output only. So, as a
// guess: every modified or untracked (not ignored) file in the session's repo whose mtime falls between the first
// scanned call's start and the last one's end. A write by someone else in that window is credited to the session; a
// repo other than the session's is not looked at. No git, no repo or no $.process (a surface other than the CLI): nothing
async function shellEdits($: EngineInterface, since: number, until: number): Promise<{ path: string; t: number }[]> {
  const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { timeoutMs: 5000 })
  if (top.exitCode !== 0) return []
  const root = top.stdout.trim()
  const ls = await $.process.run(['git', 'ls-files', '-z', '-m', '-o', '--exclude-standard'], { cwd: root, timeoutMs: 10_000 })
  if (ls.exitCode !== 0) return []
  const paths = [...new Set(ls.stdout.split('\0').filter(Boolean))].slice(0, MAX_STATS).map(p => `${root}/${p}`)
  const stats = await Promise.all(paths.map(p => $.fs.stat(p).then(s => s.mtimeMs, () => 0)))
  return paths.map((path, i) => ({ path, t: stats[i] ?? 0 })).filter(f => f.t >= since - SLACK_MS && f.t <= until + SLACK_MS)
}

const flush = ($: EngineInterface) => flushing ??= flushOnce($).finally(() => { flushing = undefined })

async function remember($: EngineInterface, snap: SessionModel) {
  if (!sid) return
  await $.store.set(snapKey(sid), snap)
  const recent = ((await $.store.get('recent').catch(() => undefined)) as string[] | undefined) ?? []
  if (recent[0] === sid) return
  const next = [sid, ...recent.filter(x => x !== sid)]
  for (const old of next.slice(KEEP_SESSIONS)) await $.store.delete(snapKey(old)).catch(() => {})
  await $.store.set('recent', next.slice(0, KEEP_SESSIONS))
}

// === GOAL ===
// One small-model call per prompt of yours, in order; a failed call leaves the goal as it was
async function askGoal($: EngineInterface) {
  goalBusy = true
  try {
    while (goalQueue.length) {
      const { text, from } = goalQueue.shift()!
      if (text.split(/\s+/).length < 3 && m.goal && !m.goal.isDraft) continue // "yes", "go on": never a new goal
      const at = sid
      const r = await $.model.complete({ model: 'haiku', system: GOAL_SYSTEM, prompt: goalPrompt(m, text), maxTokens: 300, timeoutMs: 20_000 }).catch(() => undefined)
      if (sid !== at) return // a /clear or a resume moved on: the answer is about the session before
      if (r?.isAnswered && applyGoal(m, r.text, text, from)) dirty = true
    }
  } finally { goalBusy = false }
}

// === RECAP ===
const RECAP_PROMPT = `Write a recap of this session so far, for continuing the work after older details are summarised.
Use these headings, each with short plain bullet points: Goal; Preferences and constraints; Decisions made; Progress so far; Still to do.
Only include what this conversation actually established. At most 250 words. No preamble.`

async function draftRecap($: EngineInterface) {
  await update($, recapAtom, () => ({ status: 'drafting', text: '' }))
  // what the pane folded from this session's events: a seed for what a summary may have dropped, not the source of truth
  const notes = recapNotes(m)
  const prompt = notes ? `${RECAP_PROMPT}\n\nNotes the session pane kept, which may help:\n<notes>\n${notes.slice(0, 6000)}\n</notes>` : RECAP_PROMPT
  const r = await $.model.fork({ prompt }).catch(err => ({ isAnswered: false as const, reason: String(err) }))
  const next: Recap = r.isAnswered ? { status: 'ready', text: r.text.trim() }
    : { status: 'failed', text: '', note: r.reason === 'nothing-to-fork' ? 'Nothing to recap yet: send a message first.' : `Couldn't draft a recap (${r.reason}).` }
  await update($, recapAtom, () => next)
}

async function useRecap($: EngineInterface) {
  const r = await read($, recapAtom)
  if (r.status !== 'ready') return
  await update($, recapAtom, () => ({ ...r, status: 'applying' }))
  const before = m.compactions
  const res = await $.session.compact({ instructions: `Carry this recap, reviewed by the person, into the summary faithfully:\n\n${r.text}` }).catch(err => ({ skip: String(err) }))
  // our own $ call: capture skips its events, so the compaction is folded here, unless capture saw it after all
  if (!res.skip && m.compactions === before) fold({ ev: 'session.compact', ph: 'exit', who: 'engine', e: { trigger: 'plugin' }, r: res, t: Date.now() })
  await update($, recapAtom, () => res.skip ? { ...r, status: 'failed', note: `The summary didn't run: ${res.skip}` } : { ...r, status: 'applied' })
}

// === HOOKS ===
export const register: Register = on => {
  on('*', capture)

  // Once per process and per fresh load of this module, never after a /clear or a resume: session.end starts those over.
  // A reload finds its own session in $.state
  on('session.start', async ($, e, next) => {
    timer ??= $.clock.every(2000, () => { flush($).catch(() => {}) })
    await (ready ??= restore($).catch(() => { ready = undefined }))
    return next(e) // never opens the pane: only /session-pane does
  })

  on('session.end', async ($, e, next) => {
    shellSince = undefined // the exit's time bound is short and shared: no git scan now
    try { await flush($); await flush($) } catch {} // the second catches changes made while an in-flight flush was writing
    if (e.reason === 'clear' || e.reason === 'resume') {
      // the process goes on under a new session id and no session.start follows: the clock keeps running, and its next
      // flush restores the new session once the id has moved on
      endedSid = e.sessionId; cleared = e.reason === 'clear'
      m = empty(); ready = undefined; sid = undefined; early = []; goalQueue = []; dirty = false
      await Promise.all([update($, modelAtom, () => empty()), update($, viewAtom, () => 'overview'), update($, diffAtom, () => ''), update($, recapAtom, () => ({ status: 'idle', text: '' }))]).catch(() => {})
    } else { timer?.cancel(); timer = undefined }
    return next(e)
  })

  on('command.run', { command: 'session-pane' }, async $ => {
    const up = (await $.ui.panes()).some(p => p.id === PANE)
    if (up) { await $.ui.close({ id: PANE }); return { text: 'Session pane hidden' } }
    await flush($).catch(() => {})
    // docked, the default share is far wider than the ~44 columns the pages are laid out for and squeezes the transcript;
    // 48 leaves a few over, so a long label wraps less. A request only: a width the person dragged the dock to wins
    await $.ui.open({ id: PANE, title: TITLE, focus: true, columns: 48 })
    return { text: 'Session pane shown' }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) await update($, viewAtom, () => 'overview').catch(() => {}) // reopened, it starts at the overview
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const el = $.ui.resolve(e) as Els
    const [model, view, help, diff, recap] = await Promise.all([read($, modelAtom), read($, viewAtom), read($, helpAtom), read($, diffAtom), read($, recapAtom)])
    const usage = view === 'context' ? await $.session.usage({ breakdown: 'summary' }).catch(() => undefined)
      : view === 'details' ? await $.session.usage().catch(() => undefined) : undefined
    const name = view === 'details' ? await $.session.model().catch(() => undefined) : undefined
    const act: Act = {
      go: v => { void update($, viewAtom, () => v) },
      help: () => { void update($, helpAtom, h => !h) },
      diff: path => { void update($, diffAtom, () => path).then(() => update($, viewAtom, () => 'diff')) },
      draft: () => { void draftRecap($).catch(() => {}) },
      use: () => { void useRecap($).catch(() => {}) },
      discard: () => { void update($, recapAtom, () => ({ status: 'idle', text: '' })) },
    }
    return draw(el, { m: model, view, help, diff, recap, cols: e.props.bodyColumns ?? 44, usage, model: name }, act)
  })
}
