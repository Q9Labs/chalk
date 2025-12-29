package cloudflare

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNewClient(t *testing.T) {
	cfg := Config{
		AccountID: "test-account",
		AppID:     "test-app",
		APIToken:  "test-token",
	}

	client := NewClient(cfg)

	assert.NotNil(t, client)
	assert.NotNil(t, client.httpClient)
	assert.Equal(t, "test-account", client.accountID)
	assert.Equal(t, "test-app", client.appID)
	assert.Equal(t, "test-token", client.apiToken)
}

func TestClient_Endpoint(t *testing.T) {
	cfg := Config{
		AccountID: "acc-123",
		AppID:     "app-456",
		APIToken:  "token",
	}

	client := NewClient(cfg)

	tests := []struct {
		name     string
		path     string
		expected string
	}{
		{
			name:     "meetings endpoint",
			path:     "/meetings",
			expected: "https://api.cloudflare.com/client/v4/accounts/acc-123/realtime/kit/app-456/meetings",
		},
		{
			name:     "specific meeting",
			path:     "/meetings/123",
			expected: "https://api.cloudflare.com/client/v4/accounts/acc-123/realtime/kit/app-456/meetings/123",
		},
		{
			name:     "participants",
			path:     "/meetings/123/participants",
			expected: "https://api.cloudflare.com/client/v4/accounts/acc-123/realtime/kit/app-456/meetings/123/participants",
		},
		{
			name:     "recordings",
			path:     "/recordings",
			expected: "https://api.cloudflare.com/client/v4/accounts/acc-123/realtime/kit/app-456/recordings",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			result := client.endpoint(tc.path)
			assert.Equal(t, tc.expected, result)
		})
	}
}

func TestRoleToPreset(t *testing.T) {
	tests := []struct {
		role     string
		expected string
	}{
		{"host", PresetHost},
		{"participant", PresetParticipant},
		{"", PresetParticipant},
		{"viewer", PresetParticipant}, // Unknown roles default to participant
	}

	for _, tc := range tests {
		t.Run(tc.role, func(t *testing.T) {
			result := RoleToPreset(tc.role)
			assert.Equal(t, tc.expected, result)
		})
	}
}

func TestPresetConstants(t *testing.T) {
	assert.Equal(t, "group_call_host", PresetHost)
	assert.Equal(t, "group_call_participant", PresetParticipant)
}

func TestMeetingStatusConstants(t *testing.T) {
	assert.Equal(t, "ACTIVE", MeetingStatusActive)
	assert.Equal(t, "ENDED", MeetingStatusEnded)
}

func TestRecordingStatusConstants(t *testing.T) {
	assert.Equal(t, "RECORDING", RecordingStatusRecording)
	assert.Equal(t, "STOPPED", RecordingStatusStopped)
	assert.Equal(t, "PROCESSING", RecordingStatusProcessing)
	assert.Equal(t, "COMPLETED", RecordingStatusCompleted)
	assert.Equal(t, "FAILED", RecordingStatusFailed)
}

// HTTP Mock Tests for Meeting Operations

func TestCreateMeeting_Success(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "POST", r.Method)
		assert.Equal(t, "Bearer test-token", r.Header.Get("Authorization"))

		meetingResp := Response[Meeting]{
			Success: true,
			Data: Meeting{
				ID:        "meeting-123",
				Title:     "Test Meeting",
				Status:    MeetingStatusActive,
				CreatedAt: time.Now(),
				UpdatedAt: time.Now(),
			},
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(meetingResp)
	}))
	defer server.Close()

	cfg := Config{
		AccountID: "acc-123",
		AppID:     "app-456",
		APIToken:  "test-token",
	}
	client := NewClient(cfg)
	client.baseURL = server.URL

	meeting, err := client.CreateMeeting(context.Background(), CreateMeetingRequest{
		Title:         "Test Meeting",
		RecordOnStart: false,
		PersistChat:   true,
	})

	require.NoError(t, err)
	assert.NotNil(t, meeting)
	assert.Equal(t, "meeting-123", meeting.ID)
	assert.Equal(t, "Test Meeting", meeting.Title)
	assert.Equal(t, MeetingStatusActive, meeting.Status)
}

