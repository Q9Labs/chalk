package recordernodebootstrap

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
)

type responseError struct {
	status int
}

type stepError struct {
	step string
	err  error
}

func (e stepError) Error() string { return e.err.Error() }

func (e stepError) Unwrap() error { return e.err }

func (e responseError) Error() string {
	return fmt.Sprintf("bootstrap endpoint returned status %d", e.status)
}

func httpStatus(err error) int {
	var response responseError
	if errors.As(err, &response) {
		return response.status
	}
	return 0
}

func reasonCode(err error, fallback string) string {
	if httpStatus(err) != 0 {
		return "http_status"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "deadline_exceeded"
	}
	return fallback
}

func diagnosticFor(err error, attempt int) recorderfleet.BootstrapDiagnostic {
	step := "bootstrap"
	var failedStep stepError
	if errors.As(err, &failedStep) {
		step = failedStep.step
	}
	reason := reasonCode(err, step+"_unavailable")
	return recorderfleet.BootstrapDiagnostic{
		SchemaVersion: recorderfleet.BootstrapDiagnosticSchemaVersion, Step: step,
		AttemptCount: uint32(attempt), LastReasonCode: reason, LastHTTPStatus: httpStatus(err),
	}
}

func logStep(step string, attempt int, reason string, status int, _ error) {
	attributes := []any{"step", step, "attempt", attempt, "reason_code", reason, "last_http_status", status}
	slog.Info("recorder node bootstrap step", attributes...)
}
