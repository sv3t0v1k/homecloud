#!/usr/bin/env bash
set -euo pipefail
umask 077

cd /opt/homecloud

: "${HOMECLOUD_E2E_PLATFORM:?Launcher must supply native E2E platform}"
python3 -B scripts/ci/restore-runtime-preflight.py
case "${HOMECLOUD_E2E_ENCRYPTED:-0}" in
  0) ;;
  1) command -v age >/dev/null; command -v age-keygen >/dev/null ;;
  *) exit 2 ;;
esac
case "${HOMECLOUD_E2E_HISTORICAL_SCHEMA:-0}:${HOMECLOUD_E2E_ENCRYPTED:-0}" in
  0:0|0:1|1:0) ;;
  *) exit 2 ;;
esac
case "${HOMECLOUD_E2E_FAULT_CASE:-none}" in
  none) ;;
  partial-stop|staged|db-restored|reconciled|ready-before-clear|ready-after-clear|foreign-writer)
    test "${HOMECLOUD_E2E_HISTORICAL_SCHEMA:-0}:${HOMECLOUD_E2E_ENCRYPTED:-0}" = 0:0 ;;
  *) exit 2 ;;
esac

export DOCKER_HOST=unix:///var/run/docker.sock
unset DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH

WORK="$(mktemp -d /tmp/homecloud-e2e.XXXXXX)"
LOOP=""
DAEMON=""
UUID=""

export COMPOSE_PROJECT_NAME=homecloud-restore-e2e
export COMPOSE_FILE="$WORK/compose.yml"
export COMPOSE_DISABLE_ENV_FILE=1
export COMPOSE_ENV_FILES=/dev/null

cleanup() {
  RC=$?
  trap - EXIT

  if [ "$RC" -ne 0 ]; then
    echo "=== E2E FAILURE ==="
    if [ -n "$DAEMON" ] && [ -f "$COMPOSE_FILE" ]; then
      docker compose ps --all || true
      docker compose logs --tail 80 backend db || true
    fi
    ls -la /etc/homecloud/maintenance 2>/dev/null || true
    cat /etc/homecloud/maintenance/restore.pending.json 2>/dev/null || true
    tail -30 "$WORK/dockerd.log" 2>/dev/null || true
  fi

  if [ -n "$DAEMON" ]; then
    if [ -f "$COMPOSE_FILE" ]; then
      docker compose down --volumes --remove-orphans \
        >/dev/null 2>&1 || true
    fi
    kill "$DAEMON" 2>/dev/null || true
    wait "$DAEMON" 2>/dev/null || true
  fi

  if mountpoint -q /mnt/hc-e2e; then
    umount /mnt/hc-e2e || true
  fi

  if [ -n "$UUID" ]; then
    rm -f "/dev/disk/by-uuid/$UUID"
  fi

  if [ -n "$LOOP" ]; then
    losetup -d "$LOOP" || true
  fi

  exit "$RC"
}

trap cleanup EXIT

echo "=== PRIVATE DOCKER DAEMON ==="

python3 -B scripts/ci/restore-e2e-cgroup.py

dockerd \
  --host=unix:///var/run/docker.sock \
  --storage-driver=vfs \
  --exec-opt=native.cgroupdriver=cgroupfs \
  --iptables=false \
  --ip6tables=false \
  >"$WORK/dockerd.log" 2>&1 &

DAEMON=$!
READY=0

for i in $(seq 1 60); do
  if docker info >/dev/null 2>&1; then
    READY=1
    break
  fi
  kill -0 "$DAEMON"
  sleep 1
done

test "$READY" = 1
# Receive the exact archive inside the disposable DinD container.
# The file lives only on the runner's private temporary volume.
cat > "$WORK/images.tar"

python3 -B - "$WORK/images.tar" "$HOMECLOUD_E2E_PLATFORM" "${HOMECLOUD_E2E_BACKEND_IMAGE_ID:?Expected outer backend identity}" "${HOMECLOUD_E2E_STUB_IMAGE_ID:?Expected outer stub identity}" "$HOMECLOUD_E2E_STUB_IMAGE" > "$WORK/portable-ids" <<'IMAGE_VERIFY_PY'
import hashlib
import json
import re
import sys
import tarfile

archive_path, platform, backend_id, stub_id, stub_tag = sys.argv[1:]

if platform not in ("linux/arm64", "linux/amd64"):
    raise SystemExit("STOP: unsupported archive platform")

os_name, arch = platform.split("/")

def require(condition, message):
    if not condition:
        raise ValueError(message)

def valid_digest(value):
    return (
        isinstance(value, str)
        and re.fullmatch(r"sha256:[0-9a-f]{64}", value) is not None
    )