func TestCreateMeeting_APIError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		meetingResp := Response[Meeting]{
			Success: false,
			Errors: []APIError{
				{
					Code:    "INVALID_REQUEST",
					Message: "Invalid title format",
				},
			},
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(meetingResp)
	}))
	defer server.Close()

	cfg := Config{
		AccountID: "acc-123",
		AppID:     "app-456",
		APIToken:  "test-token",
	}
	client := NewClient(cfg)
	client.baseURL = server.URL

	meeting, err := client.CreateMeeting(context.Background(), CreateMeetingRequest{
		Title: "Test Meeting",
	})

	assert.Error(t, err)
	assert.Nil(t, meeting)
	assert.Contains(t, err.Error(), "cloudflare API error")
}

func TestCreateMeeting_MalformedJSON(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{invalid json`))
	}))
	defer server.Close()

	cfg := Config{
		AccountID: "acc-123",
		AppID:     "app-456",
		APIToken:  "test-token",
	}
	client := NewClient(cfg)
	client.baseURL = server.URL

	meeting, err := client.CreateMeeting(context.Background(), CreateMeetingRequest{
		Title: "Test Meeting",
	})

	assert.Error(t, err)
	assert.Nil(t, meeting)
	assert.Contains(t, err.Error(), "decode response")
}

func TestGetMeeting_Success(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "GET", r.Method)

		meetingResp := Response[Meeting]{
			Success: true,
			Data: Meeting{
				ID:        "meeting-123",
				Title:     "Test Meeting",
				Status:    MeetingStatusActive,
				CreatedAt: time.Now(),
				UpdatedAt: time.Now(),
			},
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(meetingResp)
	}))
	defer server.Close()

	cfg := Config{
		AccountID: "acc-123",
		AppID:     "app-456",
		APIToken:  "test-token",
	}
	client := NewClient(cfg)
	client.baseURL = server.URL

	meeting, err := client.GetMeeting(context.Background(), "meeting-123")

	require.NoError(t, err)
	assert.NotNil(t, meeting)
	assert.Equal(t, "meeting-123", meeting.ID)
}

func TestGetMeeting_NotFound(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		meetingResp := Response[Meeting]{
			Success: false,
			Errors: []APIError{
				{
					Code:    "NOT_FOUND",
					Message: "Meeting not found",
				},
			},
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(meetingResp)
	}))
	defer server.Close()

	cfg := Config{
		AccountID: "acc-123",
		AppID:     "app-456",
		APIToken:  "test-token",
	}
	client := NewClient(cfg)
	client.baseURL = server.URL

	meeting, err := client.GetMeeting(context.Background(), "nonexistent")

	assert.Error(t, err)
	assert.Nil(t, meeting)
}

func TestEndMeeting_Success(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "PATCH", r.Method)

		meetingResp := Response[Meeting]{
			Success: true,
			Data: Meeting{
				ID:        "meeting-123",
				Title:     "Test Meeting",
				Status:    MeetingStatusEnded,
				CreatedAt: time.Now(),
				UpdatedAt: time.Now(),
			},
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(meetingResp)
	}))
	defer server.Close()

	cfg := Config{
		AccountID: "acc-123",
		AppID:     "app-456",
		APIToken:  "test-token",
	}
	client := NewClient(cfg)
	client.baseURL = server.URL

	meeting, err := client.EndMeeting(context.Background(), "meeting-123")

	require.NoError(t, err)
	assert.NotNil(t, meeting)
	assert.Equal(t, MeetingStatusEnded, meeting.Status)
}

func TestEndMeeting_APIError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		meetingResp := Response[Meeting]{
			Success: false,
			Errors: []APIError{
				{
					Code:    "INVALID_STATE",
					Message: "Meeting is already ended",
				},
			},
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(meetingResp)
	}))
	defer server.Close()

	cfg := Config{
		AccountID: "acc-123",
		AppID:     "app-456",
		APIToken:  "test-token",
	}
	client := NewClient(cfg)
	client.baseURL = server.URL

	meeting, err := client.EndMeeting(context.Background(), "meeting-123")

	assert.Error(t, err)
	assert.Nil(t, meeting)
}

// Participant Operation Tests

func TestAddParticipant_Success(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "POST", r.Method)

		participantResp := Response[Participant]{
			Success: true,
			Data: Participant{
				ID:               "participant-123",
				Name:             "John Doe",
				PresetName:       PresetParticipant,
				ClientSpecificID: "user-456",
				Token:            "auth-token-xyz",
			},
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(participantResp)
	}))
	defer server.Close()

	cfg := Config{
		AccountID: "acc-123",
		AppID:     "app-456",
		APIToken:  "test-token",
	}
	client := NewClient(cfg)
	client.baseURL = server.URL

	participant, err := client.AddParticipant(context.Background(), "meeting-123", AddParticipantRequest{
		Name:             "John Doe",
		PresetName:       PresetParticipant,
		ClientSpecificID: "user-456",
	})

	require.NoError(t, err)
	assert.NotNil(t, participant)
	assert.Equal(t, "participant-123", participant.ID)
	assert.Equal(t, "auth-token-xyz", participant.Token)
}

func TestAddParticipant_MalformedResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"success": true, "data":`))
	}))
	defer server.Close()

	cfg := Config{
		AccountID: "acc-123",
		AppID:     "app-456",
		APIToken:  "test-token",
	}
	client := NewClient(cfg)
	client.baseURL = server.URL

	participant, err := client.AddParticipant(context.Background(), "meeting-123", AddParticipantRequest{
		Name: "John Doe",
	})

	assert.Error(t, err)
	assert.Nil(t, participant)
}

