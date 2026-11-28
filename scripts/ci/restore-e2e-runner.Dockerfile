# Disposable test tooling only; no host data or socket is mounted at runtime.
# The existing node-ci INDEX pin (images.platforms.json) includes native ARM64
# and AMD64. The old single AMD64 manifest cannot host native ARM64 DinD.
FROM docker.io/library/node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash docker.io python3 e2fsprogs util-linux age ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# Same Compose5.8.1 as CI, verified BEFORE installation/execution. ARM64 hash
# from https://github.com/docker/compose/releases/download/v5.8.1/checksums.txt;
# AMD64 hash is also the existing checksum in .github/workflows/ci.yml.
RUN TARGETARCH="$TARGETARCH" python3 - <<'PY'
import hashlib
import os
from pathlib import Path
import urllib.request

assets = {
    "amd64": ("x86_64", "cf2713394ca63900da5d00e0be12045634cea93a504e1ab2f2ae24eed7f2d359"),
    "arm64": ("aarch64", "e169103deb35aa6633a78eca0a2a0658275d573dd689a33c839c71badfa00cce"),
}
arch, expected = assets[os.environ["TARGETARCH"]]
url = "https://github.com/docker/compose/releases/download/v5.8.1/docker-compose-linux-" + arch
with urllib.request.urlopen(url, timeout=60) as response:
    binary = response.read(100 * 1024 * 1024 + 1)
if len(binary) > 100 * 1024 * 1024 or hashlib.sha256(binary).hexdigest() != expected:
    raise SystemExit("Compose checksum mismatch")
destination = Path("/usr/libexec/docker/cli-plugins/docker-compose")
destination.parent.mkdir(parents=True, exist_ok=True)
destination.write_bytes(binary)
destination.chmod(0o755)
PY
RUN test "$(docker compose version --short)" = 5.8.1
WORKDIR /opt/homecloud