def sha256(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()

with tarfile.open(archive_path, "r:") as archive:
    members = {}

    for member in archive.getmembers():
        name = member.name

        if name.startswith("./"):
            name = name[2:]

        if member.isdir():
            continue

        require(name not in members, "duplicate archive member: " + name)
        members[name] = member

    def get_file(name):
        member = members.get(name)

        require(
            member is not None and member.isfile(),
            "missing or nonregular archive member: " + name,
        )

        return member

    def metadata(name):
        member = get_file(name)

        require(
            member.size <= 16 * 1024 * 1024,
            "oversized image metadata: " + name,
        )

        with archive.extractfile(member) as stream:
            data = stream.read()

        return json.loads(data), sha256(data), len(data)

    def file_digest(name):
        member = get_file(name)
        digest = hashlib.sha256()

        with archive.extractfile(member) as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)

        return "sha256:" + digest.hexdigest()

    def descriptor_json(descriptor):
        identity = descriptor["digest"]

        require(valid_digest(identity), "invalid OCI descriptor digest")

        obj, actual, size = metadata(
            "blobs/sha256/" + identity.split(":", 1)[1]
        )

        require(actual == identity, "OCI descriptor digest mismatch")
        require(size == descriptor["size"], "OCI descriptor size mismatch")

        return obj

    docker_manifest, _, _ = metadata("manifest.json")

    require(
        isinstance(docker_manifest, list),
        "invalid Docker archive manifest",
    )

    def resolve(tag, expected_outer):
        require(valid_digest(expected_outer), "invalid expected outer ID")

        matches = [
            entry for entry in docker_manifest
            if tag in (entry.get("RepoTags") or [])
        ]

        require(
            len(matches) == 1,
            "expected exactly one Docker archive entry for " + tag,
        )

        entry = matches[0]
        config, config_id, config_size = metadata(entry["Config"])

        require(config.get("os") == os_name, "wrong config OS")
        require(config.get("architecture") == arch, "wrong config architecture")

        layers = entry["Layers"]
        diff_ids = config.get("rootfs", {}).get("diff_ids", [])

        require(
            isinstance(layers, list)
            and len(layers) > 0
            and len(layers) == len(diff_ids)
            and all(valid_digest(value) for value in diff_ids),
            "invalid image layer inventory",
        )

        for layer in layers:
            get_file(layer)

        if config_id == expected_outer:
            # Classical Docker already uses the config digest as Id.
            # Docker load additionally verifies uncompressed layer DiffIDs.
            print(
                "PASS: classic image identity " + tag + " " + config_id,
                file=sys.stderr,
            )

            return config_id

        # Containerd image store may expose an OCI index or manifest
        # digest instead of the image's configuration digest.
        # Never accept a config digest merely because the tag matches.
        index, _, _ = metadata("index.json")

        roots = [
            descriptor for descriptor in index.get("manifests", [])
            if descriptor.get("digest") == expected_outer
        ]

        require(
            len(roots) == 1,
            "expected outer OCI descriptor not found: " + tag,
        )

        selected = descriptor_json(roots[0])
        selected_id = expected_outer

        if "manifests" in selected:
            native = [
                descriptor
                for descriptor in selected["manifests"]
                if descriptor.get("platform", {}).get("os") == os_name
                and descriptor.get("platform", {}).get("architecture") == arch
            ]

            require(
                len(native) == 1,
                "expected exactly one native OCI platform manifest",
            )

            selected_id = native[0]["digest"]
            selected = descriptor_json(native[0])

        require(
            selected.get("schemaVersion") == 2,
            "unsupported OCI manifest version",
        )

        expected_config = selected["config"]

        require(
            expected_config.get("digest") == config_id,
            "OCI manifest and Docker archive config differ",
        )

        require(
            expected_config.get("size") == config_size,
            "OCI config size mismatch",
        )

        manifest_layers = selected["layers"]

        require(
            len(manifest_layers) == len(layers),
            "OCI and Docker archive layer counts differ",
        )

        # Bind every archive layer to the selected native OCI manifest.
        # Metadata hashes alone would not prove this association.
        for filename, descriptor in zip(layers, manifest_layers):
            require(
                get_file(filename).size == descriptor["size"],
                "OCI layer size mismatch",
            )

            require(
                valid_digest(descriptor["digest"])
                and file_digest(filename) == descriptor["digest"],
                "OCI layer digest mismatch",
            )

        print(
            "PASS: verified OCI image chain "
            + tag + " "
            + expected_outer + " -> "
            + selected_id + " -> "
            + config_id,
            file=sys.stderr,
        )

        return config_id

    portable_backend = resolve(
        "homecloud-restore-e2e-backend:local",
        backend_id,
    )

    portable_stub = resolve(stub_tag, stub_id)

    # Only these two verified digests are returned to the shell.
    print(portable_backend + " " + portable_stub)
IMAGE_VERIFY_PY

read -r PORTABLE_BACKEND_ID PORTABLE_STUB_ID < "$WORK/portable-ids"
rm -f "$WORK/portable-ids"

docker load -i "$WORK/images.tar"
rm -f "$WORK/images.tar"

echo "PASS: verified portable backend config $PORTABLE_BACKEND_ID"
echo "PASS: verified portable stub config $PORTABLE_STUB_ID"

# The classic nested engine addresses loaded images by config SHA.
# Preserve the outer pin above; use its proven config identity below.
HOMECLOUD_E2E_BACKEND_IMAGE_ID="$PORTABLE_BACKEND_ID"
HOMECLOUD_E2E_STUB_IMAGE_ID="$PORTABLE_STUB_ID"

# Verify the retained backend before any storage or product workload.
EXPECTED_BACKEND_ID="${HOMECLOUD_E2E_BACKEND_IMAGE_ID:?Expected loaded backend image ID}"
test "${#EXPECTED_BACKEND_ID}" -eq 71 || exit 1
case "$EXPECTED_BACKEND_ID" in sha256:*) ;; *) exit 1 ;; esac
case "${EXPECTED_BACKEND_ID#sha256:}" in
  *[!0123456789abcdef]*) exit 1 ;;
esac
test "$(docker image inspect homecloud-restore-e2e-backend:local --format '{{.Id}}')" = "$EXPECTED_BACKEND_ID" || exit 1
test "$(docker image inspect "$EXPECTED_BACKEND_ID" --format '{{.Id}}')" = "$EXPECTED_BACKEND_ID" || exit 1
test "$(docker image inspect "$EXPECTED_BACKEND_ID" --format '{{.Os}}/{{.Architecture}}')" = "$HOMECLOUD_E2E_PLATFORM" || exit 1
echo "PASS: nested backend image matches exact exported ID $EXPECTED_BACKEND_ID"
test "$(docker image inspect "$HOMECLOUD_E2E_STUB_IMAGE" --format '{{.Id}}')" = "${HOMECLOUD_E2E_STUB_IMAGE_ID:?Expected loaded stub image ID}"
test "$(docker image inspect "$HOMECLOUD_E2E_STUB_IMAGE" --format '{{.Os}}/{{.Architecture}}')" = "$HOMECLOUD_E2E_PLATFORM"
echo "PASS: nested stub image matches exact exported ID $HOMECLOUD_E2E_STUB_IMAGE_ID"

echo "=== NESTED RESOURCE LIMIT PREFLIGHT ==="
# Exercise the same resource controls that restore's isolated PostgreSQL and
# migration containers need, before allocating storage or stopping writers.
docker run --rm --pull=never --network none --read-only \
  --security-opt no-new-privileges --memory 512m --cpus 1 --pids-limit 128 \
  --entrypoint sh "$HOMECLOUD_E2E_STUB_IMAGE" -ec '
    grep -Eq "^Seccomp:[[:space:]]+2$" /proc/self/status
    test "$(cat /sys/fs/cgroup/cgroup.type)" = domain
    test "$(cat /sys/fs/cgroup/memory.max)" = 536870912
    test "$(cat /sys/fs/cgroup/pids.max)" = 128
    read quota period < /sys/fs/cgroup/cpu.max
    test "$quota" -gt 0
    test "$quota" = "$period"
    echo "PASS: nested seccomp and memory/CPU/PID limits applied by kernel"
  '

