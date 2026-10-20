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

// Every repeat that can run into a failing match is bounded ({0,64}, {1,512}, {0,8192}):
// unbounded, a crafted output (one long word full of "token", thousands of `-eyJ` or
// unterminated BEGIN lines) takes time quadratic in its size, outruns the hook budget and
// gets the row withheld. The speed test in redact.test.ts pins this.
const NAME = String.raw`\w{0,64}(?:token|secret|password|passwd|api[_-]?key|private[_-]?key|access[_-]?key|credential)\w{0,64}`
// An unquoted value ends at whitespace, quotes, code punctuation and a placeholder, so
// `fn(name=value), y` keeps its `), y` and a query string keeps its `&next=1`.
const STOP = String.raw`\s'"\`,;&<>()[\]{}⟦⟧`
const VAL = String.raw`[^${STOP}]+`
const END = String.raw`(?![^${STOP}])`
// Unquoted values that read as code and stay: a `$` reference or shell default (`${X:-}`,
// `${X:-$Y}`), a call, index or generic (`getToken(`, `os.environ[`, `Promise<`), a keyword, type or literal
// (`await`, `string`, `1000`), a dotted path (`self.token`; a dotted literal password leaks,
// the price of this one), or the name itself (Python's `f(token=token)`). Anything else is
// masked: a miss masks. `\k<name>` is the assign rule's NAME group: CODE only works inside it.
const CODE = String.raw`(?!-?\$|[\w.]+[(\[<]|(?:await|new|string|number|boolean|bool|str|int|bytes|any|unknown|undefined|none|nil|true|false|null|\d+|[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+|\k<name>|-)${END})`

