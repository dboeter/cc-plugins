// Copied from plugins/shared/scrub.ts by plugins/shared/sync.sh: edit that file, then run the script.
// The secret scrub agent-log and event-log share: one source, copied into both by sync.sh. A secret's value as ***, the text around it
// kept. Best-effort, not a guarantee (ponytail). Its own rules, not redact's (redact reads redact-rules.json). No email
// rule: paths and git output stay readable. Repeats that can fail are bounded
// a secret's name: a keyword anywhere in it, or `_pass`/`_pwd` as its end (`DB_PASS`, not `DB_PASSPORT`)
const NAME = String.raw`\w{0,64}(?:(?:token|secret|password|passwd|api[_-]?key|private[_-]?key|access[_-]?key|credential)\w{0,64}|_(?:pass|pwd))`
const STOP = String.raw`\s'"\`,;&<>()[\]{}⟦⟧`
const VAL = String.raw`[^${STOP}]+`
const END = String.raw`(?![^${STOP}])`
// an unquoted value that reads as code stays: a `$` reference, a call or index, a keyword or literal, a dotted path, the name itself
const CODE = String.raw`(?!-?\$|[\w.]+[(\[]|(?:await|new|string|number|boolean|bool|str|int|bytes|any|unknown|undefined|none|nil|true|false|null|\d+|[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+|\k<name>|-)${END})`
// a rule masks its v (or v2) group and keeps pre, q and post; one with no groups masks its whole match
const SCRUB: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[\s\S]{0,8192}?-----END [A-Z ]*PRIVATE KEY-----|(?:(?:\r?\n|\\n)[ \t]*(?:\d+\t)?[A-Za-z0-9+/=]+(?=[\r\n\\]|$))+)/g,
  /\b(?:sk-[\w-]{20,}|gh[pousr]_\w{36,}|github_pat_\w{20,}|(?:AKIA|ASIA)[0-9A-Z]{16}|xox[abprs]-[\w-]{10,}|AIza[\w-]{35}|[sr]k_(?:live|test)_[0-9A-Za-z]{24,}|glpat-[\w-]{20,}|npm_[A-Za-z0-9]{36}|dckr_pat_[\w-]{20,}|SG\.[\w-]{20,}\.[\w-]{20,}|hf_[A-Za-z0-9]{30,}|ya29\.[\w-]{20,}|eyJ[\w-]{1,512}\.[\w-]+\.[\w-]+)/g,
  /(?<pre>\bauthorization["']?[ \t]*[:=][ \t]*(?:(?:basic|bearer|token|digest)[ \t]+)?)(?<v>[^\s'"]+)/gi,
  /\b(?<pre>bearer[ \t]+)(?<v>[\w.~+/-]{8,}=*)/gi,
  /(?<pre>\bhooks\.slack\.com\/services\/)(?<v>[\w\/]+)/g,
  /(?<pre>[?&](?:x-amz-signature|sig|signature)=)(?<v>[^&\s'"#]+)/gi, // a presigned URL's signature
  /(?<pre>:\/\/[^:\/\s@]+:)(?!\$)(?<v>[^\s@\/]+)(?<post>@)/g,
  /(?<pre>(?:^|\s)(?:-u|--user)(?:[ \t]+|=)["']?[^\s:'"]{1,64}:)(?<v>[^\s'"]+)/g,
  /(?<pre>\b(?:mysql|mysqldump|mariadb)\b[^\n]{0,200}?[ \t]-p)(?<v>[^\s'"]+)/g,
  new RegExp(String.raw`(?<pre>--(?:password|token|api-key|secret)[ \t]+)(?![$-])(?<v>${VAL})`, 'gi'),
  new RegExp(String.raw`(?<pre>\b(?<name>${NAME})["']?[ \t]*[=:][ \t]*)(?:(?<q>["'])(?!\$)(?<v>(?:(?!\k<q>)[^\n])+)(?<post>\k<q>?)|${CODE}(?<v2>${VAL}))`, 'gi'),
]
export const scrub = (s: string) => SCRUB.reduce((acc, re) => acc.replace(re, (m: string, ...rest: unknown[]) => {
  const g = rest.at(-1) as Record<string, string | undefined> | string
  return typeof g === 'object' && g ? `${g.pre ?? ''}${g.q ?? ''}***${g.post ?? ''}` : '***'
}), s)
