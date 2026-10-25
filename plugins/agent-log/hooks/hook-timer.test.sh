#!/usr/bin/env bash
# hook-timer.test.sh [ref]: runs bin/hook-timer (or $NEW) and its version at <ref> on the same fake hooks and payloads,
# stdin through a pipe as the engine sends it. A case passes when both hand the hook the same stdin and the caller the
# same stdout, stderr and exit code, append the same records (t0/t1 aside) and leave no temp file behind. The default
# ref is the last commit before the fork-lean rewrite: the contract is "what that version did", so a no-arg run still
# checks it once the rewrite is on main. Records are compared without `agent`, which that version did not write; `own` cases
# check what only this version does. `claude plugin test` runs only *.test.ts, so this one runs by hand.
here=$(cd "$(dirname "$0")/.." && pwd)
ref=${1:-6266290}
tmp=$(mktemp -d) || exit 1
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/old" "$tmp/new" "$tmp/p" "$tmp/o" "$tmp/h" "$tmp/runs"
git -C "$here" show "$ref:plugins/agent-log/bin/hook-timer" >"$tmp/old/hook-timer" || { echo "FAIL no bin/hook-timer at $ref"; exit 1; }
cp "${NEW:-$here/bin/hook-timer}" "$tmp/new/hook-timer" || exit 1
chmod +x "$tmp/old/hook-timer" "$tmp/new/hook-timer"
cmp -s "$tmp/old/hook-timer" "$tmp/new/hook-timer" && { echo "INCONCLUSIVE bin/hook-timer is $ref's own: name an older ref"; exit 2; }
command -v jq >/dev/null || { echo "FAIL jq is missing, so neither side would write a record"; exit 1; }
p=$tmp/p o=$tmp/o h=$tmp/h

cat >"$h/guard.sh" <<'EOF'
#!/usr/bin/env bash
cat >"$HT_IN"
[[ -n ${HT_OUT-} ]] && cat "$HT_OUT"
[[ -n ${HT_ERR-} ]] && cat "$HT_ERR" >&2
[[ -n ${HT_SLEEP-} ]] && sleep "$HT_SLEEP"
[[ ${HT_EXIT-} == KILL ]] && kill -KILL $$
exit "${HT_EXIT:-0}"
EOF
chmod +x "$h/guard.sh"
cp "$h/guard.sh" "$h/plainhook"
cp "$h/guard.sh" "$h/notify.py"

