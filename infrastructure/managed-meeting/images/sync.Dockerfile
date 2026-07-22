# syntax=docker/dockerfile:1.7

ARG ELIXIR_IMAGE=elixir:1.19.5-otp-28-slim@sha256:7967159aa3314fb0f559d1c0da85e04e0dc99377264297a252173e7306b26169
ARG GO_IMAGE=golang:1.25.12-bookworm@sha256:ea341baa9bd5ba6784f6d7161ace70544349a6242d54d34a0fbfd2c4d51c9d58

FROM --platform=$BUILDPLATFORM ${GO_IMAGE} AS healthcheck
ARG TARGETARCH
ARG TARGETOS
WORKDIR /src
COPY images/healthcheck/main.go ./main.go
RUN CGO_ENABLED=0 GOARCH=$TARGETARCH GOOS=$TARGETOS \
    go build -trimpath -ldflags='-s -w' -o /out/chalk-healthcheck ./main.go

FROM --platform=$TARGETPLATFORM ${ELIXIR_IMAGE} AS build
ENV MIX_ENV=prod
WORKDIR /src

COPY --from=healthcheck /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
RUN mix local.hex --force && mix local.rebar --force
COPY --from=sync_source mix.exs mix.lock ./
RUN mix deps.get --only prod && mix deps.compile

COPY --from=sync_source config ./config
COPY --from=sync_source lib ./lib
RUN mix compile --warnings-as-errors && \
    mix release --path /out/chalk_sync

FROM --platform=$TARGETPLATFORM ${ELIXIR_IMAGE}
ARG RELEASE_ID
ARG SOURCE_REVISION
LABEL org.opencontainers.image.description="Chalk WebSocket SyncEngine" \
      org.opencontainers.image.revision=$SOURCE_REVISION \
      org.opencontainers.image.source="https://github.com/q9labs/chalk" \
      org.opencontainers.image.title="chalk-sync" \
      org.opencontainers.image.version=$RELEASE_ID

RUN groupadd --gid 65532 chalk && \
    useradd --uid 65532 --gid 65532 --home-dir /opt/chalk --no-create-home --shell /usr/sbin/nologin chalk
COPY --from=healthcheck /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build --chown=65532:65532 /out/chalk_sync /opt/chalk
COPY --from=healthcheck /out/chalk-healthcheck /usr/local/bin/chalk-healthcheck

ENV ERL_CRASH_DUMP=/tmp/erl_crash.dump \
    HOME=/tmp \
    MIX_ENV=prod
WORKDIR /opt/chalk
USER 65532:65532
EXPOSE 4100
ENTRYPOINT ["/opt/chalk/bin/chalk_sync"]
CMD ["start"]