// The rules redact ships with. They stay in code, so a fix to one reaches everyone: the patterns
// file holds only the person's own patterns, and `off <id>` for a rule they turned off. Each is
// written as a line of that file (LABEL [options]: regex), so one reader reads both. The notes
// describe a match rather than show one: a real-looking token here would trip the pre-push secret
// scan. Ordered: whole-value shapes first, so the later ones see the placeholder and leave it. A
// `min` rule guesses from a name or a place, so it masks only a value that long: a short password
// still masks, a stray `a` or `|` does not, though once vaulted it masks as a word all session. A
// `strong` rule guesses from context alone (`strong` below).
const rule = (id: string, name: string, note: string, head: string, src: string) => ({ id, name, note, line: `${head}: ${src}` })
export const BUILTIN = [
  // with no END line (output cut short by head or a Read limit), the whole-line base64 body
  // after BEGIN, raw, `cat -n` numbered or JSON-escaped; a prose line stops it, and a BEGIN
  // line with no body (a doc naming the format) is left alone
  rule('private-key', 'Private key blocks, cut-short ones too',
    'hides the whole -----BEGIN ... PRIVATE KEY----- block; leaves a BEGIN line with no key under it', 'PRIVATE_KEY',
    /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[\s\S]{0,8192}?-----END [A-Z ]*PRIVATE KEY-----|(?:(?:\r?\n|\\n)[ \t]*(?:\d+\t)?[A-Za-z0-9+/=]+(?=[\r\n\\]|$))+)/.source),
  // JS copy of ~/dotagents/scripts/git-hooks/lib/secret-content.ere's vendor shapes (plus hf_, ya29.): keep in sync
  rule('vendor-token', 'Vendor tokens (sk-, gh*_, github_pat_, AKIA, ASIA, xox*-, AIza, sk_live_, glpat-, npm_, dckr_pat_, SG., hf_, ya29.) and JWTs',
    'hides the whole token', 'API_KEY',
    /\b(?:sk-[\w-]{20,}|gh[pousr]_\w{36,}|github_pat_\w{20,}|(?:AKIA|ASIA)[0-9A-Z]{16}|xox[abprs]-[\w-]{10,}|AIza[\w-]{35}|[sr]k_(?:live|test)_[0-9A-Za-z]{24,}|glpat-[\w-]{20,}|npm_[A-Za-z0-9]{36}|dckr_pat_[\w-]{20,}|SG\.[\w-]{20,}\.[\w-]{20,}|hf_[A-Za-z0-9]{30,}|ya29\.[\w-]{20,}|eyJ[\w-]{1,512}\.[\w-]+\.[\w-]+)/.source),
  // RFC 6750 token chars; strong only, so prose ("the bearer of this letter") stays
  rule('bearer', 'A token after "Bearer"', 'hides the token after "Authorization: Bearer"; leaves prose like "the bearer of this letter"',
    'TOKEN strong i', /\b(?<pre>bearer[ \t]+)(?<v>[\w.~+/-]+=*)/.source),
  rule('url-password', 'Passwords in URLs', 'hides what sits between "user:" and "@" in scheme://user:...@host; leaves a $VAR',
    'PASSWORD min=4', /(?<pre>:\/\/[^:\/\s@]+:)(?!\$)(?<v>[^\s@\/]+)(?<post>@)/.source),
  rule('flag', 'Values after --password, --token, --api-key, --secret', 'hides the word after the flag; leaves a $VAR, another flag and a usage line\'s lowercase word',
    'SECRET min=4 i', String.raw`(?<pre>--(?:password|token|api-key|secret)[ \t]+)(?![$-])(?<v>${VAL})`),
  // `NAME=v`, `name: v`, `"name": "v"`: a quoted value up to its closing quote (or the line's
  // end), unless empty or a `$` reference; an unquoted one unless CODE says it is code
  rule('assigned', 'Values assigned to a name with token, secret, password, api key, private key, access key or credential in it',
    'hides the value in NAME=..., name: ... and "name": "..."; leaves code ($VAR, getToken(), self.token, null) and "name: more words"',
    'SECRET min=4 prose i', String.raw`(?<pre>\b(?<name>${NAME})["']?[ \t]*[=:][ \t]*)(?:(?<q>["'])(?!\$)(?<v>(?:(?!\k<q>)[^\n])+)(?<post>\k<q>?)|${CODE}(?<v2>${VAL}))`),
  // last, so a password in a URL and a value assigned to a secret's name keep
  // their own label. Starts where a run of address characters does, so a local part past 64 is
  // left whole rather than cut. Not `git@`, a git host's ssh user; a TLD of letters leaves
  // `react@18.2.0` alone, `(?![1-9]x\.)` an image's `@2x.png`.
  rule('email', 'Email addresses', 'hides the whole address; leaves git@host, a version like react@18.2.0 and an image@2x.png',
    'EMAIL', /(?<![\w.+-])(?!git@)[\w.+-]{1,64}@(?![1-9]x\.)(?:[\w-]{1,63}\.){1,8}[A-Za-z]{2,24}(?![\w-])/.source),
]

