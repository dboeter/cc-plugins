# auto-title

Names the current Claude Code session from your first prompt, so the session list shows what each one was about.

- **When**: on the first prompt you type after a fresh start, `/clear`, or `/compact`. Slash commands and resumed sessions don't count.
- **When the start signal is missed**: a `/clear` can restart the plugin before it hears the clear. The first prompt it sees then still gets a title if the conversation has no earlier typed prompt.
- **After `/compact`**: a session that already has a title keeps it; only an untitled one is named.
- **How**: Haiku condenses the prompt to a title of at most 5 words and 40 characters, then hands it back as the hook's `sessionTitle`. Unlike `/rename`, that tells the model nothing: no "The user named this session" note enters the conversation.

## Install

```
/plugin install auto-title --marketplace dboeter/cc-plugins
```

Answer `y` to add the marketplace, then pick a scope.

## Use

Nothing to do: it runs on its own. Rename by hand with `/rename` at any time.

## What it does on your machine

- **One small-model call per titled session** (`haiku`, at most 16 tokens out, 5 s timeout), sent the first 1,500 characters of your prompt.
- **Delays one prompt**: the prompt that gets titled waits for Haiku (usually under a second, 5 s at most); every other prompt goes straight through.
- **Failures**: no reply, a blank reply, or a failed call shows a toast, leaves the title as it was, and lets the prompt through.
- **Storage**: none.

## Develop

```
claude --plugin-dir plugins/auto-title   # loads it from source
tsc -p plugins                           # type-checks every plugin against plugins/types/
claude plugin test plugins/auto-title    # tests
claude plugin validate plugins/auto-title
```
