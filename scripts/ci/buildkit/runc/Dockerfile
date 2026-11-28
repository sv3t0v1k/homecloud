# SEC-02: сборка runc с сохранением seccomp.
FROM docker.io/library/golang@sha256:70bd7ddea8b6cbe5d6943cde279d6b67feb10cc924fb9100d1d8757c1575b280 AS builder

ENV GOENV=off \
    GOWORK=off \
    GOTOOLCHAIN=local \
    GOPROXY=https://proxy.golang.org \
    GOSUMDB=sum.golang.org \
    CGO_ENABLED=1 \
    GOAMD64=v1

RUN apk add --no-cache \
    gcc=15.2.0-r5 \
    musl-dev=1.2.6-r3 \
    libseccomp-dev=2.6.1-r0 \
    libseccomp-static=2.6.1-r0 \
    pkgconf=2.5.1-r0 \
    binutils=2.45.1-r1 \
    file=5.47-r2

WORKDIR /src

COPY . .

RUN test "$(go env GOVERSION)" = go1.27.4 \
    && test "$(go env GOOS)/$(go env GOARCH)" = linux/amd64 \
    && mkdir /out \
    && apk list --installed | LC_ALL=C sort > /out/builder-packages.txt

RUN go build \
    -p=2 \
    -mod=readonly \
    -trimpath \
    -buildvcs=false \
    -tags 'apparmor seccomp netgo cgo static_build osusergo' \
    -ldflags "-extldflags -static -X main.gitCommit=29dd3dc2b13b4123162e5fe132504bb4b15569f1" \
    -o /out/buildkit-runc \
    .

RUN go mod verify \
    && go version -m /out/buildkit-runc > /out/runc-buildinfo.txt \
    && /out/buildkit-runc --version > /out/runc-version.txt \
    && file /out/buildkit-runc > /out/runc-elf.txt \
    && readelf -l /out/buildkit-runc > /out/runc-program-headers.txt \
    && sha256sum go.mod go.sum > /out/dependencies.sha256

FROM scratch AS export
COPY --from=builder /out/ /
