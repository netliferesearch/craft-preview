#!/usr/bin/env bash
# Helpers for the shell tests in this repo. Source it, define test_* functions, call run_tests.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export GIT_AUTHOR_NAME=Tester GIT_AUTHOR_EMAIL=tester@example.test
export GIT_COMMITTER_NAME=Tester GIT_COMMITTER_EMAIL=tester@example.test
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
PASS=0; FAIL=0; CURRENT=""; T=""
REAL_GIT="$(command -v git)"

assert_eq() { # expected actual label
  if [ "$1" != "$2" ]; then
    echo "  FAIL [$CURRENT] $3: expected '$1' got '$2'"; FAIL=$((FAIL + 1)); return 1
  fi
}

# A bare origin at $T/origin.git and a clone at $T/work with main (a.txt) and develop pushed.
make_repo() {
  T="$(mktemp -d)"
  git init -q --bare "$T/origin.git" && git -C "$T/origin.git" symbolic-ref HEAD refs/heads/main
  git init -q -b main "$T/work"
  ( cd "$T/work" && echo one > a.txt && git add a.txt && git commit -q -m one \
    && git remote add origin "$T/origin.git" && git push -q -u origin main \
    && git branch develop && git push -q -u origin develop )
}

commit_on() { # branch file content message  (in $T/work, pushed)
  ( cd "$T/work" && git checkout -q "$1" && echo "$3" > "$2" && git add "$2" \
    && git commit -q -m "$4" && git push -q origin "$1" )
}

origin_rev() { git -C "$T/origin.git" rev-parse --verify -q "$1" 2>/dev/null || echo none; }

run_in_work() { # script args...  → sets CODE, output in $T/out
  CODE=0
  ( cd "$T/work" && bash "$@" ) > "$T/out" 2>&1 || CODE=$?
}

run_tests() {
  for t in $(declare -F | awk '{print $3}' | grep '^test_'); do
    CURRENT="$t"; local before=$FAIL
    "$t"
    if [ "$before" -eq "$FAIL" ]; then PASS=$((PASS + 1)); echo "  ok   $t"; fi
  done
  echo "$PASS passed, $FAIL failed"
  [ "$FAIL" -eq 0 ]
}