ev() { printf '{"session_id":"%s","hook_event_name":"%s","tool_name":"Bash","tool_use_id":"toolu_1","tool_input":{"command":"ls"}}' "$1" "$2"; }
# pad <bytes> [tail]: a PreToolUse payload padded with spaces to exactly <bytes>, then <tail>
pad() { local head='{"session_id":"s-1","hook_event_name":"PreToolUse","tool_use_id":"toolu_1","tool_input":{"command":"'; printf '%s%*s"}}%s' "$head" $(($1 - ${#head} - 3)) '' "${2-}"; }
ev s-1 PreToolUse >"$p/pre"
{ ev s-1 PreToolUse; printf '\n\n\n'; } >"$p/pre-nl"
{ ev s-1 PreToolUse; printf '\r\n'; } >"$p/pre-crlf"
ev s-1 PostToolUse >"$p/post"
printf '{"session_id":"s-1","hook_event_name":"SessionStart","source":"startup"}' >"$p/start"
printf '{"session_id":"s-1","hook_event_name":"UserPromptSubmit","prompt":"hi"}\n' >"$p/prompt"
printf '{"session_id":"s-1","hook_event_name":"Stop"}' >"$p/stop"
printf '{"hook_event_name":"PreToolUse"}' >"$p/no-sid"
ev ../x PreToolUse >"$p/bad-sid"
ev 'a b' PreToolUse >"$p/space-sid"
ev '' PreToolUse >"$p/empty-sid"
: >"$p/empty"
printf '\n\n\n' >"$p/newlines"
printf '%s' $' \t{"session_id":"s-1",\n\n "hook_event_name":"PreToolUse",\t"tool_use_id":"toolu_1",\n"tool_input":{"command":"echo \\\\ \\" \\\\n é 日本 🎉"}}' >"$p/json-ws"
printf '%s' $'  \\\n\tback\\\\slash \\t not json \n\n\n' >"$p/raw"
pad 2047 $'\n\n\n' >"$p/edge-2047"
pad 2048 $'\n\n' >"$p/edge-2048"
pad 2049 >"$p/edge-2049"
x='{"session_id":"s-1","hook_event_name":"PreToolUse","x":"'
printf '%s%*s"\n}}' "$x" $((2046 - ${#x})) '' >"$p/edge-newline-at-2048"
printf '%s%*sé"}}' "$x" $((2047 - ${#x})) '' >"$p/edge-utf8-at-2048"
{ printf '{"session_id":"s-1","hook_event_name":"PostToolUse","tool_use_id":"toolu_1","tool_response":{"stdout":"'; head -c 200000 /dev/zero | tr '\0' a; printf '\\n日本"}}\n'; } >"$p/big"

printf 'a\n\n b\n\n\n' >"$o/trailing"
printf 'abc' >"$o/no-nl"
for i in $(seq 3000); do printf 'line %s of plain output\n' "$i"; done >"$o/big"
{ printf '{"hookSpecificOutput":{"additionalContext":"ctx"},"pad":"'; head -c 100000 /dev/zero | tr '\0' p; printf '"}'; } >"$o/big-json"
printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"  \\n\\n  first line of context\\nsecond"}}' >"$o/ctx"
printf '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"denied: because"}}\n' >"$o/deny"
printf '{"systemMessage":"note to user"}' >"$o/sysmsg"
printf '{"decision":"block","reason":"blocked because"}' >"$o/block"
printf '{"continue":false,"stopReason":"stop now"}' >"$o/stop"
printf '{"hookSpecificOutput":{"additionalContext":"   "},"systemMessage":"fallback"}' >"$o/blank-ctx"
{ printf '{"hookSpecificOutput":{"additionalContext":"'; for i in $(seq 40); do printf 'é日🎉'; done; printf '"}}'; } >"$o/long-ctx"
printf '[1,2]\n' >"$o/array"
printf '\n\n  hello from start\nsecond\n' >"$o/plain"
printf 'warning text\n' >"$o/warn"
printf '\n \n  blocked: reason\nmore\n' >"$o/reason"
{ for i in $(seq 40); do printf 'é日🎉'; done; printf '\n'; head -c 10000 /dev/zero | tr '\0' e; } >"$o/long-reason"
{ head -c 5000 /dev/zero | tr '\0' '\n'; printf 'late reason\n'; } >"$o/late-reason"

pass=0 fails=0 pre=() xdg='' runs=1
report() {
  local name=$1; shift
  if (($#)); then printf 'FAIL %s:' "$name"; printf ' [%s]' "$@"; echo; ((fails++)); else echo "PASS $name"; ((pass++)); fi
}
recs() { cat "$1"/home/.claude/hook-times/*.jsonl 2>/dev/null | sed -E 's/"agent":[^,]*,//; s/"t0":[0-9]+,"t1":[0-9]+,/"t0":T,"t1":T,/'; }
files() { (cd "$1/home" && find . -type f | sort); }
# bash's own diagnostics name the script and line (and a killed job's pid); the line moves whenever the code does
norm() { sed -E "s#^$tmp/(old|new)/hook-timer: line [0-9]+: ([0-9]+ +)?#hook-timer: line N: #" "$1"; }
clean() { # clean <run dir> <label>: no temp file left, every record's t0/t1 a sane pair
  [[ -z $(find "$1/xdg" "$1/tmp" -mindepth 1 2>/dev/null) ]] || why+=("temp file left by $2")
  cat "$1"/home/.claude/hook-times/*.jsonl 2>/dev/null |
    jq -se 'all(.[]; (.t0 | type) == "number" and (.t1 | type) == "number" and .t1 >= .t0)' >/dev/null || why+=("t0/t1 of $2")
}

# rundir <d>: a run's fresh HOME, XDG_RUNTIME_DIR (0700, as a real one is) and TMPDIR
rundir() { mkdir -p "$1/home" "$1/xdg" "$1/tmp"; chmod 700 "$1/xdg"; }

# check <name> <records> <payload> [VAR=value...] -- <command...>: both sides run the case with fresh HOME and temp dirs;
# globals pre (a command in front of hook-timer), xdg (unset, or a value for XDG_RUNTIME_DIR) and runs (0: no hook runs)
check() {
  local name=$1 want=$2 payload=$3 envs=() s d x why=(); shift 3
  while (($#)) && [[ $1 != -- ]]; do envs+=("$1"); shift; done; shift
  for s in old new; do
    d=$tmp/runs/$name.$s; rundir "$d"
    x=(XDG_RUNTIME_DIR="$d/xdg")
    case $xdg in unset) x=(-u XDG_RUNTIME_DIR) ;; ?*) x=(XDG_RUNTIME_DIR="$xdg") ;; esac
    cat "$payload" | env "${x[@]}" HOME="$d/home" TMPDIR="$d/tmp" HT_IN="$d/in" "${envs[@]}" "${pre[@]}" "$tmp/$s/hook-timer" "$@" >"$d/out" 2>"$d/err"
    echo $? >"$d/rc"
  done
  local o=$tmp/runs/$name.old n=$tmp/runs/$name.new
  if [[ -e $o/in || -e $n/in ]]; then cmp -s "$o/in" "$n/in" || why+=("hook stdin"); fi
  [[ -e $o/in || $runs == 0 ]] || why+=("hook never ran under $ref's")
  cmp -s "$o/out" "$n/out" || why+=(stdout)
  cmp -s <(norm "$o/err") <(norm "$n/err") || why+=(stderr)
  cmp -s "$o/rc" "$n/rc" || why+=("exit $(<"$o/rc") vs $(<"$n/rc")")
  cmp -s <(recs "$o") <(recs "$n") || why+=(record)
  [[ $(recs "$o" | wc -l) -eq $want ]] || why+=("$ref's wrote $(recs "$o" | wc -l) records, want $want")
  [[ $(files "$o") == "$(files "$n")" ]] || why+=("files under HOME")
  clean "$o" old; clean "$n" new
  report "$name" "${why[@]}"
}

# own <name> <payload> <jq test> -- <command...>: this version alone; its one record must pass the jq test
own() {
  local name=$1 payload=$2 want=$3 d=$tmp/runs/$1.own why=(); shift 4
  rundir "$d"
  env XDG_RUNTIME_DIR="$d/xdg" HOME="$d/home" HT_IN="$d/in" "$tmp/new/hook-timer" "$@" <"$payload" >/dev/null 2>&1
  [[ $(cat "$d"/home/.claude/hook-times/*.jsonl 2>/dev/null | jq -s "length == 1 and (.[0] | $want)") == true ]] ||
    why+=("record $(cat "$d"/home/.claude/hook-times/*.jsonl 2>/dev/null)")
  report "$name" "${why[@]}"
}

# 16 overlapping runs per side into one HOME and one temp dir: no run may get another's stdin, stdout, stderr or record
crowd() {
  local s i d f why=() o=$tmp/runs/crowd.old n=$tmp/runs/crowd.new
  for i in $(seq 16); do printf 'out %s\n' "$i" >"$o.out.$i"; printf 'blocked by run %s\n' "$i" >"$o.err.$i"; done
  for s in old new; do
    d=$tmp/runs/crowd.$s; rundir "$d"
    for i in $(seq 16); do
      { ev s-1 PreToolUse | env XDG_RUNTIME_DIR="$d/xdg" HOME="$d/home" TMPDIR="$d/tmp" HT_IN="$d/in.$i" HT_OUT="$o.out.$i" \
          HT_ERR="$o.err.$i" HT_EXIT=2 HT_SLEEP=0.3 "$tmp/$s/hook-timer" "$h/guard.sh" >"$d/out.$i" 2>"$d/err.$i"; echo $? >"$d/rc.$i"; } &
    done
    wait
  done
  for i in $(seq 16); do
    for f in in out err rc; do cmp -s "$o/$f.$i" "$n/$f.$i" || why+=("run $i $f"); done
    cmp -s "$o/err.$i" "$o.err.$i" || why+=("run $i stderr under $ref's")
  done
  cmp -s <(recs "$o" | sort) <(recs "$n" | sort) || why+=(records)
  [[ $(recs "$o" | sort -u | wc -l) -eq 16 ]] || why+=("$ref's wrote $(recs "$o" | sort -u | wc -l) distinct records, want 16")
  clean "$o" old; clean "$n" new
  report concurrent-runs "${why[@]}"
}

check stdin-json 1 "$p/pre" -- "$h/guard.sh"
check stdin-trailing-newlines 1 "$p/pre-nl" -- "$h/guard.sh"
check stdin-crlf 1 "$p/pre-crlf" -- "$h/guard.sh"
check stdin-whitespace-escapes-utf8 1 "$p/json-ws" -- "$h/guard.sh"
check stdin-raw-backslashes 0 "$p/raw" -- "$h/guard.sh"
check stdin-empty 0 "$p/empty" -- "$h/guard.sh"
check stdin-only-newlines 0 "$p/newlines" -- "$h/guard.sh"
check stdin-2047-then-newlines 1 "$p/edge-2047" -- "$h/guard.sh"
check stdin-2048-then-newlines 1 "$p/edge-2048" -- "$h/guard.sh"
check stdin-2049 1 "$p/edge-2049" -- "$h/guard.sh"
check stdin-newline-at-2048 1 "$p/edge-newline-at-2048" -- "$h/guard.sh"
check stdin-utf8-across-2048 1 "$p/edge-utf8-at-2048" -- "$h/guard.sh"
check stdin-200k 1 "$p/big" -- "$h/guard.sh"
check stdout-trailing-newlines 1 "$p/pre" HT_OUT="$o/trailing" -- "$h/guard.sh"
check stdout-no-final-newline 1 "$p/pre" HT_OUT="$o/no-nl" -- "$h/guard.sh"
check stdout-70k-plain 1 "$p/pre" HT_OUT="$o/big" -- "$h/guard.sh"
check stdout-100k-json 1 "$p/pre" HT_OUT="$o/big-json" -- "$h/guard.sh"
check stderr-exit-0 1 "$p/pre" HT_ERR="$o/warn" -- "$h/guard.sh"
check stderr-exit-2 1 "$p/pre" HT_ERR="$o/reason" HT_EXIT=2 -- "$h/guard.sh"
check stderr-exit-2-long-line 1 "$p/pre" HT_ERR="$o/long-reason" HT_EXIT=2 -- "$h/guard.sh"
check stderr-exit-2-past-4k 1 "$p/pre" HT_ERR="$o/late-reason" HT_EXIT=2 -- "$h/guard.sh"
check exit-2-silent 1 "$p/pre" HT_EXIT=2 -- "$h/guard.sh"
check stdout-stderr-exit-1 1 "$p/pre" HT_OUT="$o/trailing" HT_ERR="$o/warn" HT_EXIT=1 -- "$h/guard.sh"
check exit-3 1 "$p/pre" HT_EXIT=3 -- "$h/guard.sh"
check exit-255 1 "$p/pre" HT_EXIT=255 -- "$h/guard.sh"
check killed 1 "$p/pre" HT_ERR="$o/warn" HT_EXIT=KILL -- "$h/guard.sh"
runs=0; check missing-command 1 "$p/pre" -- "$h/missing.sh"; runs=1
check say-additional-context 1 "$p/pre" HT_OUT="$o/ctx" -- "$h/guard.sh"
check say-permission-reason 1 "$p/pre" HT_OUT="$o/deny" -- "$h/guard.sh"
check say-system-message 1 "$p/post" HT_OUT="$o/sysmsg" -- "$h/guard.sh"
check say-block-reason 1 "$p/post" HT_OUT="$o/block" -- "$h/guard.sh"
check say-stop-reason 1 "$p/stop" HT_OUT="$o/stop" -- "$h/guard.sh"
check say-skips-blank-context 1 "$p/pre" HT_OUT="$o/blank-ctx" -- "$h/guard.sh"
check say-cut-to-80-utf8 1 "$p/pre" HT_OUT="$o/long-ctx" -- "$h/guard.sh"
check say-plain-session-start 1 "$p/start" HT_OUT="$o/plain" -- "$h/guard.sh"
check say-array-session-start 1 "$p/start" HT_OUT="$o/array" -- "$h/guard.sh"
check say-plain-prompt-submit 1 "$p/prompt" HT_OUT="$o/plain" -- "$h/guard.sh"
check say-plain-elsewhere-null 1 "$p/post" HT_OUT="$o/plain" -- "$h/guard.sh"
check name-no-extension 1 "$p/pre" -- "$h/plainhook"
check name-through-interpreter 1 "$p/pre" -- bash "$h/notify.py" --flag
check no-session-id 0 "$p/no-sid" -- "$h/guard.sh"
check session-id-path 0 "$p/bad-sid" -- "$h/guard.sh"
check session-id-space 0 "$p/space-sid" -- "$h/guard.sh"
check session-id-empty 0 "$p/empty-sid" -- "$h/guard.sh"
xdg='unset'; check xdg-unset 1 "$p/pre" HT_ERR="$o/reason" HT_EXIT=2 -- "$h/guard.sh"
xdg=$tmp/nonexistent; check xdg-missing 1 "$p/pre" HT_ERR="$o/reason" HT_EXIT=2 -- "$h/guard.sh"
xdg=/; check xdg-not-ours 1 "$p/pre" HT_ERR="$o/reason" HT_EXIT=2 -- "$h/guard.sh"
mkdir -m 500 "$tmp/read-only"
xdg=$tmp/read-only; check xdg-ours-read-only 1 "$p/pre" HT_ERR="$o/reason" HT_EXIT=2 -- "$h/guard.sh"
check xdg-ours-read-only-posix-mode 1 "$p/pre" POSIXLY_CORRECT=1 HT_ERR="$o/reason" HT_EXIT=2 -- "$h/guard.sh"
xdg=
# bash 3.2 (macOS /bin/bash) has no EPOCHREALTIME; unset, bash 5 drops it the same way
# shellcheck disable=SC2016  # expands in that bash -c, not here
pre=(bash -c 'unset EPOCHREALTIME; . "$0" "$@"')
check no-clock-stderr-exit-2 0 "$p/pre" HT_ERR="$o/reason" HT_EXIT=2 -- "$h/guard.sh"
check no-clock-stdout-200k-stdin 0 "$p/big" HT_OUT="$o/trailing" -- "$h/guard.sh"
pre=()
crowd
printf '{"session_id":"s-1","hook_event_name":"SubagentStop","agent_id":"agent-1","agent_type":"Explore"}' >"$p/substop"
: >"$h/.vars.sh"
own agent-of-subagent "$p/substop" '.agent == "agent-1"' -- "$h/guard.sh"
own agent-null-in-main "$p/pre" '.agent == null' -- "$h/guard.sh"
own name-skips-dotfile "$p/pre" '.name == "guard"' -- bash -c ". $h/.vars.sh && $h/guard.sh"

# prune <name> <gone|kept> [seed]: this version alone. A session's first run deletes the files untouched for 14 days, in the
# background; a run whose session file is there already (seed) starts none
prune() {
  local name=$1 want=$2 d=$tmp/runs/$1.prune t i why=()
  rundir "$d"; t=$d/home/.claude/hook-times; mkdir -p "$t"
  : >"$t/fresh.jsonl"; touch -d '15 days ago' "$t/stale.jsonl"
  [[ -n ${3-} ]] && echo '{}' >"$t/s-1.jsonl"
  env XDG_RUNTIME_DIR="$d/xdg" HOME="$d/home" HT_IN="$d/in" "$tmp/new/hook-timer" "$h/guard.sh" <"$p/pre" >/dev/null 2>&1
  for i in $(seq 20); do [[ -e $t/stale.jsonl ]] || break; sleep 0.1; done
  [[ $([[ -e $t/stale.jsonl ]] && echo kept || echo gone) == "$want" ]] || why+=("stale file not $want")
  [[ -e $t/fresh.jsonl ]] || why+=("fresh file deleted")
  grep -q '"name":"guard"' "$t/s-1.jsonl" || why+=("no record")
  report "$name" "${why[@]}"
}
prune prune-on-first-run gone
prune no-prune-on-later-runs kept seed

echo "$pass passed, $fails failed"
((fails == 0))
