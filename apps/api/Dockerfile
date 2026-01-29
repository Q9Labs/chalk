# Build stage
FROM golang:1.24-alpine AS builder

WORKDIR /app

# Install dependencies
RUN apk add --no-cache git ca-certificates

# Copy go mod files
COPY go.mod go.sum* ./
RUN go mod download

# Copy source code
COPY . .

# Build args for version stamping
ARG COMMIT_SHA=unknown
ARG BUILD_TIME=unknown

# Build the binary
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
    -ldflags="-w -s \
      -X github.com/Q9Labs/chalk/internal/version.CommitSHA=${COMMIT_SHA} \
      -X github.com/Q9Labs/chalk/internal/version.Version=${COMMIT_SHA} \
      -X github.com/Q9Labs/chalk/internal/version.BuildTime=${BUILD_TIME}" \
    -o /app/server \
    ./cmd/main.go

# Runtime stage
FROM alpine:3.19

WORKDIR /app

# Install ca-certificates for HTTPS and curl for health checks
RUN apk --no-cache add ca-certificates tzdata curl

# Copy binary from builder
COPY --from=builder /app/server /app/server

# Create non-root user
RUN adduser -D -g '' appuser
USER appuser

# Expose port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

# Run the binary
ENTRYPOINT ["/app/server"]