echo "=== EXT4 FIXTURE ==="

mkdir -p /mnt/hc-e2e /etc/homecloud

truncate -s 512M "$WORK/disk.img"
mkfs.ext4 -q -F "$WORK/disk.img"

LOOP="$(losetup --find --show "$WORK/disk.img")"
mount -t ext4 "$LOOP" /mnt/hc-e2e

UUID="$(blkid -s UUID -o value "$LOOP")"
test -n "$UUID"

mkdir -p /dev/disk/by-uuid

# Real non-root backend must traverse the UUID alias directories.
chmod 755 /dev/disk /dev/disk/by-uuid

ln -s "../../$(basename "$LOOP")" "/dev/disk/by-uuid/$UUID"

PG_UID="$(docker run --rm --network none --entrypoint id \
  postgres:16-alpine -u postgres)"

PG_GID="$(docker run --rm --network none --entrypoint id \
  postgres:16-alpine -g postgres)"

mkdir -p \
  /mnt/hc-e2e/db \
  /mnt/hc-e2e/storage/.tmp \
  /etc/homecloud/maintenance \
  "$WORK/backups"

chown "$PG_UID:$PG_GID" /mnt/hc-e2e/db

chown 1001:65533 \
  /mnt/hc-e2e/storage \
  /mnt/hc-e2e/storage/.tmp

chmod 700 /mnt/hc-e2e/db /mnt/hc-e2e/storage \
  /mnt/hc-e2e/storage/.tmp "$WORK/backups"

chmod 755 /etc/homecloud
chmod 711 /etc/homecloud/maintenance

for ROLE in db backend; do
  printf "homecloud-v1 %s %s\n" "$ROLE" "$UUID" \
    > "/mnt/hc-e2e/.homecloud-$ROLE"
done

chown "$PG_UID:$PG_GID" /mnt/hc-e2e/.homecloud-db
chown 1001:65533 /mnt/hc-e2e/.homecloud-backend

chmod 400 /mnt/hc-e2e/.homecloud-db \
  /mnt/hc-e2e/.homecloud-backend

printf "db %s /mnt/hc-e2e /mnt/hc-e2e/db %s %s dedicated\n" \
  "$UUID" "$PG_UID" "$PG_GID" \
  > /etc/homecloud/startup-db.gate

printf "backend %s /mnt/hc-e2e /mnt/hc-e2e/storage 1001 65533 dedicated\n" \
  "$UUID" > /etc/homecloud/startup-backend.gate

chmod 644 /etc/homecloud/startup-*.gate

echo "=== ENROLL LEGACY STORAGE IDENTITY ==="

docker run --rm --pull=never --network none \
  --user 1001:65533 \
  --mount type=bind,src=/mnt/hc-e2e/storage,dst=/storage \
  --entrypoint node \
  "$EXPECTED_BACKEND_ID" \
  -e "require('./dist/storage/storage-mount-registry.js').bootstrapLegacyMarker('/storage')"

test "$(stat -c "%u:%g:%a" /mnt/hc-e2e/storage/.homecloud-storage-identity)" = "1001:65533:600"

echo "PASS: production legacy storage identity enrolled"


export HOMECLOUD_CONFIG_MODE=environment
export DB_NAME=fixture
export DB_USER=fixture

export DB_PASSWORD="$(python3 -c 'import secrets; print(secrets.token_hex(24))')"
export JWT_SECRET="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
export JWT_REFRESH_SECRET="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
export REDIS_PASSWORD="$(python3 -c 'import secrets; print(secrets.token_hex(24))')"

export STORAGE_PATH=/storage
export BACKUP_DIR="$WORK/backups"
export BACKEND_IMAGE="$EXPECTED_BACKEND_ID"
export BACKUP_WRITE_BARRIER_CONFIRMED=1

echo "=== COMPOSE FIXTURE ==="

python3 -B - <<'PY'
import json
import os
from pathlib import Path

env = os.environ
root = "/mnt/hc-e2e"
gate = "/opt/homecloud/deploy/linux/startup-gate.sh"

def mounts(role, target, directory):
    return [
        f"{root}/{directory}:{target}",
        f"{gate}:/run/homecloud/startup-gate.sh:ro",
        f"/etc/homecloud/startup-{role}.gate:/run/homecloud/startup.gate:ro",
        "/proc/1/mountinfo:/run/homecloud/host-mountinfo:ro",
        "/dev:/run/homecloud/dev:ro",
        f"{root}/.homecloud-{role}:/run/homecloud/volume-marker:ro",
    ]

def health(command):
    return {
        "test": command,
        "interval": "3s",
        "timeout": "5s",
        "retries": 40,
    }

backend_env = {
    key: env[key] for key in (
        "DB_NAME", "DB_USER", "DB_PASSWORD", "JWT_SECRET",
        "JWT_REFRESH_SECRET", "REDIS_PASSWORD", "STORAGE_PATH"
    )
}

backend_env.update({
    "NODE_ENV": "production",
    "PORT": "3000",
    "DATABASE_URL": (
        f"postgres://{env['DB_USER']}:{env['DB_PASSWORD']}"
        f"@db:5432/{env['DB_NAME']}"
    ),
    "FRONTEND_URL": "https://restore-fixture.example.invalid",
    "TRUSTED_PROXY_IP": "192.0.2.1",
    "UPLOAD_SSD_ENABLED": "false",
    "UPLOAD_SSD_RECOVERY_MODE": "manual",
    "MAX_FILE_SIZE": "104857600",
    "MAX_TOTAL_SIZE": "1073741824",
    "MAX_CHUNK_SIZE": "52428800",
})

