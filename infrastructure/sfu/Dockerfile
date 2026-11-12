# syntax=docker/dockerfile:1.7
# Build context: features/media/sfu.

ARG GO_IMAGE=golang:1.26.10-bookworm@sha256:ee3901c61e423732605a51f1b8157c849ec01194ea0a274213b5202b2c11e7bf

FROM --platform=$BUILDPLATFORM ${GO_IMAGE} AS build
ARG TARGETARCH
ARG TARGETOS
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY cmd ./cmd
COPY internal ./internal
COPY protocol ./protocol
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOARCH=$TARGETARCH GOOS=$TARGETOS \
    go build -trimpath -buildvcs=false -ldflags='-s -w' -o /out/chalk-sfu ./cmd/sfu

FROM scratch
ARG SOURCE_REVISION
LABEL org.opencontainers.image.description="Chalk SFU media node" \
      org.opencontainers.image.revision=$SOURCE_REVISION \
      org.opencontainers.image.source="https://github.com/q9labs/chalk" \
      org.opencontainers.image.title="chalk-sfu"

# Root CAs, so the node can verify its OTLP endpoint over TLS.
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /out/chalk-sfu /usr/local/bin/chalk-sfu

USER 65532:65532
ENTRYPOINT ["/usr/local/bin/chalk-sfu"]
