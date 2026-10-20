#!/usr/bin/env bash
# Runs deploy-script.sh against PATH shims for git, composer, php, curl and gunzip that log their
# arguments to $T/calls, so the seed logic can be checked without a server.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

setup() { # [php-fail-on]
  T="$(mktemp -d)"
  mkdir -p "$T/bin" "$T/site"
  for tool in git composer php curl gunzip; do
    cat > "$T/bin/$tool" <<SHIM
#!/usr/bin/env bash
echo "$tool \$*" >> "$T/calls"
if [ "$tool" = php ] && [ -n "\${PHP_FAIL_ON:-}" ] && [[ " \$* " == *" \$PHP_FAIL_ON "* ]]; then exit 1; fi
exit 0
SHIM
    chmod +x "$T/bin/$tool"
  done
  export FORGE_SITE_PATH="$T/site" FORGE_SITE_BRANCH=feature FORGE_COMPOSER=composer FORGE_PHP=php
  export PREVIEW_ADMIN_EMAIL=p@x.no PREVIEW_ADMIN_PASSWORD=pw PREVIEW_LANGUAGE=nb-NO PRIMARY_SITE_URL=https://x
  unset PREVIEW_SNAPSHOT_URL PREVIEW_BUILD_COMMAND PHP_FAIL_ON
}

run_script() { CODE=0; PATH="$T/bin:$PATH" bash "$ROOT/deploy-script.sh" > "$T/out" 2>&1 || CODE=$?; }
calls() { cat "$T/calls" 2>/dev/null; }

test_first_run_restores_and_creates_admin() {
  setup; export PREVIEW_SNAPSHOT_URL=https://b/s.sql.gz
  run_script
  assert_eq 0 "$CODE" "exit code"
  local order; order="$(calls | grep -oE 'db/restore|users/create|craft up' | tr '\n' ' ')"
  assert_eq "db/restore users/create craft up " "$order" "call order"
  [ -f "$T/site/storage/.preview-seeded" ] || assert_eq marker missing "seed marker"
}

test_second_run_skips_seed() {
  setup; export PREVIEW_SNAPSHOT_URL=https://b/s.sql.gz
  mkdir -p "$T/site/storage" && touch "$T/site/storage/.preview-seeded"
  run_script
  assert_eq 0 "$CODE" "exit code"
  assert_eq "" "$(calls | grep -E 'db/restore|users/create' || true)" "no seed calls"
  assert_eq 1 "$(calls | grep -c 'craft up')" "craft up runs"
}

test_fresh_install_without_snapshot() {
  setup
  run_script
  assert_eq 0 "$CODE" "exit code"
  assert_eq 1 "$(calls | grep -c 'install/craft')" "install/craft runs"
  assert_eq "" "$(calls | grep -E 'users/create|db/restore' || true)" "no restore or admin create"
}

test_uses_fetch_and_reset() {
  setup
  run_script
  assert_eq 1 "$(calls | grep -c '^git fetch origin feature$')" "fetch"
  assert_eq 1 "$(calls | grep -c '^git reset --hard origin/feature$')" "reset"
  assert_eq "" "$(calls | grep 'git pull' || true)" "no pull"
}

test_failed_seed_leaves_no_marker() {
  setup; export PREVIEW_SNAPSHOT_URL=https://b/s.sql.gz PHP_FAIL_ON=db/restore
  run_script
  [ "$CODE" -ne 0 ] || assert_eq nonzero "$CODE" "exit code"
  [ ! -f "$T/site/storage/.preview-seeded" ] || assert_eq absent present "seed marker"
  assert_eq "" "$(calls | grep 'craft up' || true)" "no craft up after failed seed"
}

test_admin_fallback_to_set_password() {
  setup; export PREVIEW_SNAPSHOT_URL=https://b/s.sql.gz PHP_FAIL_ON=users/create
  run_script
  assert_eq 0 "$CODE" "exit code"
  assert_eq 1 "$(calls | grep -c 'users/set-password preview')" "set-password fallback"
}

run_tests
