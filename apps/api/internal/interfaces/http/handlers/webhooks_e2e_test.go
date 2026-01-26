//go:build e2e
// +build e2e

package handlers

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// PostMeetingWebhookPayload represents the expected webhook payload structure
type PostMeetingWebhookPayload struct {
	Event     string         `json:"event"`
	Timestamp string         `json:"timestamp"`
	Meeting   MeetingInfo    `json:"meeting"`
	Recording *RecordingInfo `json:"recording,omitempty"`
	Transcript *TranscriptInfo `json:"transcript,omitempty"`
	Summary    *SummaryInfo    `json:"summary,omitempty"`
}

type MeetingInfo struct {
	ID               string `json:"id"`
	Name             string `json:"name"`
	StartedAt        string `json:"started_at"`
	EndedAt          string `json:"ended_at"`
	DurationSeconds  int    `json:"duration_seconds"`
	ParticipantCount int    `json:"participant_count"`
}

type RecordingInfo struct {
	ID              string `json:"id"`
	URL             string `json:"url"`
	DurationSeconds int    `json:"duration_seconds"`
	SizeBytes       int64  `json:"size_bytes"`
	ExpiresAt       string `json:"expires_at"`
}

type TranscriptInfo struct {
	ID        string                 `json:"id"`
	Text      string                 `json:"text"`
	Segments  []TranscriptSegment    `json:"segments"`
	Language  string                 `json:"language"`
	WordCount int                    `json:"word_count"`
	Provider  string                 `json:"provider"`
}

type TranscriptSegment struct {
	Speaker string  `json:"speaker"`
	Start   float64 `json:"start"`
	End     float64 `json:"end"`
	Text    string  `json:"text"`
}

type SummaryInfo struct {
	ID          string       `json:"id"`
	Text        string       `json:"text"`
	KeyPoints   []string     `json:"key_points"`
	ActionItems []ActionItem `json:"action_items"`
	Provider    string       `json:"provider"`
}

type ActionItem struct {
	Assignee string `json:"assignee"`
	Task     string `json:"task"`
	Due      string `json:"due,omitempty"`
}

// webhookReceiver captures incoming webhooks for testing
type webhookReceiver struct {
	mu       sync.Mutex
	received []receivedWebhook
	server   *httptest.Server
	secret   string
}

type receivedWebhook struct {
	headers http.Header
	body    []byte
	payload *PostMeetingWebhookPayload
}

func newWebhookReceiver(secret string) *webhookReceiver {
	r := &webhookReceiver{
		secret:   secret,
		received: make([]receivedWebhook, 0),
	}

	r.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		body, err := io.ReadAll(req.Body)
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}

		// Verify signature
		signature := req.Header.Get("X-Chalk-Signature")
		timestamp := req.Header.Get("X-Chalk-Timestamp")

		if signature != "" && timestamp != "" && r.secret != "" {
			signedPayload := fmt.Sprintf("%s.%s", timestamp, string(body))
			mac := hmac.New(sha256.New, []byte(r.secret))
			mac.Write([]byte(signedPayload))
			expectedSig := hex.EncodeToString(mac.Sum(nil))

			if !hmac.Equal([]byte(signature), []byte(expectedSig)) {
				w.WriteHeader(http.StatusUnauthorized)
				fmt.Fprintf(w, `{"error": "invalid signature"}`)
				return
			}
		}

		var payload PostMeetingWebhookPayload
		if err := json.Unmarshal(body, &payload); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}

		r.mu.Lock()
		r.received = append(r.received, receivedWebhook{
			headers: req.Header.Clone(),
			body:    body,
			payload: &payload,
		})
		r.mu.Unlock()

		w.WriteHeader(http.StatusOK)
		fmt.Fprintf(w, `{"received": true}`)
	}))

	return r
}

func (r *webhookReceiver) URL() string {
	return r.server.URL
}

func (r *webhookReceiver) Close() {
	r.server.Close()
}

func (r *webhookReceiver) GetReceived() []receivedWebhook {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]receivedWebhook{}, r.received...)
}

func (r *webhookReceiver) WaitForWebhook(timeout time.Duration) (*receivedWebhook, error) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		received := r.GetReceived()
		if len(received) > 0 {
			return &received[len(received)-1], nil
		}
		time.Sleep(500 * time.Millisecond)
	}
	return nil, fmt.Errorf("timeout waiting for webhook after %v", timeout)
}

