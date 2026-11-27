# 03: Your time never makes a turn "unusual"

**What to build:** The band note "#N took Xs, K× the usual" leaves out time spent waiting on you, as the README already promises. Today the median rule compares the whole turn, your wait included, and the earlier turns' times also include their waits. Repro: you 30 s plus model 5 s, against earlier turns of 10–14 s, gives "#4 took 36.0s, 3× the usual".

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [x] The turn's time minus its "you" part is compared against the median of earlier turns' times minus their "you" parts (their stored splits); a turn with no stored split counts whole
- [x] The 10 s floor applies to the time without your part too
- [x] The repro is a test and passes; the existing unusual-turn tests still pass
