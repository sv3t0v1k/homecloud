#!/bin/sh
set -eu
export LC_ALL=C
# Validate before nginx envsubst inserts the canonical lowercase hostname into its config.
printf '%s\n' "${PUBLIC_HOST:-}" | awk '
  {
    if (NR != 1) exit 1
    if (length($0) > 253) exit 1
    if ($0 !~ /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/) exit 1
    n = split($0, labels, ".")
    for (i = 1; i <= n; i++) if (length(labels[i]) > 63) exit 1
  }
  END { if (NR != 1) exit 1 }
' || { echo "PUBLIC_HOST must be a bare lowercase DNS hostname" >&2; exit 1; }

# Validate optional TRUSTED_HOSTS: space-separated bare lowercase DNS hostnames.
if [ -n "${TRUSTED_HOSTS:-}" ]; then
  printf '%s\n' "${TRUSTED_HOSTS}" | awk '
    {
      for (i = 1; i <= NF; i++) {
        h = $i
        if (length(h) > 253) exit 1
        if (h !~ /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/) exit 1
        n = split(h, labels, ".")
        for (j = 1; j <= n; j++) if (length(labels[j]) > 63) exit 1
      }
    }
  ' || { echo "TRUSTED_HOSTS must be space-separated bare lowercase DNS hostnames" >&2; exit 1; }
fi
