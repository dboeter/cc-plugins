import { atom, read, update } from 'claude-code'
import type { Register, StateDollar, Timer } from 'claude-code'

import { footerRow, spinnerRow } from './row'
import { THEMES } from './themes'
import { FRAME_MS, hash, pick, type Outcome, type Tick } from './runs'

const OUTCOMES_KEPT = 20
// a turn that starts this long after the last prompt submitted while idle is not that prompt's
const STALE_MS = 60_000
// the frame moves for about a second after the last spinner this mod drew
const IDLE_TICKS = 11

const frameAtom = atom({ plugin: 'skin-spinners', key: 'frame' } as const, 0)
const startedAtAtom = atom({ plugin: 'skin-spinners', key: 'startedAt' } as const, 0)
const outcomesAtom = atom({ plugin: 'skin-spinners', key: 'outcomes' } as const, {})
const prefsRef = { plugin: 'skins', key: 'prefs' } as const
const customRef = { plugin: 'skins', key: 'custom' } as const
const turnsRef = { plugin: 'skins', key: 'turns' } as const
const isLightRef = { plugin: 'skins', key: 'isLight' } as const

const outcomeKey = (durationMs: number) => `d${durationMs}`
// the newest last, so the trim keeps the newest
const keep = (outcomes: Record<string, Outcome>, durationMs: number, reason: Outcome) => {
  const key = outcomeKey(durationMs)
  const rest = Object.entries(outcomes).filter(([k]) => k !== key)
  return Object.fromEntries([...rest, [key, reason] as [string, Outcome]].slice(-OUTCOMES_KEPT))
}

// The skin to draw, or undefined when the row stays skins' (skins missing or off, calm, ascii icons, a light palette, a skin with no theme here).
const active = async ($: StateDollar) => {
  const prefs = await read($, prefsRef)
  if (prefs === undefined || prefs.skin === 'off' || prefs.calm !== null || prefs.icons === 'ascii') return undefined
  if ((await read($, isLightRef)) === true) return undefined
  const theme = Object.hasOwn(THEMES, prefs.skin) ? THEMES[prefs.skin] : undefined
  return theme === undefined ? undefined : { prefs, theme, skin: prefs.skin }
}

export const register: Register = on => {
  let ticker: Timer | undefined
  let idleTicks = 0
  let submittedAt = 0

  on('session.start', ($, e, next) => {
    ticker?.cancel()
    ticker = $.clock.every(FRAME_MS, () => {
      if (idleTicks++ < IDLE_TICKS) void update($, frameAtom, frame => frame + 1)
    })
    return next(e)
  })

  // The seconds of UserPromptSubmit hooks come before turn.start, with the spinner already up, so the clock starts here.
  // A prompt typed during a turn carries that turn's id and leaves the clock alone.
  on('prompt.submit', async ($, e, next) => {
    if (e.turnId === undefined) {
      const now = await $.clock.now()
      submittedAt = now
      await update($, startedAtAtom, () => now)
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      const now = await $.clock.now()
      if (submittedAt === 0 || now - submittedAt > STALE_MS) await update($, startedAtAtom, () => now)
      submittedAt = 0
    }
    return next(e)
  })

  // startedAt is left as it is: a spinner still up as the turn ends keeps its clock
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) await update($, outcomesAtom, outcomes => keep(outcomes, e.durationMs, e.reason))
    return next(e)
  })

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.message !== null) return next(e)
    const look = await active($)
    if (look === undefined) return next(e)
    const { prefs, theme, skin } = look

    const startedAt = await read($, startedAtAtom)
    const custom = (await read($, customRef))?.[skin]
    const seed = String(startedAt || e.props.word)
    const word = prefs.words === 'claude' && e.props.word !== '' ? e.props.word : pick([...theme.words, ...(custom?.spinner ?? [])], seed)
    const now = await $.clock.now()
    const frame = await read($, frameAtom)
    idleTicks = 0

    const t: Tick = { frame, elapsedMs: startedAt === 0 ? frame * FRAME_MS : now - startedAt, mode: e.props.mode, seed: hash(seed) }
    const { Text } = $.ui.resolve(e)
    return (
      <Text>
        {spinnerRow(theme, t, word, e.props.suffix).map(run => (
          <Text color={run.color} backgroundColor={run.bg} weight={run.bold ? 'bold' : undefined} italic={run.italic}>{run.text}</Text>
        ))}
      </Text>
    )
  })

  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const look = await active($)
    const done = look?.theme.done
    if (look === undefined || done === undefined) return next(e)
    const { prefs, theme, skin } = look

    const outcome = (await read($, outcomesAtom))[outcomeKey(e.props.durationMs)] ?? 'answer'
    const custom = (await read($, customRef))?.[skin]
    const list = outcome === 'aborted' ? done.aborted : outcome === 'answer' ? [...done.words, ...(custom?.done ?? [])] : done.error
    const word = prefs.words === 'claude' ? e.props.word : pick(list, String(e.props.durationMs))
    const stats = (await read($, turnsRef))?.[String(e.props.durationMs)]

    const { Text } = $.ui.resolve(e)
    return (
      <Text>
        {footerRow(theme.muted, done, word, e.props.durationMs, stats).map(run => (
          <Text color={run.color} backgroundColor={run.bg} weight={run.bold ? 'bold' : undefined} italic={run.italic}>{run.text}</Text>
        ))}
      </Text>
    )
  })
}
