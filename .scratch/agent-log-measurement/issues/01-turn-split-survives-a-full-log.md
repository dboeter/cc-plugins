# 01: A turn's split survives a full log

**What to build:** A turn's split (where its time went: model, tools, agents, hooks, compaction, permission, you, other) stays correct when the log is at its row cap or its store budget. Today a full log evicts the oldest debug row first. A model request that only called tools and a hook that changed nothing both rank debug, so once older turns run out of debug rows, each new one is evicted by its own push, before turn.complete computes the split. Their time then lands in "other". Repro: 296 old rows plus four 5 s text-less requests gives model 15 s, not 20 s. In steady state the loss is close to total.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [x] The running turn's model, hook and compaction time are counted even when the rows that carried them were evicted during that turn
- [x] A regression test: a log already at the cap of earlier-turn rows, then a turn of text-less requests; its stored split has the full model time
- [x] The header's two largest parts and the inspector's full split agree with that stored split
- [x] Turns stored before this change still draw