services = {
    "db": {
        "image": "postgres:16-alpine",
        "pull_policy": "never",
        "entrypoint": ["sh", "/run/homecloud/startup-gate.sh", "db"],
        "command": ["postgres"],
        "environment": {
            "POSTGRES_USER": env["DB_USER"],
            "POSTGRES_DB": env["DB_NAME"],
            "POSTGRES_PASSWORD": env["DB_PASSWORD"],
        },
        "volumes": mounts("db", "/var/lib/postgresql/data", "db"),
        "healthcheck": health([
            "CMD", "pg_isready", "-h", "127.0.0.1",
            "-U", env["DB_USER"], "-d", env["DB_NAME"],
        ]),
    },
    "backend": {
        "image": env["BACKEND_IMAGE"],
        "pull_policy": "never",
        "user": "1001:65533",
        "init": True,
        "entrypoint": ["sh", "/run/homecloud/startup-gate.sh", "backend"],
        "command": ["node", "dist/main.js"],
        "environment": backend_env,
        "volumes": mounts("backend", "/storage", "storage") + [
            "/etc/homecloud/maintenance:/run/homecloud/maintenance:ro"
        ],
        "depends_on": {"db": {"condition": "service_healthy"}},
        "healthcheck": health(["CMD", "node", "docker/healthcheck.cjs"]),
    },
}

for service, dependency in (
    ("frontend", "backend"), ("ingress", "frontend")
):
    services[service] = {
        "image": env.get("HOMECLOUD_E2E_STUB_IMAGE", "alpine:latest"),
        "pull_policy": "never",
        "command": ["sh", "-c", "trap 'exit 0' TERM INT; while :; do sleep 1 & wait $!; done"],
        "depends_on": {dependency: {"condition": "service_healthy"}},
        "healthcheck": health(["CMD", "true"]),
    }

config = {
    "name": env["COMPOSE_PROJECT_NAME"],
    "services": services,
    "networks": {"default": {"internal": True}},
}

Path(env["COMPOSE_FILE"]).write_text(json.dumps(config))
PY

chmod 600 "$COMPOSE_FILE"

echo "=== START REAL DATABASE AND BACKEND ==="

docker compose up -d --wait --wait-timeout 180
BACKEND_CONTAINER_ID="$(docker compose ps -q backend)"
test -n "$BACKEND_CONTAINER_ID" || exit 1
test "$(docker inspect --format '{{.Image}}' "$BACKEND_CONTAINER_ID")" = "$EXPECTED_BACKEND_ID" || exit 1
echo "PASS: running backend container uses exact retained image ID"
docker compose ps

test "$(docker compose exec -T db psql -X -v ON_ERROR_STOP=1 -U fixture -d fixture -At \
  -c 'SHOW server_version')" = 16.16
echo "PASS: actual PostgreSQL16.16"

docker compose logs backend db \
  | grep -F "PASS: HomeCloud startup disk gate"


echo "=== FIRST ADMINISTRATOR INSTALLATION QUALIFICATION ==="

HC_ADMIN_BOOTSTRAP_EXPECTED=0

# Preserve all existing specialized recovery matrices.
if [ "${HOMECLOUD_E2E_HISTORICAL_SCHEMA:-0}" = 0 ] &&
   [ "${HOMECLOUD_E2E_ENCRYPTED:-0}" = 0 ] &&
   [ "${HOMECLOUD_E2E_FAULT_CASE:-none}" = none ]; then

python3 -B - <<'ADMIN_E2E_PY'
import errno
import json
import os
import pty
import secrets
import select
import subprocess
import termios
import time

from pathlib import Path


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def passed(message):
    print("PASS: " + message, flush=True)


def command(*args, stdin=None):
    result = subprocess.run(
        ["docker", "compose", *args],
        input=stdin,
        text=True,
        capture_output=True,
        timeout=240,
    )

    require(
        result.returncode == 0,
        "Compose fixture command failed: " + args[0],
    )

    return result.stdout.strip()


def sql(statement):
    return command(
        "exec", "-T", "db",
        "psql", "-X", "-v", "ON_ERROR_STOP=1",
        "-U", "fixture", "-d", "fixture", "-At",
        "-c", statement,
    )


require(
    os.environ["COMPOSE_PROJECT_NAME"] == "homecloud-restore-e2e",
    "unexpected Compose project",
)

require(
    os.environ["DB_NAME"] == "fixture"
    and os.environ["DB_USER"] == "fixture",
    "unexpected fixture database",
)

require(
    Path(os.environ["COMPOSE_FILE"]).is_file(),
    "missing isolated fixture configuration",
)

require(
    not Path("/etc/homecloud/maintenance/maintenance.inhibit").exists(),
    "unexpected maintenance marker",
)

require(
    sql("SELECT count(*) FROM public.migrations;") == "35",
    "fresh installation migration inventory mismatch",
)

require(
    sql("SELECT count(*) FROM public.users;") == "0",
    "fresh installation unexpectedly contains users",
)

passed("fresh database, 35 migrations, no automatic administrator")

email = "bootstrap-admin@example.invalid"
password = secrets.token_hex(24)
mismatch = secrets.token_hex(24)
retry_password = secrets.token_hex(24)

command("stop", "backend")

passed("live backend stopped before operator bootstrap")


