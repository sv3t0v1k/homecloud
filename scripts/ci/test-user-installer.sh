#!/usr/bin/env bash
# Единый обязательный регрессионный набор пользовательского установщика.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
cd "$ROOT"

export HOMECLOUD_TEST_ROOT="$ROOT"
export HOMECLOUD_TEST_PROD="$ROOT/docker-compose.production.yml"

OPENSSL_BIN=""

for candidate in \
  /opt/homebrew/opt/openssl@3/bin/openssl \
  /opt/homebrew/bin/openssl \
  /usr/local/opt/openssl@3/bin/openssl \
  "$(command -v openssl)"
do
  if [ -x "$candidate" ]; then
    case "$("$candidate" version)" in
      "OpenSSL 3."*)
        OPENSSL_BIN="$candidate"
        break
        ;;
    esac
  fi
done

test -n "$OPENSSL_BIN"

export HOMECLOUD_OPENSSL="$OPENSSL_BIN"
export PATH="$(dirname "$OPENSSL_BIN"):$PATH"

openssl version

TOTAL=0

run_tests() {
  local output count

  if ! output=$(python3 -B "$1" 2>&1); then
    printf '%s\n' "$output"
    return 1
  fi

  if printf '%s\n' "$output" | grep -Eiq 'skipped[= ]|^Ran 0 tests'; then
    printf '%s\n' "$output"
    return 1
  fi

  if ! printf '%s\n' "$output" | grep -qx 'OK'; then
    printf '%s\n' "$output"
    return 1
  fi

  count=$(printf '%s\n' "$output" | awk '/^Ran [0-9]+ tests? / {print $2}')

  case "$count" in
    ''|*[!0-9]*) return 1 ;;
  esac

  test "$count" -gt 0

  TOTAL=$((TOTAL + count))

  printf 'PASS: %s — %s tests\n' "$1" "$count"
}

sh -n deploy/user/bootstrap.sh
sh -n deploy/user/install.sh

run_tests deploy/user/test_update_worker.py
run_tests deploy/user/test_bootstrap.py
run_tests deploy/user/test_generate.py
run_tests deploy/user/test_probe.py
run_tests deploy/linux/test_preflight.py
run_tests scripts/ci/test-release.py
run_tests scripts/ci/test-release-sign.py

printf 'USER_INSTALLER_REGRESSION_PASS: %s tests\n' "$TOTAL"