func TestRemoveParticipant_Success(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "DELETE", r.Method)

		resp := Response[interface{}]{
			Success: true,
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
	defer server.Close()

	cfg := Config{
		AccountID: "acc-123",
		AppID:     "app-456",
		APIToken:  "test-token",
	}
	client := NewClient(cfg)
	client.baseURL = server.URL

	err := client.RemoveParticipant(context.Background(), "meeting-123", "participant-456")

	require.NoError(t, err)
}

func TestRemoveParticipant_NotFound(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := Response[interface{}]{
			Success: false,
			Errors: []APIError{
				{
					Code:    "NOT_FOUND",
					Message: "Participant not found",
				},
			},
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(resp)
	}))
	defer server.Close()

	cfg := Config{
		AccountID: "acc-123",
		AppID:     "app-456",
		APIToken:  "test-token",
	}
	client := NewClient(cfg)
	client.baseURL = server.URL

	err := client.RemoveParticipant(context.Background(), "meeting-123", "nonexistent")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "cloudflare error")
}

func TestRefreshParticipantToken_Success(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "POST", r.Method)

		participantResp := Response[Participant]{
			Success: true,
			Data: Participant{
				ID:               "participant-123",
				Name:             "John Doe",
				PresetName:       PresetParticipant,
				ClientSpecificID: "user-456",
				Token:            "new-auth-token-abc",
			},
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(participantResp)
	}))
	defer server.Close()

	cfg := Config{
		AccountID: "acc-123",
		AppID:     "app-456",
		APIToken:  "test-token",
	}
	client := NewClient(cfg)
	client.baseURL = server.URL

	participant, err := client.RefreshParticipantToken(context.Background(), "meeting-123", "participant-123")

	require.NoError(t, err)
	assert.NotNil(t, participant)
	assert.Equal(t, "new-auth-token-abc", participant.Token)
}

func TestRefreshParticipantToken_Error(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := Response[Participant]{
			Success: false,
			Errors: []APIError{
				{
					Code:    "SERVER_ERROR",
					Message: "Internal server error",
				},
			},
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(resp)
	}))
	defer server.Close()

	cfg := Config{
		AccountID: "acc-123",
		AppID:     "app-456",
		APIToken:  "test-token",
	}
	client := NewClient(cfg)
	client.baseURL = server.URL

	participant, err := client.RefreshParticipantToken(context.Background(), "meeting-123", "participant-123")

	assert.Error(t, err)
	assert.Nil(t, participant)
}

// Recording Operation Tests

