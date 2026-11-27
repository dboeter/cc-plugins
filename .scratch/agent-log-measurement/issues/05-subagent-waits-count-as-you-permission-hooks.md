# 05: A subagent's waits count as you, permission and hooks

**What to build:** When a foreground subagent waits on your permission prompt, waits on a permission decision or runs hooks, main's turn split counts that time as you, permission or hooks, not as agents. Today the split ignores every subagent row, so all of a foreground agent's time is agents, and a long permission prompt inside an agent can trigger the "unusual" note.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [x] Inside a foreground Agent call's span, a subagent's permission waits, decision waits and hook runs take precedence over agents, as main's own do
- [x] Background agents (their call returns at once) still add nothing to main's turn
- [x] A test: a foreground agent with a 20 s permission prompt splits 20 s to you