def bootstrap(attempts, expected_status):
    # A real terminal is required by the production CLI.
    # Passwords never enter Docker arguments or environment.
    master, slave = pty.openpty()

    attributes = termios.tcgetattr(slave)
    attributes[3] &= ~termios.ECHO
    termios.tcsetattr(slave, termios.TCSANOW, attributes)

    proc = subprocess.Popen(
        [
            "docker", "compose", "run",
            "--rm", "--no-deps",
            "--name", "hc-bootstrap-" + secrets.token_hex(8),
            "backend", "node",
            "dist/users/admin-bootstrap-cli.js",
            "bootstrap", "create",
            "--email", email,
            "--name", "Installation administrator",
        ],
        stdin=slave,
        stdout=slave,
        stderr=slave,
        start_new_session=True,
    )

    os.close(slave)

    transcript = bytearray()
    stage = 0
    cursor = 0
    deadline = time.monotonic() + 120

    try:
        while time.monotonic() < deadline:
            readable, _, _ = select.select([master], [], [], 0.2)

            if readable:
                try:
                    data = os.read(master, 65536)
                except OSError as error:
                    if error.errno == errno.EIO:
                        break
                    raise

                if not data:
                    break

                transcript.extend(data)

                require(
                    len(transcript) <= 1024 * 1024,
                    "unexpectedly large bootstrap output",
                )

                unread = transcript[cursor:]
                if stage < len(attempts) * 2:
                    prompt = (b"New administrator password: " if stage % 2 == 0
                              else b"Repeat administrator password: ")
                    if prompt in unread:
                        if stage > 0 and stage % 2 == 0:
                            require(
                                sql("SELECT count(*) FROM public.users;") == "0",
                                "rejected password created an account",
                            )
                        answer = attempts[stage // 2][stage % 2]
                        os.write(master, answer.encode() + b"\n")
                        stage += 1
                        cursor = len(transcript)

            elif proc.poll() is not None:
                break

        require(
            time.monotonic() < deadline,
            "interactive bootstrap timeout",
        )

        code = proc.wait(timeout=15)

    finally:
        os.close(master)

        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=5)

    output = transcript.decode("utf-8", errors="replace")

    require(
        all(first not in output and second not in output
            for first, second in attempts),
        "interactive password was echoed",
    )

    require(
        stage == len(attempts) * 2,
        "expected password prompts were not reached",
    )

    if len(attempts) > 1:
        require(
            "Passwords do not match; try again." in output
            and "Password must be 12 or more characters" in output,
            "rejected passwords lacked retry diagnostics",
        )

    require(
        "PASS: HomeCloud startup disk gate" in output,
        "operator container did not prove startup gate",
    )

    require(code == 0, "bootstrap command failed")

    results = []

    for line in output.splitlines():
        try:
            record = json.loads(line.strip())
        except ValueError:
            continue

        if isinstance(record, dict) and "status" in record:
            results.append(record)

    require(len(results) == 1, "missing exact bootstrap result")

    result = results[0]

    require(
        set(result) == {"status", "userId", "email", "role"},
        "unexpected bootstrap result fields",
    )

    require(
        result["status"] == expected_status
        and result["email"] == email
        and result["role"] == "ADMIN"
        and type(result["userId"]) is int
        and result["userId"] > 0,
        "unexpected bootstrap result",
    )

    return result["userId"]


user_id = bootstrap(
    [(password, mismatch), ("short", "short"), (password, password)],
    "created",
)

require(
    sql("SELECT count(*) FROM public.users;") == "1",
    "password retry did not create exactly one account",
)

passed("real installed gate + TTY retries rejected passwords without echo")

row = sql(
    'SELECT id,email,role,"isActive","sessionVersion",'
    '"storageQuota","storageUsed" FROM public.users;'
)

require(
    row == str(user_id) + "|" + email + "|ADMIN|t|1|0|0",
    "unexpected persisted administrator state",
)

require(
    sql("SELECT count(*) FROM public.users;") == "1",
    "bootstrap did not create exactly one account",
)

passed("first ADMIN created through installed startup gate and root fence")


def account_digest():
    return sql(
        "SELECT md5(row_to_json(u)::text) "
        "FROM public.users u WHERE id=" + str(user_id) + ";"
    )


before = account_digest()

# Use a different password on retry: an idempotent bootstrap must
# not replace the existing administrator password or any other field.
retry_id = bootstrap([(retry_password, retry_password)], "already-configured")

require(retry_id == user_id, "bootstrap retry changed identity")
require(account_digest() == before, "bootstrap retry mutated account")
require(
    sql("SELECT count(*) FROM public.users;") == "1",
    "bootstrap retry created another account",
)

require(
    sql("SELECT count(*) FROM public.migrations;") == "35",
    "bootstrap changed migration inventory",
)

passed("interactive bootstrap retry preserves entire existing account")

command("up", "-d", "--wait", "--wait-timeout", "180")

passed("production backend and dependent services healthy")


api_test = r"""
const assert = require("node:assert/strict");
const fs = require("node:fs");

const credentials = JSON.parse(fs.readFileSync(0,"utf8"));
const base = "http://127.0.0.1:3000/api/v1";

async function request(path, method, body, token) {
  const headers = {"content-type":"application/json"};

  if(token) headers.authorization = "Bearer " + token;

  const response = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });

  return {
    status:response.status,
    body:await response.json(),
  };
}

async function main() {
  const login = await request("/auth/login","POST",{
    email:credentials.email,
    password:credentials.password,
  });

  assert.equal(login.status,200);
  assert.equal(login.body.success,true);

  const token = login.body.data.accessToken;

  assert.equal(typeof token,"string");
  assert.equal(typeof login.body.data.refreshToken,"string");

  const me = await request("/users/me","GET",undefined,token);

  assert.equal(me.status,200);
  assert.equal(me.body.data.email,credentials.email);
  assert.equal(me.body.data.id,credentials.id);
  assert.equal(me.body.data.role,"ADMIN");

  assert.equal("password" in me.body.data,false);
  assert.equal("sessionVersion" in me.body.data,false);

  const originalRegistration = {
    email:"registration-denied@example.invalid",
    password:credentials.password,
    name:"Must not exist",
  };

  const requests = [
    [originalRegistration,undefined],
    [{...originalRegistration,role:"ADMIN"},token],
    [{},undefined],
    [undefined,undefined],
  ];

  for(const [body,auth] of requests) {
    const response = await request("/auth/register","POST",body,auth);

    assert.equal(response.status,403);
    assert.equal(response.body.code,"REGISTRATION_DISABLED");
  }

  console.log("PASS: first administrator real login and users/me");
  console.log("PASS: public and authenticated registration denied");
}

main().catch(() => {
  console.error("Administrator installation API qualification failed");
  process.exit(1);
});
"""

output = command(
    "exec", "-T", "backend", "node", "-e", api_test,
    stdin=json.dumps({
        "email": email,
        "password": password,
        "id": user_id,
    }),
)

for marker in [
    "PASS: first administrator real login and users/me",
    "PASS: public and authenticated registration denied",
]:
    require(marker in output, "missing API evidence")
    print(marker, flush=True)

require(
    sql("SELECT count(*) FROM public.users;") == "1",
    "denied public registration changed user count",
)

require(
    sql(
        "SELECT count(*) FROM public.users "
        "WHERE role='ADMIN' AND \"isActive\";"
    ) == "1",
    "administrator count changed",
)

passed("registration rejection leaves database unchanged")

print("BE_ADMIN_FIRST_INSTALLATION_E2E_PASS", flush=True)
ADMIN_E2E_PY

HC_ADMIN_BOOTSTRAP_EXPECTED=1

fi


cat > "$WORK/api.cjs" <<'JS'
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const base = "http://127.0.0.1:3000/api/v1";
const credentials = {
  email: "restore-fixture@example.invalid",
  password: "E2eFixture!726184",
};
const payload = Buffer.from("HomeCloud backup restore proof\n");

