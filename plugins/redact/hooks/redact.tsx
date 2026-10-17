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
// them back; a remote surface keeps the placeholders.
// Fails closed: a masking hook that throws or outruns its budget withholds what it masks (the
// `.catch` on each), and a placeholder the vault does not hold refuses the call. The model's own
// tool_use input is recorded before any hook runs, so the transcript keeps the placeholders.
// Best-effort pattern list, not a guarantee.

// ⟦ and ⟧ open and close a placeholder: no rule's value holds them (STOP below) and real text
// rarely does, so a placeholder is never masked again and a token of its shape is read as ours.
// Spelled as escapes, so no file of this plugin holds a placeholder a restore would fill in.
const OPEN = '⟦'
const PH = /⟦([A-Z][A-Z0-9_]*)_(\d+)⟧/g
const PH_SPLIT = /(⟦[A-Z][A-Z0-9_]*_\d+⟧)/
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
// `${X:-$Y}`), a call or index (`getToken(`, `os.environ[`), a keyword, type or literal
// (`await`, `string`, `1000`), a dotted path (`self.token`; a dotted literal password leaks,
// the price of this one), or the name itself (Python's `f(token=token)`). Anything else is
// masked: a miss masks. `\k<name>` is the assign rule's NAME group: CODE only works inside it.
const CODE = String.raw`(?!-?\$|[\w.]+[(\[]|(?:await|new|string|number|boolean|bool|str|int|bytes|any|unknown|undefined|none|nil|true|false|null|\d+|[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+|\k<name>|-)${END})`

// A rule masks its `v` (or `v2`) group and keeps `pre`, `q` and `post` around it; a rule with no
// groups masks its whole match. `type` is the content type, the placeholder's label unless the
// rule names its own `label`; `name` is what the /redact show pane calls it.
type Rule = { re: RegExp; type: string; label?: string; name: string }
// ordered: whole-value shapes first, so the later rules see the placeholder and leave it
const RULES: Rule[] = [
  // with no END line (output cut short by head or a Read limit), the whole-line base64 body
  // after BEGIN, raw, `cat -n` numbered or JSON-escaped; a prose line stops it, and a BEGIN
  // line with no body (a doc naming the format) is left alone
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[\s\S]{0,8192}?-----END [A-Z ]*PRIVATE KEY-----|(?:(?:\r?\n|\\n)[ \t]*(?:\d+\t)?[A-Za-z0-9+/=]+(?=[\r\n\\]|$))+)/g,
    type: 'PRIVATE_KEY', name: 'private key blocks, cut-short ones too' },
  // JS copy of ~/dotagents/scripts/git-hooks/lib/secret-content.ere's vendor shapes (plus hf_, ya29.): keep in sync
  { re: /\b(?:sk-[\w-]{20,}|gh[pousr]_\w{36,}|github_pat_\w{20,}|(?:AKIA|ASIA)[0-9A-Z]{16}|xox[abprs]-[\w-]{10,}|AIza[\w-]{35}|[sr]k_(?:live|test)_[0-9A-Za-z]{24,}|glpat-[\w-]{20,}|npm_[A-Za-z0-9]{36}|dckr_pat_[\w-]{20,}|SG\.[\w-]{20,}\.[\w-]{20,}|hf_[A-Za-z0-9]{30,}|ya29\.[\w-]{20,}|eyJ[\w-]{1,512}\.[\w-]+\.[\w-]+)/g,
    type: 'API_KEY', name: 'vendor tokens (sk-, gh*_, github_pat_, AKIA, ASIA, xox*-, AIza, sk_live_, glpat-, npm_, dckr_pat_, SG., hf_, ya29.) and JWTs' },
  { re: /(?<pre>bearer[ \t]+)(?<v>[\w.~+/-]+=*)/gi, type: 'TOKEN', name: 'the value after "Bearer"' }, // RFC 6750 token chars
  { re: /(?<pre>:\/\/[^:\/\s@]+:)(?!\$)(?<v>[^\s@\/]+)(?<post>@)/g, type: 'PASSWORD', name: 'passwords in URLs (://user:...@)' },
  { re: new RegExp(String.raw`(?<pre>--(?:password|token|api-key|secret)[ \t]+)(?![$-])(?<v>${VAL})`, 'gi'), type: 'SECRET',
    name: 'values after --password, --token, --api-key, --secret' },
  // `NAME=v`, `name: v`, `"name": "v"`: a quoted value up to its closing quote (or the line's
  // end), unless empty or a `$` reference; an unquoted one unless CODE says it is code
  { re: new RegExp(String.raw`(?<pre>\b(?<name>${NAME})["']?[ \t]*[=:][ \t]*)(?:(?<q>["'])(?!\$)(?<v>(?:(?!\k<q>)[^\n])+)(?<post>\k<q>?)|${CODE}(?<v2>${VAL}))`, 'gi'), type: 'SECRET',
    name: 'values assigned to a name with token, secret, password, api key, private key, access key or credential in it' },
  // last, so a password in a URL (`://me:pw@host.com`) and a value assigned to a secret's name keep
  // their own label. Starts where a run of address characters does, so a local part past 64 is
  // left whole rather than cut. Not `git@`, a git host's ssh user; a TLD of letters leaves
  // `react@18.2.0` alone, `(?![1-9]x\.)` an image's `@2x.png`.
  { re: /(?<![\w.+-])(?!git@)[\w.+-]{1,64}@(?![1-9]x\.)(?:[\w-]{1,63}\.){1,8}[A-Za-z]{2,24}(?![\w-])/g,
    type: 'EMAIL', name: 'email addresses (not git@)' },
]

