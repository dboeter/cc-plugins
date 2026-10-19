#!/usr/bin/env bash
# sync.sh [--check]: copies each file in plugins/shared/ into the plugins that use it. A plugin loads no file outside its own
# folder (`claude plugin test` refuses the import), so each keeps a copy; this file is the one place to edit.
# --check: change nothing, exit 1 when a copy differs from its source.
set -euo pipefail
cd "$(dirname "$0")"
# source -> the plugins whose hooks/ hold a copy of it
declare -A USERS=([scrub.ts]="agent-log event-log")
rc=0
for src in "${!USERS[@]}"; do
  want=$(printf '// Copied from plugins/shared/%s by plugins/shared/sync.sh: edit that file, then run the script.\n' "$src"; cat "$src")
  for p in ${USERS[$src]}; do
    dst=../$p/hooks/$src
    if [[ ${1:-} == --check ]]; then
      [[ -f $dst && "$(cat "$dst")" == "$want" ]] || { echo "out of date: plugins/$p/hooks/$src (run plugins/shared/sync.sh)"; rc=1; }
    else printf '%s\n' "$want" >"$dst"; fi
  done
done
exit $rc
