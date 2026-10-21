# cc-plugins

Claude Code mods. Each one is a folder under `plugins/`, listed in `.claude-plugin/marketplace.json`.

| Plugin | What it does |
| --- | --- |
| [session-pane](plugins/session-pane) | A pane with the session's goal, what Claude is doing, the context, and the changes so far. `/session-pane` toggles it. |
| [auto-title](plugins/auto-title) | Names the session with Haiku from the first prompt after start, `/clear`, or `/compact` when it has no title yet. |
| [context-budget](plugins/context-budget) | A pane that explains the context window to people new to Claude Code: the room left before auto-compact, the window as one stacked bar in category colours with a note per category, what every request carries, the window after each turn with its change, and where auto-compact starts. `/contextbudget` toggles it. |
| [notepad](plugins/notepad) | A notepad pane, one note per project, kept between sessions. Claude does not see it. `/notepad` toggles it. |
| [agent-log](plugins/agent-log) | Why was that turn slow, and who allowed that call? A pane that splits each turn's time across the model (first token, thinking), tools, hooks and waiting on you, read from Claude Code's own model stream. With OTEL on (`CLAUDE_CODE_ENABLE_TELEMETRY=1`), also who decided each call (you, a hook or the classifier) and request prices. Per-hook times need its `hook-timer` wrapper. It never opens by itself: a turn that ended unusually says so above the prompt, and `/agentlog` toggles it. |
| [event-log](plugins/event-log) | The raw record that goes with agent-log's interpreted view: every event in a session, whoever raised it (you, the model, the engine, hooks, plugins), with its full payload on disk under `~/.claude/event-log/<session>/`, and a peek per event in a live pane. `/eventlog` toggles it, `/eventlog <you\|claude\|engine\|hook\|plugin\|all>` filters by who. |
| [redact](plugins/redact) | Lets Claude use your API keys, tokens, passwords and other secrets, hiding what your rules match from the model. Matches are swapped for stable placeholders in everything sent to the model, kept in a local vault, and restored in tool calls, remote ones included, and in your terminal. Fails closed. No rule is on by default: rules live in `~/.claude/redact-rules.json`, starting with two examples (vendor tokens, email addresses), off; each has its own pattern, replacement label and on/off switch, managed with `/redact`. Its README says what it does and does not protect against; [HARDENING.md](plugins/redact/HARDENING.md) has permission rules and a managed-settings entry that hold where its own guard can't. |
| [session-tree](plugins/session-tree) | A pane with every Claude session on this machine as a tree under its repo; pressing one focuses its herdr pane or attaches a background one in a new tab. `/sessiontree` toggles it. |

Install one:

```
/plugin install <plugin> --marketplace dboeter/cc-plugins
```

Adding a plugin: put it in `plugins/<name>/` and add `{ "name": "<name>", "source": "./plugins/<name>" }` to the marketplace's `plugins`.

## Develop

Every plugin is typed against one copy of Claude Code's plugin API, `plugins/types/claude-code.d.ts` (its first line names the Claude Code version), through `plugins/tsconfig.json`:

```
tsc -p plugins
```

A plugin loads no file outside its own folder, so code two plugins share lives once in `plugins/shared/` and is copied into each by `plugins/shared/sync.sh` (`--check` exits 1 when a copy is stale). Today that is the secret scrub agent-log and event-log use.

After a Claude Code update, replace that file with the new build's: the plugin-authoring skill writes it as `types/claude-code.d.ts` each time the skill loads. A plugin loaded with `--plugin-dir` still gets its own `.claude-plugin/types/` and, without one of its own, a `tsconfig.json`; both are gitignored.
