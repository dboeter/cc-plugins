# context-budget

A pane that explains the context window to people new to Claude Code: what fills it, what each part is, what every request pays for, and how it grows.

- **The grid**: the breakdown `/context` prints, in its category colours, with each category's tokens and share of the window. Each counted row is marked *grows* (the conversation) or *per request* (sent again with every message).
- **What each part is**: a plain-language note per category: System prompt, System tools, MCP tools, Custom agents, Memory files, Skills, Messages, Free space, Autocompact buffer. Tool schemas loaded on demand are marked as not in the window.
- **Paid on every request**: the five biggest fixed costs among each MCP server's loaded tool schemas, each memory file, the skill descriptions and the agent descriptions.
- **Growth after each turn**: one bar per turn, measured against the whole window; a drop is a compaction or a `/clear`.
- **When it fills up**: where auto-compact starts, or that it is off.

## Install

```
/plugin install context-budget --marketplace dboeter/cc-plugins
```

Answer `y` to add the marketplace, then pick a scope.

## Use

`/contextbudget` shows or hides the pane. It never opens by itself. In the pane, `r` counts the breakdown exactly and `n` hides or shows the notes.

## What it does on your machine

- **Estimates locally**: the breakdown comes from Claude Code's own estimate, read when the pane opens and again after each turn while it is open. No requests.
- **Count exactly** (`r`): asks for the full breakdown, which sends one token-count request per tool and file. Only when you press it.
- **Growth line**: kept in memory from the context fill after each turn; reloading the plugin starts it over.
- **Storage**: none.

## Develop

```
claude --plugin-dir plugins/context-budget   # loads it from source
tsc -p plugins                               # type-checks every plugin against plugins/types/
claude plugin test plugins/context-budget    # tests
claude plugin validate plugins/context-budget
```