// A pattern: each match masked whole, or only its `v` (or `v2`) group when it has one, under
// `label`; `by` is what the pane says masked it. Its options: `strong` masks only a value that
// passes `strong` below, `min` only one that long and not all lowercase (WORD), `prose` leaves an
// unquoted value after a colon alone when words follow it (PROSE).
type Pattern = { re: RegExp; label: string; by?: string; strong?: boolean; min?: number; prose?: boolean }
type Spec = Omit<Pattern, 're'> & { src: string; flags: string }
// A line of the patterns file: `off <id>`, `LABEL [options]: regex`, or a bare regex, masked as
// SECRET. The regex is the rest of the line after the first `: `, as written; a label is capitals,
// so a regex like `(?<x>a): b` stays whole. Throws why the line does not read: an unknown rule or
// option, a regex that does not compile.
const RULE = /^([A-Z][A-Z0-9_]*)((?:[ \t]+[\w=-]+)*)[ \t]*:[ \t]+(.*)$/
const OFF = /^off[ \t]+(\S+)$/
const read = (line: string): Spec | { off: string } => {
  const off = OFF.exec(line)?.[1]
  if (off !== undefined) {
    if (!BUILTIN.some(r => r.id === off)) throw new Error(`no built-in rule ${off}`)
    return { off }
  }
  // the format before this one put options at the end, after ` #!`: read as part of the regex,
  // they would mask nothing the person meant
  if (/\s#!(\s|$)/.test(line)) throw new Error('options go before the regex: LABEL i: regex')
  const [, label = 'SECRET', opts = '', src = line] = RULE.exec(line) ?? []
  const spec: Spec = { src: src.trim(), flags: 'gd', label }
  for (const o of opts.split(/\s+/).filter(Boolean)) {
    const [k, v] = o.split('=')
    if (k === 'min' && v && /^\d+$/.test(v)) spec.min = Number(v)
    else if (o === 'strong' || o === 'prose') spec[o] = true
    else if (o === 'i') spec.flags += 'i'
    else throw new Error(`unknown option ${o}`)
  }
  if (!spec.src) throw new Error('no regex')
  new RegExp(spec.src, spec.flags)
  return spec
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
export const mask = (s: string, h: Held, patterns: readonly Pattern[] = defaults) => {
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

// why a line does not read, or undefined when it does
const fault = (line: string) => { try { read(line); return undefined } catch (err) { return (err as Error).message } }
// A pattern line read as the file has it, with the comment line right above it as its name.
type Line = { line: string; name?: string }
// the lines that read as patterns, compiled; an `off` line is no pattern
const compile = (lines: readonly Line[], from: string): Pattern[] => lines.flatMap(l => {
  if (fault(l.line)) return []
  const r = read(l.line)
  if ('off' in r) return []
  const { src, flags, ...spec } = r
  return [{ ...spec, re: new RegExp(src, flags), by: `${from}: ${l.name ?? src}` }]
})
// A pattern's name: the first line of the comment right above it, its other lines a note. A
// blank line ends a comment, so the header names nothing.
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
// The patterns /redact add and the pane keep: a text file of the user's, per user, for every
// project, next to settings.json, so they edit it by hand. Older versions kept the list in the
// store under STORED; the first read with no file moves it there.
const FILE = 'redact-patterns.txt'
const STORED = 'patterns'
const YOURS = 'your pattern'
// the built-in rules, compiled: what `mask` uses on its own, and all of them until the file reads
export const defaults = BUILTIN.map(r => compile([{ line: r.line, name: r.name }], 'built-in rule')[0]!)
// each session's vault, under its id, in the store; one untouched this long is dropped
const VAULT = 'vault:'
const KEEP_MS = 30 * 24 * 3600 * 1000
// The file's first lines, written when redact creates it; no placeholder-shaped text in it.
export const HEADER = `# redact: your own patterns, masked after its built-in rules, in every project. A change
# applies from your next message on. The model cannot read or change this file. /redact patterns
# lists the built-in rules with their ids, and tests a sample.
#
#   LABEL [options]: regex    each match is masked as LABEL_1, LABEL_2, ...
#   regex                     the same, as SECRET
#   off <id>                  turns a built-in rule off
#
# options   i        ignore case
#           min=N    skip a match under N characters, or of lowercase letters only
#           strong   skip a match under 8 characters, or of one kind (letters, digits, symbols)
#           prose    skip an unquoted match after a colon when words follow it on the line
#
# A group named v (or v2) is all that is masked when it matched: (?<pre>ACME_KEY=)(?<v>\\S+)
# keeps ACME_KEY= and masks what follows. The comment line right above a pattern names it.
#
# ACME_KEY: (?<=ACME_KEY=)\\S+

`

// Files an older version wrote, rewritten once in this format: their header goes, a built-in rule
// they hold unchanged goes (it runs from code now) with its comment, one deleted or edited is
// turned off (an edited copy stays, as the person's pattern), and each pattern's options move from
// after ` #!` to before it. Known by the line that ended their header; the oldest, from before the
// rules moved into the file, by its header, six lines, and it turns no rule off; so does one with
// no header whose options sit after ` #!`.
const LEGACY = ['# ---- built-in rules: edit or delete any; keep this line, or they are added back ----',
  '# redact: its built-in rules follow. Change or delete any; keep this line, or they are added again.']
const LEGACY_HERE = '# ---- your patterns: add them below ----'
const OLDEST = '# redact: your patterns, one JavaScript regex a line, masked on top of the built-in rules,'
// a pattern of the older format in this one: its label from `label=`, else its first named group
// other than v and v2, else SECRET; `ignore-case` is `i` now
const convert = (line: string) => {
  const [, src = line, opts = ''] = /^(.*)\s#!(\s.*)?$/.exec(line) ?? []
  const o = opts.split(/\s+/).filter(Boolean)
  const group = [...src.matchAll(/\(\?<([A-Za-z_]\w*)>/g)].map(m => m[1]!).find(n => n !== 'v' && n !== 'v2')?.toUpperCase()
  const label = o.find(x => x.startsWith('label='))?.slice(6) || (group && /^[A-Z][A-Z0-9_]*$/.test(group) ? group : 'SECRET')
  return `${[label, ...o.filter(x => !x.startsWith('label=')).map(x => x === 'ignore-case' ? 'i' : x)].join(' ')}: ${src.trim()}`
}
// ⟦ and ⟧ spelled either way, as a build may have written them as \u escapes
const unesc = (s: string) => s.replace(/\\u27E6/g, '⟦').replace(/\\u27E7/g, '⟧')
export const migrate = (t: string) => {
  const lines = t.split('\n').map(l => l.trim())
  const mark = lines.findIndex(l => LEGACY.includes(l))
  const oldest = mark < 0 && lines[0] === OLDEST
  // or one with no header that has options in the old place, which this format would skip
  if (mark < 0 && !oldest && !lines.some(l => !l.startsWith('#') && /\s#!(\s|$)/.test(l))) return undefined
  const seen = new Set<string>()
  const out: string[] = []
  let notes: string[] = [] // the comment above the next pattern, dropped with a built-in rule
  for (const l of lines.slice(mark >= 0 ? mark + 1 : oldest ? 6 : 0)) {
    if (l === LEGACY_HERE) continue
    if (l.startsWith('#')) { notes.push(l); continue }
    if (!l) { out.push(...notes.splice(0), l); continue }
    const line = convert(l)
    const builtin = BUILTIN.find(r => unesc(r.line) === unesc(line))
    if (builtin) seen.add(builtin.id)
    else out.push(...notes, line)
    notes = []
  }
  out.push(...notes)
  const off = mark < 0 ? [] : BUILTIN.filter(r => !seen.has(r.id)).map(r => `off ${r.id}`)
  const body = [...off, '', ...out].join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return HEADER + (body ? `${body}\n` : '')
}

// The file's patterns as last read, and compiled, and where the file is; one per load. Read
// again at every masking, so an edit by hand or a pattern another session added masks here too;
// a failed read keeps the last list. The vault being loaded, and the queue its saves wait in;
// whether the terminal draws placeholders (`raw`), the settings patterns that did not compile,
// and the status line last set. These helpers sit at the top of the file because the engine only
// follows `$` into such functions.
type Tab = 'session' | 'patterns' | 'help'
const TABS: Record<string, Tab> = { '': 'session', show: 'session', session: 'session', patterns: 'patterns', test: 'patterns', guide: 'help', help: 'help' }
// stored: the file's pattern lines, an `off` line naming no rule among them; off: the rules it turns off
type Kept = { stored: string[]; names: (string | undefined)[]; off: Set<string>; compiled: Pattern[]; last?: string; file?: Promise<string>; seeded?: boolean; note: string
  vault?: { id: string; held: Promise<Held> }; saving: Promise<unknown>; raw: boolean; skipped: string[]; shown?: string; revealed: Set<string>; opened?: boolean; tab: Tab; sample: string }
// CLAUDE_CONFIG_DIR, else ~/.claude; USERPROFILE is Windows' HOME
const place = ($: EngineInterface, k: Kept) => k.file ??= (async () => {
  const dir = await $.env.get('CLAUDE_CONFIG_DIR') || `${await $.env.get('HOME') || await $.env.get('USERPROFILE') || '~'}/.claude`
  return `${dir.replace(/[\\/]+$/, '')}/${FILE}`
})()
// The file's text, undefined when it is there but did not read. None at all reads as the header
// (and a list an older version kept in the store, below it), and one an older version wrote in
// this format (`migrate`), written back once per load: a write that fails still masks with it.
const text = async ($: EngineInterface, k: Kept, path: string) => {
  const there = await $.fs.exists(path).catch(() => true)
  const t = there ? await $.fs.read(path).then(String, () => undefined) : ''
  if (t === undefined) return t
  let next = there ? migrate(t) : undefined, moved = false
  if (!there) {
    const old = await $.store.get(STORED).catch(() => undefined)
    const lines = Array.isArray(old) ? old.filter(s => typeof s === 'string') : []
    moved = lines.length > 0
    next = HEADER + lines.map(s => `${convert(s)}\n`).join('')
  }
  if (next === undefined) return t
  if (!k.seeded) {
    k.seeded = true
    await $.fs.write(path, next).then(
      () => { if (moved) return $.store.delete(STORED).catch(() => {}) }, // left, it is never read again: the file is there
      err => $.ui.log(`redact: ${FILE} not written: ${(err as Error)?.message ?? err}`, { to: 'debug' }))
  }
  return next
}
// the file's patterns from its text, compiled again only when the text changed: the built-in
// rules it leaves on, then its own
const take = (k: Kept, t: string) => {
  if (t === k.last) return
  k.last = t
  const lines = parse(t)
  const off = (l: Line) => !fault(l.line) && OFF.exec(l.line)?.[1]
  k.off = new Set(lines.flatMap(l => off(l) || []))
  const own = lines.filter(l => !off(l))
  k.stored = own.map(l => l.line)
  k.names = own.map(l => l.name)
  k.compiled = [...defaults.filter((_, i) => !k.off.has(BUILTIN[i]!.id)), ...compile(own, YOURS)]
}
const sync = async ($: EngineInterface, k: Kept) => {
  const t = await text($, k, await place($, k))
  if (t !== undefined) take(k, t)
}
// Writes the file's lines as `f` changes them, comments and all; a file that did not read is
// left alone, never written over.
const save = async ($: EngineInterface, k: Kept, f: (lines: string[]) => string[]) => {
  const path = await place($, k)
  const t = await text($, k, path)
  if (t === undefined) throw new Error(`${FILE} did not read`)
  const next = f(t.replace(/\n$/, '').split('\n')).join('\n') + '\n'
  await $.fs.write(path, next)
  take(k, next)
  $.ui.invalidate('ui.render')
}
// turns a built-in rule off (an `off <id>` line) or back on (that line dropped)
const turn = async ($: EngineInterface, k: Kept, id: string, on: boolean) => {
  await sync($, k)
  if (!BUILTIN.some(r => r.id === id)) return `no such rule: ${id || '(none given)'}; the rules are ${BUILTIN.map(r => r.id).join(', ')}`
  if (k.off.has(id) !== on) return `already ${on ? 'on' : 'off'}: ${id}`
  await save($, k, lines => on ? lines.filter(l => OFF.exec(l.trim())?.[1] !== id) : [...lines, `off ${id}`])
  return `${id} ${on ? 'on' : 'off'}: from the next message on`
}
// a typed pattern as the file holds it: one starting with # takes a label, as such a line is a comment
const asLine = (typed: string) => typed.startsWith('#') ? `SECRET: ${typed}` : typed
const add = async ($: EngineInterface, k: Kept, typed: string) => {
  await sync($, k)
  if (!typed) return 'nothing added: give a regex'
  const line = asLine(typed)
  const f = fault(line)
  if (f) return `not added: ${f}`
  const off = OFF.exec(line)?.[1]
  if (off) return turn($, k, off, false)
  if (k.stored.includes(line)) return `already there, as #${k.stored.indexOf(line) + 1}`
  await save($, k, lines => [...lines, line])
  return `added as #${k.stored.length}: it masks from the next message on`
}
const remove = async ($: EngineInterface, k: Kept, line: string | undefined) => {
  const i = line === undefined ? -1 : k.stored.indexOf(line)
  if (i < 0) return 'no such pattern'
  await save($, k, lines => { const at = lines.findIndex(l => l.trim() === line); return lines.filter((_, j) => j !== at) })
  return `removed #${i + 1}` // not the pattern: a reply to a typed command can reach the model
}

// /redact's reply to its arguments, undefined for the pane. It answers in a toast, never as text:
// a command's output row is one the model reads, and none of /redact is its business
// (prompt.submit drops the line itself).
const USAGE = 'show | patterns | guide | test [text] | add <pattern> | remove <n|pattern> | off <rule> | on <rule>'
const answer = async ($: EngineInterface, k: Kept, fromSettings: Pattern[], args: string) => {
  const [, verb = '', rest = ''] = /^\s*(\S*)\s*([\s\S]*?)\s*$/.exec(args) ?? []
  if (verb === 'add') return add($, k, rest)
  if (verb === 'off' || verb === 'on') return turn($, k, rest, verb === 'on')
  // by its number, or by the pattern itself; a number in range is read as the number
  if (verb === 'remove') { await sync($, k); return remove($, k, /^\d+$/.test(rest) && k.stored[Number(rest) - 1] !== undefined ? k.stored[Number(rest) - 1] : asLine(rest)) }
  if (verb === 'test' && rest) {
    await sync($, k)
    k.tab = 'patterns'; k.note = ''; k.sample = rest
    await $.ui.open({ id: PANE, title: TITLE, focus: true }); k.opened = true
    $.ui.invalidate('ui.render')
    const trial = fresh()
    const out = mask(rest, trial, [...k.compiled, ...fromSettings])
    const hits = masked(trial)
    return hits.length ? `→ ${out} (${hits.map(x => `${x.p} by ${x.by}`).join(', ')})` : 'no pattern matched'
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
  const line = [`redact: ${n} masked`, ...k.skipped.length ? [`skipped pattern ${k.skipped.join(', ')} (/redact show)`] : [],
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
// One hook's masking: the session's vault with the file's patterns (the built-in rules among
// them), then the settings'.
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

// Tamper guard: what decides this plugin's masking, kept out of the model's reach. The patterns
// file, read or written (/redact show lists it); the store file of vaults (Bash is checked whole,
// so reading it is refused too); and its enabledPlugins and pluginConfigs entries in a settings
// file. Best effort: a Bash command that spells a path another way (a variable, `cd` first, a
// search over the home folder), an MCP server's own file tools, the plugin's own source and
// `claude plugin disable` get past it.
// its file, a glob over the folder, or the folder itself (`rm -rf …/store`)
const STORE = /plugins[\\/]+store(?:[\\/]+(?:redact|[^\s'"]*[*?[])|[\\/]*(?=[\s'";|&)]|$))/i
// Bash and the patterns file: its name (FILE), a glob at the top of a `.claude` folder
// (`cat ~/.claude/*`), or a recursive reader or copier naming that folder. A bare `ls ~/.claude`
// passes, and so does the word claude (`grep -rn claude .`, `~/dotagents/claude/*`). A
// CLAUDE_CONFIG_DIR not named .claude gets the name rule only.
const PATTERNS_SH = /redact-patterns\.txt|(?:^|[\s'"=~\\/])\.claude[\\/]+[^\s'"\\/]*[*?[]|\b(?:grep|rg|ag|ack|find|tar|zip|rsync|cp|scp)\b[^|;&\n]*(?:^|[\s'"=~\\/])\.claude[\\/]*(?=[\s'";|&)]|$)/i
// where a path lands, `/`-separated and lowercased (a case alias on Windows and macOS), else as
// spelled; a Grep with no path searches the working directory
const land = async ($: EngineInterface, p: string) =>
  ((await $.fs.stat(p, { resolve: true }).catch(() => undefined))?.realPath ?? p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
// a file tool's path that lands on the patterns file, or a Grep over a folder that holds it
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
  if (e.tool === 'Bash') return STORE.test(e.command) || PATTERNS_SH.test(e.command) || (SETTINGS_SH.test(e.command) && /redact/i.test(e.command))
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
  // The `patterns` option, lines in the patterns file's format, masked after the built-in rules
  // and the file's; an `off` line there turns nothing off.
  // One that does not compile is skipped, the rest stay on. They run in each hook's budget: a slow
  // one gets the text withheld by the `.catch`es below, never passed on, so bounding its repeats
  // is the user's call.
  // an unset option reads as '', a line no pattern holds
  const settings = (typeof options.patterns === 'string' ? [options.patterns] : Array.isArray(options.patterns) ? options.patterns : [])
    .map(l => String(l).trim()).filter(Boolean)
  const fromSettings = compile(settings.map(line => ({ line })), 'pattern from settings')
  const skipped = settings.flatMap((src, i) => fault(src) ? [`#${i + 1}`] : [])
  // note: the pane's answer to its last add, remove or forget
  const kept: Kept = { stored: [], names: [], off: new Set(), compiled: defaults, note: '', saving: Promise.resolve(), raw: false, skipped, revealed: new Set(), tab: 'session', sample: '' }
  // The tamper guard is off while redact is being developed (it refuses the work on its own
  // files); the tests turn it on with this undeclared option. Default it back to on before release.
  const guarded = options.guard === true
  const failed = (where: string, kind: string) => `redact could not mask ${where} (${kind})`

  on('session.start', async ($, e, next) => {
    try { await $.command.register({ name: 'redact', description: 'Show the redact pane, test or manage patterns, turn built-in rules off or on, and forget held values.', argumentHint: USAGE }) }
    catch (err) { $.ui.log(`redact: /redact not registered: ${(err as Error)?.message ?? err}`, { to: 'debug' }) } // throws on hot reload (no session bound yet)
    try { await prune($) } catch (err) { $.ui.log(`redact: old vaults not pruned: ${(err as Error)?.message ?? err}`, { to: 'debug' }) }
    try { badge($, kept, await hold($, kept)) } // a --resume starts with a vault
    catch (err) { $.ui.log(`redact: vault not loaded: ${(err as Error)?.message ?? err}`, { to: 'debug' }) }
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

  // /redact's own arguments are a regex for the patterns file, not text for the model.
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
      return { deny: `this call would reach the redact plugin's own config (its patterns file, its store of vaults, or its entries in a settings file), which decides what gets masked. Ask the user to make that change: they edit the file themselves, or use /redact show.` }
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
    const { stored, names, note, tab, sample } = kept
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
    const skip = (src: string) => { const f = fault(src); return f ? <Text color="red"> skipped: {f}</Text> : null }
    const broken = stored.filter(fault).length + settings.filter(fault).length
    const label = (line: string) => { try { const r = read(line); return 'off' in r ? null : <Text dimColor> as {r.label}</Text> } catch { return null } }
    const lit = BUILTIN.filter(r => !kept.off.has(r.id)).length
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
              {tabBtn('patterns', `Patterns (${lit + stored.length + settings.length})`, 'p')}
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
          {note && <Text color={/^(not added|nothing added|already|no such)/.test(note) ? 'warning' : undefined} dimColor={!/^(not added|nothing added|already|no such)/.test(note)}>{note}</Text>}
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
        {tab === 'patterns' && (
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
                    ? <Text dimColor>    no pattern matched</Text>
                    : hits.map(x => <Text key={x.p} dimColor>    {x.p} {shown(x.p, x.v)} · masked by {x.by}</Text>)}
                </Box>
              )}
            </Box>
            <Box flexDirection="column">
              {section('sec-builtin', 'Built-in', `${lit} of ${BUILTIN.length} on`)}
              <Text dimColor>  shipped with redact and updated with it; off writes off &lt;id&gt; to your file</Text>
              {BUILTIN.map((r, i) => {
                const off = kept.off.has(r.id)
                return (
                  <Box key={`builtin-${r.id}`} flexDirection="column">
                    <Box gap={1}>
                      <Box flexShrink={1}><Text wrap="truncate-end" dimColor={off}>  {r.name}</Text><Text dimColor> {r.id} · as {defaults[i]!.label}</Text></Box>
                      <Box flexShrink={0}><Button key={`turn-${r.id}`} label={off ? 'turn on' : 'turn off'} plain onPress={async () => redraw(await turn($, kept, r.id, off))}><Text color={off ? undefined : 'green'} dimColor={off}>{off ? '○ off' : '● on'}</Text></Button></Box>
                    </Box>
                    <Text dimColor wrap="truncate-end">{`     ${r.note}`}</Text>
                  </Box>
                )
              })}
            </Box>
            <Box flexDirection="column">
              {section('sec-yours', 'Yours', `${stored.length} in ${FILE}`)}
              <Text dimColor>  in {file}, for every project; edit it by hand or here</Text>
              {addField}
              {stored.length === 0 && <Text dimColor>  none yet</Text>}
              {stored.map((src, i) => (
                <Box key={`yours-${i}`} flexDirection="column">
                  {/* a named pattern gets its name on its own line and the regex dimmed below it:
                      on one line, a long regex buried the name */}
                  <Box gap={1}>
                    <Box flexShrink={1}>{pattern(`  ${i + 1}. ${names[i] ?? src}`)}{label(src)}{skip(src)}</Box>
                    <Box flexShrink={0}><Button key={`remove-${i}`} label="remove" plain onPress={async () => redraw(await remove($, kept, src))}><Text color="red">✗</Text></Button></Box>
                  </Box>
                  {names[i] && <Text dimColor wrap="truncate-middle">{`     ${src}`}</Text>}
                </Box>
              ))}
            </Box>
            <Box flexDirection="column">
              {section('sec-settings', 'From settings', settings.length ? `${settings.length} set` : 'none')}
              <Text dimColor>  the patterns option in settings.json</Text>
              {settings.length === 0 && <Text dimColor>  none</Text>}
              {settings.map((src, i) => <Box key={`set-${i}`}>{pattern(`  ${src}`)}{label(src)}{skip(src)}</Box>)}
            </Box>
          </Box>
        )}
        {tab === 'help' && (
          <Box flexDirection="column" gap={1}>
            <Box flexDirection="column">
              {section('sec-format', 'Pattern format', FILE)}
              <Text dimColor>{'  LABEL: regex    masks each match as LABEL_n; a bare regex masks as SECRET'}</Text>
              <Text dimColor>{'  LABEL i: regex  options between label and colon: i min=N strong prose'}</Text>
              <Text dimColor>{'  (?<v>...)       masks only group v (or v2), keeping prefix and suffix around it'}</Text>
              <Text dimColor>{'  off <id>        turns a built-in rule off; the ids are under Patterns'}</Text>
              <Text dimColor>{'  # Name          the comment line right above a pattern names it'}</Text>
            </Box>
            <Box flexDirection="column">
              {section('sec-escape', 'Placeholders & escaping')}
              <Text dimColor>{'  once matched    a value keeps its placeholder all session and masks as a whole word'}</Text>
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