// A pattern of the person's: each match masked whole (a lookbehind keeps a prefix), under the
// name of its first named group as its label, SECRET when it has none.
type Extra = { re: RegExp; label: string }
export const labelOf = (src: string) => {
  const name = /\(\?<([A-Za-z_]\w*)>/.exec(src)?.[1]?.toUpperCase()
  return name && LABEL.test(name) ? name : 'SECRET'
}

// A session's vault: the next number per label and each placeholder's value, as the store keeps
// it; `at` is when it last changed, for pruning. Held adds the reverse index and the
// known-values pattern, both rebuilt from `ph`, and whether it changed since it was saved.
type Vault = { at: number; n: Record<string, number>; ph: Record<string, string> }
type Held = { id: string; v: Vault; byValue: Map<string, string>; known?: RegExp; dirty: boolean }
export const fresh = (id = ''): Held => ({ id, v: { at: 0, n: {}, ph: {} }, byValue: new Map(), dirty: false })

// The placeholder of a value: the one it has, or the next number under its label.
const mint = (h: Held, value: string, label: string) => {
  let p = h.byValue.get(value)
  if (p) return p
  const n = (h.v.n[label] ?? 0) + 1
  h.v.n[label] = n
  p = `${OPEN}${label}_${n}⟧`
  h.v.ph[p] = value
  h.byValue.set(value, p)
  h.known = undefined
  h.dirty = true
  return p
}

const swap = (h: Held, label: string) => (m: string, ...rest: unknown[]) => {
  const last = rest[rest.length - 1]
  const g = last && typeof last === 'object' ? last as Record<string, string | undefined> : undefined
  const value = g ? g.v ?? g.v2 : m
  if (!value || value.includes(OPEN)) return m
  return g ? `${g.pre ?? ''}${g.q ?? ''}${mint(h, value, label)}${g.post ?? ''}` : mint(h, value, label)
}

// Every value the vault holds, longest first, as one pattern; a value that starts or ends with
// a word character only where a word does, so `abc` leaves `abcdef` alone.
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&')
const knownOf = (h: Held) => h.known ??= new RegExp([...h.byValue.keys()].sort((a, b) => b.length - a.length)
  .map(s => (/^\w/.test(s) ? '(?<!\\w)' : '') + escape(s) + (/\w$/.test(s) ? '(?!\\w)' : '')).join('|'), 'g')

// Rules first, then the person's patterns, then every value the vault already holds, wherever it
// stands: a value once matched is never sent, in whatever shape it comes back. Placeholders stay
// as they are, so masking twice is masking once.
export const mask = (s: string, h: Held, extra: readonly Extra[] = []) => {
  const ruled = extra.reduce((acc, x) => acc.replace(x.re, m => m && !m.includes(OPEN) ? mint(h, m, x.label) : m),
    RULES.reduce((acc, r) => acc.replace(r.re, swap(h, r.label ?? r.type)), s))
  if (!h.byValue.size) return ruled
  const known = knownOf(h)
  return ruled.split(PH_SPLIT).map((part, i) => i % 2 ? part : part.replace(known, m => h.byValue.get(m) ?? m)).join('')
}

// The real values back in a string; `missing` collects the placeholders the vault does not hold.
export const restore = (s: string, h: Held, missing?: Set<string>) =>
  s.includes(OPEN) ? s.replace(PH, p => h.v.ph[p] ?? (missing?.add(p), p)) : s

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
const WITHHELD = 'redact: withheld, as masking it failed. Tell the user; the redact plugin needs a look.'

// The input fields whose text lands in a file or runs. Bash is checked whole: a write that
// is no file write (`gh secret set --body`, `curl -d`) has no shape to tell it apart.
const WRITES: Record<string, string[]> = { Write: ['content'], Edit: ['old_string', 'new_string'], NotebookEdit: ['new_source'], Bash: ['command'] }

// why a pattern source does not compile, or undefined when it does
const fault = (src: string) => { try { new RegExp(src, 'g'); return undefined } catch (err) { return (err as Error).message } }
const compile = (sources: readonly string[]): Extra[] => sources.filter(s => !fault(s)).map(s => ({ re: new RegExp(s, 'g'), label: labelOf(s) }))

const PANE = 'redact'
const TITLE = 'Redact rules'
// the patterns /redact add and the pane keep, in this plugin's $.store: per user, for every project
const STORED = 'patterns'
// each session's vault, under its id, in the same store; one untouched this long is dropped
const VAULT = 'vault:'
const KEEP_MS = 30 * 24 * 3600 * 1000

// The store's patterns as last read, and compiled; one per load. Read again at every masking,
// so a pattern another session added masks here too; a failed read keeps the last list. The
// vault being loaded, and the queue its saves wait in. These helpers sit at the top of the file
// because the engine only follows `$` into such functions.
type Kept = { stored: string[]; compiled: Extra[]; note: string; vault?: { id: string; held: Promise<Held> }; saving: Promise<unknown> }
const sync = async ($: EngineInterface, k: Kept) => {
  const v = await $.store.get(STORED).catch(() => undefined)
  if (!Array.isArray(v) || JSON.stringify(v) === JSON.stringify(k.stored)) return
  k.stored = v.filter((s): s is string => typeof s === 'string')
  k.compiled = compile(k.stored)
}
const save = async ($: EngineInterface, k: Kept, list: string[]) => {
  await $.store.set(STORED, list)
  k.stored = list
  k.compiled = compile(list)
  $.ui.invalidate('ui.render')
}
const add = async ($: EngineInterface, k: Kept, src: string) => {
  await sync($, k)
  if (!src) return 'nothing added: give a regex'
  const f = fault(src)
  if (f) return `not added: ${f}`
  if (k.stored.includes(src)) return `already there, as #${k.stored.indexOf(src) + 1}`
  await save($, k, [...k.stored, src])
  return `added as #${k.stored.length}: it masks from the next message on`
}
const remove = async ($: EngineInterface, k: Kept, src: string | undefined) => {
  const i = src === undefined ? -1 : k.stored.indexOf(src)
  if (i < 0) return 'no such pattern'
  await save($, k, k.stored.filter((_, j) => j !== i))
  return `removed #${i + 1}`
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
    const held = load($, id)
    k.vault = { id, held }
    held.catch(() => { if (k.vault?.held === held) k.vault = undefined })
  }
  return k.vault.held
}
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
// One hook's masking: the session's vault with the settings' and the stored patterns.
const masker = async ($: EngineInterface, k: Kept, fixed: readonly Extra[]) => {
  await sync($, k)
  const h = await hold($, k)
  const extra = [...fixed, ...k.compiled]
  return { m: (s: string) => mask(s, h, extra), done: () => keep($, k, h) }
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

// Tamper guard: what decides this plugin's masking, kept out of the model's reach. Its store
// file (the patterns /redact keeps and the vaults; Bash is checked whole, so reading it is
// refused too, and /redact show lists the patterns), and its enabledPlugins and pluginConfigs
// entries in a settings file. Best effort: a Bash command that spells a path another way (a
// variable, `cd` first) gets past it, and the plugin's own source and `claude plugin disable`
// are not guarded.
// its file, a glob over the folder, or the folder itself (`rm -rf …/store`)
const STORE = /plugins[\\/]+store(?:[\\/]+(?:redact|[^\s'"]*[*?[])|[\\/]*(?=[\s'";|&)]|$))/i
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
const tamper = async ($: EngineInterface, e: any) => {
  if (e.tool === 'Bash') return STORE.test(e.command) || (SETTINGS_SH.test(e.command) && /redact/i.test(e.command))
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
  // Extra patterns, masked on top of RULES: the `patterns` option, and the ones kept in the store.
  // One that does not compile is skipped, the rest stay on. They run in each hook's budget: a slow
  // one gets the text withheld by the `.catch`es below, never passed on, so bounding its repeats
  // is the user's call.
  const settings = typeof options.patterns === 'string' ? [options.patterns] : Array.isArray(options.patterns) ? options.patterns : []
  const fromSettings = compile(settings)
  let skipped = settings.flatMap((src, i) => { const f = fault(src); return f ? [`#${i + 1} (${f})`] : [] })
  // note: the pane's answer to its last add or remove
  const kept: Kept = { stored: [], compiled: [], note: '', saving: Promise.resolve() }
  const failed = (where: string, kind: string) => `redact could not mask ${where} (${kind})`

  on('session.start', async ($, e, next) => {
    try { await $.command.register({ name: 'redact', description: 'Show the redact rules in a pane, and add or remove patterns of your own.', argumentHint: 'show | add <regex> | remove <n>' }) }
    catch (err) { $.ui.log(`redact: /redact not registered: ${(err as Error)?.message ?? err}`, { to: 'debug' }) } // throws on hot reload (no session bound yet)
    try { await prune($) } catch (err) { $.ui.log(`redact: old vaults not pruned: ${(err as Error)?.message ?? err}`, { to: 'debug' }) }
    return next(e)
  })

  // What follows `add` lands in the transcript the model reads; what the pane's field takes does not.
  on('command.run', { command: 'redact' }, async ($, e) => {
    const [, verb = '', rest = ''] = /^\s*(\S*)\s*([\s\S]*?)\s*$/.exec(e.args) ?? []
    if (verb === 'add') return { text: await add($, kept, rest) }
    if (verb === 'remove') { await sync($, kept); return { text: await remove($, kept, kept.stored[Number(rest) - 1]) } }
    if (verb === '' || verb === 'show') { await $.ui.open({ id: PANE, title: TITLE, focus: true }); return { text: 'redact rules shown' } }
    return { text: 'usage: /redact show | add <regex> | remove <n>' }
  })

  // ---- Masking: everything the model reads, before it is recorded or sent.

  // A slash command's line takes no rewrite here: its arguments are masked at command.run, a
  // skill's text at skill.prompt.
  on('prompt.submit', async ($, e, next) => {
    if (e.command) return next(e)
    const { m, done } = await masker($, kept, fromSettings)
    const text = m(e.text)
    await done()
    return next(text === e.text ? e : { ...e, text })
  }).catch((_, _e, next) => ({ drop: `${failed('this prompt', next.error.kind)}, so it was not sent.` }))

  // /redact's own arguments are a regex for the store, not text for the model.
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
  }).catch(() => ({ blocks: [] }))

  // The system prompt. Nothing changed hands core's own list back, so `shared` sections keep the
  // prompt cache; failing, only those stay: they read the same for everyone, so hold nothing of ours.
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    const { m, done } = await masker($, kept, fromSettings)
    const sections = r.sections.map(s => { const text = m(s.text); return text === s.text ? s : { ...s, text } })
    await done()
    return sections.some((s, i) => s !== r.sections[i]) ? { sections } : r
  }).catch(async (_, e, next) => ({ sections: (await next(e)).sections.filter(s => s.scope === 'shared') }))

  // What the engine injects per request (a reminder, a mentioned file, a hook's context): the
  // transcript keeps the engine's record, the request carries this answer.
  on('prompt.attachment', async ($, e, next) => {
    const r = await next(e)
    if (typeof r.text !== 'string') return r
    const { m, done } = await masker($, kept, fromSettings)
    const text = m(r.text)
    await done()
    return text === r.text ? r : { ...r, text }
  }).catch(() => ({ text: null }))

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
    if (e.door === 'response' || e.door === 'notice') return next(e)
    const { m, done } = await masker($, kept, fromSettings)
    const content = blocks(e.message.content, m)
    await done()
    return next(content === e.message.content ? e : { ...e, message: { ...e.message, content } })
  }).catch((_, e, next) => next({ ...e, message: { ...e.message, content: blocks(e.message.content, () => WITHHELD) } }))

  // ---- Restoring: the real values, where they run or are drawn on this machine.

  on('tool.call', async ($, e, next) => {
    if (skipped.length) {
      // on the first call, not at session.start: that does not fire again on a hot reload
      try { $.ui.toast(`redact: skipped pattern ${skipped.join(', ')}`) } catch {}
      skipped = []
    }
    const h = await hold($, kept)
    const missing = new Set<string>()
    const input = deep(e, s => restore(s, h, missing)) as typeof e
    if (missing.size) {
      return { deny: `${[...missing].join(', ')} is no placeholder this session's redact vault holds, so its real value cannot be put back. Use the placeholders exactly as they appear in the conversation, or ask the user.` }
    }
    if (await tamper($, input)) {
      return { deny: `this call would touch the redact plugin's own config (its stored patterns and vaults, or its entries in a settings file), which decides what gets masked. Ask the user to make that change: /redact show, or their settings file.` }
    }
    return next(input)
  }).catch(async (_, e, next) => ({
    // No work here, the grace is 1 s. `called`: the tool ran, so retrying repeats it.
    deny: next.called
      ? `${e.tool} ran, but its output is withheld: the redact plugin failed after it (${next.error.kind}).`
      : `${e.tool} did not run: the redact plugin failed before it (${next.error.kind}).`,
  }))

  // The terminal is this machine's; a remote surface (the mobile app over Remote Control) keeps
  // the placeholders, so drawing never sends a value. A failed hook draws the engine's row, placeholders and all.
  const drawn = (s: string) => s.includes(OPEN)
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
    const { stored, note } = kept
    const { Box, Text, Button } = $.ui.resolve(e)
    const skip = (src: string) => { const f = fault(src); return f ? <Text color="red"> skipped: {f}</Text> : null }
    let field = <Text dimColor>{'add one with /redact add <regex>'}</Text> // mobile has no Input
    if (e.surface !== 'mobile') {
      const { Input } = $.ui.resolve(e)
      field = <Input key="add" label="add " placeholder="a regex; each match is masked whole, a named group names its label" submitLabel="add" onSubmit={async v => { kept.note = await add($, kept, v.trim()); $.ui.invalidate('ui.render') }} />
    }
    const label = (src: string) => <Text dimColor> as {labelOf(src)}</Text>
    return (
      <Box flexDirection="column">
        <Text weight="semibold">Built in</Text>
        {RULES.map(r => <Text dimColor>  {r.label ?? r.type}: {r.name}</Text>)}
        <Box marginTop={1}><Text weight="semibold">From settings</Text><Text dimColor> · the patterns option in settings.json</Text></Box>
        {settings.length === 0 && <Text dimColor>  none</Text>}
        {settings.map(src => <Text>  {src}{label(src)}{skip(src)}</Text>)}
        <Box marginTop={1}><Text weight="semibold">Yours</Text><Text dimColor> · kept across sessions and projects</Text></Box>
        {stored.length === 0 && <Text dimColor>  none yet</Text>}
        {stored.map((src, i) => (
          <Box gap={1}>
            <Text>  {i + 1}. {src}{label(src)}{skip(src)}</Text>
            <Button key={`remove-${i}`} label="remove" onPress={async () => { kept.note = await remove($, kept, src); $.ui.invalidate('ui.render') }} />
          </Box>
        ))}
        <Box marginTop={1}>{field}</Box>
        {note && <Text dimColor>{note}</Text>}
      </Box>
    )
  })
}
