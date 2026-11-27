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
  { name: 'Example: API keys and tokens (sk-, ghp_, AKIA, xoxb-, JWTs and more)',
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
// The pane's new rule form: the one-line form's parts, one control each. `min` as typed.
// A switch left alone is undefined, so what a pasted line sets stands; set, it wins either way.
type Draft = { pattern: string; name: string; min: string; i?: boolean; strong?: boolean; prose?: boolean }
const DRAFT: Draft = { pattern: '', name: '', min: '' }
// a name as a label (Employee ID → EMPLOYEE_ID), SECRET when none can start with a letter
const toLabel = (name: string) => {
  const l = name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return LABEL.test(l) ? l : 'SECRET'
}
// The draft as a rule. The pattern field still takes a pasted one-line rule (read), so a README
// example is not saved as a regex for its own text; a typed name and the switches win over it.
// Throws why it does not read, as read does.
const fromDraft = (d: Draft): Rule => {
  const r = read(d.pattern.trim())
  const name = d.name.trim(), min = d.min.trim()
  if (name) { r.name = name; r.replacement = toLabel(name) }
  for (const [k, o] of [['i', 'ignoreCase'], ['strong', 'strong'], ['prose', 'prose']] as const) {
    if (d[k] === true) r[o] = true
    else if (d[k] === false) delete r[o]
  }
  if (min && !/^\d+$/.test(min)) throw new Error('min length is not a whole number')
  if (min) r.min = Number(min)
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
const TITLE = 'redact'
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
type Tab = 'session' | 'rules'
// help and guide open Session with its help shown: the Help tab became a toggle on each tab
const TABS: Record<string, Tab> = { '': 'session', show: 'session', session: 'session', rules: 'rules', patterns: 'rules', test: 'rules', guide: 'session', help: 'session' }
type Kept = { rules: unknown[]; compiled: Pattern[]; broken?: string; last?: string; sig?: string; file?: Promise<string>; seeded?: boolean; note: string; extra: number
  vault?: { id: string; held: Promise<Held> }; env?: { id: string; seen: Seen }; envOn?: boolean; saving: Promise<unknown>; raw: boolean; skipped: string[]; shown?: string; revealed: Set<string>; cursor?: string; ruleAt?: number; arm?: string; opened?: boolean; tab: Tab; sample: string; help?: boolean; draft?: Draft }
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
  k.envOn = JSON.parse(t).envFiles !== false
  k.compiled = compile(rules, YOURS)
}
// Every masked event comes through here (a row, an attachment, a tool's description), so the file is read only when its
// time or size changed since the last read that took. A time of 0 is no time (a filesystem without one): read every time
const sync = async ($: EngineInterface, k: Kept) => {
  const path = await place($, k)
  const st = await $.fs.stat(path).catch(() => undefined)
  const sig = st?.mtimeMs ? `${st.mtimeMs}:${st.size}` : undefined
  if (sig && sig === k.sig) return
  const t = await text($, k, path)
  if (t !== undefined) { take(k, t); k.sig = sig }
}
// Writes the file's rules as `f` changes them, and the keys in `top`, its other keys kept; a file
// that did not read or parse is left alone, never written over. Undefined when saved, else why not.
const save = async ($: EngineInterface, k: Kept, f: (rules: unknown[]) => unknown[], top: object = {}) => {
  const path = await place($, k)
  const t = await text($, k, path)
  if (t === undefined) return `not saved: ${FILE} did not read`
  take(k, t)
  if (k.broken) return `not saved: ${FILE} ${k.broken}; fix it by hand`
  const next = JSON.stringify({ ...JSON.parse(t), ...top, rules: f(k.rules) }, null, 2) + '\n'
  try { await $.fs.write(path, next) } catch (err) { return `not saved: ${(err as Error)?.message ?? err}` }
  take(k, next)
  $.ui.invalidate('ui.render')
  return undefined
}
// a rule by its number, its name or its pattern; -1 when none is
const pick = (k: Kept, ref: string) => /^\d+$/.test(ref) && k.rules[Number(ref) - 1] !== undefined ? Number(ref) - 1
  : ref ? k.rules.findIndex((r: any) => r?.name === ref || r?.pattern === ref) : -1
// No reply names a rule by more than its number: a reply to a typed command can reach the model.
const NONE = 'no such rule. Use its number or name, as /redact rules lists them'
// turns a rule on or off
const turn = async ($: EngineInterface, k: Kept, ref: string, on: boolean) => {
  await sync($, k)
  const i = pick(k, ref)
  if (i < 0) return NONE
  if (isOn(k.rules[i]) === on) return `already ${on ? 'on' : 'off'}: rule ${i + 1}`
  return await save($, k, rules => rules.map((r, j) => j === i ? { ...r as object, enabled: on } : r))
    ?? `rule ${i + 1} ${on ? 'on' : 'off'}`
}
const add = async ($: EngineInterface, k: Kept, typed: string) => {
  if (!typed) return 'nothing added: give a regex'
  let rule: Rule
  try { rule = read(typed) } catch (err) { return `not added: ${(err as Error).message}` }
  return addRule($, k, rule)
}
const addRule = async ($: EngineInterface, k: Kept, rule: Rule) => {
  await sync($, k)
  const at = k.rules.findIndex((r: any) => r?.pattern === rule.pattern && (r?.replacement ?? 'SECRET') === rule.replacement)
  if (at >= 0) return `already there, as rule ${at + 1}`
  return await save($, k, rules => [...rules, rule]) ?? `added as rule ${k.rules.length}`
}
// Turns seeding from env files on or off: `envFiles` in the rules file, on when absent. Off keeps
// what it already put in the vault; on reads the files before the next prompt.
const envTurn = async ($: EngineInterface, k: Kept, on: boolean) => {
  await sync($, k)
  if ((k.envOn !== false) === on) return `env files already ${on ? 'on' : 'off'}`
  return await save($, k, rules => rules, { envFiles: on })
    ?? (on ? 'env files on, from the next prompt' : 'env files off. Values already masked stay masked')
}
const remove = async ($: EngineInterface, k: Kept, ref: string) => {
  await sync($, k)
  const i = pick(k, ref)
  if (i < 0) return NONE
  return await save($, k, rules => rules.filter((_, j) => j !== i)) ?? `removed rule ${i + 1}`
}
// the refusal prefixes of turn, add, remove and save's replies, which the pane's note draws as a warning
const REFUSED = /^(not added|not saved|nothing added|already|no such)/

// /redact's reply to its arguments, undefined for the pane. It answers in a toast, never as text:
// a command's output row is one the model reads, and none of /redact is its business
// (prompt.submit drops the line itself).
const USAGE = 'show | rules | help | test [text] | add <rule> | remove <n|name> | on <n|name> | off <n|name> | env on|off'
const answer = async ($: EngineInterface, k: Kept, fromSettings: Pattern[], args: string) => {
  const [, verb = '', rest = ''] = /^\s*(\S*)\s*([\s\S]*?)\s*$/.exec(args) ?? []
  if (verb === 'add') return add($, k, rest)
  if (verb === 'off' || verb === 'on') return turn($, k, rest, verb === 'on')
  if (verb === 'remove') return remove($, k, rest)
  if (verb === 'env' && (rest === 'on' || rest === 'off')) return envTurn($, k, rest === 'on')
  if (verb === 'test' && rest) {
    await sync($, k)
    // read first: unread, nothing is changed and the pane is not opened
    let h: Held
    try { h = await hold($, k) } catch (err) { return `not tested, the vault could not be read (${(err as Error)?.message ?? err})` }
    k.tab = 'rules'; k.note = ''; k.sample = rest
    await $.ui.open({ id: PANE, title: TITLE, focus: true }); k.opened = true
    $.ui.invalidate('ui.render')
    // a toast reaches every surface: the sample and the source drawn with no held value in them
    const { trial, out, hits } = tryOn(rest, h, [...k.compiled, ...fromSettings])
    const warn = inside(out, trial) ? `. ${INSIDE}` : ''
    // composed whole, then hidden: no text joined after hiding can complete a held value
    return seen((hits.length ? `→ ${out} (${hits.map(x => `${x.p} by ${x.by}`).join(', ')})` : k.compiled.length + fromSettings.length ? 'no rule matched' : 'no rule matched: none is on') + warn, trial)
  }
  const tab = !rest ? TABS[verb] : undefined
  if (tab) { k.tab = tab; k.note = ''; if (verb === 'help' || verb === 'guide') k.help = true; await $.ui.open({ id: PANE, title: TITLE, focus: true }); k.opened = true; return undefined }
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
// The indicator under the prompt, as the pane's status shows it: on while a rule or the env files
// mask, off when nothing does, a fault to fix. Drawn at the StatusLine site, not by $.ui.status,
// which the engine draws as a warning whatever it says.
const light = (k: Kept) =>
  k.broken ? { on: false, text: 'redact: rules file broken (/redact rules)' }
  : k.skipped.length ? { on: false, text: `redact: skipped pattern ${k.skipped.join(', ')} (/redact show)` }
  : k.compiled.length + k.extra || k.envOn !== false ? { on: true, text: 'redact', tail: k.raw ? "Claude's view" : undefined }
  : { on: false, text: 'redact off' }
// Redraws the indicator when what it says changes; once, clears a line an earlier version pinned.
// What the pane and the desktop widget count is in the key too: the rules on, the env files, and
// the session's vault and its size.
const badge = ($: EngineInterface, k: Kept, h?: Held) => {
  const line = JSON.stringify([light(k), k.compiled.length, k.envOn !== false, h ? [h.id, h.byValue.size] : null])
  if (line === k.shown) return
  if (k.shown === undefined) try { $.ui.status(undefined) } catch {}
  k.shown = line
  try { $.ui.invalidate('ui.render') } catch {}
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
  return `forgot ${p}. Claude can no longer use it`
}
// every placeholder at once, in one save
const forgetAll = async ($: EngineInterface, k: Kept) => {
  const h = await hold($, k)
  const n = Object.keys(h.v.ph).filter(p => drop(h, p)).length
  await keep($, k, h)
  badge($, k, h)
  return `forgot ${n}. Claude can no longer use ${n === 1 ? 'it' : 'them'}`
}
// Text the person picked to mask, as the desktop's right-click menu hands it: trimmed, and only
// what a rule could have masked (a letter or digit, no placeholder or part of one in it). 4
// characters at least: a picked value masks as a whole word all session, so a slip onto `a` or
// `the` would hide that word everywhere. 16 KB at most (a private key fits): every vault value
// joins the pattern run over every row. No control character but tab and line breaks: the
// terminal's pane draws a value, and a Text takes no other. Undefined otherwise.
const pickable = (s: string | undefined) => {
  const v = s?.trim()
  return v && v.length >= 4 && v.length <= 16384 && ALNUM.test(v) && !/[⟦⟧]/.test(v) && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v) ? v : undefined
}
// Text as a Text takes it: line ends as \n (lf), then each other control character but tab drawn
// as � (clean). For drawing only: what is masked or matched is the text as given. Either step
// can form a value the vault holds (`a\r\nb` to `a\nb`): where none may show, seen() hides them
// around each step.
const lf = (s: string) => s.replace(/\r\n?/g, '\n')
const clean = (s: string) => s.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '�')
// Every value the vault holds swapped for its placeholder wherever it stands, inside a word too,
// for drawing a sample off the terminal or in a toast: whole-word masking (mask) leaves `tok_` and
// a value as they are, and that is what Claude gets, but no value the vault holds is drawn there.
const hide = (s: string, h: Held) => [...h.byValue].sort((a, b) => b[0].length - a[0].length)
  .reduce((acc, [v, p]) => between(acc, part => part.split(v).join(p)), s)
