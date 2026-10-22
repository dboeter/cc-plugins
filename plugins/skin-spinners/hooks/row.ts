import type { Done, Theme } from './themes'
import { formatDuration, merge, timer, type Run, type Tick } from './runs'

export type TurnStats = { tools: number; added: number; removed: number }

const after = (runs: Run[]): Run[] => (runs.length === 0 ? [] : [{ text: '  ' }, ...runs])

// the sprite, the word, the suffix (the Spinner's, unless the theme has its own), then the clock and the tag; a part that draws nothing leaves its separator out
export const spinnerRow = (theme: Theme, t: Tick, word: string, suffix: string): Run[] =>
  merge([
    ...theme.sprite(t),
    { text: ' ' },
    ...theme.word(word, t),
    { text: theme.suffix ?? suffix, color: theme.muted },
    ...after(theme.clock === undefined ? timer(t.elapsedMs, theme.muted) : theme.clock(t)),
    ...after(theme.tag?.(t) ?? []),
  ])

// skins' footer with the theme's mark and line swapped in
export const footerRow = (muted: string, done: Done, word: string, durationMs: number, stats: TurnStats | undefined): Run[] => {
  const { ok, err } = done
  const line = done.line?.(word, durationMs) ?? [{ text: `${word} in ${formatDuration(durationMs)}` }]
  const hasDiff = stats !== undefined && stats.added + stats.removed > 0
  return merge([
    done.mark,
    { text: ' ' },
    ...line.map(run => ({ color: muted, ...run })),
    ...(stats === undefined || stats.tools === 0 ? [] : [{ text: `  ·  ${stats.tools} tool${stats.tools === 1 ? '' : 's'}`, color: muted }]),
    ...(hasDiff ? [{ text: '  ·  ', color: muted }, { text: `+${stats.added}`, color: ok }, { text: ` −${stats.removed}`, color: err }] : []),
  ])
}
