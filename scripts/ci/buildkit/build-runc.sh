#!/usr/bin/env bash
# Воспроизводимая сборка runc SEC-02.
set -euo pipefail
umask 077

test "$#" -eq 1

HERE="$(cd "$(dirname "$0")" && pwd -P)"
RECIPE="$HERE/runc"

DEST="$1"

test ! -e "$DEST"
test ! -L "$DEST"

mkdir -m 700 "$DEST"
DEST="$(cd "$DEST" && pwd -P)"

export GOTOOLCHAIN=go1.27.4
export GOENV=off
export GOWORK=off
export GOFLAGS=
export GOPROXY=https://proxy.golang.org
export GOSUMDB=sum.golang.org
export GOPRIVATE=
export GONOPROXY=
export GONOSUMDB=
export GOINSECURE=

lock_value() {
  python3 -B - "$RECIPE/source.lock.json" "$1" <<'PY'
import json
import sys

with open(sys.argv[1]) as stream:
    print(json.load(stream)[sys.argv[2]])
PY
}

digest() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

test "$(go env GOVERSION)" = "$(lock_value go_version)"

test "$(digest "$RECIPE/go.mod")" = \
  "$(lock_value go_mod_sha256)"

test "$(digest "$RECIPE/go.sum")" = \
  "$(lock_value go_sum_sha256)"

cd "$DEST"

go mod download -json \
  "$(lock_value Path)@$(lock_value Version)" \
  > "$DEST/source-module.json"

SOURCE="$(python3 -B - \
  "$RECIPE/source.lock.json" \
  "$DEST/source-module.json" <<'PY'
import json
import sys

with open(sys.argv[1]) as stream:
    lock = json.load(stream)

with open(sys.argv[2]) as stream:
    source = json.load(stream)

for key in ("Path", "Version", "Sum", "GoModSum"):
    if source.get(key) != lock[key]:
        sys.exit("FAIL: source identity: " + key)

origin = source.get("Origin") or {}

if origin.get("Hash") and origin["Hash"] != lock["commit"]:
    sys.exit("FAIL: source commit mismatch")

print(source["Dir"])
PY
)"

mkdir "$DEST/source"

cp -R "$SOURCE/." "$DEST/source/"
chmod -R u+rwX "$DEST/source"

cp "$RECIPE/go.mod" "$DEST/source/go.mod"
cp "$RECIPE/go.sum" "$DEST/source/go.sum"

docker build \
  --platform linux/amd64 \
  --pull=false \
  --progress plain \
  --target export \
  --output "type=local,dest=$DEST/output" \
  -f "$RECIPE/Dockerfile" \
  "$DEST/source"

echo "=== VERIFY BUILDER PACKAGE INVENTORY ==="

python3 -B - \
  "$RECIPE/builder-packages.txt" \
  "$DEST/output/builder-packages.txt" <<'PY'
import sys
from pathlib import Path

def packages(path):
    result = set()

    for line in Path(path).read_text().splitlines():
        if line.rstrip().endswith("[installed]"):
            result.add(line.split()[0])

    if not result:
        sys.exit("FAIL: empty package inventory")

    return result

expected = packages(sys.argv[1])
actual = packages(sys.argv[2])

if expected != actual:
    print("Missing:", sorted(expected - actual))
    print("Unexpected:", sorted(actual - expected))
    sys.exit("FAIL: builder package inventory mismatch")

print("RUNC_BUILDER_PACKAGE_INVENTORY_PASS")
PY

test "$(digest "$DEST/source/go.mod")" = \
  "$(lock_value go_mod_sha256)"

test "$(digest "$DEST/source/go.sum")" = \
  "$(lock_value go_sum_sha256)"

grep -Fx \
  "$(lock_value go_mod_sha256)  go.mod" \
  "$DEST/output/dependencies.sha256"

grep -Fx \
  "$(lock_value go_sum_sha256)  go.sum" \
  "$DEST/output/dependencies.sha256"

cat "$DEST/output/runc-version.txt"
cat "$DEST/output/runc-elf.txt"

grep -Fx 'runc version 1.5.2' \
  "$DEST/output/runc-version.txt"

grep -Fx 'libseccomp: 2.6.1' \
  "$DEST/output/runc-version.txt"

if grep -q 'INTERP' "$DEST/output/runc-program-headers.txt"; then
  echo "FAIL: unexpected dynamic interpreter" >&2
  exit 1
fi

echo "RUNC_STATIC_ELF_PASS"

ACTUAL="$(digest "$DEST/output/buildkit-runc")"
EXPECTED="$(lock_value binary_sha256)"

echo "Actual SHA256:   $ACTUAL"
echo "Expected SHA256: $EXPECTED"

if [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "FAIL: runc binary identity" >&2
  exit 1
fi

echo "RUNC_EXACT_REPRODUCTION_PASS"
