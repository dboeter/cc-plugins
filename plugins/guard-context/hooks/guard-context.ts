import type { Register } from 'claude-code'

// The rm executable in a clause, after guard.sh's wrappers (sudo/command/env, env assignments),
// spelled bare, with a path or a leading backslash. Mirrors guard.sh's $cmd_pfx loosely: a miss
// here only costs the notice, never the ask, which guard.sh raises on its own.
const RM = /^(?:(?:sudo|command|env)\s+|[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*\\?(?:\S*\/)?rm\s+(.*)$/

/** The operands of the first rm clause in `cmd`, unquoted; flags and `--` dropped. */
export function rmTargets(cmd: string): string[] {
  for (const clause of cmd.split(/[;&|]+/)) {
    const m = RM.exec(clause.trim())
    if (!m) continue
    const out: string[] = []
    let operands = false
    for (const tok of m[1]!.match(/'[^']*'|"[^"]*"|\S+/g) ?? []) {
      if (!operands && tok === '--') { operands = true; continue }
      if (!operands && tok.startsWith('-')) continue
      out.push(tok.replace(/^(['"])(.*)\1$/, '$2'))
    }
    return out
  }
  return []
}

// Needs a shell to resolve (variables, globs, ~user, substitutions): du would see the literal.
const UNRESOLVED = /[$*?[`]|^~[^/]/

export const register: Register = on => {
  // tool.check runs after the PreToolUse hooks with the call's tool_use_id, so an ask guard.sh
  // raised is visible here (verdict.hook === 'PreToolUse') before the dialog opens.
  on('tool.check', { tool: 'Bash' }, async ($, e, next) => {
    const verdict = await next(e)
    if (!e.tool_use_id || verdict.decision !== 'ask' || verdict.hook !== 'PreToolUse') return verdict
    const cmd = (e.input as { command?: string }).command ?? ''
    if (!verdict.reason?.startsWith('recursive rm')) return verdict

    // Detached so the dialog opens at once and the line lands when du is done; core drops it when
    // the call resolves, so a late one after an answer is harmless.
    const id = e.tool_use_id
    void (async () => {
      const targets = rmTargets(cmd)
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
      $.ui.notice(id, `guard-context: ${parts.join(' · ') || 'no targets found'}`)
    })().catch(err => $.ui.log(`guard-context: ${err}`, { to: 'debug' }))
    return verdict
  }).catch((_$, e, next) => next(e))
}
