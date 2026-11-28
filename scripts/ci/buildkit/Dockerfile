# SEC-02: исправленные BuildKit, CNI и runc.
# Исходный buildctl и конфигурация образа сохраняются.
FROM docker.io/moby/buildkit@sha256:7583a0667093d941826bcd1d2878d6a360dfd08a82c93e6d6a6f6cce78801e12

COPY --chown=0:0 --chmod=0755 buildkit-cni-bridge buildkit-cni-firewall buildkit-cni-host-local buildkit-cni-loopback buildkitd buildkit-runc /usr/bin/
