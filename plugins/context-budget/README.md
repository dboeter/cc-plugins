# context-budget

A pane that explains the context window to people new to Claude Code: how much room is left before auto-compact, what fills it, what each part is, what every request carries, and how it grows, step by step.

- **Room left**: the free space before auto-compact and where it starts, the room left in the whole window, and how much of what is used is the conversation.
- **The bar**: the window as one stacked bar in the category colours; every non-empty part gets at least one cell. Below it, each category's tokens and share of the window. Each counted row is marked *grows* (the conversation) or *each request* (sent again with every message); the autocompact buffer is marked as reserved for compaction.
- **What each part is**: a plain-language note per category: System prompt, System tools, MCP tools, Custom agents, Memory files, Skills, Messages, Free space, Autocompact buffer.
- **Available tools outside context**: tool schemas loaded on demand, listed apart from the breakdown because they are not in the window.
- **Context included in each request**: the five biggest fixed parts among each MCP server's loaded tool schemas, each memory file, the skill descriptions and the agent descriptions.
- **Growth this turn**: live while Claude works, one row per step with what it added to the context and the tools that caused it (`Read ×3`, `Bash`), the first row being your prompt plus the last reply; a drop reads as compacted or cleared. Below it, the totals of the turns before.
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
- **Growth**: read from the size of each main request as its response ends (subagents' requests are their own window and left out), kept in memory for the last few turns; reloading the plugin starts it over.
- **Storage**: none.

## Develop

```
claude --plugin-dir plugins/context-budget   # loads it from source
tsc -p plugins                               # type-checks every plugin against plugins/types/
claude plugin test plugins/context-budget    # tests
claude plugin validate plugins/context-budget
```
