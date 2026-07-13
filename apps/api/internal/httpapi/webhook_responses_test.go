package httpapi

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/webhooks"
)

func TestNewWebhookDeliveryDetailResponseMapsAttempts(t *testing.T) {
	startedAt := time.Date(2026, time.July, 13, 1, 2, 3, 4, time.FixedZone("test", 5*60*60))
	finishedAt := startedAt.Add(275 * time.Millisecond)
	latencyMilliseconds := 275
	httpStatus := 503
	errorCode := "http_5xx"
	attemptID := utilities.IDFromBytes([16]byte{15: 1})

	response := newWebhookDeliveryDetailResponse(webhooks.DeliveryDetail{
		Delivery: webhooks.Delivery{ID: utilities.IDFromBytes([16]byte{15: 2})},
		Event:    json.RawMessage(`{"event":"room.created"}`),
		Attempts: []webhooks.Attempt{{
			ID:                  attemptID,
			Number:              2,
			StartedAt:           startedAt,
			FinishedAt:          &finishedAt,
			LatencyMilliseconds: &latencyMilliseconds,
			Outcome:             "retryable_failure",
			HTTPStatus:          &httpStatus,
			ErrorCode:           &errorCode,
		}},
	})

	if len(response.Attempts) != 1 {
		t.Fatalf("attempt count = %d, want 1", len(response.Attempts))
	}
	got := response.Attempts[0]
	if got.ID != attemptID.String() || got.Number != 2 || got.StartedAt != startedAt.UTC().Format(time.RFC3339Nano) || got.FinishedAt == nil || *got.FinishedAt != finishedAt.UTC().Format(time.RFC3339Nano) || got.LatencyMilliseconds == nil || *got.LatencyMilliseconds != latencyMilliseconds || got.Outcome != "retryable_failure" || got.HTTPStatus == nil || *got.HTTPStatus != httpStatus || got.ErrorCode == nil || *got.ErrorCode != errorCode {
		t.Fatalf("mapped attempt = %#v", got)
	}
}
