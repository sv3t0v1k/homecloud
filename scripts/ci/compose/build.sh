#!/usr/bin/env bash
# Воспроизводимая сборка Docker Compose SEC-02.
set -euo pipefail
umask 077

test "$#" -eq 1

HERE="$(cd "$(dirname "$0")" && pwd -P)"
DEST="$1"

test ! -e "$DEST"
test ! -L "$DEST"

mkdir -m 700 "$DEST"

DEST="$(cd "$DEST" && pwd -P)"

export GOTOOLCHAIN=go1.27.4
export GOENV=off
export GOWORK=off
export GOFLAGS=
export GOEXPERIMENT=
export GO111MODULE=on

export GOPROXY=https://proxy.golang.org
export GOSUMDB=sum.golang.org
export GOPRIVATE=
export GONOSUMDB=
export GONOPROXY=
export GOINSECURE=

export GOPATH="$DEST/gopath"
export GOCACHE="$DEST/cache"

unset GOBIN

export CGO_ENABLED=0
export GOOS=linux
export GOARCH=amd64
export GOAMD64=v1

cd "$DEST"

lock_value() {
  python3 -B -c '
import json
import sys
with open(sys.argv[1]) as stream:
    print(json.load(stream)[sys.argv[2]])
' "$HERE/source.lock.json" "$1"
}

digest() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

ACTUAL_GO="$(go env GOVERSION)"
EXPECTED_GO="go$(lock_value go_version)"

if [ "$ACTUAL_GO" != "$EXPECTED_GO" ]; then
  echo "FAIL: Go version $ACTUAL_GO, expected $EXPECTED_GO" >&2
  exit 1
fi

echo "Go toolchain verified: $ACTUAL_GO"

test "$(digest "$HERE/go.mod")" = \
  "$(lock_value go_mod_sha256)"

test "$(digest "$HERE/go.sum")" = \
  "$(lock_value go_sum_sha256)"

MODULE="$(lock_value Path)"
VERSION="$(lock_value Version)"

go mod download -json "$MODULE@$VERSION" \
  > "$DEST/source-module.json"

SOURCE="$(python3 -B - \
  "$HERE/source.lock.json" \
  "$DEST/source-module.json" <<'PY'
import json
import sys

with open(sys.argv[1]) as stream:
    lock = json.load(stream)

with open(sys.argv[2]) as stream:
    source = json.load(stream)

for key in ("Path", "Version", "Sum", "GoModSum"):
    if source.get(key) != lock[key]:
        sys.exit("FAIL: source identity mismatch: " + key)

origin = source.get("Origin") or {}

if origin.get("Hash") and origin["Hash"] != lock["commit"]:
    sys.exit("FAIL: source commit mismatch")

print(source["Dir"])
PY
)"

mkdir "$DEST/source"

cp -R "$SOURCE/." "$DEST/source/"

chmod -R u+rwX "$DEST/source"

cp "$HERE/go.mod" "$DEST/source/go.mod"
cp "$HERE/go.sum" "$DEST/source/go.sum"

cd "$DEST/source"

go build \
  -p=2 \
  -mod=readonly \
  -tags e2e \
  -trimpath \
  -buildvcs=false \
  -ldflags '-w -X github.com/docker/compose/v5/internal.Version=v5.8.1' \
  -o "$DEST/docker-compose" \
  ./cmd

test "$(digest go.mod)" = "$(lock_value go_mod_sha256)"
test "$(digest go.sum)" = "$(lock_value go_sum_sha256)"

go mod verify

ACTUAL="$(digest "$DEST/docker-compose")"
EXPECTED="$(lock_value binary_sha256)"

echo "Actual SHA256:   $ACTUAL"
echo "Expected SHA256: $EXPECTED"

test "$ACTUAL" = "$EXPECTED"

go version -m "$DEST/docker-compose" \
  > "$DEST/buildinfo.txt"

printf '%s\n' "$ACTUAL" > "$DEST/binary.sha256"

echo "COMPOSE_EXACT_REPRODUCTION_PASS"
