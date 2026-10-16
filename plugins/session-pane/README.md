# session-pane

Tells you when Claude's checks no longer hold: tests that failed, tests that passed before Claude edited again, or code changed with no check run at all. One press reruns the stale ones. It says so in a line above the prompt, without opening anything.

`/session-pane` opens the full pane:

- **Goal**: what you're trying to get done, with the constraints you stated. It starts as the first sentence of your opening message and is condensed by a small model only while the pane is open.
- **Changes**: the files changed this session (by tools and by shell commands), their diffs, the checks run since and which ones need rerunning. *Rerun stale checks* runs them again.
- **Right now**: shown only when something needs you: a question waiting, a failed check, or subagents still running, each with what it is doing. *Session details* lists every subagent this session started, with its tool calls and, once it finishes, its tokens.
- **Context**: how full the context window is and what it holds, roughly how many turns are left before older messages are summarised (auto-compact; from the median growth of recent turns; shown only once there is an estimate), a row of bars showing how full the window was after each turn since the last summary, and when it's nearly full, a recap you can review before compacting.

## Install

```
/plugin install session-pane --marketplace dboeter/cc-plugins
```

Answer `y` to add the marketplace, then pick a scope.

## Use

`/session-pane` shows or hides the pane. It never opens by itself. (`/session` is Claude Code's own command.)

While the pane is hidden, three small signals cover what needs you:

- **Band above the prompt**: between turns, one line when code changed and no check ran, a check failed, a check needs rerunning after an edit, the context is nearly full, or summarising is two turns away or less. When nothing needs you, it doesn't draw. Lines from other mods stay below it.
- **Toasts**: one when a check is still failing at the end of a turn, and one when the context crosses 85%. Each alert is announced once while it holds, never mid-turn. It is announced again only if it clears and comes back, for example a check rerun after an edit that still fails, or the context refilling after a summary. When a recap you asked for is ready, a toast says so.
- **Spinner**: while Claude works, `· summarising in ~N turns` is appended once that is two turns away or less.

The band and the toasts stay quiet while the pane is open.

## What it does on your machine

- **Goal calls, only while the pane is open** (`haiku`, at most 150 tokens out). While the pane is hidden, nothing is sent: your messages wait, and one call reads all of them when you open it. While it is open, one call per message of three words or more; replies like "yes" or "go on" never cost one. The draft title before that is free.
- **Recap**: drafted only when you press *Prepare a recap*, by forking the conversation; applied only when you press *Use*.
- **Shell edits**: after each Bash call it runs `git rev-parse` and `git ls-files -m -o --exclude-standard` in the session's repo and lists the dirty files whose mtime falls inside the call. That's a guess: another process writing during the call is credited to the session. It looks at the first 200 dirty files in path order, so in a repo with more, a command's edits further down are missed. Without git, outside a repo, or on a surface other than the CLI, only tool edits are listed.
- **Rerun stale checks**: runs a stale check's command again, exactly as Claude ran it, only when you press the button and only between turns. It goes through the normal tool call, so your permission rules and dialogs apply. Only a command that is the check alone is offered: not one chained with other commands (`npm test && rm -rf dist`), not one that sets a variable, and not one stored with a secret masked or cut short.
- **Turns left**: after each turn, one local context count (`$.session.usage({ breakdown: 'summary' })`, no request sent) for the window's size and the auto-compact threshold.
- **Storage**: a snapshot of the pane for the 20 most recent sessions, in the plugin's own store, so a restart or resume shows the same pane.

## Develop

```
claude --plugin-dir plugins/session-pane   # loads it from source
tsc -p plugins                             # type-checks every plugin against plugins/types/
claude plugin test plugins/session-pane    # tests
claude plugin validate plugins/session-pane
```
