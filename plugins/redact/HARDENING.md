# Hardening redact

The plugin's own guard is best effort: a Bash command can spell a path another way, and `claude plugin disable` turns the plugin off. Claude Code's permission rules and managed settings hold where it can't, because Claude Code enforces them itself. [`hardening/`](hardening) holds the two snippets. What masking itself misses (shapes, images, other hooks) is listed under Limits in the [README](README.md); hardening does not change it.

## 1. Permission rules

Add the entries of [`hardening/user-settings.json`](hardening/user-settings.json) to the `permissions.deny` and `permissions.ask` lists in `~/.claude/settings.json`, after the ones you have. Claude Code applies them to the running session on save.

| Rule | What it stops |
| --- | --- |
| `Read(~/.claude/plugins/store/redact_*)` | Reading or changing the store file with the file tools, and with the Bash file commands Claude Code recognizes (`cat`, `sed`, `tee`, `>`). A Read deny also blocks Edit and Write on the path. |
| `Edit(~/.claude/plugins/store/redact_*)` | The same for NotebookEdit, which a Read deny does not cover. |
| `Read(~/.claude/redact-patterns.txt)`, `Edit(…)` | The same for your patterns file. Your editor is not Claude Code, so editing it by hand still works. With `CLAUDE_CONFIG_DIR` set, name the file in that folder. |
| `Bash(claude plugin disable*)`, `uninstall`, `marketplace remove` | Turning the plugin off from the CLI, which writes your settings itself, out of reach of the file rules. A prefix match: `$(which claude) plugin disable` gets past it. |
| ask `Edit(~/.claude/settings.json)`, `Edit(**/.claude/settings*.json)` | Any settings edit without you approving it. |

If `~/.claude/settings.json` is a link (to a dotfiles repo, say), also add an ask rule for its target: `readlink -f ~/.claude/settings.json` prints it. Claude Code refuses to write through the link and points Claude at the target, which none of the rules above name.

## 2. Force-enable it

A plugin that managed settings enable can't be disabled from user, project or local settings, and only root writes the managed file. In your own terminal, as `sudo` asks for your password:

```bash
sudo install -d -m 755 /etc/claude-code && echo '{ "enabledPlugins": { "redact@dboeter": true } }' | sudo tee /etc/claude-code/managed-settings.json
```

That writes [`hardening/managed-settings.json`](hardening/managed-settings.json) and replaces a managed file already there: if you have one, add the `enabledPlugins` entry to it instead. On macOS the file is `/Library/Application Support/ClaudeCode/managed-settings.json`. Installed from a marketplace under another name, the id is `redact@<that name>`.

**On WSL** root is reachable without a password through Windows interop (`/mnt/c/Windows/System32/wsl.exe -u root`), and Claude Code's docs count `/etc/claude-code` as user-writable there. Deny `Bash(/mnt/c/Windows/System32/wsl.exe*)` and `Bash(wsl.exe*)` (a prefix match again), or turn interop off with `enabled = false` under `[interop]` in `/etc/wsl.conf` and `wsl --shutdown` from Windows, which also stops running Windows programs from WSL.

## What stays open

- **The plugin's code**: a module that does not load masks nothing, so whoever can edit the folder the plugin loads from can switch it off. Installed from the marketplace, the copy that runs sits under `~/.claude/plugins/`, where Claude Code never auto-approves a write (in auto mode its classifier decides); a working copy loaded as a local directory marketplace has no such guard.
- **Bash spelled another way**: a variable, or `cd` first. The sandbox (`sandbox.enabled`, with `allowUnsandboxedCommands: false`) closes this for every command it runs: the operating system enforces the Read and Edit deny rules, however a command names the path. Commands in `excludedCommands` run outside it.
