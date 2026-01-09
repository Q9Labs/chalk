package cloudflare

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestRoleToPreset_Host(t *testing.T) {
	preset := RoleToPreset("host")
	assert.Equal(t, PresetHost, preset)
	assert.Equal(t, "group_call_host", preset)
}

func TestRoleToPreset_Participant(t *testing.T) {
	preset := RoleToPreset("participant")
	assert.Equal(t, PresetParticipant, preset)
	assert.Equal(t, "group_call_participant", preset)
}

func TestRoleToPreset_Unknown(t *testing.T) {
	// Unknown roles default to participant
	preset := RoleToPreset("unknown")
	assert.Equal(t, PresetParticipant, preset)
}

func TestRoleToPreset_Empty(t *testing.T) {
	preset := RoleToPreset("")
	assert.Equal(t, PresetParticipant, preset)
}

func TestCreateMeetingRequest_JSONMarshaling(t *testing.T) {
	req := CreateMeetingRequest{
		Title:                    "Test Meeting",
		PreferredRegion:          "nearest",
		RecordOnStart:            true,
		WaitingRoom:              false,
		LiveStreamOnStart:        false,
		PersistChat:              true,
		SummarizeOnEnd:           false,
		SessionKeepAliveTimeSecs: 300,
	}

	data, err := json.Marshal(req)
	require.NoError(t, err)

	var parsed CreateMeetingRequest
	err = json.Unmarshal(data, &parsed)
	require.NoError(t, err)
	assert.Equal(t, req, parsed)
}

func TestMeeting_JSONMarshaling(t *testing.T) {
	now := time.Now().Truncate(time.Second)
	meeting := Meeting{
		ID:              "meet_123",
		Title:           "Test Meeting",
		Status:          MeetingStatusActive,
		PreferredRegion: "nearest",
		RecordOnStart:   true,
		CreatedAt:       now,
		UpdatedAt:       now,
	}

	data, err := json.Marshal(meeting)
	require.NoError(t, err)

	var parsed Meeting
	err = json.Unmarshal(data, &parsed)
	require.NoError(t, err)
	assert.Equal(t, meeting.ID, parsed.ID)
	assert.Equal(t, meeting.Title, parsed.Title)
	assert.Equal(t, meeting.Status, parsed.Status)
}

func TestAddParticipantRequest_JSONMarshaling(t *testing.T) {
	req := AddParticipantRequest{
		Name:             "Test User",
		Picture:          "https://example.com/avatar.png",
		PresetName:       PresetHost,
		ClientSpecificID: "user-123",
	}

	data, err := json.Marshal(req)
	require.NoError(t, err)

	var parsed AddParticipantRequest
	err = json.Unmarshal(data, &parsed)
	require.NoError(t, err)
	assert.Equal(t, req, parsed)
}

func TestParticipant_JSONMarshaling(t *testing.T) {
	now := time.Now().Truncate(time.Second)
	participant := Participant{
		ID:               "part_123",
		Name:             "Test User",
		Picture:          "https://example.com/avatar.png",
		PresetName:       PresetParticipant,
		ClientSpecificID: "user-123",
		CreatedAt:        now,
		UpdatedAt:        now,
		Token:            "jwt-token",
	}

	data, err := json.Marshal(participant)
	require.NoError(t, err)

	var parsed Participant
	err = json.Unmarshal(data, &parsed)
	require.NoError(t, err)
	assert.Equal(t, participant.ID, parsed.ID)
	assert.Equal(t, participant.Name, parsed.Name)
	assert.Equal(t, participant.Token, parsed.Token)
}

func TestRecording_JSONMarshaling(t *testing.T) {
	now := time.Now().Truncate(time.Second)
	downloadURL := "https://example.com/recording.webm"
	fileSize := int64(1024000)
	sessionID := "session_123"

	recording := Recording{
		ID:             "rec_123",
		MeetingID:      "meet_456",
		SessionID:      &sessionID,
		Status:         RecordingStatusCompleted,
		OutputFileName: "recording.webm",
		DownloadURL:    &downloadURL,
		FileSize:       &fileSize,
		InvokedTime:    &now,
		StartedTime:    &now,
		StoppedTime:    &now,
	}

	data, err := json.Marshal(recording)
	require.NoError(t, err)

	var parsed Recording
	err = json.Unmarshal(data, &parsed)
	require.NoError(t, err)
	assert.Equal(t, recording.ID, parsed.ID)
	assert.Equal(t, recording.Status, parsed.Status)
	assert.Equal(t, *recording.DownloadURL, *parsed.DownloadURL)
}

