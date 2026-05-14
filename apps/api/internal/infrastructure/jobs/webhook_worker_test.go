package jobs

import (
	"encoding/json"
	"testing"

	"github.com/Q9Labs/chalk/internal/domain/webhook"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
)

func TestMinInt(t *testing.T) {
	tests := []struct {
		a, b     int
		expected int
	}{
		{1, 2, 1},
		{5, 3, 3},
		{0, 0, 0},
		{-1, 1, -1},
	}

	for _, tc := range tests {
		result := minInt(tc.a, tc.b)
		if result != tc.expected {
			t.Errorf("minInt(%d, %d) = %d, want %d", tc.a, tc.b, result, tc.expected)
		}
	}
}

func TestExtractWebhookSecret(t *testing.T) {
	tests := []struct {
		name     string
		config   []byte
		expected string
		wantErr  bool
	}{
		{
			name:     "nil config",
			config:   nil,
			expected: "",
			wantErr:  false,
		},
		{
			name:     "empty config",
			config:   []byte("{}"),
			expected: "",
			wantErr:  false,
		},
		{
			name:     "config without webhook",
			config:   []byte(`{"some_other_key": "value"}`),
			expected: "",
			wantErr:  false,
		},
		{
			name:     "config with webhook but no secret",
			config:   []byte(`{"post_meeting_webhook": {"enabled": true}}`),
			expected: "",
			wantErr:  false,
		},
		{
			name:     "config with webhook and secret",
			config:   []byte(`{"post_meeting_webhook": {"enabled": true, "secret": "whsec_test123"}}`),
			expected: "whsec_test123",
			wantErr:  false,
		},
		{
			name:     "invalid json",
			config:   []byte(`{invalid json`),
			expected: "",
			wantErr:  true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			secret, err := webhook.ExtractWebhookSecret(tc.config)
			if (err != nil) != tc.wantErr {
				t.Errorf("extractWebhookSecret() error = %v, wantErr %v", err, tc.wantErr)
				return
			}
			if secret != tc.expected {
				t.Errorf("extractWebhookSecret() = %q, want %q", secret, tc.expected)
			}
		})
	}
}

func TestAnnotateWebhookDeliveryPayload(t *testing.T) {
	recordingID := uuid.New()
	transcriptID := uuid.New()
	summary := "  lesson summary  "
	payloadBytes, err := json.Marshal(webhook.WebhookPayload{
		Event:     "meeting.recording_ready",
		Timestamp: "2026-03-17T00:00:00Z",
		Meeting: webhook.MeetingInfo{
			ID:               "meeting-123",
			Name:             "Algebra",
			ParticipantCount: 3,
		},
		Recording: &webhook.RecordingInfo{
			ID:              recordingID.String(),
			DurationSeconds: 912,
			SizeBytes:       2048,
			DownloadURL:     "https://files.example.com/recording.mp4",
		},
		Transcript: &webhook.TranscriptInfo{
			ID:        transcriptID.String(),
			Text:      "hello world",
			WordCount: 2,
			Language:  "en",
			Provider:  "whisper",
			Segments: []webhook.Segment{
				{Start: 0, End: 1, Text: "hello"},
			},
		},
		Summary:     &summary,
		ActionItems: []string{"follow up"},
		Errors: []webhook.ErrorInfo{
			{Field: "summary", Code: "missing", Message: "summary missing"},
		},
	})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}

	evt := map[string]any{}
	annotateWebhookDeliveryPayload(evt, db.WebhookDelivery{
		RecordingID:  pgtype.UUID{Bytes: recordingID, Valid: true},
		TranscriptID: pgtype.UUID{Bytes: transcriptID, Valid: true},
		Payload:      payloadBytes,
	})

	if got := evt["meeting_id"]; got != "meeting-123" {
		t.Fatalf("meeting_id = %v, want meeting-123", got)
	}
	if got := evt["meeting_name"]; got != "Algebra" {
		t.Fatalf("meeting_name = %v, want Algebra", got)
	}
	if got := evt["participant_count"]; got != 3 {
		t.Fatalf("participant_count = %v, want 3", got)
	}
	if got := evt["has_recording"]; got != true {
		t.Fatalf("has_recording = %v, want true", got)
	}
	if got := evt["has_transcript"]; got != true {
		t.Fatalf("has_transcript = %v, want true", got)
	}
	if got := evt["has_summary"]; got != true {
		t.Fatalf("has_summary = %v, want true", got)
	}
	if got := evt["has_action_items"]; got != true {
		t.Fatalf("has_action_items = %v, want true", got)
	}
	if got := evt["has_errors"]; got != true {
		t.Fatalf("has_errors = %v, want true", got)
	}
	if got := evt["summary_length"]; got != len("lesson summary") {
		t.Fatalf("summary_length = %v, want %d", got, len("lesson summary"))
	}
	if got := evt["transcript_chars"]; got != len("hello world") {
		t.Fatalf("transcript_chars = %v, want %d", got, len("hello world"))
	}
	if got := evt["segments_count"]; got != 1 {
		t.Fatalf("segments_count = %v, want 1", got)
	}
	if got := evt["audio_url_host"]; got != "files.example.com" {
		t.Fatalf("audio_url_host = %v, want files.example.com", got)
	}
	if got := evt["audio_url_scheme"]; got != "https" {
		t.Fatalf("audio_url_scheme = %v, want https", got)
	}
}

func TestAnnotateWebhookDeliveryPayloadParseError(t *testing.T) {
	recordingID := uuid.New()
	evt := map[string]any{}

	annotateWebhookDeliveryPayload(evt, db.WebhookDelivery{
		RecordingID: pgtype.UUID{Bytes: recordingID, Valid: true},
		Payload:     []byte(`{"bad-json"`),
	})

	if got := evt["recording_id"]; got != recordingID {
		t.Fatalf("recording_id = %v, want %v", got, recordingID)
	}
	if _, ok := evt["payload_parse_error"]; !ok {
		t.Fatal("expected payload_parse_error to be set")
	}
}
