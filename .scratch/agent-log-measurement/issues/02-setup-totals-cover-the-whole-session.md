# 02: Setup-page totals cover the whole session

**What to build:** The setup page's "Model use this session" (requests, time, tokens, $ for main, subagents, the engine's own requests and plugins), the problem counts (failed hook runs, API errors, failed turns, MCP servers down, skipped hooks) and the earlier-turn times "the usual" is measured against count everything that happened this session. Today every draw recounts them from the rows still in the log, so they shrink as rows are evicted while the labels say "this session".

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [x] Running totals saved with the session's store entry, so a hot reload or resume keeps them; /agentlog clear decides explicitly whether they reset (and the README says which)
- [x] A test: evicting rows does not change the setup page's request count, cost or problem counts
- [x] The "unusual" median reads from the kept turn times, not from surviving turn rows
- [x] Stores written before this change fall back to counting rows, as today
