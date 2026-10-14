# session-pane

A pane that answers four questions about the current Claude Code session:

- **Goal**: what you're trying to get done, condensed from your messages, with the constraints you stated.
- **Now**: what Claude is doing, what's next on its todo list, and whether it's waiting on you.
- **Changes**: the files changed this session (by tools and by shell commands), their diffs, the checks run since and which ones need rerunning.
- **Context**: how full the context window is and what it holds; when it's nearly full, a recap you can review before compacting.

## Install

```
/plugin install session-pane --marketplace dboeter/cc-plugins
```

Answer `y` to add the marketplace, then pick a scope.

## Use

`/session-pane` shows or hides the pane. It never opens by itself. (`/session` is Claude Code's own command.)

## What it does on your machine

- **One small-model call per prompt you send** (`haiku`, at most 300 tokens out) to keep the goal line current.
- **Recap**: drafted only when you press *Prepare a recap*, by forking the conversation; applied only when you press *Use*.
- **Shell edits**: after each Bash call it runs `git rev-parse` and `git ls-files -m -o --exclude-standard` in the session's repo and lists the dirty files whose mtime falls inside the call. That's a guess: another process writing during the call is credited to the session. It looks at the first 200 dirty files in path order, so in a repo with more, a command's edits further down are missed. Without git, outside a repo, or on a surface other than the CLI, only tool edits are listed.
- **Storage**: a snapshot of the pane for the 20 most recent sessions, in the plugin's own store, so a restart or resume shows the same pane.

## Develop

```
claude --plugin-dir plugins/session-pane   # loads it from source
tsc -p plugins                             # type-checks every plugin against plugins/types/
claude plugin test plugins/session-pane    # tests
claude plugin validate plugins/session-pane
```