async function request(path, method, body, token) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;

  if (body && !(body instanceof FormData)) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(body);
  }

  const response = await fetch(base + path, {
    method, headers, body,
    signal: AbortSignal.timeout(20000),
  });

  if (!response.ok) {
    throw new Error(`${method} ${path}: HTTP ${response.status} ${await response.text()}`);
  }

  const result = await response.json();
  assert.equal(result.success, true);
  return result.data;
}

// Executed only inside the existing disposable restore fixture.
// No product registration method or test-only API endpoint is used.
async function prepareFixtureAccount() {
  const { Client } = require("pg");
  const bcrypt = require("bcryptjs");

  assert.equal(process.env.HOMECLOUD_RESTORE_FIXTURE_SEED, "1");

  const url = new URL(process.env.DATABASE_URL);

  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  assert.equal(url.hostname, "db");
  assert.equal(url.port, "5432");
  assert.equal(url.pathname, "/fixture");
  assert.equal(url.username, "fixture");

  const passwordHash = await bcrypt.hash(credentials.password, 12);

  const client = new Client({
    connectionString: url.toString(),
    connectionTimeoutMillis: 10000,
  });

  try {
    await client.connect();

    await client.query("BEGIN");

    const identity = await client.query(`
      SELECT current_database() AS database,
             current_user AS username,
             current_schema() AS schema
    `);

    assert.deepEqual(identity.rows, [{
      database: "fixture",
      username: "fixture",
      schema: "public",
    }]);

    await client.query(
      'LOCK TABLE public.users IN SHARE ROW EXCLUSIVE MODE'
    );

    const before = await client.query(
      "SELECT count(*)::int AS count FROM public.users"
    );

    const administratorExpected =
      process.env.HC_ADMIN_BOOTSTRAP_EXPECTED === "1";

    assert.equal(
      before.rows[0].count,
      administratorExpected ? 1 : 0,
    );

    if (administratorExpected) {
      const administrator = await client.query(`
        SELECT email, role, "isActive" FROM public.users
      `);

      assert.deepEqual(administrator.rows, [{
        email: "bootstrap-admin@example.invalid",
        role: "ADMIN",
        isActive: true,
      }]);
    }

    const inserted = await client.query(
      `INSERT INTO public.users
         (email, password, name, role, "sessionVersion",
          "isActive", "storageQuota", "storageUsed")
       VALUES ($1, $2, $3, 'USER', 1, true, 0, 0)
       RETURNING id, email, role`,
      [credentials.email, passwordHash, "Restore fixture"]
    );

    assert.equal(inserted.rowCount, 1);
    assert.equal(inserted.rows[0].email, credentials.email);
    assert.equal(inserted.rows[0].role, "USER");

    await client.query("COMMIT");

    console.log("PASS: ordinary user prepared in disposable restore database");
  } catch {
    await client.query("ROLLBACK").catch(() => {});
    throw new Error("Restore fixture account preparation failed");
  } finally {
    await client.end();
  }
}

async function main() {
  const mode = process.env.HC_ACTION;

  if (mode === "prepare-account") {
    await prepareFixtureAccount();
  }

  const auth = await request(
    "/auth/login",
    "POST",
    credentials
  );

  const token = auth.accessToken;
  assert.ok(token);

  if (mode === "prepare-account") {
    assert.ok(auth.refreshToken);
    console.log("PASS: prepared fixture user authenticated through real login");
    return;
  }

  if (mode === "seed" || mode === "mutate") {
    const filename = mode === "seed"
      ? "before-backup.txt" : "after-backup.txt";

    const bytes = mode === "seed"
      ? payload : Buffer.from("must disappear\n");

    const session = await request("/uploads/session", "POST", {
      filename,
      totalSize: bytes.length,
      chunkSize: bytes.length,
      expectedSha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    }, token);

    assert.ok(session.uploadId);

    const form = new FormData();
    form.append("chunkIndex", "0");
    form.append("chunk", new Blob([bytes]), filename);

    await request(
      `/uploads/session/${session.uploadId}/chunk`, "POST", form, token
    );

    await request(
      `/uploads/session/${session.uploadId}/complete`,
      "POST", undefined, token
    );

    console.log(`PASS: uploaded ${filename}`);
    return;
  }

  const result = await request("/files", "GET", undefined, token);
  const files = Array.isArray(result) ? result : result.files;

  assert.ok(Array.isArray(files));

  const original = files.find(file => file.name === "before-backup.txt");

  assert.ok(original);
  assert.ok(!files.some(file => file.name === "after-backup.txt"));

  const download = await fetch(`${base}/files/${original.id}/download`, {
    headers: {authorization: `Bearer ${token}`},
    signal: AbortSignal.timeout(20000),
  });

  assert.ok(download.ok);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), payload);

  console.log("PASS: restored download contains exact original bytes");
  console.log("PASS: post-backup file absent");
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
JS

echo "=== PREPARE FIXTURE USER AND VERIFY LOGIN ==="

# Check the existing disposable Compose and DB identities BEFORE seeding.
test "$COMPOSE_PROJECT_NAME" = homecloud-restore-e2e
test "$DB_NAME" = fixture
test "$DB_USER" = fixture

docker compose exec -T \
  -e HOMECLOUD_RESTORE_FIXTURE_SEED=1 \
  -e HC_ADMIN_BOOTSTRAP_EXPECTED="$HC_ADMIN_BOOTSTRAP_EXPECTED" \
  -e HC_ACTION=prepare-account backend node \
  < "$WORK/api.cjs"

echo "=== ASSIGN FIXTURE QUOTA ==="

test "$COMPOSE_PROJECT_NAME" = homecloud-restore-e2e
test "$DB_NAME" = fixture
test "$DB_USER" = fixture

QUOTA_RESULT="$(docker compose exec -T db \
  psql -X -v ON_ERROR_STOP=1 -U fixture -d fixture -At <<'SQL'
WITH updated AS (
  UPDATE users
  SET "storageQuota" = 104857600
  WHERE email = 'restore-fixture@example.invalid'
    AND "storageUsed" = 0
    AND "storageQuota" = 0
  RETURNING id
)
SELECT count(*) FROM updated;
SQL
)"

test "$QUOTA_RESULT" = 1

echo "PASS: fixture quota assigned (100 MiB)"

