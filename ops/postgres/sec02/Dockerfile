# SEC-02: закреплённый PostgreSQL для Linux AMD64.
# Историческая квалификация D5.1.12 не изменяется.
FROM docker.io/library/postgres:16.16-alpine@sha256:9d9e487c1bd6413c52ccb3c02f46c8e37fa1e1d1a32a84519eb4e68d0ad1da30

COPY --chown=0:0 --chmod=0755 gosu /usr/local/bin/gosu

RUN --network=none --mount=type=bind,source=libxml2-2.13.9-r5.apk,target=/tmp/libxml2.apk \
    printf '%s  %s\n' \
      '81b8e04f7ec075babb1bd154c4dbdb3b9e07c8a3eb21f3f7537c7d5bc88d351a' '/usr/local/bin/gosu' \
      'b7d56295eab909875e724992b53ccc242fa792b40d682f303595f958a97b0224' '/tmp/libxml2.apk' \
      | sha256sum -c - \
    && apk verify /tmp/libxml2.apk \
    && apk --no-network --repositories-file /dev/null add /tmp/libxml2.apk \
    && awk 'BEGIN { RS=""; FS="\n" } \
      { p=""; v=""; for (i=1;i<=NF;i++) { \
        if ($i ~ /^P:/) p=substr($i,3); \
        if ($i ~ /^V:/) v=substr($i,3) \
      } \
      if (p=="libxml2" && v=="2.13.9-r5") found++ \
      } END { exit(found!=1) }' /lib/apk/db/installed

# ENTRYPOINT, CMD, USER, ENV и VOLUME наследуются от base.
