#!/bin/sh
set -eu

[ "$#" -eq 2 ] || exit 2
tool=$1
target=$2

case "$tool" in
  trivy)
    image='ghcr.io/aquasecurity/trivy@sha256:8f6bb947dbc528902e11f2f5be52f7b519f6a39d5d148f41166f2040499768fb'
    binary='/usr/local/bin/trivy'
    ;;
  gitleaks)
    image='ghcr.io/gitleaks/gitleaks@sha256:b109bc5f8f76a38196a3e413704fc5b9e3c32360bce4e4b603bd6f45b3721dbb'
    binary='/usr/bin/gitleaks'
    ;;
  *)
    echo 'Unsupported scanner' >&2
    exit 2
    ;;
esac

[ -n "$target" ] && [ ! -e "$target" ] && [ ! -L "$target" ]
mkdir -p "$(dirname "$target")"

# Docker validates immutable manifest and layer digests.
docker pull --platform linux/amd64 "$image"
test "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image")" = linux/amd64

container=''
cleanup() {
  if [ -n "$container" ]; then
    docker rm -f "$container" >/dev/null 2>&1 || :
  fi
}
trap cleanup 0
trap 'exit 1' 1 2 3 15

# Never run the scanner image with access to repository, credentials or socket.
container=$(docker create --platform linux/amd64 --entrypoint /bin/true "$image")
[ -n "$container" ]
docker cp "$container:$binary" "$target"
test -f "$target" && test -x "$target"

# Reject an unexpected version before executing any security scan.
case "$tool" in
  trivy)
    version=$("$target" --version)
    test "$version" = 'Version: 0.76.2'
    ;;
  gitleaks)
    version=$("$target" version)
    case "$version" in
      8.30.1|v8.30.1) ;;
      *) echo 'Unexpected Gitleaks version' >&2; exit 1 ;;
    esac
    ;;
esac

echo "PASS: verified $tool OCI scanner"