docker compose ps --all -q | sort > "$WORK/original-containers"
stat -c '%d:%i' /mnt/hc-e2e/storage/.homecloud-storage-identity \
  > "$WORK/original-storage-identity"

echo "=== SEED DATA THROUGH REAL API ==="

docker compose exec -T -e HC_ACTION=seed backend node \
  < "$WORK/api.cjs"

verify_restored_state() {
echo "=== VERIFY RESTORED DATA ==="

docker compose exec -T -e HC_ACTION=verify backend node \
  < "$WORK/api.cjs"

echo "=== VERIFY MAINTENANCE CLEANUP ==="

docker compose ps --all -q | sort > "$WORK/restored-containers"
cmp "$WORK/original-containers" "$WORK/restored-containers"
test "$(stat -c '%d:%i' /mnt/hc-e2e/storage/.homecloud-storage-identity)" = \
  "$(cat "$WORK/original-storage-identity")"

CONSISTENCY="$(docker compose exec -T db \
  psql -X -v ON_ERROR_STOP=1 -U fixture -d fixture -At <<'SQL'
SELECT count(*) FROM users u
WHERE email = 'restore-fixture@example.invalid'
  AND "storageQuota" = 104857600
  AND "storageUsed" = (SELECT COALESCE(sum(size),0) FROM files f
                        WHERE f."userId"=u.id AND NOT f."isFolder")
  AND (SELECT count(*) FROM files f WHERE f."userId"=u.id
       AND f.name='before-backup.txt' AND NOT f."isDeleted") = 1
  AND NOT EXISTS (SELECT 1 FROM files f WHERE f."userId"=u.id
                  AND f.name='after-backup.txt')
  AND NOT EXISTS (SELECT 1 FROM file_copy_operations
                  WHERE state IN ('reserved','cleanup_required'));
SQL
)"
test "$CONSISTENCY" = 1
echo "PASS: original containers, storage identity, quota and journal consistent"

PYTHONPATH=/opt/homecloud/scripts python3 -B - <<'PY'
from pathlib import Path

state = Path("/etc/homecloud/maintenance")
root = Path("/mnt/hc-e2e/storage")

assert not (state / "maintenance.inhibit").exists()
assert not (state / "restore.pending.json").exists()
assert not list(state.glob("restore-migration.*"))
assert not (root / ".restore-staging").exists()
assert not (root / ".restore-swap").exists()

print("PASS: no residual maintenance or restore artifacts")
PY
}

echo "=== FENCED BACKUP ==="

if [ "${HOMECLOUD_E2E_ENCRYPTED:-0}" = 1 ]; then
  echo "=== REAL ENCRYPTED PRODUCTION COORDINATOR ==="
  export BACKUP_PRODUCTION_DIR="$WORK/encrypted-local"
  export BACKUP_OFFSITE_DIR="$WORK/encrypted-offsite"
  export BACKUP_OFFSITE_CONFIRMED=1
  export BACKUP_WRITE_BARRIER_CONFIRMED=1
  export BACKUP_AGE_IDENTITY_FILE="$WORK/age-identity"
  export BACKUP_AGE_RECIPIENTS_FILE="$WORK/age-recipients"
  mkdir -m 0700 "$BACKUP_PRODUCTION_DIR" "$BACKUP_OFFSITE_DIR"
  age-keygen -o "$BACKUP_AGE_IDENTITY_FILE" 2>/dev/null
  age-keygen -y "$BACKUP_AGE_IDENTITY_FILE" > "$BACKUP_AGE_RECIPIENTS_FILE"
  chmod 0600 "$BACKUP_AGE_IDENTITY_FILE" "$BACKUP_AGE_RECIPIENTS_FILE"
  # The actual coordinator captures the backup operation FD and invokes the
  # real raw producer. No stubbed child, pre-stopped writer or fake manifest.
  bash scripts/backup-production.sh
  GENERATION="$(python3 -B - <<'PY'
import json
import os
from pathlib import Path
import re

local = Path(os.environ['BACKUP_PRODUCTION_DIR'])
remote = Path(os.environ['BACKUP_OFFSITE_DIR'])
marker = json.loads((local / 'last-backup-success.json').read_text())
name = marker['generation']
assert re.fullmatch(r'hc_\d{8}T\d{6}Z_[0-9a-f]{16}', name)
assert marker['offsite_verified'] is True
for directory in (local, remote):
    assert {p.name for p in (directory / name).iterdir()} == {'backup.age', 'manifest.json'}
    assert not list(directory.glob('.plaintext_*'))
    assert not (directory / '.production.lock').exists()
assert (local / name / 'backup.age').read_bytes().startswith(b'age-encryption.org/v1\n')
for member in ('backup.age', 'manifest.json'):
    assert (local / name / member).read_bytes() == (remote / name / member).read_bytes()
print(name)
PY
)"
else
PYTHONPATH=/opt/homecloud/scripts python3 -B - <<'PY'
import subprocess
import json
import os
import recovery_storage as storage

with storage.release_backup_window() as capture:
    fd = capture["operation_fd"]
    subprocess.run(
        ["bash", "/opt/homecloud/scripts/backup.sh", "--yes"],
        env={**os.environ, "HOMECLOUD_BACKUP_OPERATION_FD": str(fd),
             "HOMECLOUD_BACKUP_MARKER_IDENTITY": json.dumps(capture["marker_identity"])},
        pass_fds=(fd,),
        check=True,
    )

print("PASS: actual Backup and fenced restart")
PY
fi

if [ "${HOMECLOUD_E2E_FAULT_CASE:-none}" != none ]; then
  docker compose exec -T -e HC_ACTION=mutate backend node < "$WORK/api.cjs"
  python3 -B scripts/ci/test-restore-fault-e2e.py "$HOMECLOUD_E2E_FAULT_CASE" "$WORK"
  echo "PASS: REAL RESTORE FAULT CASE $HOMECLOUD_E2E_FAULT_CASE"
  exit 0
fi

