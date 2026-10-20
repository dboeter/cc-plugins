import type { Register } from 'claude-code'

// The rm executable in a clause, after guard.sh's wrappers (sudo/command/env, env assignments),
// spelled bare, with a path or a leading backslash. Mirrors guard.sh's $cmd_pfx loosely: a miss
// here only costs the notice, never the ask, which guard.sh raises on its own.
const RM = /^(?:(?:sudo|command|env)\s+|[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*\\?(?:\S*\/)?rm\s+(.*)$/

/** The operands of the first recursive rm clause in `cmd`, unquoted; flags and `--` dropped. */
export function rmTargets(cmd: string): string[] {
  for (const clause of cmd.split(/[;&|]+/)) {
    const m = RM.exec(clause.trim())
    if (!m) continue
    const out: string[] = []
    let operands = false, recursive = false
    for (const tok of m[1]!.match(/'[^']*'|"[^"]*"|\S+/g) ?? []) {
      if (!operands && tok === '--') { operands = true; continue }
      if (!operands && tok.startsWith('-')) { recursive ||= /^-[A-Za-z]*[rR]|^--recursive$/.test(tok); continue }
      out.push(tok.replace(/^(['"])(.*)\1$/, '$2'))
    }
    if (recursive) return out
  }
  return []
}

// Needs a shell to resolve (variables, globs, ~user, substitutions): du would see the literal.
const UNRESOLVED = /[$*?[`]|^~[^/]/

/** One line on what the targets hold: size and entry count for each one du resolves. */
async function describe($: { process: { run: (argv: readonly string[], init?: { timeoutMs?: number }) => Promise<{ stdout: string; stderr: string }> } }, targets: string[]) {
  const plain = targets.filter(t => !UNRESOLVED.test(t))
  const parts: string[] = []
  if (plain.length) {
    const home = (await $.process.run(['sh', '-c', 'printf %s "$HOME"'])).stdout
    const abs = plain.map(t => (t === '~' || t.startsWith('~/') ? home + t.slice(1) : t))
    const size = await $.process.run(['du', '-sh', '--', ...abs], { timeoutMs: 2000 })
    const files = await $.process.run(['du', '-s', '--inodes', '--', ...abs], { timeoutMs: 2000 })
    const counts = files.stdout.trim().split('\n').map(l => l.split('\t')[0])
    size.stdout.trim().split('\n').filter(Boolean).forEach((line, i) => {
      const [sz, path] = line.split('\t')
      parts.push(`${path}: ${sz}, ${counts[i] ?? '?'} entries`)
    })
    if (size.stderr.includes('No such file')) parts.push('some targets do not exist')
  }
  const skipped = targets.length - plain.length
  if (skipped) parts.push(`${skipped} target(s) need a shell to resolve`)
  return `guard-context: ${parts.join(' · ') || 'no targets found'}`
}

// SPIKE: which hook fired and whether the notice went through, appended to
// ~/.claude/logs/guard-context.log so it can be read whichever surface answers the ask
// (a remote card shows neither the notice nor transcript lines). $.fs has no append, so sh does it.
const trace = ($: Parameters<typeof describe>[0], text: string) =>
  void $.process.run(['sh', '-c', 'printf "%s %s\\n" "$(date +%T)" "$1" >> "$HOME/.claude/logs/guard-context.log"', 'sh', text]).catch(() => {})

export const register: Register = on => {
  // The notice goes up in tool.call, before next(e) opens the dialog (the documented order), for
  // every recursive rm: guard.sh decides the ask on its own, and where it doesn't ask core drops
  // the line with the call. A notice from tool.check (after PreToolUse, before the dialog) did not
  // show in the live test of 2026-10-20.
  on('tool.call', { tool: 'Bash' }, ($, e, next) => {
    const targets = rmTargets(e.command)
    if (!targets.length) return next(e)
    const id = e.tool_use_id
    try { $.ui.notice(id, 'guard-context: sizing the targets…'); trace($, `tool.call notice set for ${id}`) }
    catch (err) { trace($, `tool.call notice refused: ${err}`) }
    // detached so the dialog is not held up by du; the line is replaced when it is done
    void describe($, targets)
      .then(line => { $.ui.notice(id, line); trace($, `notice updated: ${line}`) })
      .catch(err => trace($, `describe/notice failed: ${err}`))
    return next(e)
  }).catch((_$, e, next) => next(e))

  on('tool.check', { tool: 'Bash' }, async ($, e, next) => {
    const verdict = await next(e)
    if (e.tool_use_id) trace($, `tool.check ${e.tool_use_id}: ${verdict.decision} hook=${verdict.hook ?? '-'} reason=${verdict.reason ?? '-'}`)
    return verdict
  }).catch((_$, e, next) => next(e))
}
