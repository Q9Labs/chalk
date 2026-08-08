package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/status"
)

func TestStatusRepositoryFailsClosedWithoutPool(t *testing.T) {
	repository := NewStatusRepository(nil)
	if _, err := repository.Append(context.Background(), status.MonitorResult{}); !errors.Is(err, status.ErrStatusUnavailable) {
		t.Fatalf("append error = %v, want status unavailable", err)
	}
	if _, err := repository.Current(context.Background()); !errors.Is(err, status.ErrStatusUnavailable) {
		t.Fatalf("current error = %v, want status unavailable", err)
	}
}

func TestStatusResultParamsPreserveNullableFieldsAndTimestamps(t *testing.T) {
	checkedAt := time.Date(2026, 8, 8, 11, 59, 0, 0, time.UTC)
	input := status.MonitorResult{
		ResultKey:         "run-1:api.health",
		RunID:             "run-1",
		MonitorKey:        "api.health",
		Status:            "healthy",
		CheckedAt:         checkedAt,
		EventAt:           checkedAt,
		LatencyMS:         12,
		ReportedSource:    "test",
		ReportedEmitterID: "emitter",
		ReceivedAt:        checkedAt.Add(time.Second),
	}
	params := statusResultParams(input)
	if params.HttpStatus.Valid || params.ErrorCode.Valid || params.Metadata == nil || params.Details == nil {
		t.Fatalf("params nullable fields = %#v, want null status/errors and object JSON", params)
	}
	if !params.CheckedAt.Time.Equal(checkedAt) || !params.ReceivedAt.Time.Equal(checkedAt.Add(time.Second)) {
		t.Fatalf("params timestamps = %#v", params)
	}
}
