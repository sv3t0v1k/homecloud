#!/bin/sh
set -eu

[ "$#" -eq 2 ] || exit 2
tool=$1
target=$2

case "$tool" in
  trivy)
    image='ghcr.io/aquasecurity/trivy@sha256:8f6bb947dbc528902e11f2f5be52f7b519f6a39d5d148f41166f2040499768fb'
    binary='/usr/local/bin/trivy'
    expected_sha256=''
    ;;
  gitleaks)
    image='ghcr.io/sv3t0v1k/homecloud-sec02-gitleaks@sha256:e86133002f108ce5e58225e0bda5613b42fb58ad7e0f136161a8fa67e3ab6257'
    binary='/usr/bin/gitleaks'
    expected_sha256='b37d4b1499ebfa3281183e357c21dd8e1f678d9760ff1508a6cab9e1585668ea'
    ;;
  compose)
    image='ghcr.io/sv3t0v1k/homecloud-sec02-compose@sha256:90572c9597798a70d6d96ccdcebd68a90ed58050730d4f27d63379fb53a3ed28'
    binary='/docker-compose'
    expected_sha256='a9e710eba0ded73a609b47c9c9383711686778acf8aed71407850c14a627287d'
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
test -f "$target" && test ! -L "$target" && test -x "$target"

# Проверяем квалифицированный бинарник до его исполнения.
if [ -n "$expected_sha256" ]; then
  python3 - "$target" "$expected_sha256" <<'PYHASH'
import hashlib
import sys

digest = hashlib.sha256()
with open(sys.argv[1], "rb") as stream:
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        digest.update(chunk)

if digest.hexdigest() != sys.argv[2]:
    raise SystemExit("OCI tool binary SHA256 mismatch")
PYHASH
fi

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
  compose)
    version=$("$target" version --short)
    test "$version" = '5.8.1'
    ;;
esac

echo "PASS: verified $tool OCI scanner"