func TestStartRecording_Success(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "POST", r.Method)

		recordingResp := Response[Recording]{
			Success: true,
			Data: Recording{
				ID:        "recording-123",
				MeetingID: "meeting-123",
				Status:    RecordingStatusRecording,
				StartedAt: func() *time.Time {
					t := time.Now()
					return &t
				}(),
			},
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(recordingResp)
	}))
	defer server.Close()

	cfg := Config{
		AccountID: "acc-123",
		AppID:     "app-456",
		APIToken:  "test-token",
	}
	client := NewClient(cfg)
	client.baseURL = server.URL

	recording, err := client.StartRecording(context.Background(), "meeting-123", StartRecordingRequest{
		RecordingConfig: &RecordingConfig{
			Codec:      "H264",
			AudioCodec: "OPUS",
		},
	})

	require.NoError(t, err)
	assert.NotNil(t, recording)
	assert.Equal(t, "recording-123", recording.ID)
	assert.Equal(t, RecordingStatusRecording, recording.Status)
}

func TestStartRecording_APIError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := Response[Recording]{
			Success: false,
			Errors: []APIError{
				{
					Code:    "INVALID_STATE",
					Message: "Recording already in progress",
				},
			},
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		json.NewEncoder(w).Encode(resp)
	}))
	defer server.Close()

	cfg := Config{
		AccountID: "acc-123",
		AppID:     "app-456",
		APIToken:  "test-token",
	}
	client := NewClient(cfg)
	client.baseURL = server.URL

	recording, err := client.StartRecording(context.Background(), "meeting-123", StartRecordingRequest{})

	assert.Error(t, err)
	assert.Nil(t, recording)
}

func TestStopRecording_Success(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "PUT", r.Method)

		recordingResp := Response[Recording]{
			Success: true,
			Data: Recording{
				ID:        "recording-123",
				MeetingID: "meeting-123",
				Status:    RecordingStatusStopped,
				StoppedAt: func() *time.Time {
					t := time.Now()
					return &t
				}(),
				Duration: 300,
				FileSize: 1024000,
			},
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(recordingResp)
	}))
	defer server.Close()

	cfg := Config{
		AccountID: "acc-123",
		AppID:     "app-456",
		APIToken:  "test-token",
	}
	client := NewClient(cfg)
	client.baseURL = server.URL

	recording, err := client.StopRecording(context.Background(), "recording-123")

	require.NoError(t, err)
	assert.NotNil(t, recording)
	assert.Equal(t, RecordingStatusStopped, recording.Status)
	assert.Equal(t, 300, recording.Duration)
}

