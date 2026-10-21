import type { EngineInterface, Register } from 'claude-code'

// Swaps secret-shaped values for numbered placeholders (⟦API_KEY_n⟧) in what the model reads,
// before it leaves the machine: the prompt and a command's arguments, the first request's
// context blocks and system prompt, the reminders and mentioned files the engine injects, a
// skill's text, and every row a conversation keeps (tool results, a subagent's rows too). The
// values stay in this session's vault, in the plugin's $.store, never in a request; a value keeps
// its placeholder for the whole session, its subagents and a --resume.
// Every tool call gets the real values back in its input before it runs, a remote tool's too
// (WebFetch, WebSearch, MCP): the person chose an uninterrupted workflow over blocking those,
// knowing that a page telling the model to put a placeholder in a URL gets the value sent. The
// permission check, which runs beneath this hook, sees the real values too. The terminal draws
// them back, unless the pane's toggle shows them as the model reads them; a remote surface keeps
// the placeholders.
// Fails closed: a masking hook that throws or outruns its budget withholds what it masks (the
// `.catch` on each), and a placeholder the vault does not hold refuses the call. The model's own
// tool_use input is recorded before any hook runs, so the transcript keeps the placeholders.
// Best-effort pattern list, not a guarantee.

// ⟦ and ⟧ open and close a placeholder: no rule's value holds them (STOP below) and real text
// rarely does, so a placeholder is never masked again and a token of its shape is read as ours.
// Spelled as escapes, so no file of this plugin holds a placeholder a restore would fill in, nor
// an escaped one (`!` after the bracket) a restore would rewrite.
const OPEN = '⟦'
// a placeholder or an escaped one, both kept whole by every pass that splits on it
const PH_SPLIT = /(⟦!?[A-Z][A-Z0-9_]*_\d+⟧)/
// A placeholder escaped: `!` after the opening bracket. Restore gives its literal text and never
// looks it up, so text about placeholders (a doc, a report) can name one.
const ESC = OPEN + '!'
const PH_OR_ESC = /⟦(!?)([A-Z][A-Z0-9_]*_\d+⟧)/g
const LABEL = /^[A-Z][A-Z0-9_]*$/

// A rule of the rules file: a JavaScript regex, the label its placeholders take (`replacement`:
// API_KEY masks as API_KEY_n), whether it is on, and its options (`ignoreCase`, and `min`,
// `strong`, `prose` as Pattern below has them). `name` is what the pane and the vault call it.
type Rule = { name?: string; pattern: string; replacement: string; enabled?: boolean; ignoreCase?: boolean; min?: number; strong?: boolean; prose?: boolean }

// The rules a new rules file holds: two examples, both off, so nothing is masked until the person
// turns one on or adds their own. Copied into the file once; a later version's change to them
// does not reach it. Their repeats are bounded ({1,64}, {1,512}): unbounded, a crafted output
// (thousands of `-eyJ`) takes time quadratic in its size, outruns the hook budget and gets the
// row withheld. The speed test in redact.test.ts pins this. A real-looking token here would trip
// the pre-push secret scan, so the names describe a match rather than show one.
export const EXAMPLES: Rule[] = [
  // JS copy of ~/dotagents/scripts/git-hooks/lib/secret-content.ere's vendor shapes (plus hf_, ya29.)
  { name: 'Example: vendor tokens (sk-, gh*_, github_pat_, AKIA, ASIA, xox*-, AIza, sk_live_, glpat-, npm_, dckr_pat_, SG., hf_, ya29.) and JWTs',
    pattern: /\b(?:sk-[\w-]{20,}|gh[pousr]_\w{36,}|github_pat_\w{20,}|(?:AKIA|ASIA)[0-9A-Z]{16}|xox[abprs]-[\w-]{10,}|AIza[\w-]{35}|[sr]k_(?:live|test)_[0-9A-Za-z]{24,}|glpat-[\w-]{20,}|npm_[A-Za-z0-9]{36}|dckr_pat_[\w-]{20,}|SG\.[\w-]{20,}\.[\w-]{20,}|hf_[A-Za-z0-9]{30,}|ya29\.[\w-]{20,}|eyJ[\w-]{1,512}\.[\w-]+\.[\w-]+)/.source,
    replacement: 'API_KEY', enabled: false },
  // Starts where a run of address characters does, so a local part past 64 is left whole rather
  // than cut. Not `git@`, a git host's ssh user; a TLD of letters leaves `react@18.2.0` alone,
  // `(?![1-9]x\.)` an image's `@2x.png`.
  { name: 'Example: email addresses',
    pattern: /(?<![\w.+-])(?!git@)[\w.+-]{1,64}@(?![1-9]x\.)(?:[\w-]{1,63}\.){1,8}[A-Za-z]{2,24}(?![\w-])/.source,
    replacement: 'EMAIL', enabled: false },
]

// A pattern: each match masked whole, or only its `v` (or `v2`) group when it has one, under
// `label`; `by` is what the pane says masked it. Its options: `strong` masks only a value that
// passes `strong` below, `min` only one that long and not all lowercase (WORD), `prose` leaves an
// unquoted value after a colon alone when words follow it (PROSE).
type Pattern = { re: RegExp; label: string; by?: string; strong?: boolean; min?: number; prose?: boolean }
type Spec = Omit<Pattern, 're'> & { src: string; flags: string }
// A rule as compiled. Throws why it does not read: no pattern, a replacement no placeholder can
// carry, an option of the wrong type, a regex that does not compile.
const spec = (r: any): Spec => {
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error('not a rule')
  if (typeof r.pattern !== 'string' || !r.pattern) throw new Error('no pattern')
  const label = r.replacement ?? 'SECRET'
  if (typeof label !== 'string' || !LABEL.test(label)) throw new Error('replacement is not capitals, digits and _')
  if (r.min !== undefined && !(Number.isInteger(r.min) && r.min >= 0)) throw new Error('min is not a whole number')
  for (const k of ['enabled', 'ignoreCase', 'strong', 'prose']) if (r[k] !== undefined && typeof r[k] !== 'boolean') throw new Error(`${k} is not true or false`)
  const s: Spec = { src: r.pattern, flags: r.ignoreCase ? 'gdi' : 'gd', label }
  if (r.min) s.min = r.min
  if (r.strong) s.strong = true
  if (r.prose) s.prose = true
  new RegExp(s.src, s.flags)
  return s
}
// A line in the short form /redact add and the `patterns` option take, as a rule that is on:
// `LABEL [options]: regex`, or a bare regex, masked as SECRET. The regex is the rest of the line
// after the first `: `, as written; a label is capitals, so a regex like `(?<x>a): b` stays whole.
// Throws why the line does not read: an unknown option, or what `spec` throws.
const RULE = /^([A-Z][A-Z0-9_]*)((?:[ \t]+[\w=-]+)*)[ \t]*:[ \t]+(.*)$/
const read = (line: string): Rule => {
  const [, label = 'SECRET', opts = '', src = line] = RULE.exec(line) ?? []
  const r: Rule = { pattern: src.trim(), replacement: label, enabled: true }
  for (const o of opts.split(/\s+/).filter(Boolean)) {
    const [k, v] = o.split('=')
    if (k === 'min' && v && /^\d+$/.test(v)) r.min = Number(v)
    else if (o === 'strong' || o === 'prose') r[o] = true
    else if (o === 'i') r.ignoreCase = true
    else throw new Error(`unknown option ${o}`)
  }
  spec(r)
  return r
}

