# Disposable test tooling only; no host data or socket is mounted at runtime.
# The existing node-ci INDEX pin (images.platforms.json) includes native ARM64
# and AMD64. The old single AMD64 manifest cannot host native ARM64 DinD.
FROM --platform=linux/amd64 ghcr.io/sv3t0v1k/homecloud-sec02-compose@sha256:90572c9597798a70d6d96ccdcebd68a90ed58050730d4f27d63379fb53a3ed28 AS sec02-compose-amd64

FROM docker.io/library/node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS runner-base
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash docker.io python3 e2fsprogs util-linux age ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# AMD64: квалифицированный OCI-бинарник SEC-02.
# ARM64: прежний upstream-бинарник с проверкой SHA256.
FROM runner-base AS runner-amd64
COPY --from=sec02-compose-amd64 /docker-compose /tmp/homecloud-compose-amd64

FROM runner-base AS runner-arm64

FROM runner-${TARGETARCH} AS runner
ARG TARGETARCH
RUN TARGETARCH="$TARGETARCH" python3 - <<'PY'
import hashlib
import os
from pathlib import Path
import urllib.request

architecture = os.environ["TARGETARCH"]

if architecture == "amd64":
    source = Path("/tmp/homecloud-compose-amd64")
    expected = "a9e710eba0ded73a609b47c9c9383711686778acf8aed71407850c14a627287d"
    with source.open("rb") as stream:
        binary = stream.read(100 * 1024 * 1024 + 1)
elif architecture == "arm64":
    expected = "e169103deb35aa6633a78eca0a2a0658275d573dd689a33c839c71badfa00cce"
    url = "https://github.com/docker/compose/releases/download/v5.8.1/docker-compose-linux-aarch64"
    with urllib.request.urlopen(url, timeout=60) as response:
        binary = response.read(100 * 1024 * 1024 + 1)
else:
    raise SystemExit("Unsupported Compose architecture")

if len(binary) > 100 * 1024 * 1024 or hashlib.sha256(binary).hexdigest() != expected:
    raise SystemExit("Compose checksum mismatch")

destination = Path("/usr/libexec/docker/cli-plugins/docker-compose")
destination.parent.mkdir(parents=True, exist_ok=True)
destination.write_bytes(binary)
destination.chmod(0o755)

if architecture == "amd64":
    source.unlink()
PY
RUN test "$(docker compose version --short)" = 5.8.1
WORKDIR /opt/homecloud