func TestStopRecording_MalformedResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{broken`))
	}))
	defer server.Close()

	cfg := Config{
		AccountID: "acc-123",
		AppID:     "app-456",
		APIToken:  "test-token",
	}
	client := NewClient(cfg)
	client.baseURL = server.URL

	recording, err := client.StopRecording(context.Background(), "recording-123")

	assert.Error(t, err)
	assert.Nil(t, recording)
	assert.Contains(t, err.Error(), "decode response")
}

func TestGetRecording_Success(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "GET", r.Method)

		recordingResp := Response[Recording]{
			Success: true,
			Data: Recording{
				ID:          "recording-123",
				MeetingID:   "meeting-123",
				Status:      RecordingStatusCompleted,
				Duration:    300,
				FileSize:    1024000,
				DownloadURL: "https://example.com/recording-123",
			},
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(recordingResp)
	}))
	defer server.Close()

	cfg := Config{
		AccountID: "acc-123",
		AppID:     "app-456",
		APIToken:  "test-token",
	}
	client := NewClient(cfg)
	client.baseURL = server.URL

	recording, err := client.GetRecording(context.Background(), "recording-123")

	require.NoError(t, err)
	assert.NotNil(t, recording)
	assert.Equal(t, "recording-123", recording.ID)
	assert.Equal(t, RecordingStatusCompleted, recording.Status)
	assert.Equal(t, "https://example.com/recording-123", recording.DownloadURL)
}

func TestGetRecording_NotFound(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := Response[Recording]{
			Success: false,
			Errors: []APIError{
				{
					Code:    "NOT_FOUND",
					Message: "Recording not found",
				},
			},
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(resp)
	}))
	defer server.Close()

	cfg := Config{
		AccountID: "acc-123",
		AppID:     "app-456",
		APIToken:  "test-token",
	}
	client := NewClient(cfg)
	client.baseURL = server.URL

	recording, err := client.GetRecording(context.Background(), "nonexistent")

	assert.Error(t, err)
	assert.Nil(t, recording)
}

// Error Handling Tests

func TestClient_NetworkError(t *testing.T) {
	cfg := Config{
		AccountID: "acc-123",
		AppID:     "app-456",
		APIToken:  "test-token",
	}
	client := NewClient(cfg)
	client.baseURL = "http://invalid-host-that-does-not-exist.local"

	meeting, err := client.CreateMeeting(context.Background(), CreateMeetingRequest{
		Title: "Test",
	})

	assert.Error(t, err)
	assert.Nil(t, meeting)
}

func TestClient_ContextCancelled(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(100 * time.Millisecond)
		resp := Response[Meeting]{Success: true}
		json.NewEncoder(w).Encode(resp)
	}))
	defer server.Close()

	cfg := Config{
		AccountID: "acc-123",
		AppID:     "app-456",
		APIToken:  "test-token",
	}
	client := NewClient(cfg)
	client.baseURL = server.URL

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	meeting, err := client.CreateMeeting(ctx, CreateMeetingRequest{
		Title: "Test",
	})

	assert.Error(t, err)
	assert.Nil(t, meeting)
}

func TestClient_500Error(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		resp := Response[Meeting]{
			Success: false,
			Errors: []APIError{
				{
					Code:    "INTERNAL_ERROR",
					Message: "Server error",
				},
			},
		}
		json.NewEncoder(w).Encode(resp)
	}))
	defer server.Close()

	cfg := Config{
		AccountID: "acc-123",
		AppID:     "app-456",
		APIToken:  "test-token",
	}
	client := NewClient(cfg)
	client.baseURL = server.URL

	meeting, err := client.CreateMeeting(context.Background(), CreateMeetingRequest{
		Title: "Test",
	})

	assert.Error(t, err)
	assert.Nil(t, meeting)
}

func TestClient_EmptyResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{}`))
	}))
	defer server.Close()

	cfg := Config{
		AccountID: "acc-123",
		AppID:     "app-456",
		APIToken:  "test-token",
	}
	client := NewClient(cfg)
	client.baseURL = server.URL

	meeting, err := client.CreateMeeting(context.Background(), CreateMeetingRequest{
		Title: "Test",
	})

	assert.Error(t, err)
	assert.Nil(t, meeting)
}

func TestDoRequest_InvalidJSON(t *testing.T) {
	cfg := Config{
		AccountID: "acc-123",
		AppID:     "app-456",
		APIToken:  "test-token",
	}
	client := NewClient(cfg)

	// Use a custom marshaller that fails
	unmarshalableBody := make(chan int) // channels cannot be marshalled

	_, err := client.doRequest(context.Background(), "POST", "/test", unmarshalableBody)
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "marshal request body")
}

func TestAddParticipant_Empty401Response(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"success": false}`))
	}))
	defer server.Close()

	cfg := Config{
		AccountID: "acc-123",
		AppID:     "app-456",
		APIToken:  "invalid-token",
	}
	client := NewClient(cfg)
	client.baseURL = server.URL

	participant, err := client.AddParticipant(context.Background(), "meeting-123", AddParticipantRequest{
		Name: "John",
	})

	assert.Error(t, err)
	assert.Nil(t, participant)
}

func TestRefreshParticipantToken_403Forbidden(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		w.Header().Set("Content-Type", "application/json")
		resp := Response[Participant]{
			Success: false,
			Errors: []APIError{
				{Code: "FORBIDDEN", Message: "Access denied"},
			},
		}
		json.NewEncoder(w).Encode(resp)
	}))
	defer server.Close()

	cfg := Config{
		AccountID: "acc-123",
		AppID:     "app-456",
		APIToken:  "test-token",
	}
	client := NewClient(cfg)
	client.baseURL = server.URL

	participant, err := client.RefreshParticipantToken(context.Background(), "meeting-123", "participant-123")

	assert.Error(t, err)
	assert.Nil(t, participant)
}

func TestCreateMeeting_EmptyID(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := Response[Meeting]{
			Success: true,
			Data: Meeting{
				ID:     "",
				Title:  "Test",
				Status: MeetingStatusActive,
			},
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
	defer server.Close()

	cfg := Config{
		AccountID: "acc-123",
		AppID:     "app-456",
		APIToken:  "test-token",
	}
	client := NewClient(cfg)
	client.baseURL = server.URL

	meeting, err := client.CreateMeeting(context.Background(), CreateMeetingRequest{
		Title: "Test",
	})

	require.NoError(t, err)
	assert.Equal(t, "", meeting.ID)
}

func TestRemoveParticipant_MalformedJSONResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"success": `))
	}))
	defer server.Close()

	cfg := Config{
		AccountID: "acc-123",
		AppID:     "app-456",
		APIToken:  "test-token",
	}
	client := NewClient(cfg)
	client.baseURL = server.URL

	err := client.RemoveParticipant(context.Background(), "meeting-123", "participant-456")

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "decode response")
}

