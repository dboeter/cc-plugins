// Checks one session's event log: node check-log.mjs ~/.claude/event-log/<sessionId>
// Prints a PASS/FAIL line per check, then a count of rows per event; exits 1 on any FAIL.
import { readdirSync, readFileSync } from 'node:fs'

const dir = process.argv[2]
const rows = readdirSync(dir).filter(f => /^\d{4}\.jsonl$/.test(f)).sort()
  .flatMap(f => readFileSync(`${dir}/${f}`, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)))
const seqs = rows.map(r => r.seq)
const enters = new Set(rows.filter(r => r.ph === 'enter').map(r => r.seq))
const checks = [
  ['seq strictly increasing, no gaps', seqs.every((s, i) => i === 0 ? s >= 1 : s === seqs[i - 1] + 1)],
  ['>=1 classic.* row', rows.some(r => r.ev.startsWith('classic.'))],
  ['>=1 session.append row', rows.some(r => r.ev === 'session.append')],
  ['>=1 turn.step exit', rows.some(r => r.ev === 'turn.step' && r.ph === 'exit')],
  ['>=1 row from a third-party plugin', rows.some(r => r.origin && !['engine', 'event-log'].includes(r.origin.plugin))],
  ['every exit has its enter', rows.filter(r => r.ph === 'exit').every(r => enters.has(r.enter))],
]
for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`)
const by = {}
for (const r of rows) by[r.ev] = (by[r.ev] ?? 0) + 1
console.log(`${rows.length} rows:`, Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', '))
console.log('plugins:', [...new Set(rows.map(r => r.origin?.plugin).filter(Boolean))].join(', '))
process.exit(checks.every(c => c[1]) ? 0 : 1)