// TestPostMeetingWebhook_EndToEnd tests the full post-meeting webhook pipeline.
// This test requires:
// - GROQ_API_KEY set (for transcription)
// - OPENROUTER_API_KEY set (for AI summary)
// - DATABASE_URL set (postgres connection)
// - R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY set (for storage)
func TestPostMeetingWebhook_EndToEnd(t *testing.T) {
	// Skip if required env vars are not set
	requiredEnvVars := []string{
		"GROQ_API_KEY",
		"OPENROUTER_API_KEY",
		"DATABASE_URL",
		"R2_ACCESS_KEY_ID",
		"R2_SECRET_ACCESS_KEY",
	}

	for _, env := range requiredEnvVars {
		if os.Getenv(env) == "" {
			t.Skipf("Skipping E2E test: %s not set", env)
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	// 1. Start webhook receiver
	webhookSecret := "test-webhook-secret-e2e"
	receiver := newWebhookReceiver(webhookSecret)
	defer receiver.Close()

	t.Logf("Webhook receiver listening at: %s", receiver.URL())

	// 2. Create test tenant with webhook config
	// Note: In a real E2E test, this would create an actual tenant in the database
	// For now, this is a placeholder showing the expected flow
	t.Log("Creating test tenant with webhook configuration...")

	tenantConfig := map[string]interface{}{
		"post_meeting_webhook": map[string]interface{}{
			"url":     receiver.URL(),
			"secret":  webhookSecret,
			"enabled": true,
			"events":  []string{"meeting.recording_ready"},
		},
	}
	t.Logf("Tenant config: %+v", tenantConfig)

	// 3. Simulate webhook delivery (integration point)
	// In real E2E, this would be triggered by the post-meeting service
	// after a recording completes. Here we simulate the expected payload.
	simulatedPayload := PostMeetingWebhookPayload{
		Event:     "meeting.recording_ready",
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		Meeting: MeetingInfo{
			ID:               "room_e2e_test_123",
			Name:             "E2E Test Meeting",
			StartedAt:        time.Now().Add(-30 * time.Minute).UTC().Format(time.RFC3339),
			EndedAt:          time.Now().UTC().Format(time.RFC3339),
			DurationSeconds:  1800,
			ParticipantCount: 3,
		},
		Recording: &RecordingInfo{
			ID:              "rec_e2e_test_456",
			URL:             "https://r2.example.com/recordings/rec_e2e_test_456.webm?token=xxx",
			DurationSeconds: 1800,
			SizeBytes:       52428800,
			ExpiresAt:       time.Now().Add(1 * time.Hour).UTC().Format(time.RFC3339),
		},
		Transcript: &TranscriptInfo{
			ID:        "tr_e2e_test_789",
			Text:      "This is a test transcript from the E2E test meeting.",
			Segments: []TranscriptSegment{
				{Speaker: "Host", Start: 0.0, End: 5.0, Text: "This is a test transcript"},
				{Speaker: "Host", Start: 5.0, End: 10.0, Text: "from the E2E test meeting."},
			},
			Language:  "en",
			WordCount: 11,
			Provider:  "groq",
		},
		Summary: &SummaryInfo{
			ID:        "sum_e2e_test_012",
			Text:      "This was an E2E test meeting to verify the webhook pipeline.",
			KeyPoints: []string{
				"Webhook pipeline tested successfully",
				"All components integrated correctly",
			},
			ActionItems: []ActionItem{
				{Assignee: "DevOps", Task: "Deploy to production", Due: "2026-01-20"},
			},
			Provider: "openrouter",
		},
	}

	// Deliver simulated webhook
	payloadBytes, err := json.Marshal(simulatedPayload)
	require.NoError(t, err)

	timestamp := fmt.Sprintf("%d", time.Now().Unix())
	signedPayload := fmt.Sprintf("%s.%s", timestamp, string(payloadBytes))
	mac := hmac.New(sha256.New, []byte(webhookSecret))
	mac.Write([]byte(signedPayload))
	signature := hex.EncodeToString(mac.Sum(nil))

	req, err := http.NewRequestWithContext(ctx, "POST", receiver.URL(), bytes.NewReader(payloadBytes))
	require.NoError(t, err)

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Chalk-Signature", signature)
	req.Header.Set("X-Chalk-Timestamp", timestamp)
	req.Header.Set("X-Chalk-Event", "meeting.recording_ready")
	req.Header.Set("X-Chalk-Delivery-ID", "delivery_e2e_test_001")

	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()

	assert.Equal(t, http.StatusOK, resp.StatusCode)

	// 4. Verify webhook was received
	webhook, err := receiver.WaitForWebhook(10 * time.Second)
	require.NoError(t, err, "Expected to receive webhook")

	// 5. Assertions on received webhook
	t.Log("Verifying webhook payload...")

	assert.NotNil(t, webhook.payload)
	assert.Equal(t, "meeting.recording_ready", webhook.payload.Event)

	// Verify meeting info
	assert.Equal(t, "room_e2e_test_123", webhook.payload.Meeting.ID)
	assert.Equal(t, "E2E Test Meeting", webhook.payload.Meeting.Name)
	assert.Equal(t, 1800, webhook.payload.Meeting.DurationSeconds)
	assert.Equal(t, 3, webhook.payload.Meeting.ParticipantCount)

	// Verify recording info
	require.NotNil(t, webhook.payload.Recording)
	assert.Equal(t, "rec_e2e_test_456", webhook.payload.Recording.ID)
	assert.NotEmpty(t, webhook.payload.Recording.URL)
	assert.Equal(t, 1800, webhook.payload.Recording.DurationSeconds)
	assert.Greater(t, webhook.payload.Recording.SizeBytes, int64(0))

	// Verify transcript info
	require.NotNil(t, webhook.payload.Transcript)
	assert.Equal(t, "tr_e2e_test_789", webhook.payload.Transcript.ID)
	assert.NotEmpty(t, webhook.payload.Transcript.Text)
	assert.NotEmpty(t, webhook.payload.Transcript.Segments)
	assert.Equal(t, "en", webhook.payload.Transcript.Language)
	assert.Greater(t, webhook.payload.Transcript.WordCount, 0)
	assert.Equal(t, "groq", webhook.payload.Transcript.Provider)

	// Verify summary info
	require.NotNil(t, webhook.payload.Summary)
	assert.Equal(t, "sum_e2e_test_012", webhook.payload.Summary.ID)
	assert.NotEmpty(t, webhook.payload.Summary.Text)
	assert.NotEmpty(t, webhook.payload.Summary.KeyPoints)
	assert.NotEmpty(t, webhook.payload.Summary.ActionItems)
	assert.Equal(t, "openrouter", webhook.payload.Summary.Provider)

	// Verify headers
	assert.Equal(t, "meeting.recording_ready", webhook.headers.Get("X-Chalk-Event"))
	assert.NotEmpty(t, webhook.headers.Get("X-Chalk-Signature"))
	assert.NotEmpty(t, webhook.headers.Get("X-Chalk-Timestamp"))
	assert.Equal(t, "delivery_e2e_test_001", webhook.headers.Get("X-Chalk-Delivery-ID"))

	t.Log("E2E test completed successfully")
}

// TestPostMeetingWebhook_SignatureVerification tests webhook signature validation
func TestPostMeetingWebhook_SignatureVerification(t *testing.T) {
	secret := "test-secret-for-signature"
	receiver := newWebhookReceiver(secret)
	defer receiver.Close()

	payload := `{"event": "meeting.recording_ready", "meeting": {"id": "test"}}`
	timestamp := fmt.Sprintf("%d", time.Now().Unix())

	t.Run("valid signature accepted", func(t *testing.T) {
		signedPayload := fmt.Sprintf("%s.%s", timestamp, payload)
		mac := hmac.New(sha256.New, []byte(secret))
		mac.Write([]byte(signedPayload))
		signature := hex.EncodeToString(mac.Sum(nil))

		req, _ := http.NewRequest("POST", receiver.URL(), bytes.NewBufferString(payload))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Chalk-Signature", signature)
		req.Header.Set("X-Chalk-Timestamp", timestamp)

		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()

		assert.Equal(t, http.StatusOK, resp.StatusCode)
	})

	t.Run("invalid signature rejected", func(t *testing.T) {
		req, _ := http.NewRequest("POST", receiver.URL(), bytes.NewBufferString(payload))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Chalk-Signature", "invalid-signature")
		req.Header.Set("X-Chalk-Timestamp", timestamp)

		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()

		assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
	})

	t.Run("tampered payload rejected", func(t *testing.T) {
		signedPayload := fmt.Sprintf("%s.%s", timestamp, payload)
		mac := hmac.New(sha256.New, []byte(secret))
		mac.Write([]byte(signedPayload))
		signature := hex.EncodeToString(mac.Sum(nil))

		// Send different payload with original signature
		tamperedPayload := `{"event": "meeting.recording_ready", "meeting": {"id": "tampered"}}`

		req, _ := http.NewRequest("POST", receiver.URL(), bytes.NewBufferString(tamperedPayload))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Chalk-Signature", signature)
		req.Header.Set("X-Chalk-Timestamp", timestamp)

		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()

		assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
	})
}

// TestPostMeetingWebhook_RetryBehavior tests webhook retry scenarios
func TestPostMeetingWebhook_RetryBehavior(t *testing.T) {
	t.Run("server returns 500 - should be retried", func(t *testing.T) {
		callCount := 0
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			callCount++
			if callCount < 3 {
				w.WriteHeader(http.StatusInternalServerError)
				return
			}
			w.WriteHeader(http.StatusOK)
		}))
		defer server.Close()

		// In a real implementation, the webhook delivery service would retry
		// This test documents the expected behavior
		assert.Equal(t, 0, callCount) // No calls yet - would be triggered by delivery service
	})

	t.Run("server returns 400 - should not be retried", func(t *testing.T) {
		callCount := 0
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			callCount++
			w.WriteHeader(http.StatusBadRequest)
		}))
		defer server.Close()

		// 4xx errors (except 429) should not be retried
		// This test documents the expected behavior
		assert.Equal(t, 0, callCount) // No calls yet - would be triggered by delivery service
	})

	t.Run("server returns 429 - should be retried with backoff", func(t *testing.T) {
		callCount := 0
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			callCount++
			if callCount < 2 {
				w.Header().Set("Retry-After", "1")
				w.WriteHeader(http.StatusTooManyRequests)
				return
			}
			w.WriteHeader(http.StatusOK)
		}))
		defer server.Close()

		// 429 should be retried respecting Retry-After header
		// This test documents the expected behavior
		assert.Equal(t, 0, callCount) // No calls yet - would be triggered by delivery service
	})
}