// A session's vault: the next number per label and each placeholder's value, as the store keeps
// it, and which rule or pattern masked each (`by`, absent from a vault saved before it was
// kept); `at` is when it last changed, for pruning. Held adds the reverse index and the
// known-values pattern, both rebuilt from `ph`, and whether it changed since it was saved.
// `known` is undefined until knownOf builds it, null when the vault is empty.
type Vault = { at: number; n: Record<string, number>; ph: Record<string, string>; by?: Record<string, string> }
type Held = { id: string; v: Vault; byValue: Map<string, string>; known?: RegExp | null; dirty: boolean }
export const fresh = (id = ''): Held => ({ id, v: { at: 0, n: {}, ph: {} }, byValue: new Map(), dirty: false })

// The placeholder of a value: the one it has, or the next number under its label.
const mint = (h: Held, value: string, label: string, by: string) => {
  let p = h.byValue.get(value)
  if (p) return p
  const n = (h.v.n[label] ?? 0) + 1
  h.v.n[label] = n
  p = `${OPEN}${label}_${n}⟧`
  h.v.ph[p] = value
  ;(h.v.by ??= {})[p] = by
  h.byValue.set(value, p)
  h.known = undefined
  h.dirty = true
  return p
}

// a value with no letter or digit (`**`, `...`) is markup or code, never a secret
const ALNUM = /[A-Za-z0-9]/
// An unquoted value after `name:` with a word after it is prose, a heading or a list (`TOKEN: a
// token-shaped value`, the pane's own rows read back), not a setting.
const PROSE = /^[ \t]+[A-Za-z]/
// A `min` rule leaves a value of lowercase letters alone (`password: value`, `--token word`): a doc
// or a usage line puts a word there far more often than a setting puts a password, and once
// vaulted, the word is masked everywhere all session. The person's choice, at a price: a
// lowercase-only password (`password=letmein`) is sent as it is.
const WORD = /^[a-z]+$/
// `part` with each match of `x` that passes its checks swapped for a placeholder: the `v` or `v2`
// span where the match has one (a pattern compiled with `d` gives their indices), else the whole match.
const swap = (part: string, h: Held, x: Pattern) => {
  let out = '', at = 0
  for (const r of part.matchAll(x.re)) {
    const g = r.indices?.groups
    const [from, to] = g?.v ?? g?.v2 ?? [r.index, r.index + r[0].length]
    const value = part.slice(from, to)
    if (!value || value.includes(OPEN) || !ALNUM.test(value) || (x.strong && !strong(value)) || value.length < (x.min ?? 0)) continue
    if (x.min && WORD.test(value)) continue
    if (x.prose && /:[ \t]*$/.test(part.slice(r.index, from)) && PROSE.test(part.slice(r.index + r[0].length))) continue
    out += part.slice(at, from) + mint(h, value, x.label, x.by ?? 'a pattern')
    at = to
  }
  return at ? out + part.slice(at) : part
}

// A value that looks like a secret on its own: 8 or more characters, of at least two kinds out
// of letters, digits and symbols (whitespace is no symbol, so a misread phrase is not one). A
// `strong` rule, which guesses from context alone, masks only such a value.
const strong = (s: string) => s.length >= 8 && [/[A-Za-z]/, /[0-9]/, /[^A-Za-z0-9\s]/].filter(k => k.test(s)).length >= 2
// Every value the vault holds, longest first, as one pattern, each only where it stands apart
// from word characters, so `abc123xy` leaves `abc123xyz` alone; null when the vault is empty.
// Weak ones too (`hunter2`, a PIN): a value comes back in shapes no rule matches (a prompt the
// model writes for a subagent, after restore). The price: a word or number a rule misread stays
// masked, as a whole word, for the whole session.
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&')
const knownOf = (h: Held) => {
  if (h.known !== undefined) return h.known
  const values = [...h.byValue.keys()].sort((a, b) => b.length - a.length)
  return h.known = values.length ? new RegExp(values.map(s => '(?<!\\w)' + escape(s) + '(?!\\w)').join('|'), 'g') : null
}

// `f` over the text between placeholders, the placeholders left as they are
const between = (s: string, f: (part: string) => string) => s.split(PH_SPLIT).map((part, i) => i % 2 ? part : f(part)).join('')

// Rules first, over the whole text, so a later rule sees an earlier one's placeholder and leaves
// it. Then, only between placeholders (a pattern like `\d+` would rewrite one's number), the
// person's patterns, and every value the vault already holds, wherever it stands: a value
// once matched is never sent, in whatever shape it comes back. A placeholder-shaped text the
// vault does not hold (a doc naming the format) reads escaped, so writing it back gives the
// literal. Masking twice is masking once.
export const mask = (s: string, h: Held, patterns: readonly Pattern[]) => {
  const ruled = patterns.reduce((acc, x) => between(acc, part => swap(part, h, x)), s)
  if (!ruled.includes(OPEN) && !h.byValue.size) return ruled
  const known = h.byValue.size ? knownOf(h) : null
  const placeholder = (p: string) => p.startsWith(ESC) || p in h.v.ph ? p : ESC + p.slice(OPEN.length)
  const text = (t: string) => known ? t.replace(known, m => h.byValue.get(m) ?? m) : t
  return ruled.split(PH_SPLIT).map((part, i) => i % 2 ? placeholder(part) : text(part)).join('')
}

// The real values back in a string, and an escaped placeholder as its literal text; `missing`
// collects the placeholders the vault does not hold.
export const restore = (s: string, h: Held, missing?: Set<string>) =>
  s.includes(OPEN) ? s.replace(PH_OR_ESC, (p, esc: string, body: string) => esc ? OPEN + body : h.v.ph[p] ?? (missing?.add(p), p)) : s

// `f` over every string in a value; the same value back where nothing changed.
const deep = (v: unknown, f: (s: string) => string): unknown => {
  if (typeof v === 'string') return f(v)
  if (Array.isArray(v)) { const a = v.map(x => deep(x, f)); return a.some((x, i) => x !== v[i]) ? a : v }
  if (v && typeof v === 'object') {
    const es = Object.entries(v)
    const out = es.map(([k, x]) => [k, deep(x, f)] as const)
    return out.some(([, x], i) => x !== es[i]![1]) ? Object.fromEntries(out) : v
  }
  return v
}

// A row's rewritable text: its text blocks and its tool results' content. Media, thinking and
// tool_use blocks pass as they are. The same array back where nothing changed.
const blocks = (content: any, f: (s: string) => string): any => {
  if (typeof content === 'string') return f(content)
  if (!Array.isArray(content)) return content
  const out = content.map((b: any) => b?.type === 'text' && typeof b.text === 'string' ? { ...b, text: f(b.text) }
    : b?.type === 'tool_result' ? { ...b, content: blocks(b.content, f) }
    : b)
  return out.some((b: any, i: number) => b.text !== content[i].text || b.content !== content[i].content) ? out : content
}
// a /redact command line as the engine records it, its arguments in group 2
const REDACT_ARGS = /(<command-name>\/redact<\/command-name>[\s\S]*?<command-args>)[\s\S]*?(<\/command-args>)/g
const WITHHELD = 'redact: withheld, as masking it failed. Tell the user; the redact plugin needs a look.'

// The input fields whose text lands in a file or runs. Bash is checked whole: a write that
// is no file write (`gh secret set --body`, `curl -d`) has no shape to tell it apart.
const WRITES: Record<string, string[]> = { Write: ['content'], Edit: ['old_string', 'new_string'], NotebookEdit: ['new_source'], Bash: ['command'] }

