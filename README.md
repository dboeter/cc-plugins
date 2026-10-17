# cc-plugins

Claude Code mods. Each one is a folder under `plugins/`, listed in `.claude-plugin/marketplace.json`.

| Plugin | What it does |
| --- | --- |
| [session-pane](plugins/session-pane) | A pane with the session's goal, what Claude is doing, the context, and the changes so far. `/session-pane` toggles it. |
| [auto-title](plugins/auto-title) | Names the session with Haiku from the first prompt after start, `/clear`, or `/compact` when it has no title yet. |
| [context-budget](plugins/context-budget) | A pane that explains the context window to people new to Claude Code: the room left before auto-compact, the window as one stacked bar in category colours with a note per category, what every request carries, the window after each turn with its change, and where auto-compact starts. `/contextbudget` toggles it. |
| [notepad](plugins/notepad) | A notepad pane, one note per project, kept between sessions. Claude does not see it. `/notepad` toggles it. |
| [agent-log](plugins/agent-log) | A pane that shows what Claude Code does in this session and where the time goes: each model request with its timings and price, tool calls and the permission decision behind each, hooks and Claude Code's own events, per agent and per turn. Calls outside the project root are marked, and a setup page lists what the session runs on and what broke. `/agentlog` toggles it. |
| [event-log](plugins/event-log) | Logs every event in a session, whoever raised it (you, the model, the engine, hooks, plugins), with full payloads to `~/.claude/event-log/<session>/` and a peek per event in a live pane. `/eventlog` toggles it, `/eventlog <you\|claude\|engine\|hook\|plugin\|all>` filters by who. |
| [redact](plugins/redact) | Swaps secret-shaped values and email addresses for numbered placeholders in everything the model is sent, from the first request on (prompt, context, system prompt, injected reminders, tool results, subagents), keeps the real values in a local vault per session, and puts them back in every tool call's input, remote tools included, and in the terminal. Refuses a placeholder it cannot restore, and tool calls that would change its own store or its entries in a settings file (best effort: a Bash command can spell the path another way). `/redact show` opens a pane with every rule, where you add and remove regexes of your own, kept across sessions and projects; `/redact add <regex>` and `/redact remove <n>` do the same from the prompt, though what you type there lands in the transcript the model reads. More can be set in the `patterns` option, a list in settings.json `pluginConfigs` (`/config` does not show list fields). Its README has companion settings, permission rules and a managed-settings entry, that hold where its own guard can't. |
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

After a Claude Code update, replace that file with the new build's: the plugin-authoring skill writes it as `types/claude-code.d.ts` each time the skill loads. A plugin loaded with `--plugin-dir` still gets its own `.claude-plugin/types/` and, without one of its own, a `tsconfig.json`; both are gitignored.
