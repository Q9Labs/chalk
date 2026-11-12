package httpapi

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

func publicInviteTelemetry(operation string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			tracer := otel.Tracer("github.com/q9labs/chalk/apps/api/internal/httpapi/public_invites")
			ctx, span := tracer.Start(r.Context(), "public_invite."+operation, trace.WithAttributes(
				attribute.String("chalk.public_invite.operation", operation),
			))
			recorder := &publicInviteResponseRecorder{ResponseWriter: w}
			next.ServeHTTP(recorder, r.WithContext(ctx))
			status := recorder.status
			if status == 0 {
				status = http.StatusOK
			}
			outcome, reason := publicInviteRouteResult(status)
			span.SetAttributes(
				attribute.Int("http.response.status_code", status),
				attribute.String("chalk.public_invite.outcome", outcome),
				attribute.String("chalk.public_invite.reason", reason),
			)
			if outcome != "succeeded" {
				span.SetStatus(codes.Error, reason)
			}
			slog.Default().Log(ctx, publicInviteLogLevel(outcome), "public invite request",
				"event", "public_invite.request",
				"operation", operation,
				"outcome", outcome,
				"reason", reason,
				"status", status,
			)
			span.End()
		})
	}
}

type publicInviteResponseRecorder struct {
	http.ResponseWriter
	status int
}

func (r *publicInviteResponseRecorder) Unwrap() http.ResponseWriter {
	return r.ResponseWriter
}

func (r *publicInviteResponseRecorder) WriteHeader(status int) {
	if r.status != 0 {
		return
	}
	r.status = status
	r.ResponseWriter.WriteHeader(status)
}

func (r *publicInviteResponseRecorder) Write(body []byte) (int, error) {
	if r.status == 0 {
		r.WriteHeader(http.StatusOK)
	}
	return r.ResponseWriter.Write(body)
}

func publicInviteRouteResult(status int) (string, string) {
	switch {
	case status >= http.StatusInternalServerError:
		return "failed", "server_error"
	case status == http.StatusUnauthorized:
		return "rejected", "unauthenticated"
	case status == http.StatusForbidden:
		return "rejected", "forbidden"
	case status == http.StatusNotFound:
		return "rejected", "not_found"
	case status == http.StatusBadRequest:
		return "rejected", "invalid_request"
	case status == http.StatusConflict:
		return "rejected", "conflict"
	case status == http.StatusTooManyRequests:
		return "rejected", "rate_limited"
	case status >= http.StatusBadRequest:
		return "rejected", "client_error"
	default:
		return "succeeded", "none"
	}
}

func publicInviteLogLevel(outcome string) slog.Level {
	if outcome == "succeeded" {
		return slog.LevelInfo
	}
	if outcome == "rejected" {
		return slog.LevelWarn
	}
	return slog.LevelError
}

func principalUserID(ctx context.Context) utilities.ID {
	principal, ok := authentication.PrincipalFromContext(ctx)
	if !ok || principal.Kind != authentication.PrincipalUser {
		return utilities.ID{}
	}
	return principal.UserID
}
