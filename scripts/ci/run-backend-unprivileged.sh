#!/usr/bin/env bash
# Запуск backend tests без root, sudo и доступа к Docker socket.
set -euo pipefail

test "${GITHUB_ACTIONS:-}" = true
test "${RUNNER_ENVIRONMENT:-}" = github-hosted
test "$(uname -s)" = Linux
test "$(uname -m)" = x86_64
test ! -e /.dockerenv
test "$(id -u)" -ne 0

backend="$GITHUB_WORKSPACE/backend"
test "$(pwd -P)" = "$backend"
test "$(realpath "$backend")" = "$backend"
test "$#" -gt 0

account=homecloud-ci-test
test "$(id -u "$account")" -ne 0
test "$(id -u "$account")" != "$(id -u)"

owner="$(id -u):$(id -g)"

if sudo -n -u "$account" sudo -n true >/dev/null 2>&1; then
  echo "STOP: privileged test account" >&2
  exit 1
fi

if sudo -n -u "$account" test -w /var/run/docker.sock; then
  echo "STOP: test account has Docker access" >&2
  exit 1
fi

restore_owner() {
  sudo -n chown -hR "$owner" "$backend"
}

trap restore_owner EXIT

sudo -n chown -hR "$account:$account" "$backend"

variables=(
  "PATH=$PATH"
  "CI=true"
  "GITHUB_ACTIONS=true"
  "NODE_INCLUDE_DIR=${NODE_INCLUDE_DIR:?}"
)

if [ "${HOMECLOUD_TEST_DATABASE_URL+x}" = x ]; then
  variables+=(
    "HOMECLOUD_TEST_DATABASE_URL=$HOMECLOUD_TEST_DATABASE_URL"
  )
fi

sudo -n -H -u "$account" -- env "${variables[@]}" "$@"
