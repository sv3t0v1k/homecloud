#!/usr/bin/env bash
# Strictly qualify the actual apt-installed tool before its first use in this job.
set -euo pipefail
tool=${1:?Specify age or skopeo}
output=${2:?Specify evidence directory}
case "$tool" in age|skopeo) ;; *) echo 'Unsupported apt tool' >&2; exit 2 ;; esac
test "${GITHUB_ACTIONS:-}" = true
test "${RUNNER_ENVIRONMENT:-}" = github-hosted
test "${RUNNER_OS:-}/${RUNNER_ARCH:-}" = Linux/X64
test -n "${GITHUB_RUN_ID:-}" && test -n "${GITHUB_RUN_ATTEMPT:-}"
test -n "${ImageOS:-}" && test -n "${ImageVersion:-}"
mkdir -p "$output"
output=$(realpath "$output")
source_commit=$(git rev-parse HEAD)
python3 scripts/ci/skopeo-closure.py baseline --tool "$tool" --source "$source_commit" --output "$output/baseline.json"
sudo apt-get update --error-on=any > "$output/apt-update.log" 2>&1
python3 - "$output/apt-update.log" "$output/apt-update.json" <<'PY'
import hashlib, json, sys
log, result = sys.argv[1:]
with open(log, 'rb') as stream:
    digest = hashlib.sha256(stream.read()).hexdigest()
with open(result, 'w') as stream:
    json.dump(dict(command=['apt-get', 'update', '--error-on=any'], exit_code=0,
                   log_path=log, log_sha256=digest), stream, sort_keys=True)
PY
sudo apt-get install --download-only --no-install-recommends -y "$tool"
sudo apt-get install --no-install-recommends -y "$tool"
python3 scripts/ci/skopeo-closure.py capture --tool "$tool" --baseline "$output/baseline.json" \
  --output "$output/closure.json" --binary "$(command -v "$tool")" --apt-update-status "$output/apt-update.json"
sh scripts/ci/install-trivy.sh "$output/scanner"
workspace=$(realpath "${GITHUB_WORKSPACE:?}")
cache="$output/scanner/cache"
skip="/proc,/sys,/dev,/run,/tmp,/var/tmp,/var/lib/docker,/var/lib/containerd,$workspace,$output,$cache"
"$output/scanner/trivy" --cache-dir "$cache" rootfs --config /dev/null \
  --java-db-repository ghcr.io/aquasecurity/trivy-java-db:1 \
  --java-db-repository mirror.gcr.io/aquasec/trivy-java-db:1 \
  --skip-dirs "$skip" --scanners vuln --ignore-unfixed=false --ignorefile /dev/null \
  --list-all-pkgs --parallel 0 --timeout 60m --no-progress --format json \
  --output "$output/rootfs.json" / > "$output/rootfs.log" 2>&1
python3 - "$output" "$tool" "$source_commit" <<'PY'
from datetime import datetime, timedelta, timezone
import hashlib, importlib.util, json, os
from pathlib import Path
import sys
out, tool, source = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
report = json.loads((out / 'rootfs.json').read_text())
db = json.loads((out / 'scanner/cache/db/metadata.json').read_text())
spec = importlib.util.spec_from_file_location('scan_evidence', 'scripts/ci/scan-evidence.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
now = datetime.now(timezone.utc)
updated, downloaded, next_update = (module.timestamp(db[key]) for key in ('UpdatedAt', 'DownloadedAt', 'NextUpdate'))
tolerance = timedelta(minutes=5)
if (db.get('Version') != 2 or not now - timedelta(hours=24) <= updated <= now + tolerance
        or not updated - tolerance <= downloaded <= now + tolerance
        or not (next_update > now and next_update > updated)):
    raise ValueError('Apt closure scan has stale or invalid vulnerability DB')
expected_name = Path('/etc/hostname').read_text().strip() or '/'
if (report.get('ArtifactType') not in ('rootfs', 'filesystem')
        or report.get('ArtifactName') != expected_name
        or report.get('Trivy', {}).get('Version') != '0.76.2'):
    raise ValueError('Apt closure scan target or scanner mismatch')
context = dict(tool=tool, source_commit=source, run_id=os.environ['GITHUB_RUN_ID'],
               attempt=os.environ['GITHUB_RUN_ATTEMPT'], image_os=os.environ['ImageOS'],
               image_version=os.environ['ImageVersion'], db=db,
               report_sha256=hashlib.sha256((out / 'rootfs.json').read_bytes()).hexdigest())
(out / 'scan-context.json').write_text(json.dumps(context, sort_keys=True, indent=2) + '\n')
PY
python3 scripts/ci/skopeo-closure.py evaluate --tool "$tool" --evidence "$output/closure.json" \
  --rootfs "$output/rootfs.json" --source "$source_commit" --run-id "$GITHUB_RUN_ID" \
  --attempt "$GITHUB_RUN_ATTEMPT" --image-os "$ImageOS" --image-version "$ImageVersion" \
  --output "$output/summary.json"
