# 04: A tool row's time is the call alone

**What to build:** A tool row and its inspector's "took" show the call's own run time, without its PreToolUse and PostToolUse hooks. Today both hook events run inside the call's span (checked in the event log), so an Edit followed by a 1.3 s lint hook reads about 1.4 s. The hooks keep their own rows on the call's bracket. The turn split is already right (hooks rank above tools) and must stay so.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [x] The call's PreToolUse and PostToolUse chain time is left out of its row's time, as the permission wait already is
- [x] The inspector says what "took" covers, or shows the hooks' time beside it
- [x] The README example (an Edit beside a slower lint-feedback) holds
- [x] A test: a call whose hooks take longer than its run shows the run time on its row; the turn split is unchanged
