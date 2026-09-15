# syntax=docker/dockerfile:1.7
ARG GO_IMAGE=golang:1.25.13-bookworm@sha256:e401dae1bf814e29204a8cb7915682e1780951e609ca0dd8865ee1937f510c48
FROM --platform=$BUILDPLATFORM ${GO_IMAGE} AS build
ARG TARGETARCH
ARG TARGETOS
WORKDIR /src
COPY --from=api_source . ./
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOARCH=$TARGETARCH GOOS=$TARGETOS \
    go build -trimpath -ldflags='-s -w' -o /out/recorder-fleet-controller ./cmd/recorder-fleet-controller
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOARCH=$TARGETARCH GOOS=$TARGETOS \
    go build -trimpath -ldflags='-s -w' -o /out/recorder-fleet-issuer ./cmd/recorder-fleet-issuer
FROM scratch
ARG RELEASE_ID
ARG SOURCE_REVISION
LABEL org.opencontainers.image.title="chalk-recorder-control" \
      org.opencontainers.image.description="Chalk colocated recording fleet control processes; no media worker" \
      org.opencontainers.image.revision=$SOURCE_REVISION \
      org.opencontainers.image.version=$RELEASE_ID \
      org.opencontainers.image.source="https://github.com/q9labs/chalk"
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /out/ /usr/local/bin/
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/recorder-fleet-controller"]
