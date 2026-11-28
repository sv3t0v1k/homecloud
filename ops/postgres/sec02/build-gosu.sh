#!/usr/bin/env bash
# Воспроизводимая сборка квалифицированного gosu для Linux AMD64.
set -euo pipefail
umask 077

VERSION="v0.0.0-20261025094355-29b939aa5bd4"
MODULE="github.com/tianon/gosu"

EXPECTED="81b8e04f7ec075babb1bd154c4dbdb3b9e07c8a3eb21f3f7537c7d5bc88d351a"

export GOTOOLCHAIN=go1.27.4
export GOENV=off
export GOWORK=off
export GOFLAGS=
export GOEXPERIMENT=
export GOPROXY=https://proxy.golang.org
export GOSUMDB=sum.golang.org
export GOPRIVATE=
export GONOSUMDB=
export GONOPROXY=
export GOINSECURE=

test "$#" -eq 1

DEST="$1"

test ! -e "$DEST"
mkdir -m 700 "$DEST"

DEST="$(cd "$DEST" && pwd -P)"

export GOPATH="$DEST/gopath"
export GOCACHE="$DEST/cache"

unset GOBIN

export GOOS=linux
export GOARCH=amd64
export GOAMD64=v1
export CGO_ENABLED=0

echo "=== PINNED GO TOOLCHAIN ==="

test "$(go env GOVERSION)" = "go1.27.4"

go version

echo "=== VERIFY SOURCE MODULE ==="

go mod download -json "$MODULE@$VERSION" \
  > "$DEST/source-module.json"

python3 -B - "$DEST/source-module.json" <<'PY'
import json
import sys

with open(sys.argv[1]) as stream:
    module = json.load(stream)

expected = {
    "Path": "github.com/tianon/gosu",
    "Version": "v0.0.0-20261025094355-29b939aa5bd4",
    "Sum": "h1:1SHWv8GcArm5ipwzlVf6Xp4e9mAvzBVlfrkxJTCh4jc=",
    "GoModSum": "h1:qhSq4lQUHixsrEUdDELVut2bDulrl360vkDJwY9iaSM=",
}

for key, value in expected.items():
    if module.get(key) != value:
        sys.exit(f"FAIL: module identity mismatch: {key}")

print("GOSU_SOURCE_IDENTITY_PASS")
PY

if command -v sha256sum >/dev/null 2>&1; then
  digest() {
    sha256sum "$1" | awk '{print $1}'
  }
else
  digest() {
    shasum -a 256 "$1" | awk '{print $1}'
  }
fi

SOURCE_COMMIT="29b939aa5bd4dc588af765b8248f6e39150d2565"

go install -trimpath -buildvcs=false -ldflags '-d -w' \
  "$MODULE@$SOURCE_COMMIT"

HOST_OS="$(go env GOHOSTOS)"
HOST_ARCH="$(go env GOHOSTARCH)"

if [ "$HOST_OS/$HOST_ARCH" = "linux/amd64" ]; then
  BIN="$GOPATH/bin/gosu"
else
  BIN="$GOPATH/bin/linux_amd64/gosu"
fi

test -f "$BIN"

HASH="$(digest "$BIN")"

echo "Actual SHA256:   $HASH"
echo "Expected SHA256: $EXPECTED"

test "$HASH" = "$EXPECTED"

cp "$BIN" "$DEST/gosu"
chmod 0755 "$DEST/gosu"

printf '%s\n' "$HASH" > "$DEST/gosu.sha256"

go version -m "$DEST/gosu" > "$DEST/buildinfo.txt"

echo "GOSU_EXACT_BINARY_REPRODUCTION_PASS"
