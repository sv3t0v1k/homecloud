# SEC-02: OCI-артефакт доставки Gitleaks.
# Сканирование выполняется в окружении CI runner.
FROM docker.io/library/alpine@sha256:0f49f331d9212aff11b932863be4eb01cdf962969aa86dab7d1ee21ac6f5f52b

COPY --chown=0:0 --chmod=0755 gitleaks /usr/bin/gitleaks

LABEL org.opencontainers.image.description="HomeCloud Gitleaks binary transport"

ENTRYPOINT ["/usr/bin/gitleaks"]
CMD ["version"]
