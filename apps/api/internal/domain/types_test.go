package domain

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestParticipantMetadata_JSONMarshaling(t *testing.T) {
	now := time.Now().Truncate(time.Second)
	meta := ParticipantMetadata{
		DisplayName: "Test User",
		Role:        "host",
		JoinedAt:    now,
	}

	data, err := json.Marshal(meta)
	require.NoError(t, err)

	var parsed ParticipantMetadata
	err = json.Unmarshal(data, &parsed)
	require.NoError(t, err)

	assert.Equal(t, "Test User", parsed.DisplayName)
	assert.Equal(t, "host", parsed.Role)
	assert.Equal(t, now.Unix(), parsed.JoinedAt.Unix())
}

func TestParticipantMetadata_JSONFields(t *testing.T) {
	meta := ParticipantMetadata{
		DisplayName: "Test",
		Role:        "participant",
		JoinedAt:    time.Now(),
	}

	data, err := json.Marshal(meta)
	require.NoError(t, err)

	// Verify JSON field names
	var raw map[string]interface{}
	err = json.Unmarshal(data, &raw)
	require.NoError(t, err)

	assert.Contains(t, raw, "display_name")
	assert.Contains(t, raw, "role")
	assert.Contains(t, raw, "joined_at")
}

func TestRecordingState_WithRecordingID(t *testing.T) {
	recordingID := uuid.New()
	state := RecordingState{
		IsRecording: true,
		RecordingID: &recordingID,
	}

	data, err := json.Marshal(state)
	require.NoError(t, err)

	var parsed RecordingState
	err = json.Unmarshal(data, &parsed)
	require.NoError(t, err)

	assert.True(t, parsed.IsRecording)
	assert.NotNil(t, parsed.RecordingID)
	assert.Equal(t, recordingID, *parsed.RecordingID)
}

func TestRecordingState_WithoutRecordingID(t *testing.T) {
	state := RecordingState{
		IsRecording: false,
		RecordingID: nil,
	}

	data, err := json.Marshal(state)
	require.NoError(t, err)

	var parsed RecordingState
	err = json.Unmarshal(data, &parsed)
	require.NoError(t, err)

	assert.False(t, parsed.IsRecording)
	assert.Nil(t, parsed.RecordingID)
}

func TestRecordingState_JSONOmitEmpty(t *testing.T) {
	state := RecordingState{
		IsRecording: false,
		RecordingID: nil,
	}

	data, err := json.Marshal(state)
	require.NoError(t, err)

	// Verify recording_id is omitted when nil
	var raw map[string]interface{}
	err = json.Unmarshal(data, &raw)
	require.NoError(t, err)

	assert.Contains(t, raw, "is_recording")
	assert.NotContains(t, raw, "recording_id")
}

func TestRecordingState_JSONWithRecordingID(t *testing.T) {
	recordingID := uuid.New()
	state := RecordingState{
		IsRecording: true,
		RecordingID: &recordingID,
	}

	data, err := json.Marshal(state)
	require.NoError(t, err)

	// Verify recording_id is present when set
	var raw map[string]interface{}
	err = json.Unmarshal(data, &raw)
	require.NoError(t, err)

	assert.Contains(t, raw, "is_recording")
	assert.Contains(t, raw, "recording_id")
}

func TestParticipantMetadata_ZeroValue(t *testing.T) {
	var meta ParticipantMetadata

	assert.Empty(t, meta.DisplayName)
	assert.Empty(t, meta.Role)
	assert.True(t, meta.JoinedAt.IsZero())
}

func TestRecordingState_ZeroValue(t *testing.T) {
	var state RecordingState

	assert.False(t, state.IsRecording)
	assert.Nil(t, state.RecordingID)
}
