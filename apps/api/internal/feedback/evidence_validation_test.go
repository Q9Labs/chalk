package feedback

import (
	"encoding/json"
	"errors"
	"testing"
)

func TestEvidenceRejectsUnregisteredAndRawLocalState(t *testing.T) {
	request := feedbackRequestFixture()
	request.Evidence.LocalState.Entries = []FeedbackLocalStateEntry{{Key: "host.auth-token", Value: "secret"}}
	if _, _, _, err := request.validate(); !errors.Is(err, ErrInvalidEvidence) {
		t.Fatalf("unregistered state error = %v, want invalid evidence", err)
	}

	request = feedbackRequestFixture()
	request.Evidence.LocalState.Entries = []FeedbackLocalStateEntry{{Key: "chalk.web.telemetry.v1", Value: []any{map[string]any{"authorization": "Bearer secret"}}}}
	if _, _, _, err := request.validate(); !errors.Is(err, ErrInvalidEvidence) {
		t.Fatalf("raw telemetry state error = %v, want invalid evidence", err)
	}
}

func TestEvidenceAcceptsTypedLocalStateSummaries(t *testing.T) {
	request := feedbackRequestFixture()
	request.Evidence.LocalState.Entries = []FeedbackLocalStateEntry{
		{Key: "chalk.web.telemetry.v1", Value: map[string]any{"pending_count": 2, "timeline_count": 10}},
		{Key: "chalk.tenant-hint", Value: "11111111-1111-4111-8111-111111111111"},
		{Key: "chalk.dashboard-request.episode-end", Value: true},
	}
	if _, _, _, err := request.validate(); err != nil {
		t.Fatalf("typed local state: %v", err)
	}
}

func TestEvidenceRejectsSensitiveTelemetryAttributesAndMetadata(t *testing.T) {
	request := feedbackRequestFixture()
	request.Evidence.Diagnostics.TelemetryEvents = []json.RawMessage{json.RawMessage(`{"version":1,"event_id":"11111111-1111-4111-8111-111111111111","journey_id":"22222222-2222-4222-8222-222222222222","sequence":1,"occurred_at":"2026-08-19T12:00:00Z","name":"journey.started","phase":"root","state":"started","origin_kind":"client","first_observed_layer":"client","upstream_visibility":"local","attributes":{"authorization":"Bearer secret"}}`)}
	if _, _, _, err := request.validate(); !errors.Is(err, ErrInvalidEvidence) {
		t.Fatalf("sensitive telemetry error = %v, want invalid evidence", err)
	}

	request = feedbackRequestFixture()
	request.Evidence.Diagnostics.TelemetryEvents = []json.RawMessage{json.RawMessage(`{"version":1,"event_id":"11111111-1111-4111-8111-111111111111","journey_id":"22222222-2222-4222-8222-222222222222","sequence":1,"occurred_at":"2026-08-19T12:00:00Z","name":"journey.started","phase":"root","state":"started","origin_kind":"client","first_observed_layer":"client","upstream_visibility":"local","attributes":{"opaque_subject_id":"33333333-3333-4333-8333-333333333333"}}`)}
	if _, _, _, err := request.validate(); !errors.Is(err, ErrInvalidEvidence) {
		t.Fatalf("identifier telemetry error = %v, want invalid evidence", err)
	}

	request = feedbackRequestFixture()
	request.Evidence.Platform.DeviceModel = "https://attacker.invalid/collect"
	if _, _, _, err := request.validate(); !errors.Is(err, ErrInvalidEvidence) {
		t.Fatalf("unsafe metadata error = %v, want invalid evidence", err)
	}
}

func TestEvidenceRejectsCookieValuesAndSpoofedScreenshots(t *testing.T) {
	request := feedbackRequestFixture()
	request.Evidence.Cookies.Entries = []FeedbackCookieEntry{{Name: "account", Present: true, Value: "private-value"}}
	if _, _, _, err := request.validate(); !errors.Is(err, ErrInvalidEvidence) {
		t.Fatalf("account cookie error = %v, want invalid evidence", err)
	}

	request = feedbackRequestFixture()
	request.Evidence.Screenshot = FeedbackScreenshotState{State: "captured", CapturedAt: "2026-08-19T12:00:00Z"}
	request.Screenshot = &FeedbackScreenshot{SchemaVersion: ScreenshotSchemaVersion, MimeType: "image/png", Width: 1, Height: 1, CapturedAt: "2026-08-19T12:00:00Z", DataBase64: "bm90LWEtcG5n"}
	if _, _, _, err := request.validate(); !errors.Is(err, ErrInvalidScreenshot) {
		t.Fatalf("spoofed screenshot error = %v, want invalid screenshot", err)
	}
}
