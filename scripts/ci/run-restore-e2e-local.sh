#!/usr/bin/env bash
# Rebuild the current sources into the existing isolated nested-Docker fixture.
set -euo pipefail
cd "$(dirname "$0")/../.."
PLATFORM="${1:-linux/arm64}"
ENCRYPTED=0
HISTORICAL_SCHEMA=0
FAULT_CASE=none
case "${2:-}" in
  "") ;;
  --encrypted-only) ENCRYPTED=1 ;;
  --historical-schema-only) HISTORICAL_SCHEMA=1 ;;
  --fault-case=*) FAULT_CASE="${2#--fault-case=}" ;;
  *) exit 2 ;;
esac
case "$FAULT_CASE" in none|partial-stop|staged|db-restored|reconciled|ready-before-clear|ready-after-clear|foreign-writer) ;; *) exit 2 ;; esac
test "$#" -le 2
# DinD/runc must run natively; an emulated daemon cannot qualify this E2E.
TOOL_PLATFORM="$PLATFORM"
STUB_IMAGE="${HOMECLOUD_E2E_STUB_IMAGE:-alpine:latest}"
EXPECTED_BACKEND_ID="${HOMECLOUD_E2E_BACKEND_IMAGE_ID:-}"

valid_image_id() {
  local value="$1"
  test "${#value}" -eq 71 || return 1
  case "$value" in sha256:*) ;; *) return 1 ;; esac
  case "${value#sha256:}" in
    *[!0123456789abcdef]*) return 1 ;;
  esac
}

if [ -n "$EXPECTED_BACKEND_ID" ]; then
  valid_image_id "$EXPECTED_BACKEND_ID" || exit 1
  test -n "${HOMECLOUD_E2E_BACKEND_IMAGE:-}" || exit 1
fi
case "$PLATFORM" in linux/arm64|linux/amd64) ;; *) exit 1 ;; esac

# No host socket/data/source bind mounts are passed into the test container.
docker info >/dev/null
engine_platform="$(docker info --format '{{.OSType}}/{{.Architecture}}')"
case "$engine_platform" in linux/aarch64) engine_platform=linux/arm64 ;; linux/x86_64) engine_platform=linux/amd64 ;; esac
if [ "$engine_platform" != "$PLATFORM" ]; then
  echo "STOP: native Docker Engine $PLATFORM required; actual $engine_platform" >&2
  exit 1
fi
for image in postgres:16-alpine "$STUB_IMAGE"; do
  docker image inspect "$image" >/dev/null
  test "$(docker image inspect "$image" --format '{{.Os}}/{{.Architecture}}')" = "$PLATFORM"
done
# Docker save/load preserves RepoTags, not registry digest references. Pin the
# exact inspected config ID behind a fixture tag before crossing into DinD.
STUB_IMAGE_ID="$(docker image inspect "$STUB_IMAGE" --format '{{.Id}}')"
[[ "$STUB_IMAGE_ID" =~ ^sha256:[a-f0-9]{64}$ ]]
docker tag "$STUB_IMAGE_ID" homecloud-restore-e2e-stub:local
STUB_IMAGE=homecloud-restore-e2e-stub:local
test "$(docker image inspect "$STUB_IMAGE" --format '{{.Id}}')" = "$STUB_IMAGE_ID"
# Own the fixture base build so a preceding AMD qualification cannot leave a
# stale/emulated DinD base behind. This does not build another product image.
docker build --platform "$TOOL_PLATFORM" -t homecloud-restore-e2e-runner:local \
  - < scripts/ci/restore-e2e-runner.Dockerfile
test "$(docker image inspect homecloud-restore-e2e-runner:local --format '{{.Os}}/{{.Architecture}}')" = "$TOOL_PLATFORM"

if [ -n "${HOMECLOUD_E2E_BACKEND_IMAGE:-}" ]; then
  # CI tests the retained OCI candidate, never a second rebuild.
  candidate_id="$(docker image inspect "$HOMECLOUD_E2E_BACKEND_IMAGE" --format '{{.Id}}')"
  valid_image_id "$candidate_id" || exit 1

  if [ -n "$EXPECTED_BACKEND_ID" ]; then
    test "$candidate_id" = "$EXPECTED_BACKEND_ID" || exit 1
  fi

  docker tag "$candidate_id" homecloud-restore-e2e-backend:local
  test "$(docker image inspect homecloud-restore-e2e-backend:local --format '{{.Id}}')" = "$candidate_id" || exit 1
else
  docker build --pull=false --platform "$PLATFORM" \
    -t homecloud-restore-e2e-backend:local backend
  candidate_id="$(docker image inspect homecloud-restore-e2e-backend:local --format '{{.Id}}')"
  valid_image_id "$candidate_id" || exit 1
fi

# From this point forward, do not use a mutable backend tag.
BACKEND_IMAGE_ID="$candidate_id"
test "$(docker image inspect "$BACKEND_IMAGE_ID" --format '{{.Id}}')" = "$BACKEND_IMAGE_ID" || exit 1
test "$(docker image inspect "$BACKEND_IMAGE_ID" --format '{{.Os}}/{{.Architecture}}')" = "$PLATFORM" || exit 1

echo "PASS: outer backend image ID $BACKEND_IMAGE_ID"

docker run --rm --pull=never --platform "$PLATFORM" --network none --cap-drop ALL \
  --security-opt no-new-privileges --entrypoint node "$BACKEND_IMAGE_ID" \
  -e "$(cat scripts/ci/native-boundary-preflight.cjs)" -- --strict

# Allowlist source files: no Git metadata, env files, keys or user data.
# A Docker build context is a test artifact, never another Git checkout.
python3 -B scripts/ci/restore-e2e-context.py | docker build --pull=false --network none \
  --platform "$TOOL_PLATFORM" -t homecloud-restore-e2e-runtime:local -

# Check the actual image, unprivileged and without mounts, before nested dockerd.
docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges \
  -e "HOMECLOUD_E2E_PLATFORM=$PLATFORM" \
  --platform "$TOOL_PLATFORM" --entrypoint python3 homecloud-restore-e2e-runtime:local \
  -B /opt/homecloud/scripts/ci/restore-runtime-preflight.py

docker save "$BACKEND_IMAGE_ID" postgres:16-alpine "$STUB_IMAGE" \
  | docker run --rm -i --privileged --cgroupns=private --network none \
      --platform "$TOOL_PLATFORM" \
      -e "HOMECLOUD_E2E_STUB_IMAGE=$STUB_IMAGE" \
      -e "HOMECLOUD_E2E_STUB_IMAGE_ID=$STUB_IMAGE_ID" \
      -e "HOMECLOUD_E2E_BACKEND_IMAGE_ID=$BACKEND_IMAGE_ID" \
      -e "HOMECLOUD_E2E_ENCRYPTED=$ENCRYPTED" \
      -e "HOMECLOUD_E2E_HISTORICAL_SCHEMA=$HISTORICAL_SCHEMA" \
      -e "HOMECLOUD_E2E_FAULT_CASE=$FAULT_CASE" \
      -e "HOMECLOUD_E2E_PLATFORM=$PLATFORM" \
      --mount type=volume,dst=/var/lib/docker,volume-nocopy \
      --mount type=volume,dst=/tmp,volume-nocopy \
      homecloud-restore-e2e-runtime:local
