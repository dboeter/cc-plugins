# agent-log

Why was that turn slow, and who allowed that call? A live pane that splits each turn's time across the model (time to first token, thinking), tools, hooks and waiting on you, read from Claude Code's own model stream, and who decided each call: you, a hook or the classifier.

```
#1 · tools 17.2s · model 12.3s · 4 hidden ▸                                           39.6s
╭ context-mode context
│ Waiting for you to answer the permission prompt                                       4.2s
╰ Run the tests                                                                     ✗ 18.4s
╭ guard                                                                             ⊘ <0.1s
╰ Clean the build output                                                          ⊘ denied
╭ Edit agent-log.tsx                                                                    0.1s
╰ lint-feedback                                                                     ↩ 1.3s
  Read index.ts ↗ ~/other-project/src                                                <0.1s
╭ Reply: The test fails because the header grew a row.                                 6.1s
╰ Advisor                                                                               3.2s
```

agent-log is the interpreted view of a session. [event-log](../event-log) is the raw record, every event with its full payload on disk. The two work as a pair.

## What it shows

Prices, request ids, who decided a call, permission waits, hook run counts and API errors come from the telemetry records Claude Code hands plugins. They arrive whether or not telemetry export is on (checked on Claude Code 2.1.310), so agent-log needs no `CLAUDE_CODE_ENABLE_TELEMETRY` or `OTEL_*` variables.

- **Turns**: each prompt's header gives the turn's time and its two largest parts. `#N` opens the full split: model, tools, agents, hooks, compaction, permission prompts and you.
- **Model requests**: one row per request of the main loop or a subagent, with time to first token, thinking time, tokens and the start of the reply. Price and request id.
- **Tool calls**: each call with its run time, and its hooks bracketed around it (`╭ ├ ╰`). The inspector says who decided it: a settings rule, you, a hook or the auto-mode classifier. A call that waited for that decision gets a `Waiting for …` row above it.
- **Outside the project root**: a call that reached another project is marked `↗` with the place, and the controls count them (`↗ 2 other project`). A routine place (`~/.claude`, `/tmp`) shows as a dim path without the `↗`. The `outside` view keeps all of these calls.
- **The harness**: hook runs and what they injected, plugins' model calls, compactions, model switches and MCP failures. Claude Code's own requests (titles, suggestions) and API errors.
- **Running now**: what streams or runs at this moment, as green `●` lines under the log.
- **Setup page** (`s`): what broke this session (each problem opens its row), hooks per event with their runs, whether hook-timer times them (`per-hook times`), plugins, model use per source, where the session is, and background work still running. Context, cost, rate limits and MCP servers are left to `/context`, `/cost`, `/status` and `/mcp`.

`i` opens the keys page, which lists what every mark and colour means. Each mark has its own glyph, so none relies on colour alone. In the controls, bright means active: the view shown (also marked `•`), the open page, the loop the log is filtered to. When the log starts mid-turn, that turn's `#N` header stays pinned on its first line.

## Per-hook times

Claude Code times an event's hooks as one chain and merges their text, so without help the log can only say "these hooks ran, together, in 1.3s". Wrapping each settings hook in [`bin/hook-timer`](bin/hook-timer) gives each hook its own row, its own time and the text it injected. It needs bash 5+ and `jq`. Copy it onto your `PATH` and put it in front of each hook command in `settings.json`:

```json
{ "type": "command", "command": "hook-timer ~/.claude/hooks/guard.sh" }
```

The hook keeps its stdin, stdout, stderr and exit code. hook-timer appends one line per run to `~/.claude/hook-times/<session_id>.jsonl`, which agent-log reads. Plugins' hooks can't be wrapped; they are named from their `hooks.json`, and their text by the name in its first line. Text that names no hook goes to the event's one plugin hook, or, with several, to `<event> hook`.

## Install

```
/plugin install agent-log --marketplace dboeter/cc-plugins
```

Answer `y` to add the marketplace, then pick a scope.

## Use

The pane never opens by itself. While it is closed, a turn that ended unusually gets one line above the prompt, between turns, until the next turn ends or you open the pane:

- `/agentlog #4 took 41.2s, 3× the usual`: the turn ran over twice the median of your earlier turns (once there are three).
- `/agentlog #2: hooks 12.0s of 20.0s`: hooks, or a slow permission decision, held the turn longest.

Turns under 10 seconds never get a line, and time spent waiting on you never counts as unusual. `/agentlog` shows or hides the pane, `/agentlog all|model|harness|outside` picks a view (`agent` still works for `model`), `/agentlog level debug|info|notice|error` sets the least important row shown, and `/agentlog clear` empties the log. No `/agentlog` enters the conversation: its line is dropped and its reply is a toast, so the model reads neither.

In the pane, `a` `m` `h` `u` switch views: all, what the model did, the harness, outside the root. `l` toggles the level between info and notice. `o` opens or closes every Agent fold. `s` opens the setup page and `i` the keys page. `j` and `k` (or ↓ and ↑) move a row cursor, and Enter opens its row. `e` jumps to the newest row, ctrl+↑↓ (`^↑↓ turn`) to the previous or next prompt, and `b` goes back. In a row's inspector, `n` and `p` step to the next and previous row; an Agent row's inspector has `f` to keep only that agent's rows, and `f` outside it clears that filter. Tab moves the focus over the buttons, and Enter presses one. While an agent runs, a tree of the main loop and its agents sits at the top, and pressing one filters the log to it.

## What it does on your machine

- **Storage**: the rows of the 10 newest sessions in the plugin store. A session keeps at most 300 rows (the `keep` option), and fewer when its rows are large, since each session is held to a tenth of the store's 4 MiB. Every new session prunes the older ones. If the store refuses a write, the rows stay in memory, the setup badge shows "log not saved", and the write is retried. Secret-shaped text (tokens, keys, passwords, `Authorization` headers, webhook and presigned URLs) is masked as `***` on a best-effort basis, as is your email in the session context Claude Code sends, and text is cut short: 300 characters, 400 for a command. Your typed prompts and a slash command's arguments are not stored as such. A turn header's first few words of the prompt are kept in memory only, so a resumed session's headers have none. Two stored texts can still restate what you typed: a skill's expanded text (which can include the arguments after `/name`) and a compaction summary. Both are kept scrubbed, up to 300 characters.
- **Telemetry records**: it reads the records Claude Code hands plugins, export on or off: request prices and ids, who decided each permission, hook run counts, plugins loaded, MCP connections, API errors and Claude Code's own model requests. It reads them and sends nothing.
- **Reads**: your settings and the `hooks.json` of enabled plugins (to name hooks), `~/.claude/hook-times/<session_id>.jsonl` when hook-timer writes it, the main loop's model at session start, and the session's root and cwd at each tool call. It makes no model requests and no network calls.

## Develop

```
claude --plugin-dir plugins/agent-log   # loads it from source
tsc -p plugins                          # type-checks every plugin against plugins/types/
claude plugin test plugins/agent-log    # tests
claude plugin validate plugins/agent-log
```

`claude plugin test` runs only `*.test.ts`. After changing `bin/hook-timer`, run `plugins/agent-log/hooks/hook-timer.test.sh`: it checks the same stdin, stdout, stderr, exit code and record as the version before the fork-lean rewrite, or as the commit you name. Records are compared without `agent`, which that version did not write; its `own` cases check what only the new version writes.

`hooks/scrub.ts` is a copy of `plugins/shared/scrub.ts`: edit that file and run `plugins/shared/sync.sh`.
