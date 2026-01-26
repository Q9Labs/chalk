package jobs

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/Q9Labs/chalk/internal/domain/webhook"
)

func TestWebhookDelivery_SignatureVerification(t *testing.T) {
	secret := "whsec_test_secret_for_verification"
	var mu sync.Mutex
	var capturedSignature string
	var capturedTimestamp string

	// Create a test server that captures webhook requests
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()

		capturedSignature = r.Header.Get("X-Chalk-Signature")
		capturedTimestamp = r.Header.Get("X-Chalk-Timestamp")
		_, _ = io.ReadAll(r.Body)

		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	// Create test payload
	payload := webhook.WebhookPayload{
		Event:     "meeting.recording_ready",
		Timestamp: "2024-01-15T10:30:00Z",
		Meeting: webhook.MeetingInfo{
			ID:               "test-room-id",
			Name:             "Test Meeting",
			StartedAt:        "2024-01-15T09:00:00Z",
			EndedAt:          "2024-01-15T10:00:00Z",
			DurationSeconds:  3600,
			ParticipantCount: 5,
		},
	}

	payloadBytes, _ := json.Marshal(payload)

	// Simulate webhook delivery
	req, _ := http.NewRequest("POST", server.URL, nil)

	// Generate signature like the worker would
	timestamp := int64(1705318200) // Fixed timestamp for test
	signature := webhook.GenerateSignature(secret, timestamp, payloadBytes)

	// Verify signature format
	if len(signature) != 71 { // sha256= + 64 hex chars
		t.Errorf("unexpected signature length: %d", len(signature))
	}

	// Verify the signature is valid
	if !webhook.VerifySignature(secret, timestamp, payloadBytes, signature) {
		t.Error("generated signature should verify correctly")
	}

	t.Logf("Generated signature: %s", signature)
	t.Logf("Payload: %s", string(payloadBytes))

	// Verify with wrong secret fails
	if webhook.VerifySignature("wrong_secret", timestamp, payloadBytes, signature) {
		t.Error("signature should not verify with wrong secret")
	}

	// Send actual request
	req, _ = http.NewRequest("POST", server.URL, nil)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Chalk-Signature", signature)
	req.Header.Set("X-Chalk-Timestamp", "1705318200")

	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Errorf("expected status 200, got %d", resp.StatusCode)
	}

	// Verify captured headers
	mu.Lock()
	defer mu.Unlock()
	if capturedSignature == "" {
		t.Error("expected X-Chalk-Signature header")
	}
	if capturedTimestamp == "" {
		t.Error("expected X-Chalk-Timestamp header")
	}
	t.Logf("Captured signature: %s", capturedSignature)
	t.Logf("Captured timestamp: %s", capturedTimestamp)
}

func TestWebhookPayload_JSONFormat(t *testing.T) {
	payload := webhook.WebhookPayload{
		Event:     "meeting.recording_ready",
		Timestamp: "2024-01-15T10:30:00Z",
		Meeting: webhook.MeetingInfo{
			ID:               "room-123",
			Name:             "Physics 101",
			StartedAt:        "2024-01-15T09:00:00Z",
			EndedAt:          "2024-01-15T10:00:00Z",
			DurationSeconds:  3600,
			ParticipantCount: 25,
		},
		Recording: &webhook.RecordingInfo{
			ID:              "rec-456",
			DurationSeconds: 3600,
			SizeBytes:       524288000,
			DownloadURL:     "https://example.com/download",
			DownloadAPI:     "/api/v1/recordings/rec-456/download",
			ExpiresAt:       "2024-01-16T10:30:00Z",
		},
		Transcript: &webhook.TranscriptInfo{
			ID:        "trans-789",
			Text:      "Welcome to today's lecture...",
			WordCount: 5000,
			Language:  "en",
			Provider:  "groq",
		},
		Summary: strPtr("This meeting covered the fundamentals of physics."),
		ActionItems: []string{
			"Complete homework by Friday",
			"Read chapter 5",
		},
	}

	data, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		t.Fatalf("failed to marshal payload: %v", err)
	}

	t.Logf("Webhook payload:\n%s", string(data))

	// Verify it can be unmarshaled back
	var decoded webhook.WebhookPayload
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("failed to unmarshal payload: %v", err)
	}

	if decoded.Event != payload.Event {
		t.Errorf("event mismatch: %s != %s", decoded.Event, payload.Event)
	}

	if decoded.Meeting.Name != payload.Meeting.Name {
		t.Errorf("meeting name mismatch: %s != %s", decoded.Meeting.Name, payload.Meeting.Name)
	}

	if decoded.Recording == nil {
		t.Error("recording should not be nil")
	}

	if decoded.Transcript == nil {
		t.Error("transcript should not be nil")
	}

	if decoded.Summary == nil || *decoded.Summary == "" {
		t.Error("summary should not be empty")
	}

	if len(decoded.ActionItems) != 2 {
		t.Errorf("expected 2 action items, got %d", len(decoded.ActionItems))
	}
}

func strPtr(s string) *string {
	return &s
}
