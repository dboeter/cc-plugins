# 07: "Who decided" agrees with the wait in auto mode

**What to build:** In auto mode, a call whose decision waited for main's message to finish is no longer credited to the auto-mode classifier. Today the wait is named "the model to finish its message" while the same call's decided-by reads "the auto-mode classifier decided", from a config decision that merely waited. A classifier refusal (named in the error result) still reads as the classifier's.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [x] The decided-by and the wait use one reading of the same evidence: a wait explained by the message ending is not the classifier's
- [x] If the engine can show whether a classifier request ran (a side request in the collector's records), that decides it; else the inspector says the decider is unknown rather than guessing
- [x] Tests: auto mode with a config decision during streaming; auto mode with a classifier refusal
