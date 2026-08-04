# syntax=docker/dockerfile:1.7

ARG GO_IMAGE=golang:1.25.12-bookworm@sha256:ea341baa9bd5ba6784f6d7161ace70544349a6242d54d34a0fbfd2c4d51c9d58

FROM --platform=$BUILDPLATFORM ${GO_IMAGE} AS build
ARG TARGETARCH
ARG TARGETOS
WORKDIR /src

COPY --from=api_source go.mod go.sum ./
COPY --from=api_source . ./
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOARCH=$TARGETARCH GOOS=$TARGETOS \
    go build -trimpath -ldflags='-s -w' -o /out/chalk-api ./cmd

COPY images/healthcheck/main.go /healthcheck/main.go
RUN CGO_ENABLED=0 GOARCH=$TARGETARCH GOOS=$TARGETOS \
    go build -trimpath -ldflags='-s -w' -o /out/chalk-healthcheck /healthcheck/main.go

FROM scratch
ARG RELEASE_ID
ARG SOURCE_REVISION
LABEL org.opencontainers.image.description="Chalk control-plane API" \
      org.opencontainers.image.revision=$SOURCE_REVISION \
      org.opencontainers.image.source="https://github.com/q9labs/chalk" \
      org.opencontainers.image.title="chalk-api" \
      org.opencontainers.image.version=$RELEASE_ID

COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /out/chalk-api /usr/local/bin/chalk-api
COPY --from=build /out/chalk-healthcheck /usr/local/bin/chalk-healthcheck

USER 65532:65532
EXPOSE 8080 8443
ENTRYPOINT ["/usr/local/bin/chalk-api"]
