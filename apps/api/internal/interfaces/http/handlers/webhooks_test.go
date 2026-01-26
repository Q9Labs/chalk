package handlers

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestWebhookHandler_HandleRecordingReady_MissingSignature(t *testing.T) {
	router := setupTestRouter()
	handler := NewWebhookHandler(nil, nil, nil)
	router.POST("/webhooks/recording", handler.HandleRecordingReady)

	body := bytes.NewBufferString(`{"type": "recording.ready"}`)
	req := httptest.NewRequest("POST", "/webhooks/recording", body)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	var response map[string]interface{}
	err := json.Unmarshal(w.Body.Bytes(), &response)
	require.NoError(t, err)
	assert.Equal(t, "missing signature", response["error"])
}

func TestWebhookHandler_HandleRecordingReady_InvalidSignature(t *testing.T) {
	// Set a test secret
	os.Setenv("CLOUDFLARE_WEBHOOK_SECRET", "test-secret")
	defer os.Unsetenv("CLOUDFLARE_WEBHOOK_SECRET")

	router := setupTestRouter()
	handler := NewWebhookHandler(nil, nil, nil)
	router.POST("/webhooks/recording", handler.HandleRecordingReady)

	body := bytes.NewBufferString(`{"type": "recording.ready"}`)
	req := httptest.NewRequest("POST", "/webhooks/recording", body)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Cloudflare-Signature", "invalid-signature")
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
	var response map[string]interface{}
	err := json.Unmarshal(w.Body.Bytes(), &response)
	require.NoError(t, err)
	assert.Equal(t, "invalid signature", response["error"])
}

func TestWebhookHandler_HandleRecordingReady_NoSecret(t *testing.T) {
	// Ensure no secret is set
	os.Unsetenv("CLOUDFLARE_WEBHOOK_SECRET")

	router := setupTestRouter()
	handler := NewWebhookHandler(nil, nil, nil)
	router.POST("/webhooks/recording", handler.HandleRecordingReady)

	body := bytes.NewBufferString(`{"type": "recording.ready"}`)
	req := httptest.NewRequest("POST", "/webhooks/recording", body)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Cloudflare-Signature", "any-signature")
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
}

func TestWebhookHandler_HandleRecordingReady_AfterBodyRead(t *testing.T) {
	// API-HIGH-07: Body is now reset after signature verification, so binding succeeds.
	// This test verifies that non-recording.ready webhook types are rejected.
	secret := "test-secret"
	os.Setenv("CLOUDFLARE_WEBHOOK_SECRET", secret)
	defer os.Unsetenv("CLOUDFLARE_WEBHOOK_SECRET")

	router := setupTestRouter()
	handler := NewWebhookHandler(nil, nil, nil)
	router.POST("/webhooks/recording", handler.HandleRecordingReady)

	payload := `{"type": "meeting.ended"}`
	signature := computeHMAC([]byte(payload), secret)

	req := httptest.NewRequest("POST", "/webhooks/recording", bytes.NewBufferString(payload))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Cloudflare-Signature", signature)
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	// Body reset works, binding succeeds, but wrong webhook type is rejected
	assert.Equal(t, http.StatusBadRequest, w.Code)
	var response map[string]interface{}
	err := json.Unmarshal(w.Body.Bytes(), &response)
	require.NoError(t, err)
	assert.Contains(t, response["error"], "unsupported webhook type")
}

func TestWebhookHandler_verifySignatureBody_ValidSignature(t *testing.T) {
	secret := "test-secret-key"
	os.Setenv("CLOUDFLARE_WEBHOOK_SECRET", secret)
	defer os.Unsetenv("CLOUDFLARE_WEBHOOK_SECRET")

	handler := NewWebhookHandler(nil, nil, nil)
	body := []byte(`{"type": "recording.ready", "recording_id": "rec_123"}`)
	signature := computeHMAC(body, secret)

	result := handler.verifySignatureBody(body, signature)
	assert.True(t, result)
}

func TestWebhookHandler_verifySignatureBody_InvalidSignature(t *testing.T) {
	secret := "test-secret-key"
	os.Setenv("CLOUDFLARE_WEBHOOK_SECRET", secret)
	defer os.Unsetenv("CLOUDFLARE_WEBHOOK_SECRET")

	handler := NewWebhookHandler(nil, nil, nil)
	body := []byte(`{"type": "recording.ready"}`)

	result := handler.verifySignatureBody(body, "wrong-signature")
	assert.False(t, result)
}

func TestWebhookHandler_verifySignatureBody_EmptySecret(t *testing.T) {
	os.Unsetenv("CLOUDFLARE_WEBHOOK_SECRET")

	handler := NewWebhookHandler(nil, nil, nil)
	body := []byte(`{"type": "recording.ready"}`)
	signature := computeHMAC(body, "any-secret")

	result := handler.verifySignatureBody(body, signature)
	assert.False(t, result)
}

func TestWebhookHandler_verifySignatureBody_MalformedHex(t *testing.T) {
	secret := "test-secret"
	os.Setenv("CLOUDFLARE_WEBHOOK_SECRET", secret)
	defer os.Unsetenv("CLOUDFLARE_WEBHOOK_SECRET")

	handler := NewWebhookHandler(nil, nil, nil)
	body := []byte(`{"type": "recording.ready"}`)

	// Not valid hex
	result := handler.verifySignatureBody(body, "not-valid-hex-xyz")
	assert.False(t, result)
}

func TestRecordingReadyWebhook_JSONMarshaling(t *testing.T) {
	webhook := RecordingReadyWebhook{
		Type:        "recording.ready",
		RecordingID: "rec_123",
		MeetingID:   "meet_456",
		URL:         "https://storage.example.com/rec.webm",
		Duration:    3600,
		Size:        1024000,
		ContentType: "video/webm",
	}

	data, err := json.Marshal(webhook)
	require.NoError(t, err)

	var parsed RecordingReadyWebhook
	err = json.Unmarshal(data, &parsed)
	require.NoError(t, err)
	assert.Equal(t, webhook, parsed)
}

func TestRecordingReadyWebhook_JSONParsing(t *testing.T) {
	testCases := []struct {
		name    string
		json    string
		wantErr bool
	}{
		{
			name:    "valid payload",
			json:    `{"type": "recording.ready", "recording_id": "rec_123", "meeting_id": "meet_456", "url": "https://example.com/rec.webm", "duration_seconds": 300, "size_bytes": 1024, "content_type": "video/webm"}`,
			wantErr: false,
		},
		{
			name:    "minimal payload",
			json:    `{"type": "recording.ready"}`,
			wantErr: false,
		},
		{
			name:    "invalid json",
			json:    `{invalid}`,
			wantErr: true,
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			var webhook RecordingReadyWebhook
			err := json.Unmarshal([]byte(tc.json), &webhook)
			if tc.wantErr {
				assert.Error(t, err)
			} else {
				assert.NoError(t, err)
			}
		})
	}
}

// computeHMAC computes HMAC-SHA256 and returns hex-encoded string
func computeHMAC(body []byte, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}
