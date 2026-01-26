package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestWebhookHandler_HandleRecordingReady_InvalidJSON(t *testing.T) {
	router := setupTestRouter()
	handler := NewWebhookHandler(nil, nil, nil)
	router.POST("/webhooks/recording", handler.HandleRecordingReady)

	body := bytes.NewBufferString(`{invalid json}`)
	req := httptest.NewRequest("POST", "/webhooks/recording", body)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	var response map[string]interface{}
	err := json.Unmarshal(w.Body.Bytes(), &response)
	require.NoError(t, err)
	assert.Contains(t, response["error"], "invalid webhook payload")
}

func TestWebhookHandler_HandleRecordingReady_NonCompletedStatus(t *testing.T) {
	router := setupTestRouter()
	handler := NewWebhookHandler(nil, nil, nil)
	router.POST("/webhooks/recording", handler.HandleRecordingReady)

	payload := RecordingStatusWebhook{
		Event: "recording.statusUpdate",
		Recording: RecordingWebhookData{
			ID:     "rec_123",
			Status: "RECORDING",
		},
		Meeting: MeetingWebhookData{
			ID:    "meet_456",
			Title: "Test Meeting",
		},
	}
	body, _ := json.Marshal(payload)

	req := httptest.NewRequest("POST", "/webhooks/recording", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	// Non-completed status is acknowledged with 200
	assert.Equal(t, http.StatusOK, w.Code)
	var response map[string]interface{}
	err := json.Unmarshal(w.Body.Bytes(), &response)
	require.NoError(t, err)
	assert.Equal(t, "status update acknowledged", response["message"])
	assert.Equal(t, "RECORDING", response["status"])
}

func TestWebhookHandler_HandleRecordingReady_CompletedNoURL(t *testing.T) {
	router := setupTestRouter()
	handler := NewWebhookHandler(nil, nil, nil)
	router.POST("/webhooks/recording", handler.HandleRecordingReady)

	payload := RecordingStatusWebhook{
		Event: "recording.statusUpdate",
		Recording: RecordingWebhookData{
			ID:     "rec_123",
			Status: "COMPLETED",
			// No DownloadURL
		},
		Meeting: MeetingWebhookData{
			ID: "meet_456",
		},
	}
	body, _ := json.Marshal(payload)

	req := httptest.NewRequest("POST", "/webhooks/recording", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	var response map[string]interface{}
	err := json.Unmarshal(w.Body.Bytes(), &response)
	require.NoError(t, err)
	assert.Contains(t, response["error"], "no download URL")
}

func TestRecordingStatusWebhook_JSONMarshaling(t *testing.T) {
	downloadURL := "https://storage.example.com/rec.mp4"
	fileSize := int64(1024000)

	webhook := RecordingStatusWebhook{
		Event: "recording.statusUpdate",
		Recording: RecordingWebhookData{
			ID:          "rec_123",
			DownloadURL: &downloadURL,
			FileSize:    &fileSize,
			SessionID:   "sess_456",
			Status:      "COMPLETED",
		},
		Meeting: MeetingWebhookData{
			ID:    "meet_789",
			Title: "Test Meeting",
		},
	}

	data, err := json.Marshal(webhook)
	require.NoError(t, err)

	var parsed RecordingStatusWebhook
	err = json.Unmarshal(data, &parsed)
	require.NoError(t, err)
	assert.Equal(t, webhook.Event, parsed.Event)
	assert.Equal(t, webhook.Recording.ID, parsed.Recording.ID)
	assert.Equal(t, webhook.Meeting.ID, parsed.Meeting.ID)
}

func TestRecordingStatusWebhook_JSONParsing(t *testing.T) {
	testCases := []struct {
		name    string
		json    string
		wantErr bool
	}{
		{
			name:    "valid payload",
			json:    `{"event": "recording.statusUpdate", "recording": {"id": "rec_123", "status": "COMPLETED"}, "meeting": {"id": "meet_456"}}`,
			wantErr: false,
		},
		{
			name:    "minimal payload",
			json:    `{"event": "recording.statusUpdate", "recording": {}, "meeting": {}}`,
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
			var webhook RecordingStatusWebhook
			err := json.Unmarshal([]byte(tc.json), &webhook)
			if tc.wantErr {
				assert.Error(t, err)
			} else {
				assert.NoError(t, err)
			}
		})
	}
}
