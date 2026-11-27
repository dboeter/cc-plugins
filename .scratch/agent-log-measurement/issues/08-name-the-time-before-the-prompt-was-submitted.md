# 08: Name the time before the prompt was submitted

**What to build:** The engine's turn duration starts before the prompt submit agent-log sees (1.8 and 3.3 s more on two turns in the event log). That stretch has no rows, so the split puts it in "other", described as "the engine's and plugins' own work between steps". Show it as its own part, or say in "other"'s description that it includes it. Low priority.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [x] The time from the turn's start to the prompt submit is measured, not inferred
- [x] The split shows it as its own part or "other"'s description covers it, and the keys page and README agree
- [x] A test: a turn whose duration starts 2 s before its submit reads that 2 s under the chosen name