// `s` drawn as a Text takes it with no value the vault holds in it: hidden before and after each
// step that changes the text, so no step forms one
const seen = (s: string, h: Held) => hide(clean(hide(lf(hide(s, h)), h)), h)
// whether `s` still carries a value the vault holds, inside a word, where masking leaves it
const inside = (s: string, h: Held) => s.split(PH_SPLIT).some((part, i) => i % 2 === 0 && [...h.byValue.keys()].some(v => part.includes(v)))
const INSIDE = 'A value already masked stands inside a word here, so Claude gets it as it is'
// A copy of a vault to try masking on: the session's numbering, nothing written back.
const trialOf = (h: Held): Held => ({ ...fresh(h.id), v: JSON.parse(JSON.stringify(h.v)), byValue: new Map(h.byValue), known: h.known })
// What Claude would get from `s`, masked against a copy of the session's vault as the real masking
// runs (a held value masks, a held placeholder stays), and what that masking added: placeholders
// the output carries more often than `s` did.
const tryOn = (s: string, h: Held, patterns: readonly Pattern[]) => {
  const trial = trialOf(h)
  const out = mask(s, trial, patterns)
  const times = (t: string, p: string) => t.split(p).length - 1
  return { trial, out, hits: masked(trial).filter(x => times(out, x.p) > times(s, x.p)) }
}
// Masks `value` from now on under SECRET, as a rule's match is. Only text recorded after this:
// rows are masked as they are recorded (session.append), so the ones already sent keep it.
// Saved first, in the save queue, and put in the live vault only once saved: no masking uses its
// placeholder before a --resume could restore it, a failed save leaves the vault as it was (clean,
// so later prompts are not withheld for it), and a second press waits for the first.
const PICKED = 'picked in the desktop app'
const pin = async ($: EngineInterface, k: Kept, value: string) => {
  // the session's vault read in the queue, so a /clear during an earlier save is followed
  const run = k.saving.catch(() => {}).then(async () => {
    const h = await hold($, k)
    const had = h.byValue.get(value)
    if (had) return { h, said: `already masked as ${had}` }
    const t = trialOf(h)
    mint(t, value, 'SECRET', PICKED)
    t.v.at = await $.clock.now()
    await $.store.set(VAULT + h.id, t.v)
    // Clean before and after the save, nothing changed the vault (every mint and drop dirties
    // it): what was saved is it with the pick. Else it stays dirty, and the next save writes it.
    const untouched = !h.dirty
    const p = mint(h, value, 'SECRET', PICKED)
    if (untouched) h.v.at = t.v.at, h.dirty = false
    else {
      // Changed meanwhile (another value may hold the saved number, so the pick has another):
      // the vault as it is now saved here, clean only if nothing changed it during this save.
      // Failing, it stays dirty, and the next masking saves it before it sends anything.
      // a mint always moves `n`, so a mint and a forget during the save still read as a change
      const state = () => JSON.stringify([h.v.n, h.v.ph])
      const was = state()
      try { h.v.at = await $.clock.now(); await $.store.set(VAULT + h.id, h.v); if (state() === was) h.dirty = false }
      catch { return { h, said: `masked as ${p} for now, but not saved yet: it is saved before anything more is sent to Claude` } }
    }
    return { h, said: `masked as ${p}: this exact text, as a whole word, from now on. Rows already sent to Claude keep it` }
  })
  k.saving = run.catch(() => {})
  const { h, said } = await run
  badge($, k, h)
  return said
}
// What the pane lists: each placeholder, its value, and the rule or pattern that masked it.
const masked = (h: Held) => Object.entries(h.v.ph).map(([p, v]) => ({ p, v, by: h.v.by?.[p] ?? 'rule unknown' }))
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
const GUIDE_ID = 'redact:placeholders'
export const PLACEHOLDER_GUIDE = [
  `Tokens shaped like ${OPEN}LABEL_n⟧ (such as ${OPEN}API_KEY_n⟧) are live value handles substituted automatically with their real values before any tool runs.`,
  '- Use them verbatim in commands, code, and edits as if they were the real values. Do not ask the user for the underlying value, treat them as missing/template text, or alter their brackets or numbers.',
  '- Do not inspect, decode, slice, or probe a handle to reveal its underlying value (e.g., via echo, base64, xxd, or scripts); only transform a handle when the task itself requires it (such as encoding a credential for a config or header).',
  '- Work silently with them: do not mention redaction or placeholders to the user unless asked or a tool call refuses one.',
  `- Every tool receives the real value (including git commits, PR bodies, and web/MCP calls)—placing a handle there publishes the real value. To write a handle literally as text, escape it as ${ESC}LABEL_n⟧.`,
].join('\n')
export const COMPACT_NOTE = `Preserve any ${OPEN}LABEL_n⟧ tokens verbatim in the summary; they are live value handles restored automatically before tools run.`
export const SUBAGENT_NOTE = `Note: Tokens shaped like ${OPEN}LABEL_n⟧ are live value handles restored automatically before tools run. Use them verbatim without asking for real values, probing to reveal them, or mentioning masking unless asked; escape literal text as ${ESC}LABEL_n⟧.`

