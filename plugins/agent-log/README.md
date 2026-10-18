# agent-log

A pane that shows what Claude Code does in this session and where the time goes: every model request, tool call, hook run and engine event, per agent and per turn, with what broke in red and what was refused in cyan.

- **Model requests**: one row per request of the main loop or a subagent, named by its model when that is not the session's: the model and effort, time to first token, time spent thinking, the start of the reply, the tools it called, the calls the API ran itself (the advisor) with their times, and tokens. With OTEL export on, also the price and request id. The row reads by what the request did (`Reply`, `Thought`, `Model API call` when it only called tools, which follow as rows of their own), and a plugin's model call by the plugin's name; what the model wrote or thought shows in the inspector. A request that only called tools hides at the `info` level. The API's own calls show as rows below their request.
- **Tool calls**: each call with its time and the permission decision behind it: the settings rule, you, a hook or the auto-mode classifier. The log is flat: every call, hook run and context entry is a row of its own, in time order; only an Agent row folds, its subagent's rows beneath it. A call that waited for its decision gets a `Waiting for …` row above it. The hooks that ran on a call, and the text they injected, sit next to it while it is drawn, its PreToolUse ones above it and the rest below, all on one bracket with the call (`╭` opens it, `├` marks the call, `╰` closes it). Hook rows are dim unless they blocked or broke. Each is marked by what it did: `⊘` blocked, `↩` feedback to the model, `+` added context, `·` changed nothing, `■` stopped the session, `✗` failed. Claude Code runs an event's hooks as one chain; the log draws one row per hook, by name only on its call's bracket (`guard`, `context-mode context`), by name and event where its call is hidden (`guard on PreToolUse Bash`). What a hook said shows only in its inspector, with the call it ran on, its command, its own time and exit code. Claude Code times only the whole chain and merges its hooks' text, so where a settings command runs through a wrapper that appends `{name, event, use, t0, t1, say}` lines to `~/.claude/hook-times/<session_id>.jsonl` (`say`: the first line the hook handed back), the log names the hooks that actually ran, each row shows its hook's own time, and text goes to the hook whose `say` it holds. Hooks the wrapper does not cover (a plugin's) are named from your settings and the plugins' `hooks.json`, and their text by the name in its first line. A failed command shows its exit code and its output boiled down in its inspector; a refused call reads a cyan `⊘` with who refused it (`⊘ guard`, a rule, the classifier or you), not a red `✗`.
- **Outside the project root**: a call that reached outside the session's project root is marked `↗` with the directory's `~` path, cut from the left at a folder when long (the inspector gives the full path): a file outside it, a `cd` out of it, or a path under your home that a command names. Another project draws amber, and the setup row counts those calls (`↗ 3 outside cwd`); `~/.claude` and `/tmp` are routine and stay dim. An Agent fold names another project's place before a routine one. The `outside` view keeps these calls, added directories, worktrees and cwd changes.
- **The harness**: hook runs and the text they injected, plugins' own model calls and forks, Claude Code's own model requests (session titles, prompt suggestions, compaction), model switches, compactions, API errors, MCP servers connecting, failing or closing, and permission mode changes.
- **Turns**: each prompt's header says how long the turn took and the two largest parts of where the time went. Pressing `#N` opens the turn, with the whole split (model, tools, agents, hooks, compaction, permission prompts and you) and the loops that acted.
- **Running now**: what streams or runs at this moment, as `●` lines under the log, with a permission prompt that waits for you. Only what will stay as a row at the current level gets a line: a model request shows once it writes text.
- **Setup**: a row under the controls with the model and effort, a rate limit once it passes 80%, and first, in red, what broke this session. `s` opens the setup page: Claude Code's version, permission mode, context use, cost and rate limits, the problems (each opens its row), hooks per event with their runs, plugins, MCP servers, model use per source, where the session is (root, cwd, added directories, the places calls reached outside the root), and the background work still running when the last turn ended.

## Install

```
/plugin install agent-log --marketplace dboeter/cc-plugins
```

Answer `y` to add the marketplace, then pick a scope.

## Use

The pane opens with every interactive session. `/agentlog` shows or hides it, `/agentlog all|agent|harness|outside` picks a view, `/agentlog level debug|info|notice|error` sets the least important row shown, and `/agentlog clear` empties the log.

In the pane, `a` `g` `h` `u` switch views, `l` cycles the level, `o` opens or closes every Agent fold, `s` opens the setup page, `j` jumps to the newest row, ctrl+↑↓ jump to the previous or next prompt, `b` goes back and `k` shows the legend with every key. A row opens its inspector, where `n` and `p` step to the next and previous row. With subagents, an agent in the tree at the top filters the log to that agent.

## What it does on your machine

- **Storage**: the rows of the 10 newest sessions in the plugin store, at most 300 per session (the `keep` option). Text is secret-scrubbed and cut short: 300 characters, 400 for a command. Your prompts and a slash command's arguments are never stored.
- **OTEL**: with OpenTelemetry export on (`CLAUDE_CODE_ENABLE_TELEMETRY=1`), it reads the records Claude Code sends the collector: request prices and ids, who decided each permission, hook run counts, plugins loaded, MCP connections, API errors and Claude Code's own model requests. Without it, those parts are missing. It reads them and sends nothing.
- **Reads**: your settings and the `hooks.json` of enabled plugins (to name hooks), `~/.claude/hook-times/<session_id>.jsonl` when a timing wrapper writes it, Claude Code's version and tool list at session start, and the session's root and cwd at each tool call. It makes no model requests and no network calls.

## Develop

```
claude --plugin-dir plugins/agent-log   # loads it from source
tsc -p plugins                          # type-checks every plugin against plugins/types/
claude plugin test plugins/agent-log    # tests
claude plugin validate plugins/agent-log
```
