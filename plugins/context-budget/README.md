# context-budget

A pane that explains the context window to people new to Claude Code: how much room is left before auto-compact, what fills it, what each part is, what every request carries, and how it grows turn by turn.

- **Room left**: the free space before auto-compact and where it starts, the room left in the whole window, and how much of what is used is the conversation. The room before auto-compact turns yellow under a quarter of the window and red under a tenth.
- **The bar**: the window as one stacked bar in the category colours; every non-empty part gets at least one cell. Below it, each category's tokens and share of the window. Each counted row is marked *grows* (the conversation) or *each request* (sent again with every message); the autocompact buffer is marked as reserved for compaction.
- **What each part is**: a plain-language note per category: System prompt, System tools, MCP tools, Custom agents, Memory files, Skills, Messages, Free space, Autocompact buffer.
- **Available tools outside context**: tool schemas loaded on demand, listed apart from the breakdown because they are not in the window.
- **Context included in each request**: the five biggest fixed parts among each MCP server's loaded tool schemas, each memory file, the skill descriptions and the agent descriptions.
- **Per turn**: the context total now (the header's) and how much the last turn added, then one row per turn for the last ten, newest first: the total after that turn, the change from the turn before, and a bar of the window in the same category colours as the top bar, so you see which part grew. A drop is a compaction or a `/clear`.
- **When it fills up**: where auto-compact starts, or that it is off.

## Install

```
/plugin install context-budget --marketplace dboeter/cc-plugins
```

Answer `y` to add the marketplace, then pick a scope.

## Use

`/contextbudget` shows or hides the pane. It never opens by itself. In the pane, `e` estimates the breakdown again (local, no requests), `r` counts it exactly and `n` shows or hides the notes, which start hidden.

## What it does on your machine

- **Estimates locally**: the breakdown comes from Claude Code's own estimate, read when the pane opens, after every turn (pane open or not, so the per-turn rows reach back) and on `e`. No requests.
- **Count exactly** (`r`): asks for the full breakdown, which sends one token-count request per tool and file. Only when you press it.
- **Per-turn rows**: kept in memory from the estimate after each turn; reloading the plugin starts them over.
- **Storage**: none.

## Develop

```
claude --plugin-dir plugins/context-budget   # loads it from source
tsc -p plugins                               # type-checks every plugin against plugins/types/
claude plugin test plugins/context-budget    # tests
claude plugin validate plugins/context-budget
```
