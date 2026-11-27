# 06: Answering a question or approving a plan counts as you

**What to build:** The time you spend answering an AskUserQuestion or approving an ExitPlanMode plan counts as you in the turn split, and never makes a turn "unusual". Unverified premise: that the wait happens inside the call's run. Check it in the raw event log first; if the wait is not inside the call, close this ticket with that evidence.

**Blocked by:** 05

**Status:** ready-for-agent

- [x] Evidence recorded: where the person's answer time sits relative to the call's span
- [x] If inside: that span counts as you, in main's loop and in a subagent's (as 05 does for permission prompts)
- [x] A test: a turn of 5 s model time plus a 60 s AskUserQuestion is not noted as unusual

## Evidence (2026-10-28)

Inside. In the raw event log (`~/.claude/event-log/<session>/*.jsonl`) the answer is the engine's `tool_decision` (`source: user_temporary`), and it lands between the call's `tool.call` enter and exit, after the PermissionRequest that shows the dialog:

- AskUserQuestion, session `181f745d`: `tool.call` enter seq 24609 `2026-10-14T00:04:04.904Z`; `tool.check` exit 24613 `00:04:04.907Z`; PermissionRequest 24614 `00:04:04.913Z`; main's message closes (`api_request`) 24631 `00:04:05.199Z`; `tool_decision accept user_temporary` 32116 `00:09:42.225Z`; `tool.call` exit 32128 `00:09:42.350Z`, `ms` 337447.
- ExitPlanMode, session `3b6f58ce`: enter 22629 `2026-10-13T16:34:31.187Z`; `tool.check` exit 22635 `16:34:31.192Z`; `tool_decision accept user_temporary` 38520 `16:46:17.881Z`; exit 38527 `16:46:17.970Z`, `ms` 706784.
- ExitPlanMode, session `bfe64334`: enter 8067 `2026-10-13T19:02:52.948Z`; decision 113988 `20:21:56.259Z`; exit 113995 `20:21:56.343Z`, `ms` 4743395.

So the row's `wait` (check to decision) is the person's time. But agent-log's stored rows label most of these waits `waitFor: "the model to finish its message"` (e.g. AskUserQuestion `wait` 385471, ExitPlanMode `wait` 2626051, both `via: user_temporary`): main's message closes after the check and before the answer, so the STREAMING test in tool.call (agent-log.tsx, the `waitFor` line) wins over the `user*` source. splitOf dropped those waits (they fell to "other"), and rows logged before `waitFor` existed counted as "permission".

Done: splitOf counts an AskUserQuestion or ExitPlanMode row's wait as you whatever its `waitFor`, for main and inside a foreground subagent's Agent call (tests in `plugins/agent-log/hooks/split-asked.test.ts`). Not done here: the `waitFor` label itself, which the inspector still reads as "waited … for the model to finish its message", and which hides the call's Waiting row. The unusual-note test uses no earlier turns: with a median the 65 s turn still notes "× the usual" until 03 lands.
