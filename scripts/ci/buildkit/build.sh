#!/usr/bin/env bash
# Воспроизводимая сборка BuildKit и CNI SEC-02.
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
  python3 -B - "$HERE/source.lock.json" "$@" <<'PY'
import json
import sys

with open(sys.argv[1]) as stream:
    data = json.load(stream)

for key in sys.argv[2:]:
    data = data[key]

print(data)
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

echo "Go toolchain: $(go env GOVERSION)"

mkdir "$DEST/linux"

prepare_source() {
  local COMPONENT="$1"
  local MODULE VERSION SOURCE

  test "$(digest "$HERE/$COMPONENT/go.mod")" = \
    "$(lock_value sources "$COMPONENT" go_mod_sha256)"

  test "$(digest "$HERE/$COMPONENT/go.sum")" = \
    "$(lock_value sources "$COMPONENT" go_sum_sha256)"

  MODULE="$(lock_value sources "$COMPONENT" Path)"
  VERSION="$(lock_value sources "$COMPONENT" Version)"

  cd "$DEST"

  if ! go mod download -json "$MODULE@$VERSION" \
    > "$DEST/$COMPONENT-module.json"
  then
    echo "FAIL: source download: $COMPONENT" >&2
    return 1
  fi

  SOURCE="$(python3 -B - \
    "$HERE/source.lock.json" \
    "$DEST/$COMPONENT-module.json" \
    "$COMPONENT" <<'PY'
import json
import sys

with open(sys.argv[1]) as stream:
    lock = json.load(stream)["sources"][sys.argv[3]]

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

  mkdir "$DEST/$COMPONENT"

  cp -R "$SOURCE/." "$DEST/$COMPONENT/"
  chmod -R u+rwX "$DEST/$COMPONENT"

  cp "$HERE/$COMPONENT/go.mod" "$DEST/$COMPONENT/go.mod"
  cp "$HERE/$COMPONENT/go.sum" "$DEST/$COMPONENT/go.sum"

  echo "Source identity verified: $COMPONENT"
}

verify_manifests() {
  local COMPONENT="$1"

  test "$(digest "$DEST/$COMPONENT/go.mod")" = \
    "$(lock_value sources "$COMPONENT" go_mod_sha256)"

  test "$(digest "$DEST/$COMPONENT/go.sum")" = \
    "$(lock_value sources "$COMPONENT" go_sum_sha256)"
}

verify_binary() {
  local NAME="$1"
  local ACTUAL EXPECTED

  ACTUAL="$(digest "$DEST/linux/$NAME")"
  EXPECTED="$(lock_value binaries "$NAME")"

  echo "$NAME"
  echo "Actual:   $ACTUAL"
  echo "Expected: $EXPECTED"

  if [ "$ACTUAL" != "$EXPECTED" ]; then
    echo "FAIL: binary identity: $NAME" >&2
    return 1
  fi

  go version -m "$DEST/linux/$NAME" \
    > "$DEST/$NAME.buildinfo.txt"

  echo "Exact binary match: $NAME"
}

prepare_source buildkit
prepare_source cni

echo "=== BUILD BUILDKITD ==="

cd "$DEST/buildkit"

go build \
  -p=2 \
  -mod=readonly \
  -tags 'osusergo,netgo,static_build,seccomp,grpcnotrace' \
  -trimpath \
  -buildvcs=false \
  -ldflags '-X github.com/moby/buildkit/version.Version=v0.35.1 -X github.com/moby/buildkit/version.Revision=412cc86ad3c4252b82e929f9b1b1ad167376ded8 -X github.com/moby/buildkit/version.Package=github.com/moby/buildkit' \
  -o "$DEST/linux/buildkitd" \
  ./cmd/buildkitd

verify_manifests buildkit
verify_binary buildkitd

go mod verify

echo "=== BUILD CNI PLUGINS ==="

cd "$DEST/cni"

build_cni() {
  local NAME="$1"
  local TARGET="$2"

  go build \
    -p=2 \
    -mod=readonly \
    -trimpath \
    -buildvcs=false \
    -ldflags '-w -X github.com/containernetworking/plugins/pkg/utils/buildversion.BuildVersion=v1.9.1' \
    -o "$DEST/linux/buildkit-cni-$NAME" \
    "$TARGET"

  verify_binary "buildkit-cni-$NAME"
}

build_cni bridge ./plugins/main/bridge
build_cni firewall ./plugins/meta/firewall
build_cni host-local ./plugins/ipam/host-local
build_cni loopback ./plugins/main/loopback

verify_manifests cni

go mod verify

echo "BUILDKIT_CNI_EXACT_REPRODUCTION_PASS"
