package redis

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNewRoomState(t *testing.T) {
	t.Skip("Requires Redis server running")

	ctx := context.Background()
	client, err := NewClient(ctx, "redis://localhost:6379")
	require.NoError(t, err)
	defer client.Close()

	roomState := NewRoomState(client)
	assert.NotNil(t, roomState)
}

func TestRoomStateAddGetParticipant(t *testing.T) {
	t.Skip("Requires Redis server running")

	ctx := context.Background()
	client, err := NewClient(ctx, "redis://localhost:6379")
	require.NoError(t, err)
	defer client.Close()

	roomState := NewRoomState(client)
	roomID := uuid.New()
	participantID := uuid.New()

	meta := ParticipantMetadata{
		DisplayName: "Test User",
		Role:        "participant",
		JoinedAt:    time.Now().Truncate(time.Millisecond),
	}

	err = roomState.AddParticipant(ctx, roomID, participantID, meta)
	require.NoError(t, err)

	participants, err := roomState.GetParticipants(ctx, roomID)
	require.NoError(t, err)

	assert.Len(t, participants, 1)
	retrieved, ok := participants[participantID]
	assert.True(t, ok)
	assert.Equal(t, meta.DisplayName, retrieved.DisplayName)
	assert.Equal(t, meta.Role, retrieved.Role)

	err = roomState.ClearRoom(ctx, roomID)
	require.NoError(t, err)
}

func TestRoomStateRemoveParticipant(t *testing.T) {
	t.Skip("Requires Redis server running")

	ctx := context.Background()
	client, err := NewClient(ctx, "redis://localhost:6379")
	require.NoError(t, err)
	defer client.Close()

	roomState := NewRoomState(client)
	roomID := uuid.New()
	participantID := uuid.New()

	meta := ParticipantMetadata{
		DisplayName: "Test User",
		Role:        "participant",
		JoinedAt:    time.Now(),
	}

	err = roomState.AddParticipant(ctx, roomID, participantID, meta)
	require.NoError(t, err)

	err = roomState.RemoveParticipant(ctx, roomID, participantID)
	require.NoError(t, err)

	participants, err := roomState.GetParticipants(ctx, roomID)
	require.NoError(t, err)
	assert.Len(t, participants, 0)

	err = roomState.ClearRoom(ctx, roomID)
	require.NoError(t, err)
}

func TestRoomStateMultipleParticipants(t *testing.T) {
	t.Skip("Requires Redis server running")

	ctx := context.Background()
	client, err := NewClient(ctx, "redis://localhost:6379")
	require.NoError(t, err)
	defer client.Close()

	roomState := NewRoomState(client)
	roomID := uuid.New()

	participant1 := uuid.New()
	participant2 := uuid.New()
	participant3 := uuid.New()

	err = roomState.AddParticipant(ctx, roomID, participant1, ParticipantMetadata{
		DisplayName: "User 1",
		Role:        "host",
		JoinedAt:    time.Now(),
	})
	require.NoError(t, err)

	err = roomState.AddParticipant(ctx, roomID, participant2, ParticipantMetadata{
		DisplayName: "User 2",
		Role:        "participant",
		JoinedAt:    time.Now(),
	})
	require.NoError(t, err)

	err = roomState.AddParticipant(ctx, roomID, participant3, ParticipantMetadata{
		DisplayName: "User 3",
		Role:        "participant",
		JoinedAt:    time.Now(),
	})
	require.NoError(t, err)

	participants, err := roomState.GetParticipants(ctx, roomID)
	require.NoError(t, err)
	assert.Len(t, participants, 3)

	err = roomState.RemoveParticipant(ctx, roomID, participant2)
	require.NoError(t, err)

	participants, err = roomState.GetParticipants(ctx, roomID)
	require.NoError(t, err)
	assert.Len(t, participants, 2)

	_, exists := participants[participant2]
	assert.False(t, exists)

	err = roomState.ClearRoom(ctx, roomID)
	require.NoError(t, err)
}

func TestRoomStateRecordingState(t *testing.T) {
	t.Skip("Requires Redis server running")

	ctx := context.Background()
	client, err := NewClient(ctx, "redis://localhost:6379")
	require.NoError(t, err)
	defer client.Close()

	roomState := NewRoomState(client)
	roomID := uuid.New()
	recordingID := uuid.New()

	err = roomState.SetRecordingState(ctx, roomID, true, &recordingID)
	require.NoError(t, err)

	state, err := roomState.GetRecordingState(ctx, roomID)
	require.NoError(t, err)
	assert.True(t, state.IsRecording)
	assert.Equal(t, recordingID, *state.RecordingID)

	err = roomState.SetRecordingState(ctx, roomID, false, nil)
	require.NoError(t, err)

	state, err = roomState.GetRecordingState(ctx, roomID)
	require.NoError(t, err)
	assert.False(t, state.IsRecording)
	assert.Nil(t, state.RecordingID)

	err = roomState.ClearRoom(ctx, roomID)
	require.NoError(t, err)
}

func TestRoomStateClearRoom(t *testing.T) {
	t.Skip("Requires Redis server running")

	ctx := context.Background()
	client, err := NewClient(ctx, "redis://localhost:6379")
	require.NoError(t, err)
	defer client.Close()

	roomState := NewRoomState(client)
	roomID := uuid.New()
	participantID := uuid.New()
	recordingID := uuid.New()

	err = roomState.AddParticipant(ctx, roomID, participantID, ParticipantMetadata{
		DisplayName: "Test User",
		Role:        "participant",
		JoinedAt:    time.Now(),
	})
	require.NoError(t, err)

	err = roomState.SetRecordingState(ctx, roomID, true, &recordingID)
	require.NoError(t, err)

	err = roomState.ClearRoom(ctx, roomID)
	require.NoError(t, err)

	participants, err := roomState.GetParticipants(ctx, roomID)
	require.NoError(t, err)
	assert.Len(t, participants, 0)
}

func TestRoomStateGetParticipantsEmptyRoom(t *testing.T) {
	t.Skip("Requires Redis server running")

	ctx := context.Background()
	client, err := NewClient(ctx, "redis://localhost:6379")
	require.NoError(t, err)
	defer client.Close()

	roomState := NewRoomState(client)
	roomID := uuid.New()

	participants, err := roomState.GetParticipants(ctx, roomID)
	require.NoError(t, err)
	assert.Len(t, participants, 0)
}
