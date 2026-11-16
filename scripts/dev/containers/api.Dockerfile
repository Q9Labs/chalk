ARG GO_VERSION
FROM golang:${GO_VERSION}-bookworm
RUN apt-get update && apt-get install --yes --no-install-recommends openssl ca-certificates python3 && rm -rf /var/lib/apt/lists/*
ENV GOCACHE=/cache/go-build GOMODCACHE=/cache/go-mod GOTOOLCHAIN=local
WORKDIR /workspace/apps/api