// Concurrent Request Tests

func TestConcurrentRequests(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := Response[Meeting]{
			Success: true,
			Data: Meeting{
				ID:        "meeting-" + r.URL.Query().Get("id"),
				Title:     "Test Meeting",
				Status:    MeetingStatusActive,
				CreatedAt: time.Now(),
				UpdatedAt: time.Now(),
			},
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
	defer server.Close()

	cfg := Config{
		AccountID: "acc-123",
		AppID:     "app-456",
		APIToken:  "test-token",
	}
	client := NewClient(cfg)
	client.baseURL = server.URL

	// Test concurrent calls
	done := make(chan bool, 5)
	for i := 0; i < 5; i++ {
		go func(id int) {
			resp, err := client.doRequest(context.Background(), "GET", "/test", nil)
			assert.NoError(t, err)
			assert.NotNil(t, resp)
			if resp != nil {
				io.ReadAll(resp.Body)
				resp.Body.Close()
			}
			done <- true
		}(i)
	}

	// Wait for all goroutines
	for i := 0; i < 5; i++ {
		<-done
	}
}

// HTTP Status Code Tests

func TestCreateMeeting_404NotFound(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		resp := Response[Meeting]{
			Success: false,
			Errors: []APIError{
				{Code: "NOT_FOUND", Message: "Endpoint not found"},
			},
		}
		json.NewEncoder(w).Encode(resp)
	}))
	defer server.Close()

	cfg := Config{
		AccountID: "acc-123",
		AppID:     "app-456",
		APIToken:  "test-token",
	}
	client := NewClient(cfg)
	client.baseURL = server.URL

	meeting, err := client.CreateMeeting(context.Background(), CreateMeetingRequest{
		Title: "Test",
	})

	assert.Error(t, err)
	assert.Nil(t, meeting)
}

func TestStartRecording_429RateLimit(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
		resp := Response[Recording]{
			Success: false,
			Errors: []APIError{
				{Code: "RATE_LIMIT", Message: "Too many requests"},
			},
		}
		json.NewEncoder(w).Encode(resp)
	}))
	defer server.Close()

	cfg := Config{
		AccountID: "acc-123",
		AppID:     "app-456",
		APIToken:  "test-token",
	}
	client := NewClient(cfg)
	client.baseURL = server.URL

	recording, err := client.StartRecording(context.Background(), "meeting-123", StartRecordingRequest{})

	assert.Error(t, err)
	assert.Nil(t, recording)
}

func TestGetRecording_MultipleErrors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		resp := Response[Recording]{
			Success: false,
			Errors: []APIError{
				{Code: "ERR1", Message: "First error"},
				{Code: "ERR2", Message: "Second error"},
				{Code: "ERR3", Message: "Third error"},
			},
		}
		json.NewEncoder(w).Encode(resp)
	}))
	defer server.Close()

	cfg := Config{
		AccountID: "acc-123",
		AppID:     "app-456",
		APIToken:  "test-token",
	}
	client := NewClient(cfg)
	client.baseURL = server.URL

	recording, err := client.GetRecording(context.Background(), "recording-123")

	assert.Error(t, err)
	assert.Nil(t, recording)
	assert.Contains(t, err.Error(), "cloudflare error")
}