func TestStartRecordingRequest_JSONMarshaling(t *testing.T) {
	req := StartRecordingRequest{
		MeetingID:  "meet_123",
		MaxSeconds: 3600,
		StorageConfig: &StorageConfig{
			Type:   "r2",
			Bucket: "recordings",
			Path:   "/meetings",
		},
	}

	data, err := json.Marshal(req)
	require.NoError(t, err)

	var parsed StartRecordingRequest
	err = json.Unmarshal(data, &parsed)
	require.NoError(t, err)
	assert.Equal(t, req.MeetingID, parsed.MeetingID)
	assert.Equal(t, req.MaxSeconds, parsed.MaxSeconds)
	assert.NotNil(t, parsed.StorageConfig)
}

func TestStopRecordingRequest_JSONMarshaling(t *testing.T) {
	actions := []string{"stop", "pause", "resume"}

	for _, action := range actions {
		t.Run(action, func(t *testing.T) {
			req := StopRecordingRequest{Action: action}
			data, err := json.Marshal(req)
			require.NoError(t, err)

			var parsed StopRecordingRequest
			err = json.Unmarshal(data, &parsed)
			require.NoError(t, err)
			assert.Equal(t, action, parsed.Action)
		})
	}
}

func TestUpdateMeetingRequest_JSONMarshaling(t *testing.T) {
	req := UpdateMeetingRequest{Status: MeetingStatusInactive}
	data, err := json.Marshal(req)
	require.NoError(t, err)

	var parsed UpdateMeetingRequest
	err = json.Unmarshal(data, &parsed)
	require.NoError(t, err)
	assert.Equal(t, MeetingStatusInactive, parsed.Status)
}

func TestStorageConfig_JSONMarshaling(t *testing.T) {
	config := StorageConfig{
		ID:        "storage_123",
		Type:      "r2",
		AccessKey: "access",
		SecretKey: "secret",
		Region:    "auto",
		Bucket:    "recordings",
		Path:      "/meetings",
	}

	data, err := json.Marshal(config)
	require.NoError(t, err)

	var parsed StorageConfig
	err = json.Unmarshal(data, &parsed)
	require.NoError(t, err)
	assert.Equal(t, config, parsed)
}

func TestAPIError_JSONMarshaling(t *testing.T) {
	apiError := APIError{
		Code:    "invalid_request",
		Message: "The request was invalid",
	}

	data, err := json.Marshal(apiError)
	require.NoError(t, err)

	var parsed APIError
	err = json.Unmarshal(data, &parsed)
	require.NoError(t, err)
	assert.Equal(t, apiError, parsed)
}

func TestResponse_JSONMarshaling(t *testing.T) {
	meeting := Meeting{
		ID:     "meet_123",
		Title:  "Test",
		Status: MeetingStatusActive,
	}

	resp := Response[Meeting]{
		Success: true,
		Data:    meeting,
	}

	data, err := json.Marshal(resp)
	require.NoError(t, err)

	var parsed Response[Meeting]
	err = json.Unmarshal(data, &parsed)
	require.NoError(t, err)
	assert.True(t, parsed.Success)
	assert.Equal(t, meeting.ID, parsed.Data.ID)
}

func TestResponse_WithErrors(t *testing.T) {
	resp := Response[Meeting]{
		Success: false,
		Errors: []APIError{
			{Code: "not_found", Message: "Meeting not found"},
		},
	}

	data, err := json.Marshal(resp)
	require.NoError(t, err)

	var parsed Response[Meeting]
	err = json.Unmarshal(data, &parsed)
	require.NoError(t, err)
	assert.False(t, parsed.Success)
	assert.Len(t, parsed.Errors, 1)
	assert.Equal(t, "not_found", parsed.Errors[0].Code)
}

func TestAIConfig_JSONMarshaling(t *testing.T) {
	config := AIConfig{
		Transcription: &TranscriptionConfig{
			Enabled:  true,
			Language: "en-US",
		},
	}

	data, err := json.Marshal(config)
	require.NoError(t, err)

	var parsed AIConfig
	err = json.Unmarshal(data, &parsed)
	require.NoError(t, err)
	assert.NotNil(t, parsed.Transcription)
	assert.True(t, parsed.Transcription.Enabled)
	assert.Equal(t, "en-US", parsed.Transcription.Language)
}