// why a rule, or a line in the short form, does not read; undefined when it does
const fault = (r: unknown) => { try { spec(r); return undefined } catch (err) { return (err as Error).message } }
const lineFault = (line: string) => { try { read(line); return undefined } catch (err) { return (err as Error).message } }
// A rule with no `enabled` is on: the person wrote it to mask, and a miss sends the value.
const isOn = (r: any) => r?.enabled !== false
// the rules that are on and read, compiled
const compile = (rules: readonly unknown[], from: string): Pattern[] => rules.flatMap(r => {
  if (fault(r) || !isOn(r)) return []
  const { src, flags, ...s } = spec(r)
  return [{ ...s, re: new RegExp(src, flags), by: `${from}: ${(r as Rule).name ?? src}` }]
})
// A pattern line of the old patterns file, with the comment line right above it as its name. A
// blank line ends a comment, so the header names nothing.
type Line = { line: string; name?: string }
const parse = (text: string): Line[] => {
  let name: string | undefined, inComment = false
  return text.split('\n').flatMap(raw => {
    const l = raw.trim()
    if (l.startsWith('#')) { if (!inComment) name = l.replace(/^#\s*/, '') || undefined; inComment = true; return [] }
    const at = name
    name = undefined
    inComment = false
    return l ? [{ line: l, name: at }] : []
  })
}
const PANE = 'redact'
const TITLE = 'Redact rules'
// The rules /redact and the pane keep: a JSON file of the user's, per user, for every project,
// next to settings.json, so they can edit it by hand. A new one holds EXAMPLES.
const FILE = 'redact-rules.json'
const YOURS = 'rule'
const json = (rules: readonly unknown[]) => JSON.stringify({ rules }, null, 2) + '\n'
// each session's vault, under its id, in the store; one untouched this long is dropped
const VAULT = 'vault:'
const KEEP_MS = 30 * 24 * 3600 * 1000

// The patterns file of the version before, which shipped these rules in code and turned one off
// with an `off <id>` line. Moved into a rules file once, when there is none: each pattern line
// that reads becomes a rule that is on, named by the comment above it, and an example is on
// where the old file left its rule on (`was`). `gone` names the other rules it left on, which mask
// nothing now; `lost` counts the lines that did not read. The old file stays where it is.
const OLD_FILE = 'redact-patterns.txt'
const OLD_RULES = ['private-key', 'vendor-token', 'bearer', 'url-password', 'flag', 'assigned', 'email']
const WAS = ['vendor-token', 'email'] // EXAMPLES' rule in the old file, in their order
const OFF = /^off[ \t]+(\S+)$/
export const migrate = (t: string) => {
  const lines = parse(t)
  const off = new Set(lines.flatMap(l => OFF.exec(l.line)?.[1] ?? []))
  const left = OLD_RULES.filter(id => !off.has(id))
  const examples = EXAMPLES.map((r, i) => ({ ...r, enabled: left.includes(WAS[i]!) }))
  let lost = 0
  const rules = lines.flatMap(l => {
    if (OFF.test(l.line)) return []
    try { return [{ ...l.name ? { name: l.name } : {}, ...read(l.line) }] } catch { lost++; return [] }
  })
  return { text: json([...examples, ...rules]), gone: left.filter(id => !WAS.includes(id)), lost }
}

// The file's rules as last read, and compiled, and where the file is; one per load. Read again at
// every masking, so an edit by hand or a rule another session added masks here too; a text that
// does not parse keeps the last rules (`broken` says why). The vault being loaded, and the queue
// its saves wait in; whether the terminal draws placeholders (`raw`), the settings patterns that
// did not compile and how many did (`extra`), and the status line last set. These helpers sit at
// the top of the file because the engine only follows `$` into such functions.
type Tab = 'session' | 'rules' | 'help'
const TABS: Record<string, Tab> = { '': 'session', show: 'session', session: 'session', rules: 'rules', patterns: 'rules', test: 'rules', guide: 'help', help: 'help' }
type Kept = { rules: unknown[]; compiled: Pattern[]; broken?: string; last?: string; file?: Promise<string>; seeded?: boolean; note: string; extra: number
  vault?: { id: string; held: Promise<Held> }; saving: Promise<unknown>; raw: boolean; skipped: string[]; shown?: string; revealed: Set<string>; opened?: boolean; tab: Tab; sample: string }
// CLAUDE_CONFIG_DIR, else ~/.claude; USERPROFILE is Windows' HOME
const place = ($: EngineInterface, k: Kept) => k.file ??= (async () => {
  const dir = await $.env.get('CLAUDE_CONFIG_DIR') || `${await $.env.get('HOME') || await $.env.get('USERPROFILE') || '~'}/.claude`
  return `${dir.replace(/[\\/]+$/, '')}/${FILE}`
})()
// The file's text, undefined when it, or the old patterns file it would be made from, is there
// but did not read. None at all is made once per load, from the old patterns file when there is
// one (`migrate`, and a toast of what changed), else from the examples: a write that fails still
// masks with it.
const text = async ($: EngineInterface, k: Kept, path: string) => {
  if (await $.fs.exists(path).catch(() => true)) return $.fs.read(path).then(String, () => undefined)
  const old = path.replace(/[^\\/]+$/, OLD_FILE)
  const was = await $.fs.exists(old).catch(() => true) ? await $.fs.read(old).then(String, () => null) : undefined
  if (was === null) return undefined
  const moved = was === undefined ? undefined : migrate(was)
  const next = moved?.text ?? json(EXAMPLES)
  if (!k.seeded) {
    k.seeded = true
    await $.fs.write(path, next).then(
      () => {
        if (!moved) return
        const gone = moved.gone.length ? ` ${moved.gone.join(', ')} ${moved.gone.length > 1 ? 'were' : 'was'} on and ${moved.gone.length > 1 ? 'mask' : 'masks'} nothing now.` : ''
        const lost = moved.lost ? ` ${moved.lost} line${moved.lost > 1 ? 's' : ''} that did not read stayed behind.` : ''
        told($, `redact: your patterns moved from ${OLD_FILE} to ${FILE}; redact ships no built-in rules now.${gone}${lost} /redact rules lists what is on.`)
      },
      err => $.ui.log(`redact: ${FILE} not written: ${(err as Error)?.message ?? err}`, { to: 'debug' }))
  }
  return next
}
// the rules from the file's text, compiled again only when the text changed
const take = (k: Kept, t: string) => {
  if (t === k.last) return
  k.last = t
  let rules: unknown
  try { rules = JSON.parse(t)?.rules } catch {}
  if (!Array.isArray(rules)) { k.broken = 'is no JSON object with a rules list'; return }
  k.broken = undefined
  k.rules = rules
  k.compiled = compile(rules, YOURS)
}
const sync = async ($: EngineInterface, k: Kept) => {
  const t = await text($, k, await place($, k))
  if (t !== undefined) take(k, t)
}
// Writes the file's rules as `f` changes them, its other keys kept; a file that did not read or
// parse is left alone, never written over. Undefined when saved, else why not.
const save = async ($: EngineInterface, k: Kept, f: (rules: unknown[]) => unknown[]) => {
  const path = await place($, k)
  const t = await text($, k, path)
  if (t === undefined) return `not saved: ${FILE} did not read`
  take(k, t)
  if (k.broken) return `not saved: ${FILE} ${k.broken}; fix it by hand`
  const next = JSON.stringify({ ...JSON.parse(t), rules: f(k.rules) }, null, 2) + '\n'
  try { await $.fs.write(path, next) } catch (err) { return `not saved: ${(err as Error)?.message ?? err}` }
  take(k, next)
  $.ui.invalidate('ui.render')
  return undefined
}
// a rule by its number, its name or its pattern; -1 when none is
const pick = (k: Kept, ref: string) => /^\d+$/.test(ref) && k.rules[Number(ref) - 1] !== undefined ? Number(ref) - 1
  : ref ? k.rules.findIndex((r: any) => r?.name === ref || r?.pattern === ref) : -1
// No reply names a rule by more than its number: a reply to a typed command can reach the model.
const NONE = 'no such rule: give its number or name (/redact rules lists them)'
// turns a rule on or off
const turn = async ($: EngineInterface, k: Kept, ref: string, on: boolean) => {
  await sync($, k)
  const i = pick(k, ref)
  if (i < 0) return NONE
  if (isOn(k.rules[i]) === on) return `already ${on ? 'on' : 'off'}: #${i + 1}`
  return await save($, k, rules => rules.map((r, j) => j === i ? { ...r as object, enabled: on } : r))
    ?? `#${i + 1} ${on ? 'on' : 'off'}: from the next message on`
}
const add = async ($: EngineInterface, k: Kept, typed: string) => {
  await sync($, k)
  if (!typed) return 'nothing added: give a regex'
  let rule: Rule
  try { rule = read(typed) } catch (err) { return `not added: ${(err as Error).message}` }
  const at = k.rules.findIndex((r: any) => r?.pattern === rule.pattern && (r?.replacement ?? 'SECRET') === rule.replacement)
  if (at >= 0) return `already there, as #${at + 1}`
  return await save($, k, rules => [...rules, rule]) ?? `added as #${k.rules.length}: it masks from the next message on`
}
const remove = async ($: EngineInterface, k: Kept, ref: string) => {
  await sync($, k)
  const i = pick(k, ref)
  if (i < 0) return NONE
  return await save($, k, rules => rules.filter((_, j) => j !== i)) ?? `removed #${i + 1}`
}

// /redact's reply to its arguments, undefined for the pane. It answers in a toast, never as text:
// a command's output row is one the model reads, and none of /redact is its business
// (prompt.submit drops the line itself).
const USAGE = 'show | rules | guide | test [text] | add <rule> | remove <n|name> | on <n|name> | off <n|name>'
const answer = async ($: EngineInterface, k: Kept, fromSettings: Pattern[], args: string) => {
  const [, verb = '', rest = ''] = /^\s*(\S*)\s*([\s\S]*?)\s*$/.exec(args) ?? []
  if (verb === 'add') return add($, k, rest)
  if (verb === 'off' || verb === 'on') return turn($, k, rest, verb === 'on')
  if (verb === 'remove') return remove($, k, rest)
  if (verb === 'test' && rest) {
    await sync($, k)
    k.tab = 'rules'; k.note = ''; k.sample = rest
    await $.ui.open({ id: PANE, title: TITLE, focus: true }); k.opened = true
    $.ui.invalidate('ui.render')
    const trial = fresh()
    const out = mask(rest, trial, [...k.compiled, ...fromSettings])
    const hits = masked(trial)
    return hits.length ? `→ ${out} (${hits.map(x => `${x.p} by ${x.by}`).join(', ')})` : k.compiled.length + fromSettings.length ? 'no rule matched' : 'no rule matched: none is on'
  }
  const tab = !rest ? TABS[verb] : undefined
  if (tab) { k.tab = tab; k.note = ''; await $.ui.open({ id: PANE, title: TITLE, focus: true }); k.opened = true; return undefined }
  return `usage: /redact ${USAGE}`
}

// The vault of the session the hook runs in, read from the store once per session id (a /clear
// starts a new one), every hook of that id sharing the one read, so two never number apart. A
// read that fails is tried again by the next hook.
const load = async ($: EngineInterface, id: string): Promise<Held> => {
  const v: any = await $.store.get(VAULT + id)
  if (!v || typeof v.ph !== 'object' || typeof v.n !== 'object') return fresh(id)
  const vault: Vault = JSON.parse(JSON.stringify(v)) // the store's copy may be frozen
  return { id, v: vault, byValue: new Map(Object.entries(vault.ph).map(([p, x]) => [x, p])), dirty: false }
}
const hold = async ($: EngineInterface, k: Kept) => {
  const id = await $.session.id()
  if (k.vault?.id !== id) {
    k.revealed.clear() // a new session numbers from 1 again: no reveal carries over to its placeholders
    const held = load($, id)
    k.vault = { id, held }
    held.catch(() => { if (k.vault?.held === held) k.vault = undefined })
  }
  return k.vault.held
}
// A toast that never throws: a catch's notice of what it left out (the model never learns it is
// missing), a refusal the person should see.
const told = ($: EngineInterface, text: string) => { try { $.ui.toast(text) } catch {} }
// The status line under the prompt: how many values this session's vault holds, so masking shows
// though the terminal draws the real values back. Set only when it changes.
const badge = ($: EngineInterface, k: Kept, h: Held) => {
  const n = Object.keys(h.v.ph).length
  // with no rule on, a count alone would read as protected: nothing new is masked
  const line = [`redact: ${n} masked`, ...k.compiled.length + k.extra ? [] : ['no rules on'],
    ...k.broken ? [`${FILE} ${k.broken}, last rules kept (/redact rules)`] : [],
    ...k.skipped.length ? [`skipped pattern ${k.skipped.join(', ')} (/redact show)`] : [],
    ...k.raw ? ['drawn as the model reads it'] : []].join(' · ')
  if (line === k.shown) return
  k.shown = line
  try { $.ui.status(line) } catch {}
}
// Drops a placeholder from the vault. Its number is never handed out again (`n` stays), so a row
// still holding it never restores to another value: a call naming it is refused, and the value,
// matched again, masks under a new number.
const drop = (h: Held, p: string) => {
  const value = h.v.ph[p]
  if (value === undefined) return false
  delete h.v.ph[p]
  delete h.v.by?.[p]
  h.byValue.delete(value)
  h.known = undefined
  h.dirty = true
  return true
}
const forget = async ($: EngineInterface, k: Kept, p: string) => {
  const h = await hold($, k)
  if (!drop(h, p)) return 'already forgotten'
  await keep($, k, h)
  badge($, k, h)
  return `forgot ${p}: a call naming it is refused from now on, and the value, matched again, masks under a new number`
}
// every placeholder at once, in one save
const forgetAll = async ($: EngineInterface, k: Kept) => {
  const h = await hold($, k)
  const n = Object.keys(h.v.ph).filter(p => drop(h, p)).length
  await keep($, k, h)
  badge($, k, h)
  return `forgot ${n}: a call naming one is refused from now on, and each value, matched again, masks under a new number`
}
// What the pane lists: each placeholder, its value, and the rule or pattern that masked it.
const masked = (h: Held) => Object.entries(h.v.ph).map(([p, v]) => ({ p, v, by: h.v.by?.[p] ?? 'not recorded (masked before redact kept it)' }))
// Saves the vault when a masking added to it, one save at a time so an older copy never lands
// last. A save that fails throws, and the hook withholds: a --resume would not find the value.
const keep = ($: EngineInterface, k: Kept, h: Held) => {
  if (!h.dirty) return Promise.resolve()
  return k.saving = k.saving.catch(() => {}).then(async () => {
    if (!h.dirty) return
    h.dirty = false
    try { h.v.at = await $.clock.now(); await $.store.set(VAULT + h.id, h.v) }
    catch (err) { h.dirty = true; throw err }
  })
}
// One hook's masking: the session's vault with the file's rules that are on, then the settings'.
const masker = async ($: EngineInterface, k: Kept, fixed: readonly Pattern[]) => {
  await sync($, k)
  const h = await hold($, k)
  const patterns = [...k.compiled, ...fixed]
  return { m: (s: string) => mask(s, h, patterns), done: async () => { await keep($, k, h); badge($, k, h) } }
}
// drops the vaults of sessions untouched for KEEP_MS; a --resume of one finds its placeholders gone
const prune = async ($: EngineInterface) => {
  const now = await $.clock.now()
  for (const key of await $.store.keys()) {
    if (!key.startsWith(VAULT)) continue
    const v: any = await $.store.get(key)
    if (typeof v?.at !== 'number' || now - v.at > KEEP_MS) await $.store.delete(key)
  }
}

// The env files at the top of the folder a session starts in: `.env` and every `.env.*` but a
// template's (`.env.example`, its values are `changeme`). Not `.envrc`, whose lines are shell.
const ENV_FILE = /^\.env(?:\.(?!(?:example|sample|template|dist)$)[^\\/]+)?$/i
// `KEY=value`, `export` before it allowed; a quoted value runs to its closing quote, an unquoted
// one to a ` #` comment (`a#b` is one value). A value with a line break in its quotes is skipped,
// not half read.
const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'#](?:.*?\S)?)?)(?:\s+#.*)?\s*$/
// a value that only names another (`${OTHER}`, `$OTHER`) holds no secret of its own
const REF = /^\$\{?\w+\}?$/
export const envValues = (text: string) => text.split(/\r?\n/).flatMap(l => {
  const r = ENV_LINE.exec(l)
  const value = r && (r[2] ?? r[3] ?? r[4] ?? '')
  return r && value ? [{ key: r[1]!, value }] : []
})
// Puts each secret-shaped value of the env files at `dir` in the vault, under its key as label
// (`⟦GITHUB_TOKEN_n⟧`, ENV where the key is no label), so it is masked wherever it comes back
// with no rule on. Only a `strong` value: `PORT=3000` or `DEBUG=true`, vaulted, would mask
// every 3000 and true all session. A value the vault holds keeps its placeholder. The number added.
const seed = async ($: EngineInterface, h: Held, dir: string) => {
  const before = h.byValue.size
  const names = (await $.fs.list(dir)).filter(f => f.kind !== 'dir' && ENV_FILE.test(f.name)).map(f => f.name).sort()
  for (const name of names) {
    const text = await $.fs.read(`${dir.replace(/[\\/]+$/, '')}/${name}`).then(String, () => '')
    for (const { key, value } of envValues(text)) {
      if (value.includes(OPEN) || REF.test(value) || !strong(value)) continue
      const label = key.toUpperCase().replace(/[.-]/g, '_')
      mint(h, value, LABEL.test(label) ? label : 'ENV', `${name}: ${key}`)
    }
  }
  return h.byValue.size - before
}

// Tamper guard: what decides this plugin's masking, kept out of the model's reach. The patterns
// file, read or written (/redact show lists it); the store file of vaults (Bash is checked whole,
// so reading it is refused too); and its enabledPlugins and pluginConfigs entries in a settings
// file. Best effort: a Bash command that spells a path another way (a variable, `cd` first, a
// search over the home folder), an MCP server's own file tools, the plugin's own source and
// `claude plugin disable` get past it.
// its file, a glob over the folder, or the folder itself (`rm -rf …/store`)
const STORE = /plugins[\\/]+store(?:[\\/]+(?:redact|[^\s'"]*[*?[])|[\\/]*(?=[\s'";|&)]|$))/i
// Bash and the rules file: its name (FILE), a glob at the top of a `.claude` folder
// (`cat ~/.claude/*`), or a recursive reader or copier naming that folder. A bare `ls ~/.claude`
// passes, and so does the word claude (`grep -rn claude .`, `~/dotagents/claude/*`). A
// CLAUDE_CONFIG_DIR not named .claude gets the name rule only.
const RULES_SH = /redact-rules\.json|(?:^|[\s'"=~\\/])\.claude[\\/]+[^\s'"\\/]*[*?[]|\b(?:grep|rg|ag|ack|find|tar|zip|rsync|cp|scp)\b[^|;&\n]*(?:^|[\s'"=~\\/])\.claude[\\/]*(?=[\s'";|&)]|$)/i
// where a path lands, `/`-separated and lowercased (a case alias on Windows and macOS), else as
// spelled; a Grep with no path searches the working directory
const land = async ($: EngineInterface, p: string) =>
  ((await $.fs.stat(p, { resolve: true }).catch(() => undefined))?.realPath ?? p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
// a file tool's path that lands on the rules file, or a Grep over a folder that holds it
const reaches = async ($: EngineInterface, e: any, file: string) => {
  const p = e.tool === 'Grep' ? String(e.path ?? '.') : e.file_path ?? e.notebook_path ?? e.path
  if (typeof p !== 'string' || !p) return false
  if (p.toLowerCase().includes(FILE)) return true
  const [at, f] = await Promise.all([land($, p), land($, file)])
  return at === f || (e.tool === 'Grep' && f.startsWith(at + '/'))
}
// A file tool's settings file is any of that name, since ~/.claude/settings.json can be a link
// to one elsewhere (a dotfiles repo) and the tool names the target: the before and after decide.
// Bash names it under a claude folder, and redact.
const SETTINGS = /(?:^|[\\/])settings(?:\.local)?\.json$/i
const SETTINGS_SH = /claude[\\/]+settings(?:\.local)?\.json/i
// this plugin's entries in a settings file's text; undefined when it is no JSON, since a broken
// settings file drops them all
const ours = (text: string) => {
  try {
    const j = JSON.parse(text)
    return JSON.stringify(['enabledPlugins', 'pluginConfigs'].map(k => Object.entries(j?.[k] ?? {}).filter(([id]) => id === 'redact' || id.startsWith('redact@'))))
  } catch { return undefined }
}
const tamper = async ($: EngineInterface, e: any, file: string) => {
  if (e.tool === 'Bash') return STORE.test(e.command) || RULES_SH.test(e.command) || (SETTINGS_SH.test(e.command) && /redact/i.test(e.command))
  if (await reaches($, e, file)) return true
  if (!WRITES[e.tool]) return false
  const path = String(e.file_path ?? e.notebook_path ?? '')
  if (STORE.test(path)) return true
  if (!SETTINGS.test(path) || (e.tool !== 'Write' && e.tool !== 'Edit')) return false
  // an Edit names only the lines it changes, so compare the entries before and after it
  const before = await $.fs.read(path).catch(() => '{}')
  const after = e.tool === 'Write' ? String(e.content)
    : e.replace_all ? before.split(e.old_string).join(e.new_string) : before.replace(e.old_string, () => e.new_string)
  return ours(after) !== ours(before)
}

export const register: Register = (on, options) => {
  // The `patterns` option, lines in /redact add's short form, masked after the file's rules.
  // One that does not compile is skipped, the rest stay on. They run in each hook's budget: a slow
  // one gets the text withheld by the `.catch`es below, never passed on, so bounding its repeats
  // is the user's call.
  // an unset option reads as '', a line no pattern holds
  const settings = (typeof options.patterns === 'string' ? [options.patterns] : Array.isArray(options.patterns) ? options.patterns : [])
    .map(l => String(l).trim()).filter(Boolean)
  const fromSettings = compile(settings.flatMap(line => lineFault(line) ? [] : [read(line)]), 'pattern from settings')
  const skipped = settings.flatMap((src, i) => lineFault(src) ? [`#${i + 1}`] : [])
  // note: the pane's answer to its last add, remove or forget
  const kept: Kept = { rules: [], compiled: [], note: '', extra: fromSettings.length, saving: Promise.resolve(), raw: false, skipped, revealed: new Set(), tab: 'session', sample: '' }
  // The tamper guard is off while redact is being developed (it refuses the work on its own
  // files); the tests turn it on with this undeclared option. Default it back to on before release.
  const guarded = options.guard === true
  const failed = (where: string, kind: string) => `redact could not mask ${where} (${kind})`

  on('session.start', async ($, e, next) => {
    try { await $.command.register({ name: 'redact', description: 'Show the redact pane, test, add or remove rules, turn them on or off, and forget held values.', argumentHint: USAGE }) }
    catch (err) { $.ui.log(`redact: /redact not registered: ${(err as Error)?.message ?? err}`, { to: 'debug' }) } // throws on hot reload (no session bound yet)
    try { await prune($) } catch (err) { $.ui.log(`redact: old vaults not pruned: ${(err as Error)?.message ?? err}`, { to: 'debug' }) }
    try { await sync($, kept); badge($, kept, await hold($, kept)) } // a --resume starts with a vault
    catch (err) { $.ui.log(`redact: vault not loaded: ${(err as Error)?.message ?? err}`, { to: 'debug' }) }
    // the project's env values, masked from the first request on
    try {
      const h = await hold($, kept)
      const n = await seed($, h, e.cwd)
      await keep($, kept, h)
      badge($, kept, h)
      if (n) told($, `redact: ${n} value${n > 1 ? 's' : ''} from the env files here masked (/redact show)`)
    } catch (err) { $.ui.log(`redact: env files not read: ${(err as Error)?.message ?? err}`, { to: 'debug' }) }
    return next(e)
  })

  on('command.run', { command: 'redact' }, async ($, e) => {
    const reply = await answer($, kept, fromSettings, e.args)
    if (reply) told($, `redact: ${reply}`)
    return {}
  })

  // ---- Masking: everything the model reads, before it is recorded or sent.

  // A slash command's line takes no rewrite here: its arguments are masked at command.run, a
  // skill's text at skill.prompt.
  on('prompt.submit', async ($, e, next) => {
    // Every /redact line stays out of the conversation: dropped, it never enters it. command.run
    // has run it by now (`e.command.args` is what its hooks left); the pane opens here only when
    // command.run did not open it, should a build drop before it runs.
    if (e.command?.name === 'redact') {
      const tab = TABS[e.command.args.trim()]
      if (!kept.opened && tab) { kept.tab = tab; kept.note = ''; await $.ui.open({ id: PANE, title: TITLE, focus: true }) }
      kept.opened = false
      return { drop: 'redact: kept out of the conversation' }
    }
    if (e.command) return next(e)
    const { m, done } = await masker($, kept, fromSettings)
    const text = m(e.text)
    await done()
    return next(text === e.text ? e : { ...e, text })
  }).catch((_, _e, next) => ({ drop: `${failed('this prompt', next.error.kind)}, so it was not sent.` }))

  // /redact's own arguments are a rule for the rules file, not text for the model.
  on('command.run', async ($, e, next) => {
    if (e.command === 'redact' || !e.args) return next(e)
    const { m, done } = await masker($, kept, fromSettings)
    const args = m(e.args)
    await done()
    return next(args === e.args ? e : { ...e, args })
  }).catch((_, e, next) => next.called ? { text: failed(`/${e.command}'s output`, next.error.kind) } : { text: `${failed(`/${e.command}'s arguments`, next.error.kind)}, so it did not run.` })

  on('skill.prompt', async ($, e, next) => {
    const r = await next(e)
    const { m, done } = await masker($, kept, fromSettings)
    const text = m(r.text)
    await done()
    return text === r.text ? r : { ...r, text }
  }).catch((_, e, next) => ({ text: `${failed(`the ${e.skill} skill's text`, next.error.kind)}, so it was left out.` }))

  // The first message's blocks (CLAUDE.md, the account's email, the date). A rewritten claudeMd
  // text leaves the files behind it unknown, so the engine renders nothing again from them.
  on('prompt.context', async ($, e, next) => {
    const r = await next(e)
    const { m, done } = await masker($, kept, fromSettings)
    const blocks = r.blocks.map(b => { const text = m(b.text); return text === b.text ? b : { ...b, text } })
    await done()
    return blocks.some((b, i) => b !== r.blocks[i]) ? { ...r, blocks } : r
  }).catch(($, _e, next) => { told($, `${failed('the first request\'s context (CLAUDE.md, the date)', next.error.kind)}, so it was left out.`); return { blocks: [] } })

  // The system prompt. Nothing changed hands core's own list back, so `shared` sections keep the
  // prompt cache; failing, only those stay: they read the same for everyone, so hold nothing of ours.
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    const { m, done } = await masker($, kept, fromSettings)
    const sections = r.sections.map(s => { const text = m(s.text); return text === s.text ? s : { ...s, text } })
    await done()
    return sections.some((s, i) => s !== r.sections[i]) ? { sections } : r
  }).catch(async ($, e, next) => {
    told($, `${failed('the system prompt', next.error.kind)}, so only its shared sections were sent.`)
    return { sections: (await next(e)).sections.filter(s => s.scope === 'shared') }
  })

  // What the engine injects per request (a reminder, a mentioned file, a hook's context): the
  // transcript keeps the engine's record, the request carries this answer.
  on('prompt.attachment', async ($, e, next) => {
    const r = await next(e)
    if (typeof r.text !== 'string') return r
    const { m, done } = await masker($, kept, fromSettings)
    const text = m(r.text)
    await done()
    return text === r.text ? r : { ...r, text }
  }).catch(($, e, next) => { told($, `${failed(`an injected ${e.type}`, next.error.kind)}, so it was left out.`); return { text: null } })

  // An MCP server's words about its tools; the built-in tools' are the engine's own.
  on('tool.describe', async ($, e, next) => {
    const r = await next(e)
    if (!e.tool.startsWith('mcp__')) return r
    const { m, done } = await masker($, kept, fromSettings)
    const description = m(r.description)
    await done()
    return description === r.description ? r : { ...r, description }
  }).catch(async (_, e, next) => ({ ...(await next(e)), description: 'redact: withheld, as masking it failed.' }))

  // Every row a conversation keeps, a subagent's too: what the transcript stores and the next
  // request sends. The model's response holds no value it never saw, and a notice is never sent.
  // Failing, the row's text is withheld: the catch maps blocks to a constant, nothing that can throw.
  on('session.append', async ($, e, next) => {
    if (e.door === 'response') return next(e)
    // a /redact line's arguments (a pattern being added) are emptied in any row, a notice too:
    // the engine records them empty already, this holds should it stop
    const scrubbed = blocks(e.message.content, s => s.replace(REDACT_ARGS, '$1$2'))
    if (e.door === 'notice') return next(scrubbed === e.message.content ? e : { ...e, message: { ...e.message, content: scrubbed } })
    const { m, done } = await masker($, kept, fromSettings)
    const content = blocks(scrubbed, m)
    await done()
    return next(content === e.message.content ? e : { ...e, message: { ...e.message, content } })
  }).catch((_, e, next) => next({ ...e, message: { ...e.message, content: blocks(e.message.content, () => WITHHELD) } }))

  // ---- Restoring: the real values, where they run or are drawn on this machine.

  on('tool.call', async ($, e, next) => {
    const h = await hold($, kept)
    const missing = new Set<string>()
    const input = deep(e, s => restore(s, h, missing)) as typeof e
    if (missing.size) {
      const names = [...missing].join(', ')
      const isNo = missing.size > 1 ? 'are no placeholders' : 'is no placeholder'
      // the deny reaches only the model; the person sees why their call stopped too
      told($, `redact refused ${e.tool}: ${names} ${isNo} this session holds`)
      const escaped = [...missing].map(p => ESC + p.slice(OPEN.length)).join(', ')
      return { deny: `${names} ${isNo} this session's redact vault holds, so its real value cannot be put back. Use the placeholders exactly as they appear in the conversation, or ask the user. To write one as literal text (a doc, a report), put ! after its opening bracket: ${escaped}.` }
    }
    if (guarded && await tamper($, input, await place($, kept))) {
      return { deny: `this call would reach the redact plugin's own config (its rules file, its store of vaults, or its entries in a settings file), which decides what gets masked. Ask the user to make that change: they edit the file themselves, or use /redact show.` }
    }
    return next(input)
  }).catch(async (_, e, next) => ({
    // No work here, the grace is 1 s. `called`: the tool ran, so retrying repeats it.
    deny: next.called
      ? `${e.tool} ran, but its output is withheld: the redact plugin failed after it (${next.error.kind}).`
      : `${e.tool} did not run: the redact plugin failed before it (${next.error.kind}).`,
  }))

  // The terminal is this machine's; every other surface (the mobile app over Remote Control, the
  // desktop app, VS Code) keeps the placeholders, so drawing never sends a value off the terminal. A
  // failed hook draws the engine's row, placeholders and all.
  // `kept.raw` (the pane's toggle) draws the placeholders on the terminal too, as the model reads
  // them: the transcript and the suggested prompt
  const drawn = (s: string) => !kept.raw && s.includes(OPEN)
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) =>
    e.surface === 'terminal' && drawn(e.props.text) ? next({ ...e, props: { ...e.props, text: restore(e.props.text, await hold($, kept)) } }) : next(e))
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) =>
    e.surface === 'terminal' && drawn(e.props.text) ? next({ ...e, props: { ...e.props, text: restore(e.props.text, await hold($, kept)) } }) : next(e))
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || !drawn(JSON.stringify(e.props.input) ?? '')) return next(e)
    const h = await hold($, kept)
    return next({ ...e, props: { ...e.props, input: deep(e.props.input, s => restore(s, h)) } })
  })
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || !drawn(JSON.stringify(e.props.output) ?? '')) return next(e)
    const h = await hold($, kept)
    return next({ ...e, props: { ...e.props, output: deep(e.props.output, s => restore(s, h)) } })
  })
  // the engine's guess at the next prompt, in the box: submitted, it is masked again
  on('prompt.suggest', async ($, e, next) => drawn(e.text) ? next({ ...e, text: restore(e.text, await hold($, kept)) }) : next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    await sync($, kept)
    const file = await place($, kept)
    const vault = masked(await hold($, kept))
    const { rules, note, tab, sample } = kept
    const { Box, Text, Button } = $.ui.resolve(e)
    const w = Math.max(1, e.props.bodyColumns ?? 80)
    const len = (s: string) => [...s].length
    const section = (k: string, title: string, right?: string) => {
      const bare = 3 + len(title) + 1
      const r = right && w - bare - (len(right) + 4) >= 2 ? right : undefined
      const fill = Math.max(2, w - bare - (r ? len(r) + 4 : 0))
      return (
        <Text key={k} wrap="truncate-end">
          <Text dimColor>── </Text>
          <Text weight="semibold">{title}</Text>
          <Text dimColor> {'─'.repeat(fill)}</Text>
          {r ? <Text dimColor> {r} </Text> : null}
          {r ? <Text dimColor>──</Text> : null}
        </Text>
      )
    }
    const redraw = (s: string) => { kept.note = s; $.ui.invalidate('ui.render') }
    const go = (t: Tab) => { kept.tab = t; kept.note = ''; $.ui.invalidate('ui.render') }
    const tabBtn = (t: Tab, title: string, hk: string) => (
      <Button key={`tab-${t}`} label={`${title}${tab === t ? '•' : ' '}`} hotkey={hk} plain dimColor={tab !== t} onPress={() => go(t)} />
    )
    // The value, on the terminal only: every other surface (mobile, desktop, VS Code) keeps the
    // placeholders, so the pane never sends a value there either. The model never reads a pane, and a tool that reads the
    // screen back (a Bash `tmux capture-pane`) returns text the vault masks again, as it holds
    // every value shown here; a screenshot is an image, which nothing masks (README, Limits).
    // A value with a line break or past 40 characters (a private key runs to 8 KB) is cut to its ends
    // until its reveal is pressed, so one key does not fill the pane or show whole on a shared screen.
    const long = (v: string) => e.surface === 'terminal' && (v.includes('\n') || v.length > 40)
    const shown = (p: string, v: string) => {
      if (e.surface !== 'terminal') return `${v.length} chars`
      if (!long(v) || kept.revealed.has(p)) return v
      const lines = v.split('\n').length
      const size = `(${lines > 1 ? `${lines} lines, ` : ''}${v.length} chars)`
      // a short one shows its size alone, as its ends would be all of it; a line break draws as ⏎
      const ends = v.length > 20 ? `${v.slice(0, 6)}…${v.slice(-4)} `.replace(/\r?\n/g, '⏎') : ''
      return ends + size
    }
    const reveal = (p: string) => { kept.revealed.has(p) ? kept.revealed.delete(p) : kept.revealed.add(p); $.ui.invalidate('ui.render') }
    // a long pattern is cut in the middle, so its row keeps the remove button on a narrow terminal
    const pattern = (text: string) => <Box flexShrink={1}><Text wrap="truncate-middle">{text}</Text></Box>
    const skip = (f: string | undefined) => f ? <Text color="red"> skipped: {f}</Text> : null
    const broken = rules.filter(fault).length + settings.filter(lineFault).length + (kept.broken ? 1 : 0)
    const label = (r: unknown) => fault(r) ? null : <Text dimColor> as {spec(r).label}</Text>
    const lit = kept.compiled.length
    const trial = fresh()
    const preview = sample ? mask(sample, trial, [...kept.compiled, ...fromSettings]) : ''
    const hits = sample ? masked(trial) : []
    let testField = <Text dimColor>{'  try a sample with /redact test <text>'}</Text>
    let addField = <Text dimColor>{'  add one with /redact add <regex>'}</Text> // mobile has no Input
    if (e.surface !== 'mobile') {
      const { Input } = $.ui.resolve(e)
      testField = <Input key="test" value={sample} label="  test " placeholder="sample text; Enter previews what these patterns mask" submitLabel="test" onSubmit={v => { kept.sample = v; $.ui.invalidate('ui.render') }} />
      addField = <Input key="add" label="  add  " placeholder="LABEL [i min=N strong prose]: regex, or a bare regex, masked as SECRET" submitLabel="add" onSubmit={async v => redraw(await add($, kept, v.trim()))} />
    }
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Box flexWrap="wrap" columnGap={2} justifyContent="space-between">
            <Box flexWrap="wrap" columnGap={2}>
              {tabBtn('session', `This session (${vault.length})`, 's')}
              {tabBtn('rules', `Rules (${lit + fromSettings.length} on)`, 'r')}
              {tabBtn('help', 'Guide', 'h')}
              {broken > 0 && <Text color="red">✗ {broken} skipped</Text>}
            </Box>
            {e.surface === 'terminal' && (
              <Box gap={1}>
                <Text dimColor>terminal draws: {kept.raw ? 'as the model reads it' : 'the real values'}</Text>
                <Button key="raw" label="switch" hotkey="d" onPress={async () => { kept.raw = !kept.raw; badge($, kept, await hold($, kept)); $.ui.invalidate('ui.render') }} />
              </Box>
            )}
          </Box>
          {note && <Text color={/^(not added|not saved|nothing added|already|no such)/.test(note) ? 'warning' : undefined} dimColor={!/^(not added|not saved|nothing added|already|no such)/.test(note)}>{note}</Text>}
        </Box>
        {tab === 'session' && (
          <Box flexDirection="column">
            <Box gap={1}>
              <Box flexShrink={1}>{section('sec-session', 'This session', `${vault.length} masked`)}</Box>
              {vault.length > 1 && <Box flexShrink={0}><Button key="forget-all" label="forget all" plain onPress={async () => redraw(await forgetAll($, kept))}><Text color="red">✗ all</Text></Button></Box>}
            </Box>
            {vault.length === 0
              ? <Text dimColor>  nothing masked yet</Text>
              : <Text dimColor>  forget drops one from the vault: a call naming it is refused, and the value masks under a new number</Text>}
            {vault.map(({ p, v, by }) => (
              <Box key={p} flexDirection="column">
                <Box gap={1}>
                  <Box flexShrink={1}><Text>  {p} {shown(p, v)}</Text></Box>
                  {long(v) && <Box flexShrink={0}><Button key={`reveal-${p}`} label={kept.revealed.has(p) ? 'hide' : 'reveal'} plain dimColor onPress={() => reveal(p)}>{kept.revealed.has(p) ? '▾' : '▸'}</Button></Box>}
                  <Box flexShrink={0}><Button key={`forget-${p}`} label="forget" plain onPress={async () => redraw(await forget($, kept, p))}><Text color="red">✗</Text></Button></Box>
                </Box>
                <Text dimColor>    masked by {by}</Text>
              </Box>
            ))}
          </Box>
        )}
        {tab === 'rules' && (
          <Box flexDirection="column" gap={1}>
            <Box flexDirection="column">
              <Box gap={1}>
                <Box flexShrink={1}>{section('sec-test', 'Test', sample ? `${hits.length} matched` : 'without saving')}</Box>
                {sample && <Box flexShrink={0}><Button key="clear-test" label="clear" plain onPress={() => { kept.sample = ''; $.ui.invalidate('ui.render') }}><Text color="red">✗</Text></Button></Box>}
              </Box>
              {testField}
              {sample && (
                <Box flexDirection="column">
                  <Text>  → {preview}</Text>
                  {hits.length === 0
                    ? <Text dimColor>    {lit + fromSettings.length ? 'no rule matched' : 'no rule matched: none is on'}</Text>
                    : hits.map(x => <Text key={x.p} dimColor>    {x.p} {shown(x.p, x.v)} · masked by {x.by}</Text>)}
                </Box>
              )}
            </Box>
            <Box flexDirection="column">
              {section('sec-rules', 'Rules', `${lit} of ${rules.length} on`)}
              <Text dimColor>  in {file}, for every project; edit it by hand or here</Text>
              {kept.broken && <Text color="red">  {FILE} {kept.broken}: masking with the last rules read until it is fixed by hand</Text>}
              {addField}
              {rules.length === 0 && <Text dimColor>  none yet</Text>}
              {rules.map((r: any, i) => {
                const src = typeof r?.pattern === 'string' ? r.pattern : JSON.stringify(r)
                const name = typeof r?.name === 'string' && r.name ? r.name : undefined
                const f = fault(r), enabled = isOn(r)
                return (
                  <Box key={`rule-${i}`} flexDirection="column">
                    {/* a named rule gets its name on its own line and the regex dimmed below it:
                        on one line, a long regex buried the name */}
                    <Box gap={1}>
                      <Box flexShrink={1}>{pattern(`  ${i + 1}. ${name ?? src}`)}{label(r)}{skip(f)}</Box>
                      <Box flexShrink={0}><Button key={`turn-${i}`} label={enabled ? 'turn off' : 'turn on'} plain onPress={async () => redraw(await turn($, kept, `${i + 1}`, !enabled))}><Text color={enabled && !f ? 'green' : undefined} dimColor={!enabled || !!f}>{enabled ? '● on' : '○ off'}</Text></Button></Box>
                      <Box flexShrink={0}><Button key={`remove-${i}`} label="remove" plain onPress={async () => redraw(await remove($, kept, `${i + 1}`))}><Text color="red">✗</Text></Button></Box>
                    </Box>
                    {name && <Text dimColor wrap="truncate-middle">{`     ${src}`}</Text>}
                  </Box>
                )
              })}
            </Box>
            <Box flexDirection="column">
              {section('sec-settings', 'From settings', settings.length ? `${settings.length} set` : 'none')}
              <Text dimColor>  the patterns option in settings.json, always on</Text>
              {settings.length === 0 && <Text dimColor>  none</Text>}
              {settings.map((src, i) => <Box key={`set-${i}`}>{pattern(`  ${src}`)}{lineFault(src) ? null : label(read(src))}{skip(lineFault(src))}</Box>)}
            </Box>
          </Box>
        )}
        {tab === 'help' && (
          <Box flexDirection="column" gap={1}>
            <Box flexDirection="column">
              {section('sec-format', 'Rule format', FILE)}
              <Text dimColor>{'  pattern         a JavaScript regex; each match is masked whole'}</Text>
              <Text dimColor>{'  replacement     the placeholder\'s label, capitals, digits and _: API_KEY masks as API_KEY_n'}</Text>
              <Text dimColor>{'  enabled         false turns a rule off; the two examples start off'}</Text>
              <Text dimColor>{'  name            what the pane and the vault call it'}</Text>
              <Text dimColor>{'  options         ignoreCase, strong, prose: true; min: N'}</Text>
              <Text dimColor>{'  (?<v>...)       masks only group v (or v2), keeping prefix and suffix around it'}</Text>
              <Text dimColor>{'  /redact add     LABEL [i min=N strong prose]: regex, or a bare regex as SECRET'}</Text>
            </Box>
            <Box flexDirection="column">
              {section('sec-escape', 'Placeholders & escaping')}
              <Text dimColor>{'  once matched    a value keeps its placeholder all session and masks as a whole word'}</Text>
              <Text dimColor>{'  env files       a session starts with the secret-shaped values of .env and .env.* where it starts'}</Text>
              <Text dimColor>{'  unknown         a placeholder not in this session\'s vault refuses the tool call'}</Text>
              <Text dimColor>{`  ${ESC}LABEL_n⟧     ! after ${OPEN} writes the literal placeholder without restoring it`}</Text>
            </Box>
            <Box flexDirection="column">
              {section('sec-restore', 'Where real values go')}
              <Text dimColor>{'  tools           every tool call (Bash, Edit, WebFetch, WebSearch, MCP) gets real values'}</Text>
              <Text dimColor>{'  surfaces        only the terminal draws real values; desktop, VS Code and mobile keep placeholders'}</Text>
            </Box>
          </Box>
        )}
      </Box>
    )
  })
}