// One hook's masking: the session's vault with the file's rules that are on, then the settings'.
const masker = async ($: EngineInterface, k: Kept, fixed: readonly Pattern[]) => {
  await sync($, k)
  const h = await hold($, k)
  const patterns = [...k.compiled, ...fixed]
  return { h, m: (s: string) => mask(s, h, patterns), done: async () => { await keep($, k, h); badge($, k, h) } }
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

// The env files at the top of the folder a session starts in: `.env`, `.env.*` and `*.env`
// (dotenv, Docker), `.envrc` (direnv: its `export KEY=value` lines read, the rest of its shell
// passes), `.dev.vars` and `.dev.vars.*` (wrangler), `.flaskenv`; and the files a compose file's
// `env_file:` names. Never a template's (`.env.example`, `example.env`): its values are `changeme`.
const ENV_FILE = /^(?:\.env(?:\..+)?|[^.].*\.env|\.envrc|\.dev\.vars(?:\..+)?|\.flaskenv)$/i
const TEMPLATE = /(?:^|\.)(?:example|sample|template|dist)(?:\.|$)/i
const COMPOSE = /^(?:docker-)?compose(?:\.[\w-]+)?\.ya?ml$/i
// The paths a compose file's `env_file:` names, as a scalar after it or a list below it (`- a.env`,
// `- path: a.env`), quotes stripped. Read as lines, not as YAML: a key indented less ends the list.
export const composeEnvFiles = (text: string) => {
  const out: string[] = []
  const lines = text.split(/\r?\n/)
  const unquote = (s: string) => s.replace(/^(['"])(.*)\1$/, '$2')
  lines.forEach((l, i) => {
    const r = /^(\s*)env_file:[ \t]*([^#]*?)\s*(?:#.*)?$/.exec(l)
    if (!r) return
    const [, indent, rest] = r as unknown as [string, string, string]
    if (rest.startsWith('[')) return void out.push(...rest.slice(1, rest.lastIndexOf(']')).split(',').map(s => unquote(s.trim())).filter(Boolean))
    if (rest) return void out.push(unquote(rest))
    for (const below of lines.slice(i + 1)) {
      if (!below.trim() || /^\s*#/.test(below)) continue
      const at = below.search(/\S/)
      if (at < indent.length || (at === indent.length && !below.trimStart().startsWith('-'))) break
      const p = /^\s*(?:-\s+(?!path:)([^\s#:]+|'[^']+'|"[^"]+")|(?:-\s+)?path:\s*([^\s#]+|'[^']+'|"[^"]+"))\s*(?:#.*)?$/.exec(below)
      if (p) out.push(unquote(p[1] ?? p[2]!))
    }
  })
  return out
}
// `KEY=value`, `export` before it allowed; a quoted value runs to its closing quote, an unquoted
// one to a ` #` comment (`a#b` is one value). A value with a line break in its quotes is skipped,
// not half read.
const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'#](?:.*?\S)?)?)(?:\s+#.*)?\s*$/
// a value that only names another (`${OTHER}`, `$OTHER`) or runs a command (`$(cat key)`, an
// `.envrc`'s) holds no secret of its own
const REF = /^\$\{?\w+\}?$|^\$\(|^`/
// Word-bounded credential key names: benign-value exemptions never apply to these
// (except *_FILE / *_DIR — or *_PATH on non-hook keys — for benign filesystem paths like SSL_PRIVATE_KEY_PATH).
const SECRET_KEY = /(?:^|[_.-])(?:SECRET|TOKEN|KEY|PASS|PASSWORD|PASSWD|PWD|CREDENTIAL|CREDENTIALS|WEBHOOK|HOOK|DSN|SIGNING|PRIVATE|COOKIE|BEARER)(?:$|[_.-])/i
const HOOK_KEY = /(?:^|[_.-])(?:WEBHOOK|HOOK)(?:$|[_.-])/i
const PATH_KEY = /(?:^|_)(?:PATH|FILE|DIR)$/i
// Safe DNS label: lowercase letters/hyphens, at most 24 chars, optional short trailing digit suffix (e.g. us-east-1, db1, s3).
const SAFE_HOST_LABEL = /^[a-z](?:[a-z-]{0,21}[a-z])?(?:-[0-9]{1,2}|[0-9])?$/
const SAFE_IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/
const SAFE_IPV6 = /^\[[0-9a-fA-F:]+\]$/
const isSafeHost = (host: string, allowSingleLabel: boolean) => {
  if (host === 'localhost' || SAFE_IPV4.test(host) || SAFE_IPV6.test(host)) return true
  const labels = host.split('.')
  if (!allowSingleLabel && labels.length < 2) return false
  return labels.every(l => l.length <= 24 && SAFE_HOST_LABEL.test(l))
}
// Known web/db schemes only (excludes s3:// etc. where the authority may be a key id).
const URL_PARTS = /^(https?|wss?|postgres(?:ql)?|mysql|mariadb|mongodb|redis|rediss|amqps?):\/\/([^/?#@:\s]+|\[[0-9a-fA-F:]+\])(?::(\d{1,5}))?(\/[^?#\s]*)?$/
const DB_SCHEME = /^(?:postgres(?:ql)?|mysql|mariadb|mongodb|redis|rediss|amqps?)$/
const isLocalHost = (host: string) =>
  host === 'localhost' || /^127\./.test(host) || host === '0.0.0.0' || host === '[::1]' || /\.(?:local|localhost|internal)$/.test(host)
// For local/private hosts and database schemes, ordinary short lowercase segments (e.g. /myapp_dev, /0) are safe.
// For public web/ws hosts, only generic API route segments pass so capability paths like /private-alerts stay masked.
const LOCAL_URL_SEG = /^(?:v\d{1,2}|[a-z][a-z_-]{0,14}|\d{1,4})$/
const PUBLIC_URL_SEG = /^(?:v\d{1,2}|api|graphql|gql|rpc|trpc|rest|ws|wss|hmr|auth|oauth|oauth2|oidc|sso|health|healthz|ready|readyz|status|metrics|docs|swagger|openapi)$/
const CAPABILITY_SEG = /^(?:hooks?|webhooks?|catch|callback|callbacks)$/
const isBenignUrl = (v: string) => {
  const m = URL_PARTS.exec(v)
  if (!m) return false
  const [, scheme = '', host = '', , path = ''] = m
  const isDb = DB_SCHEME.test(scheme)
  if (!isSafeHost(host, isDb)) return false
  if (!path || path === '/') return true
  const segs = path.replace(/^\/+|\/+$/g, '').split('/')
  if (segs.length > 3) return false
  if (isDb || isLocalHost(host)) return segs.every(s => LOCAL_URL_SEG.test(s) && !CAPABILITY_SEG.test(s))
  return segs.every(s => PUBLIC_URL_SEG.test(s))
}
// IPv4, bracketed IPv6, localhost[:port], or lowercase safe-label dotted host:port (mandatory port avoids dotted tokens like SG.xxx.yyy).
const PLAIN_ADDR = /^(?:(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?|\[[0-9a-fA-F:]+\](?::\d{1,5})?|localhost(?::\d{1,5})?|([a-z0-9-]+(?:\.[a-z0-9-]+)+):\d{1,5})$/
const isBenignAddr = (v: string) => {
  const m = PLAIN_ADDR.exec(v)
  return !!m && (!m[1] || isSafeHost(m[1], false))
}
// Clear filesystem path starting with ./, ../, ~/, or / with at least two segments (plus file: / sqlite:// local DB paths).
const PLAIN_PATH = /^(?:(?:\.\.?|~)(?:\/[A-Za-z0-9._-]+)+|(?:\/[A-Za-z0-9._-]+){2,})\/?$/
const tokenLikeSegment = (seg: string) =>
  /^[0-9a-f]{10,}$/i.test(seg)
  || (seg.length >= 10 && /[a-z]/.test(seg) && /[A-Z]/.test(seg) && /[0-9]/.test(seg))
  || (seg.length >= 12 && /[a-z]/.test(seg) && /[A-Z]/.test(seg) && !/^[A-Z][a-z]+(?:[-_][A-Z][a-z]+)*$/.test(seg))
  || (seg.length >= 16 && /[A-Za-z]/.test(seg) && /[0-9]/.test(seg))
const isBenignPath = (v: string) => {
  const p = v.startsWith('file:') ? v.slice(5) : v.startsWith('sqlite://') ? v.slice(9) : v
  return PLAIN_PATH.test(p) && !p.split('/').some(tokenLikeSegment)
}
const PLAIN_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/
const PLAIN_TZ = /^(?:(?:Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific)\/[A-Z][A-Za-z_-]{1,23}(?:\/[A-Z][A-Za-z_-]{1,23})?|Etc\/(?:UTC|GMT(?:[+-]\d{1,2})?))$/
const isBenignTz = (v: string) => PLAIN_TZ.test(v) && !v.split('/').some(tokenLikeSegment)
const PLAIN_LOCALE = /^[a-z]{2,3}(?:_[A-Z]{2})?\.(?:UTF-?8|ASCII|ISO-8859-\d+)$/i
const PLAIN_REGION = /^(?:(?:us|eu|ap|ca|sa|me|af|il|cn|us-gov)-(?:north|south|east|west|central|northeast|northwest|southeast|southwest)-\d|(?:us|europe|asia|australia|northamerica|southamerica|me|africa)-(?:north|south|east|west|central|northeast|northwest|southeast|southwest)\d)$/
const PLAIN_SEMVER = /^v?\d+\.\d+\.\d+(?:-[a-z0-9.]{1,12})?$/
export const isEnvSecret = (key: string, value: string) => {
  if (value.includes(OPEN) || REF.test(value) || !strong(value)) return false
  const secretKey = SECRET_KEY.test(key)
  if (isBenignPath(value) && (!secretKey || (PATH_KEY.test(key) && !HOOK_KEY.test(key)))) return false
  if (secretKey) return true
  if (isBenignUrl(value) || isBenignAddr(value) || PLAIN_DATE.test(value) || isBenignTz(value) || PLAIN_LOCALE.test(value) || PLAIN_REGION.test(value) || PLAIN_SEMVER.test(value)) return false
  return true
}
export const envValues = (text: string) => text.split(/\r?\n/).flatMap(l => {
  const r = ENV_LINE.exec(l)
  const value = r && (r[2] ?? r[3] ?? r[4] ?? '')
  return r && value ? [{ key: r[1]!, value }] : []
})
// Puts each secret-shaped value of the env files at `dir` (and those its compose files name) in the vault, under its key as label
// (`⟦GITHUB_TOKEN_n⟧`, ENV where the key is no label), so it is masked wherever it comes back
// with no rule on. Only a `strong` value: `PORT=3000` or `DEBUG=true`, vaulted, would mask
// every 3000 and true all session. A value the vault holds keeps its placeholder. The number added.
// Run again before every prompt with the session's `seen`: a file is read only when its time or
// size changed since, and only then are its values put in, so a value forgotten in the pane stays
// out until its file changes.
type Seen = Map<string, { sig: string; got: any }>
const reread = async <T,>($: EngineInterface, seen: Seen, path: string, parse: (t: string) => T) => {
  const st = await $.fs.stat(path).catch(() => undefined)
  const sig = st ? `${st.mtimeMs}:${st.size}` : 'none'
  const was = seen.get(path)
  if (was?.sig === sig) return { got: was.got as T, changed: false }
  const got = parse(st ? await $.fs.read(path).then(String, () => '') : '')
  seen.set(path, { sig, got })
  return { got, changed: true }
}
const seed = async ($: EngineInterface, h: Held, dir: string, seen: Seen) => {
  const before = h.byValue.size
  const base = dir.replace(/[\\/]+$/, '')
  const entries = (await $.fs.list(dir)).filter(f => f.kind !== 'dir').map(f => f.name).sort()
  const named: string[] = []
  for (const name of entries.filter(n => COMPOSE.test(n))) {
    const { got } = await reread($, seen, `${base}/${name}`, composeEnvFiles)
    named.push(...got.map(p => p.replace(/^\.[\\/]+/, '')))
  }
  // once each, as listed or as a compose file names it (relative to the folder, or absolute)
  const names = [...new Set([...entries.filter(n => ENV_FILE.test(n)), ...named])]
    .filter(n => !TEMPLATE.test(n.replace(/^.*[\\/]/, '')))
  for (const name of names) {
    const path = /^(?:[\\/]|[A-Za-z]:)/.test(name) ? name : `${base}/${name}`
    const { got, changed } = await reread($, seen, path, envValues)
    if (!changed) continue
    for (const { key, value } of got) {
      if (!isEnvSecret(key, value)) continue
      const label = key.toUpperCase().replace(/[.-]/g, '_')
      mint(h, value, LABEL.test(label) ? label : 'ENV', `${name}: ${key}`)
    }
  }
  return h.byValue.size - before
}
// Seeds this session's vault from the env files at `dir`, the session's folder when absent; a new
// session id (a /clear) reads every file again. A failure is logged, never thrown: the prompt it
// runs before still goes.
const seedHere = async ($: EngineInterface, k: Kept, dir?: string) => {
  try {
    await sync($, k)
    if (k.envOn === false) return
    const h = await hold($, k)
    if (k.env?.id !== h.id) k.env = { id: h.id, seen: new Map() }
    const n = await seed($, h, dir ?? await $.session.cwd(), k.env.seen)
    await keep($, k, h)
    badge($, k, h)
    if (n) told($, `redact: masked ${n} value${n > 1 ? 's' : ''} from .env files (/redact)`)
  } catch (err) { $.ui.log(`redact: env files not read: ${(err as Error)?.message ?? err}`, { to: 'debug' }) }
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
    try { await $.command.register({ name: 'redact', description: 'See what redact hides from Claude and manage its rules.', argumentHint: USAGE, immediate: true }) }
    catch (err) { $.ui.log(`redact: /redact not registered: ${(err as Error)?.message ?? err}`, { to: 'debug' }) } // throws on hot reload (no session bound yet)
    try { await prune($) } catch (err) { $.ui.log(`redact: old vaults not pruned: ${(err as Error)?.message ?? err}`, { to: 'debug' }) }
    try { await sync($, kept); badge($, kept, await hold($, kept)) } // a --resume starts with a vault
    catch (err) { $.ui.log(`redact: vault not loaded: ${(err as Error)?.message ?? err}`, { to: 'debug' }) }
    // the project's env values, masked from the first request on
    await seedHere($, kept, e.cwd)
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
    // an env file changed since the last prompt masks from this one on
    await seedHere($, kept)
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

  const isActive = (h: Held) => kept.compiled.length + fromSettings.length > 0 || kept.envOn !== false || h.byValue.size > 0

  // The system prompt. Nothing changed hands core's own list back, so `shared` sections keep the
  // prompt cache; failing, only those stay: they read the same for everyone, so hold nothing of ours.
  // While masking is active (including envFiles on with an empty vault) or the vault holds values,
  // append a static `session` guide upfront so flipping from empty to vaulted never busts the
  // session prompt cache mid-conversation.
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    const { h, m, done } = await masker($, kept, fromSettings)
    const maskedSections = r.sections.map(s => { const text = m(s.text); return text === s.text ? s : { ...s, text } })
    await done()
    const changed = maskedSections.some((s, i) => s !== r.sections[i])
    if (!isActive(h) || maskedSections.some(s => s.id === GUIDE_ID)) return changed ? { sections: maskedSections } : r
    return { sections: [...maskedSections, { id: GUIDE_ID, text: PLACEHOLDER_GUIDE, scope: 'session' as const }] }
  }).catch(async ($, e, next) => {
    told($, `${failed('the system prompt', next.error.kind)}, so only its shared sections were sent.`)
    return { sections: (await next(e)).sections.filter(s => s.scope === 'shared') }
  })

  // Keeps exact ⟦LABEL_n⟧ handles intact across compaction summaries when the vault holds values.
  on('session.compact', async ($, e, next) => {
    let vaulted = false
    try { vaulted = (await hold($, kept)).byValue.size > 0 } catch {}
    if (!vaulted || e.instructions?.includes(COMPACT_NOTE)) return next(e)
    const instructions = e.instructions ? `${e.instructions}\n\n${COMPACT_NOTE}` : COMPACT_NOTE
    return next({ ...e, instructions })
  })

  // Custom subagents may replace the session system prompt, so brief fresh subagents when masking
  // is active (or the vault holds values). Skips resumes (rewrites ignored), forks (inherit parent),
  // teammates (use prompt.compose), and workflow runs (may hold hidden placeholder prompts).
  on('agent.spawn', async ($, e, next) => {
    if (e.resume || e.fork || e.workflow || e.isTeammate || e.prompt.includes(SUBAGENT_NOTE)) return next(e)
    let active = false
    try { await sync($, kept); active = isActive(await hold($, kept)) } catch {}
    if (!active) return next(e)
    return next({ ...e, prompt: e.prompt ? `${e.prompt}\n\n${SUBAGENT_NOTE}` : SUBAGENT_NOTE })
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

  // The pane's one cursor is the engine's focus ring, which the arrows and Tab walk: the row cursor
  // (›) and the key line follow it onto a row's buttons, and stay put on any other stop (a tab).
  on('ui.focus', { component: 'Pane', requestId: PANE }, ($, e, next) => {
    const k = e.element ?? ''
    const p = /^(?:pick|forget)-(⟦.+)$/.exec(k)?.[1]
    const i = /^(?:turn|remove)-(\d+)$/.exec(k)?.[1]
    if (p !== undefined && p !== kept.cursor) kept.cursor = p
    else if (i !== undefined && +i !== kept.ruleAt) { kept.ruleAt = +i; if (kept.arm !== undefined && !kept.arm.startsWith(`${i}:`)) { kept.arm = undefined; kept.note = '' } }
    else return next(e)
    $.ui.invalidate('ui.render')
    return next(e)
  })

  // Under a statusLine command's output, and left out when that output fills the rows it has.
  on('ui.render', { component: 'StatusLine' }, async ($, e, next) => {
    await sync($, kept)
    const rows = e.props.text ? e.props.text.replace(/\n$/, '').split('\n').length : 0
    if (rows >= e.props.maxRows) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const l = light(kept)
    const beneath = await next(e)
    return (
      <Box flexDirection="column">
        {beneath}
        {l.on
          ? <Text wrap="truncate-end"><Text color="green">●</Text> {l.text}{l.tail ? <Text dimColor> · {l.tail}</Text> : null}</Text>
          : <Text color="warning" wrap="truncate-end">⚠ {l.text}</Text>}
      </Box>
    )
  })

  // The desktop app has no StatusLine: the same light as a chip in the gutter beside the message
  // box. A cell there draws Box and Text alone, so no press; /redact opens the pane. The terminal
  // raises BesidePrompt too, and has the line already.
  on('ui.render', { component: 'BesidePrompt' }, async ($, e, next) => {
    if (e.surface !== 'desktop') return next(e)
    await sync($, kept)
    const l = light(kept)
    // a warning too long for the gutter says less rather than vanishing when it matters
    const text = [l.on ? 'redact' : kept.broken ? 'redact: rules broken' : kept.skipped.length ? 'redact: pattern skipped' : 'redact off', 'redact off', 'redact']
      .find(t => e.props.maxColumns >= t.length + 2)
    if (!text) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box key="redact-chip">
        {l.on ? <Text color="green">●</Text> : <Text color="warning">⚠</Text>}<Text color={l.on ? undefined : 'warning'} dimColor={l.on}> {text}</Text>
      </Box>
    )
  })

  // The desktop's right-click menu on selected text: test it against the rules in the pane, or
  // mask it from now on. Sync and cheap, as the menu may open before a slow answer: the vault is
  // read in the press. A selection in the transcript is what the desktop drew, placeholders and
  // all, so a value there has been recorded; masking it keeps it out of what is recorded next.
  on('ui.render', { component: 'ContextMenu' }, ($, e, next) => {
    const sel = e.props.selection?.text
    if (!sel?.trim()) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const value = pickable(sel)
    const testIt = async () => {
      kept.sample = sel; kept.tab = 'rules'; kept.note = ''; kept.arm = undefined
      await $.ui.open({ id: PANE, title: TITLE, focus: true })
      $.ui.invalidate('ui.render')
    }
    const maskIt = async () => {
      if (!value) return
      try { told($, `redact: ${await pin($, kept, value)}`) }
      catch (err) { told($, `redact: not masked, the vault could not be read or saved (${(err as Error)?.message ?? err})`) }
    }
    return (
      <Box flexDirection="column">
        <Button key="redact-test" label="Test in redact" onPress={testIt}><Text dimColor>See what Claude would get</Text></Button>
        {value !== undefined && <Button key="redact-mask" label="Mask with redact" onPress={maskIt}><Text dimColor>Hide this exact text from Claude from now on</Text></Button>}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    await sync($, kept)
    const file = await place($, kept)
    const held = await hold($, kept)
    const vault = masked(held)
    const { rules, note, tab, sample } = kept
    const { Box, Text, Button } = $.ui.resolve(e)
    // The desktop's minimized widget: read at a glance, and clicks may not reach it, so no button,
    // and nothing a value or a rule's text could be in.
    if (e.props.placement === 'widget') {
      const l = light(kept)
      const rulesOn = kept.compiled.length + fromSettings.length
      return (
        <Box flexDirection="column">
          {l.on
            ? <Text><Text color="green">●</Text> redact</Text>
            : <Text color="warning">⚠ {l.text}</Text>}
          <Text dimColor size="footnote">{vault.length} masked · {rulesOn} rule{rulesOn === 1 ? '' : 's'}{kept.envOn !== false ? ' · env files' : ''}</Text>
        </Box>
      )
    }
    // The desktop draws in a window, not a grid of cells: sections as headings rather than a rule
    // of ─ counted to the width, no row cursor or key line (each row has its own buttons), and no
    // key hints, as its hotkeys are not known to answer.
    const desk = e.surface === 'desktop'
    // the body's last column left free, as the other panes do: drawn to it, a header lost its end
    // and a right-aligned ✗ vanished
    const w = Math.max(1, (e.props.bodyColumns ?? 80) - 1)
    const len = (s: string) => [...s].length
    const section = (k: string, title: string, right?: string) => {
      if (desk) return (
        <Box key={k} justifyContent="space-between" columnGap={2} flexGrow={1}>
          <Text weight="semibold" size="heading" wrap="truncate-end">{title}</Text>
          {right ? <Text dimColor>{right}</Text> : null}
        </Box>
      )
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
    // Any press but a rule's ✗ disarms it, its note with it. Session's own presses need not: the
    // tab switch that reaches them disarms.
    const disarm = () => { if (kept.arm !== undefined) { kept.arm = undefined; kept.note = '' } }
    const redraw = (s: string) => { disarm(); kept.note = s; $.ui.invalidate('ui.render') }
    const go = (t: Tab) => { disarm(); kept.tab = t; kept.note = ''; $.ui.invalidate('ui.render') }
    const tabBtn = (t: Tab, title: string, hk: string) => (
      <Button key={`tab-${t}`} label={title} hotkey={desk ? undefined : hk} plain dimColor={tab !== t} onPress={() => go(t)}>
        {tab === t ? <Text weight="bold" underline>{title}</Text> : title}
      </Button>
    )
    // On the terminal hotkeys answer only while the pane holds the keyboard: the row cursor and the
    // key line show then, a hint to click otherwise. Mobile and VS Code press the key line's buttons;
    // the desktop draws none (desk, above).
    const focused = e.surface !== 'terminal' || e.props.isFocused === true
    // a tab's keys as one line at its foot, so no row carries a key prefix that moves its switch
    const arrows = e.surface === 'terminal'
    const keyLine = (k: string, buttons: unknown[], hint: string, right?: unknown) => desk ? (right ? <Box key={k} justifyContent="flex-end">{right as any}</Box> : null) : (
      <Box key={k} justifyContent="space-between" paddingLeft={2} columnGap={2}>
        {focused
          ? <Box columnGap={2}>{arrows && <Text dimColor>↑↓ move</Text>}{buttons as any}</Box>
          : <Text dimColor>click the pane to use keys: ↑↓ move, {hint}</Text>}
        {right ? <Box flexShrink={0}>{right as any}</Box> : null}
      </Box>
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
    // A rule with no name is drawn by its regex, and a literal regex is the value itself: off the
    // terminal, rule text is masked by the vault like any other text.
    // Every text the pane draws from rules, sources or samples goes through here as the last step,
    // after any formatting: off the terminal, no held value is drawn, whatever joined it.
    const offTerminal = (s: string) => e.surface === 'terminal' ? clean(lf(s)) : seen(s, held)
    const reveal = (p: string) => { kept.revealed.has(p) ? kept.revealed.delete(p) : kept.revealed.add(p); $.ui.invalidate('ui.render') }
    // a long pattern is cut in the middle, so its row keeps the remove button on a narrow terminal
    const pattern = (text: string) => <Box flexShrink={1}><Text wrap="truncate-middle">{offTerminal(text)}</Text></Box>
    const skip = (f: string | undefined) => f ? <Text color="red"> skipped: {offTerminal(f)}</Text> : null
    const broken = rules.filter(fault).length + settings.filter(lineFault).length + (kept.broken ? 1 : 0)
    // a placeholder as the pane writes it, `_n` for its number: no digits, so no restore reads it as
    // one; `open` ESC writes the escaped form
    const notation = (label: string, open = OPEN) => `${open}${label}_n⟧`
    const label = (r: unknown) => fault(r) ? null : <Text dimColor>{` → ${notation(spec(r).label)}`}</Text>
    const lit = kept.compiled.length
    const tried = sample ? tryOn(sample, held, [...kept.compiled, ...fromSettings]) : undefined
    const preview = tried?.out ?? '', hits = tried?.hits ?? []
    // Off the terminal the field is never filled: the sample shows, hidden, in the line under it.
    // Filled, the surface draws it its own way (a one-line field joins lines, which can form a held
    // value), and a placeholder in it, edited beside (x⟦…⟧), tests as masked where the real text
    // would not be.
    const fieldValue = e.surface === 'terminal' ? clean(lf(sample)) : ''
    let testField = <Text dimColor>{'  try a sample with /redact test <text>'}</Text>
    const hasInput = e.surface !== 'mobile' // mobile has no Input
    const Input = hasInput ? $.ui.resolve(e).Input : undefined
    if (Input) testField = <Box paddingLeft={2}><Input key="test" value={fieldValue} label="test" placeholder="paste text to see what Claude gets" submitLabel="test" onSubmit={v => { disarm(); kept.sample = v; $.ui.invalidate('ui.render') }} /></Box>
    // a rule's or the env files' on/off button: green when on, dim when off or the rule is skipped
    // `active`, not `on`: the hook loader refuses a name that shadows on()
    const toggle = (key: string, active: boolean, label: string, onPress: () => void, faulty?: string, autoFocus?: boolean) => (
      <Button key={key} label={label} plain autoFocus={autoFocus || undefined} onPress={onPress}><Text color={active && !faulty ? 'green' : undefined} dimColor={!active || !!faulty}>{active ? '● on' : '○ off'}</Text></Button>
    )

    // indented by padding, not leading spaces, so a line that wraps keeps its indent
    // dim by default; 'ink' sets it in the full text colour, any other colour names itself
    const para = (text: string, color?: string) => <Box paddingLeft={2}><Text dimColor={!color} color={color === 'ink' ? undefined : color} wrap="wrap">{text}</Text></Box>
    const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`
    // What masks from now on. A fresh install has env files on and no rule: said, so the green
    // line does not read as everything covered.
    const ruleCount = lit + fromSettings.length
    const envOn = kept.envOn !== false
    const masking = [ruleCount ? count(ruleCount, 'rule') : '', envOn ? 'env files' : ''].filter(Boolean)
    const status = masking.length
      ? <Text color="green" wrap="wrap">● On: {masking.join(' and ')}{ruleCount ? '' : desk ? ' only, no rules' : ' only, no rules (r)'}</Text>
      : <Text color="warning" wrap="wrap">○ Off: no rules on{desk ? '' : ' (r)'}</Text>
    // Help is a toggle on each tab, off by default: the pane shows what is on and what to press,
    // and h adds the why. A Help tab of its own was a page nobody opened at the moment of doubt.
    const help = kept.help === true
    const tip = (text: string) => help && para(text)
    // a term at normal weight in a 16-column field, its meaning dim beside it, wrapping in its column
    const row = (k: string, d: string) => desk ? <Box key={k}><Text wrap="wrap">{k} <Text dimColor>{d}</Text></Text></Box> : (
      <Box key={k}>
        <Box flexShrink={0}><Text>{`  ${k.padEnd(14)}`}</Text></Box>
        <Box flexShrink={1}><Text dimColor wrap="wrap">{d}</Text></Box>
      </Box>
    )
    // The draw switch's two states, the one drawn now bracketed and bold, the other dim and padded to
    // the same width, so a flip moves nothing. It switches the transcript, not this pane: named so.
    const drawState = (title: string, active: boolean) => <Text dimColor={!active} weight={active ? 'bold' : undefined}>{active ? `[${title}]` : ` ${title} `}</Text>
    const topBar = () => (
      <Box flexDirection="column">
        {/* the tabs on a row of their own: beside the status, a long one wrapped a tab away */}
        <Box flexWrap="wrap" columnGap={2}>
          {tabBtn('session', `Session (${vault.length})`, 's')}
          {tabBtn('rules', 'Rules', 'r')}
          {broken > 0 && <Text color="red">⚠ {count(broken, 'rule')} invalid</Text>}
          <Button key="help" label={help ? 'hide help' : 'help'} hotkey={desk ? undefined : 'h'} plain dimColor onPress={() => { disarm(); kept.help = !help; $.ui.invalidate('ui.render') }} />
        </Box>
        {status}
        {e.surface === 'terminal' && (
          <Box gap={1}>
            <Text dimColor>Transcript:</Text>
            <Button key="raw" label={kept.raw ? 'show real values' : "show Claude's view"} hotkey="d" plain onPress={async () => { disarm(); kept.raw = !kept.raw; badge($, kept, await hold($, kept)); $.ui.invalidate('ui.render') }}>
              <Text>{drawState('real values', !kept.raw)}{drawState("Claude's view", kept.raw)}</Text>
            </Button>
          </Box>
        )}
        {note && <Text color={REFUSED.test(note) ? 'warning' : undefined} dimColor={!REFUSED.test(note)}>{note}</Text>}
      </Box>
    )

    // The values under the rule or file that masked each, in the vault's order: the order the row
    // cursor (›) follows the focus ring through.
    const groups = new Map<string, typeof vault>()
    for (const x of vault) groups.set(x.by, [...groups.get(x.by) ?? [], x])
    const order = [...groups.values()].flat()
    const at = Math.max(0, order.findIndex(x => x.p === kept.cursor))
    const cur = order[at]?.p
    const aim = (p: string | undefined) => { kept.cursor = p; $.ui.invalidate('ui.render') }
    const pw = Math.max(0, ...vault.map(x => len(x.p)))
    // the cursor goes on to the row after the forgotten one, wherever the cursor was
    const forgetCur = async (p: string) => { const i = order.findIndex(x => x.p === p); kept.cursor = (order[i + 1] ?? order[i - 1])?.p; redraw(await forget($, kept, p)) }
    const curValue = order[at]?.v
    const sessionKeys = () => vault.length > 0 && keyLine('session-keys', [
      curValue !== undefined && long(curValue) && <Button key="cur-reveal" label={kept.revealed.has(cur!) ? 'hide' : 'reveal'} hotkey="v" plain dimColor onPress={() => reveal(cur!)} />,
      <Button key="cur-forget" label="forget" hotkey="x" plain dimColor onPress={() => cur && forgetCur(cur)} />,
    ].filter(Boolean), 'x forget',
    vault.length > 1 && <Button key="forget-all" label="forget all" plain dimColor onPress={async () => redraw(await forgetAll($, kept))} />)
    const sessionTab = () => (
      <Box flexDirection="column">
        {help && (
          <Box flexDirection="column" marginBottom={1}>
            {section('sec-how', 'How redact works')}
            {para(`redact swaps what your rules match for placeholders like ${notation('API_KEY')} before Claude sees it. Claude's tools still get the real value. Real values stay in a file on this machine.`, 'ink')}
            {para(`To start, turn on a rule in Rules${desk ? '' : ' (r)'} and paste a sample under Test to check it. Values show up here once something matches.`, 'ink')}
          </Box>
        )}
        {/* keyed on no rule, as a fresh install has env files on and may hold values from them */}
        {!help && ruleCount === 0 && <Box marginBottom={vault.length ? 1 : 0}>{para(desk ? 'No rules on yet. Turn one on under Rules.' : 'No rules on yet. Press r to turn one on, or h for help.', 'ink')}</Box>}
        {vault.length === 0 && ruleCount > 0 && para('Nothing masked yet.', 'ink')}
        {[...groups].map(([by, xs]) => (
          <Box key={`by-${by}`} flexDirection="column">
            {section(`src-${by}`, offTerminal(by.replace(/\r\n|\r|\n/g, '⏎')))}
            {/* one line per value, a revealed one too (its line breaks draw as ⏎): the value shrinks,
                the placeholder, padded to the widest, and the cursor's actions do not */}
            {xs.map(({ p, v }) => (
              <Box key={p} justifyContent="space-between" columnGap={2}>
                <Box flexShrink={1}>
                  {!desk && <Text>{focused && p === cur ? '› ' : '  '}</Text>}
                  <Box flexShrink={0}>{desk ? <Text>{p}</Text> : <Button key={`pick-${p}`} label={p} plain autoFocus={p === cur || undefined} onPress={() => aim(p)} />}</Box>
                  <Box flexShrink={1}><Text wrap="truncate-end">{desk ? '  ' : ' '.repeat(pw - len(p) + 2)}{shown(p, v).replace(/\r\n|\r|\n/g, '⏎')}</Text></Box>
                </Box>
                {/* on every row, as a rule's ✗ is: the arrows walk the ring in document order, and
                    buttons that came and went with the cursor made each step land somewhere new */}
                <Box flexShrink={0}>
                  <Button key={`forget-${p}`} label="forget" plain onPress={() => forgetCur(p)}><Text dimColor>✗</Text></Button>
                </Box>
              </Box>
            ))}
          </Box>
        ))}
        {help && (
          <Box flexDirection="column" marginTop={1}>
            {section('sec-know', 'Good to know')}
            {row('once masked', 'a value keeps its placeholder for the whole session')}
            {row('forget', 'Claude can no longer use the placeholder. If the value shows up again, it gets a new number.')}
            {row('unknown', "a tool call with a placeholder this session doesn't hold is refused")}
            {row(notation('LABEL', ESC), `writes the placeholder as plain text`)}
            {row('tools', 'all of them get real values, web and MCP tools too')}
            {row('other apps', 'only the terminal shows real values. Desktop, VS Code and mobile show placeholders.')}
            {desk && row('right-click', 'selected text in the conversation: test it here, or mask it from now on')}
          </Box>
        )}
      </Box>
    )

    // the Rules tab's row cursor, by index, kept in range as rules come and go
    const ruleAt = Math.min(Math.max(0, kept.ruleAt ?? 0), Math.max(0, rules.length - 1))
    const turnRule = async (i: number) => { kept.ruleAt = i; redraw(await turn($, kept, `${i + 1}`, !isOn(rules[i]))) }
    // The first press arms the ✗, the second removes: a slip off the switch beside it cost a rule.
    // Armed by the rule and its place, read afresh at the press, so a file edited by hand between
    // the presses re-arms instead of removing the rule now in that place.
    const armOf = (i: number) => `${i}:${JSON.stringify(kept.rules[i])}`
    const removeRule = async (i: number) => {
      await sync($, kept)
      if (kept.arm !== armOf(i)) { kept.arm = armOf(i); kept.ruleAt = i; kept.note = `press ✗ again to remove rule ${i + 1}`; $.ui.invalidate('ui.render'); return }
      kept.ruleAt = Math.max(0, i - (i === kept.rules.length - 1 ? 1 : 0))
      redraw(await remove($, kept, `${i + 1}`))
    }
    const rulesKeys = () => rules.length > 0 && keyLine('rules-keys', [
      <Button key="rule-turn" label="on/off" hotkey="t" plain dimColor onPress={() => turnRule(ruleAt)} />,
      <Button key="rule-remove" label={kept.arm === armOf(ruleAt) ? 'remove?' : 'remove'} hotkey="x" plain dimColor onPress={() => removeRule(ruleAt)} />,
    ], 't on/off, x remove')

    // The new rule form, behind one button so the tab stays short and the arrows walk past it.
    // Typing redraws it (onInput), so the placeholder and the check follow what is typed.
    const draft = kept.draft
    const setDraft = (d: Draft | undefined) => { kept.draft = d; $.ui.invalidate('ui.render') }
    // The button pressed goes as the form opens or closes, and the keyboard would go back to the
    // prompt with it: the focus moves to what replaces it. Refused when the pane does not hold it.
    const focusOn = (key: string) => { void $.ui.focus({ requestId: PANE, key }).catch(() => {}) }
    const edit = (patch: Partial<Draft>) => setDraft({ ...DRAFT, ...kept.draft, ...patch })
    // why a draft does not read, a regex error in the words the check line uses
    const why = (err: unknown) => err instanceof SyntaxError
      ? `not a valid regex: ${err.message.replace(/^Invalid regular expression: (?:\/.*\/[a-z]*: )?/, '')}`
      : (err as Error).message
    // Enter empties the terminal's field, and a redraw with the text it already drew does not put
    // it back: a refused draft is drawn empty once, then with its text again.
    const restore = async (key: keyof Draft) => {
      const d = kept.draft
      if (!d || typeof d[key] !== 'string' || !d[key]) return
      setDraft({ ...d, [key]: '' })
      await $.clock.sleep(30).catch(() => {})
      if (kept.draft) setDraft({ ...kept.draft, [key]: d[key] })
    }
    const submitDraft = async (from?: keyof Draft) => {
      const d = kept.draft ?? DRAFT
      let said: string
      if (!d.pattern.trim()) said = 'nothing added: give a pattern'
      else {
        let rule: Rule | undefined
        try { rule = fromDraft(d) } catch (err) { said = `not added: ${why(err)}` }
        said = rule ? await addRule($, kept, rule) : said!
      }
      if (!REFUSED.test(said)) { kept.draft = undefined; focusOn('new-rule') }
      redraw(said)
      if (from && kept.draft) void restore(from)
    }
    // what the draft would mask as, and a line on the pattern: why it does not read, or what it
    // matches in the test sample
    const check = (d: Draft) => {
      let r: Rule | undefined, no = ''
      try { r = d.pattern.trim() ? fromDraft(d) : undefined } catch (err) { no = why(err) }
      const as = r?.replacement ?? (d.name.trim() ? toLabel(d.name) : 'SECRET')
      if (no || !r || !sample) return { as, why: no, found: '' }
      // masked as the Test section masks, so min, mixed only, skip prose and a v group count
      const tried = fresh()
      mask(sample, tried, compile([r], 'rule'))
      const n = masked(tried).length
      return { as, why: no, found: n ? `masks ${count(n, 'value')} in your test sample` : 'masks nothing in your test sample' }
    }
    const opt = (key: string, set: boolean | undefined, text: string, flip: () => void) => (
      <Button key={key} label={`${text} ${set ? 'on' : 'off'}`} plain onPress={flip}><Text color={set ? "green" : undefined} dimColor={!set}>{set ? "●" : "○"}</Text> {text}</Button>
    )
    const field = (label: string, input: unknown) => (
      <Box columnGap={1}><Box width={9} flexShrink={0}><Text dimColor>{label}</Text></Box><Box flexGrow={1} flexShrink={1}>{input as any}</Box></Box>
    )
    const addForm = () => {
      if (!Input) return <Text dimColor>{'  add one with /redact add LABEL: regex'}</Text>
      if (!draft) return <Box paddingLeft={2}><Button key="new-rule" label="new rule" hotkey={desk ? undefined : 'a'} plain dimColor onPress={() => { disarm(); setDraft({ ...DRAFT }); focusOn('add') }} /></Box>
      const c = check(draft)
      // each switch as the rule would have it: set in the form, else as a pasted line has it
      let pasted: Rule | undefined
      try { pasted = read(draft.pattern.trim()) } catch {}
      const sw = { i: draft.i ?? !!pasted?.ignoreCase, strong: draft.strong ?? !!pasted?.strong, prose: draft.prose ?? !!pasted?.prose }
      return (
        <Box flexDirection="column" paddingLeft={2} marginTop={1}>
          {field('pattern', <Input key="add" value={draft.pattern} placeholder={String.raw`a regex, like \be\d{6}\b`} submitLabel="add" autoFocus onInput={v => edit({ pattern: v })} onSubmit={v => { edit({ pattern: v }); return submitDraft('pattern') }} />)}
          {c.why ? <Box paddingLeft={10}><Text color="warning" wrap="wrap">{c.why}</Text></Box> : c.found ? <Box paddingLeft={10}><Text dimColor>{c.found}</Text></Box> : null}
          {field('name', <Input key="new-name" value={draft.name} placeholder="like Employee ID (optional)" submitLabel="add" onInput={v => edit({ name: v })} onSubmit={v => { edit({ name: v }); return submitDraft('name') }} />)}
          <Box paddingLeft={10}><Text dimColor>masks as {notation(c.as)}</Text></Box>
          <Box paddingLeft={10} columnGap={2} flexWrap="wrap">
            {opt('new-i', sw.i, 'ignore case', () => edit({ i: !sw.i }))}
            {opt('new-strong', sw.strong, 'mixed characters only', () => edit({ strong: !sw.strong }))}
            {opt('new-prose', sw.prose, 'skip prose', () => edit({ prose: !sw.prose }))}
          </Box>
          {field('min', <Input key="new-min" value={draft.min} placeholder="shortest length to mask (optional)" submitLabel="add" onInput={v => edit({ min: v })} onSubmit={v => { edit({ min: v }); return submitDraft('min') }} />)}
          {help && <Box flexDirection="column" marginTop={1}>
            {row('ignore case', 'matches upper and lower case alike')}
            {row('mixed characters only', 'masks only values of 8+ characters that mix letters, digits or symbols')}
            {row('skip prose', 'leaves "key: some words" alone, so headings and notes stay readable')}
            {row('min', 'masks only values this long or longer that are not all lowercase')}
          </Box>}
          <Box columnGap={2} marginTop={1}>
            <Button key="new-add" label="add rule" variant="primary" onPress={() => submitDraft()} />
            <Button key="new-cancel" label="cancel" plain dimColor onPress={() => { disarm(); kept.note = ''; setDraft(undefined); focusOn('new-rule') }} />
          </Box>
        </Box>
      )
    }

    // Awaited here, as the return below calls it sync: the folder the env files are read in
    // (seedHere's fallback), ~ for the home folder; a failed read drops it from the Env files line.
    const rulesTab = await (async () => {
      const home = await $.env.get('HOME') || await $.env.get('USERPROFILE')
      const cwd = await $.session.cwd().catch(() => undefined)
      const tilde = (p: string | undefined) => p && home && p.startsWith(home) && /^(?:[\\/]|$)/.test(p.slice(home.length)) ? '~' + p.slice(home.length) : p
      const here = tilde(cwd)
      return () => (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column">
            {section('sec-rules', 'Rules', `${lit} of ${rules.length} on`)}
            {tip(`A rule masks what it matches while it's on. Saved in ${tilde(file)}, for all projects.`)}
            {kept.broken && para(`${FILE} ${kept.broken}. Using the last rules that read until you fix it.`, 'red')}
            {rules.length === 0 && <Text dimColor>  none yet</Text>}
            {rules.map((r: any, i) => {
              const src = typeof r?.pattern === 'string' ? r.pattern : JSON.stringify(r)
              const name = typeof r?.name === 'string' && r.name ? r.name : undefined
              const f = fault(r), enabled = isOn(r), atRow = focused && !desk && i === ruleAt, armed = kept.arm === armOf(i)
              return (
                <Box key={`rule-${i}`} flexDirection="column">
                  {/* a named rule gets its name on its own line and the regex dimmed below it:
                      on one line, a long regex buried the name */}
                  <Box justifyContent="space-between" columnGap={1}>
                    <Box flexShrink={1}>{!desk && <Text>{atRow ? '› ' : '  '}</Text>}{name ? <Box flexShrink={1}><Text wrap="truncate-end">{`${i + 1}. ${offTerminal(name)}`}</Text></Box> : pattern(`${i + 1}. ${src}`)}{label(r)}{skip(f)}</Box>
                    <Box flexShrink={0} columnGap={1}>
                      {toggle(`turn-${i}`, enabled, enabled ? 'turn off' : 'turn on', () => turnRule(i), f, i === ruleAt)}
                      <Button key={`remove-${i}`} label="remove" plain onPress={() => removeRule(i)}>
                        {armed ? <Text color="warning">✗ remove?</Text> : <Text dimColor>✗</Text>}
                      </Button>
                    </Box>
                  </Box>
                  {/* the regex under the cursor's row only, with help shown: a list of regexes hid the names */}
                  {name && help && (desk || atRow) && <Text dimColor wrap="truncate-middle">{desk ? offTerminal(src) : `     ${offTerminal(src)}`}</Text>}
                </Box>
              )
            })}
            {addForm()}
          </Box>
          <Box flexDirection="column">
            <Box gap={1}>
              <Box flexShrink={1} flexGrow={desk ? 1 : undefined}>{section('sec-test', 'Test', sample ? `${hits.length} matched` : undefined)}</Box>
              {sample && <Box flexShrink={0}><Button key="clear-test" label="clear" plain onPress={() => { disarm(); kept.sample = ''; $.ui.invalidate('ui.render') }}><Text dimColor>✗</Text></Button></Box>}
            </Box>
            {testField}
            {tip('Shows what Claude gets from your sample with the rules that are on and the values already masked this session. Nothing is saved.')}
            {sample && (
              <Box flexDirection="column">
                {para(e.surface === 'terminal' ? clean(lf(`Claude gets: ${preview}`)) : seen(`Claude gets: ${preview}`, tried!.trial), 'ink')}
                {inside(preview, tried!.trial) && para(INSIDE, 'warning')}
                {hits.length === 0
                  ? <Text dimColor>    {lit + fromSettings.length ? 'no rule matched' : 'no rule matched: none is on'}</Text>
                  : hits.map(x => { const line = `    ${x.p}  ${shown(x.p, x.v).replace(/\r\n|\r|\n/g, '⏎')} · by ${x.by}`; return <Text key={x.p} dimColor>{e.surface === 'terminal' ? clean(lf(line)) : seen(line, tried!.trial)}</Text> })}
              </Box>
            )}
          </Box>
          <Box flexDirection="column">
            {section('sec-env', 'Env files') /* no state at its end: the switch below reads it */}
            <Box justifyContent="space-between" columnGap={1}>
              <Box flexShrink={1}>{para(`.env files${here ? ` in ${here}` : ''}`)}</Box>
              <Box flexShrink={0}>{toggle('env', kept.envOn !== false, kept.envOn === false ? 'turn on' : 'turn off', async () => redraw(await envTurn($, kept, kept.envOn === false)))}</Box>
            </Box>
            {tip('Masks values that look like secrets, with no rule. Values already masked stay masked when you turn it off.')}
          </Box>
          {/* only when the option is set: an empty section of an advanced option was noise to a new user (Help names it) */}
          {settings.length > 0 && <Box flexDirection="column">
            {section('sec-settings', 'From settings', `${settings.length} on`)}
            {tip('Always on. Set by the patterns option in settings.json.')}
            {settings.map((src, i) => <Box key={`set-${i}`}>{pattern(`  ${src}`)}{lineFault(src) ? null : label(read(src))}{skip(lineFault(src))}</Box>)}
          </Box>}
          {help && (
            <Box flexDirection="column">
              {section('sec-format', 'Writing a rule')}
              {row('pattern', String.raw`a JavaScript regex. \b marks a word edge, \d a digit, {6} six of them.`)}
              {row('(?<v>...)', String.raw`masks only group v. (?<pre>KEY=)(?<v>\S+) keeps KEY= visible.`)}
              {row('name', `names the rule and its placeholder. Employee ID masks as ${notation('EMPLOYEE_ID')}, no name as ${notation('SECRET')}.`)}
              {row('one line', String.raw`/redact add and the pattern field also take EMPLOYEE_ID i min=6: \be\d{6}\b`)}
              {row('by hand', `edit ${FILE}. Each rule has pattern, replacement, enabled and name.`)}
            </Box>
          )}
        </Box>
      )
    })()

    return (
      <Box flexDirection="column" gap={1} width={w}>
        {topBar()}{tab === 'session' && sessionTab()}{tab === 'rules' && rulesTab()}
        {tab === 'session' && sessionKeys()}{tab === 'rules' && rulesKeys()}
      </Box>
    )
  })
}