if [ "${HOMECLOUD_E2E_HISTORICAL_SCHEMA:-0}" = 1 ]; then
  for table_count in 7 8 9 10 11 13 15; do
    echo "=== HISTORICAL DATABASE: $table_count TABLES ==="
    schema_dir="$WORK/historical-schema-$table_count"
    python3 -B scripts/ci/test-historical-schema-e2e.py "$table_count" "$schema_dir"
    docker compose exec -T -e HC_ACTION=mutate backend node < "$WORK/api.cjs"
    BACKUP_DIR="$schema_dir" bash scripts/restore.sh --validate-only
    test "$(docker compose exec -T db psql -X -v ON_ERROR_STOP=1 -U fixture -d fixture -At \
      -c "SELECT count(*) FROM files WHERE name='after-backup.txt' AND NOT \"isDeleted\"")" = 1
    BACKUP_DIR="$schema_dir" bash scripts/restore.sh --yes
    verify_restored_state
    echo "PASS: HISTORICAL DATABASE $table_count TABLES -> CURRENT18 -> REAL API"
  done
  docker compose ps
  echo "PASS: HISTORICAL DATABASE SCHEMA MATRIX 7/8/9/10/11/13/15"
  exit 0
fi

echo "=== MODIFY REAL DATA ==="

docker compose exec -T -e HC_ACTION=mutate backend node \
  < "$WORK/api.cjs"

echo "=== VALIDATE-ONLY RESTORE ==="

if [ "${HOMECLOUD_E2E_ENCRYPTED:-0}" = 1 ]; then
  bash scripts/restore-offsite.sh "$GENERATION" --validate-only
  # Validation must leave the post-backup mutation intact.
  test "$(docker compose exec -T db psql -X -v ON_ERROR_STOP=1 -U fixture -d fixture -At \
    -c "SELECT count(*) FROM files WHERE name='after-backup.txt' AND NOT \"isDeleted\"")" = 1
else
  bash scripts/restore.sh --validate-only
fi

echo "=== ACTUAL RESTORE ==="

if [ "${HOMECLOUD_E2E_ENCRYPTED:-0}" = 1 ]; then
  bash scripts/restore-offsite.sh "$GENERATION" --yes
else
  bash scripts/restore.sh --yes
fi


verify_restored_state

if [ "${HOMECLOUD_E2E_ENCRYPTED:-0}" = 1 ]; then
  python3 -B - <<'PY'
import json
import os
from pathlib import Path

local = Path(os.environ['BACKUP_PRODUCTION_DIR'])
for operation, event in (('restore-validation', 'encrypted_offsite_validation_completed'),
                         ('restore', 'encrypted_offsite_restore_completed')):
    marker = json.loads((local / ('last-' + operation + '-success.json')).read_text())
    assert marker['event'] == event
    assert (local / marker['generation'] / 'backup.age').is_file()
assert not list(local.glob('.restore_*'))
assert not list(local.glob('.plaintext_*'))
assert not (local / '.production.lock').exists()
print('PASS: production encrypted coordinator markers and plaintext cleanup')
PY
  docker compose ps
  echo "PASS: REAL ENCRYPTED BACKUP -> OFFSITE -> RESTORE E2E"
  exit 0
fi

echo "=== HISTORICAL ARCHIVE WITH ROOT IDENTITY METADATA ==="

# Construct the old producer's archive shape from this disposable backup.
# The original backup remains byte-for-byte unchanged.
export HOMECLOUD_HISTORICAL_FIXTURE="$WORK/historical-backups"
PYTHONPATH=/opt/homecloud/scripts python3 -B - <<'PY'
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import tarfile
import restore_storage as restore

original = Path(os.environ["BACKUP_DIR"])
metas = list(original.glob("homecloud_*.meta"))
assert len(metas) == 1
meta_path = metas[0]
meta = json.loads(meta_path.read_bytes())
fixture = Path(os.environ["HOMECLOUD_HISTORICAL_FIXTURE"])
fixture.mkdir(mode=0o700)
for key in ("db_dump", "storage_archive"):
    assert Path(meta[key]).name == meta[key]
archive_path = original / meta["storage_archive"]
original_hash = hashlib.sha256(archive_path.read_bytes()).hexdigest()
original_meta_hash = hashlib.sha256(meta_path.read_bytes()).hexdigest()
marker = Path("/mnt/hc-e2e/storage/.homecloud-storage-identity").read_bytes()
assert marker == restore.LEGACY_IDENTITY_BYTES
archive_fixture = fixture / meta["storage_archive"]
with tarfile.open(archive_path, "r:gz") as source:
    with tarfile.open(archive_fixture, "w:gz") as target:
        for entry, _, historical in restore.checked_archive_members(source):
            assert not historical, "New backup must omit root identity"
            if entry.isfile():
                with source.extractfile(entry) as stream:
                    target.addfile(entry, stream)
            else:
                target.addfile(entry)
        entry = tarfile.TarInfo("./" + restore.IDENTITY_MARKER)
        entry.size, entry.mode, entry.uid, entry.gid = len(marker), 0o600, 1001, 65533
        target.addfile(entry, io.BytesIO(marker))
archive_fixture.chmod(0o600)
shutil.copyfile(original / meta["db_dump"], fixture / meta["db_dump"])
(fixture / meta["db_dump"]).chmod(0o600)
meta["storage_file_count"] += 1
meta["storage_archive_size"] = archive_fixture.stat().st_size
meta["storage_archive_sha256"] = hashlib.sha256(archive_fixture.read_bytes()).hexdigest()
metadata = json.dumps(meta, sort_keys=True, indent=2).encode() + b"\n"
(fixture / meta_path.name).write_bytes(metadata)
(fixture / meta_path.name).chmod(0o600)
sidecar = fixture / (meta_path.name + ".sha256")
sidecar.write_text(hashlib.sha256(metadata).hexdigest() + "  " + meta_path.name + "\n")
sidecar.chmod(0o600)
assert hashlib.sha256(archive_path.read_bytes()).hexdigest() == original_hash
assert hashlib.sha256(meta_path.read_bytes()).hexdigest() == original_meta_hash
print("PASS: old archive layout constructed without modifying original backup")
PY

docker compose exec -T -e HC_ACTION=mutate backend node < "$WORK/api.cjs"
BACKUP_DIR="$HOMECLOUD_HISTORICAL_FIXTURE" bash scripts/restore.sh --validate-only
BACKUP_DIR="$HOMECLOUD_HISTORICAL_FIXTURE" bash scripts/restore.sh --yes
verify_restored_state
echo "PASS: HISTORICAL ROOT IDENTITY BACKUP -> RESTORE"

docker compose ps

echo "PASS: REAL BACKUP -> RESTORE E2E"
