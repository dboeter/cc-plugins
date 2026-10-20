# event-log

The raw record of a session: every event that crosses Claude Code, in the order it happened, with its full payload written to disk. It names who raised each one: you, the model, the engine, settings hooks or a plugin. Use it when you need to know exactly what was sent and returned, or to see what a plugin does behind your back.

[agent-log](../agent-log) is the interpreted view of the same session: turns, timings and who decided each call. The two work as a pair, agent-log to find the moment and event-log to read what actually crossed.

## What it records

- **Rows**: each event gets an `enter` row before its hook chain runs and an `exit` row after, so nested events land between the two and the order on disk is the order things happened. An exit row carries the result or the error and how long the chain took.
- **Payloads**: in full, each string cut at 16 KiB. Secret-shaped text (tokens, keys, passwords, `Authorization` headers) is masked as `***` on a best-effort basis.
- **Counted, not stored**: screen events (`ui.*`, apart from `ui.fault`), typing and autocomplete, clock ticks, and plugins' read-only queries. A tally row per flush says how many there were.

## Install

```
/plugin install event-log --marketplace dboeter/cc-plugins
```

Answer `y` to add the marketplace, then pick a scope.

## Use

The pane stays closed until `/eventlog` opens it, and shows one line per event, an enter and its exit merged when nothing came between them. Pressing a line opens its full rows, and `b` goes back. `/eventlog` shows or hides the pane, and `/eventlog you|claude|engine|hook|plugin` keeps only the events that one source raised (`all` clears the filter). No `/eventlog` enters the conversation: its line is dropped and its reply is a toast, so the model reads neither.

To check a session's log on disk:

```
node plugins/event-log/check-log.mjs ~/.claude/event-log/<session_id>
```

It prints a PASS or FAIL line per check (sequence numbers without gaps, every exit with its enter), then a count of rows per event, and exits 1 on any FAIL.

## What it does on your machine

- **Writes**: `~/.claude/event-log/<session_id>/0001.jsonl`, `0002.jsonl`, and so on, one JSON row per line, in chunks of about 1 MiB, flushed every 2 seconds and at session end. Past the `maxMB` option (50 MB per session by default) it stops writing for good and the pane says so; the rows stay in the pane only. Old sessions are not pruned: delete their folders when you no longer need them.
- **Reads**: its own last chunk after a plugin reload, to carry on where it left off. It makes no model requests and no network calls.

## Develop

```
claude --plugin-dir plugins/event-log   # loads it from source
tsc -p plugins                          # type-checks every plugin against plugins/types/
claude plugin test plugins/event-log    # tests
```

`hooks/scrub.ts` is a copy of `plugins/shared/scrub.ts`: edit that file and run `plugins/shared/sync.sh`.
