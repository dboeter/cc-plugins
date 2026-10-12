# cc-plugins

Claude Code mods. Each one is a folder under `plugins/`, listed in `.claude-plugin/marketplace.json`.

| Plugin | What it does |
| --- | --- |
| [session-pane](plugins/session-pane) | A pane with the session's goal, what Claude is doing, the context, and the changes so far. `/session-pane` toggles it. |
| [auto-title](plugins/auto-title) | Names the session with Haiku from the first prompt after start, `/clear`, or `/compact` when it has no title yet. |
| [context-budget](plugins/context-budget) | A pane that explains the context window to people new to Claude Code: the `/context` grid with a note per category, what every request pays, growth per turn, and where auto-compact starts. `/contextbudget` toggles it. |

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
