package participant

import (
	"context"
	"encoding/json"
	"testing"

	wsapi "github.com/Q9Labs/chalk/internal/interfaces/websocket"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func TestLeaveRoom_BroadcastsStructuredParticipantLeft(t *testing.T) {
	roomID := uuid.New()
	participantID := uuid.New()

	dbStub := &updateParticipantDBStub{}
	roomState := &updateParticipantRoomStateStub{}
	hub := &updateParticipantHubStub{}
	svc := NewService(dbStub, nil, roomState, nil, hub, nil)

	err := svc.LeaveRoom(context.Background(), roomID, participantID)
	require.NoError(t, err)

	require.Equal(t, roomID, roomState.removedRoomID)
	require.Equal(t, participantID, roomState.removedID)
	require.Equal(t, participantID, hub.removedMetaID)
	require.Equal(t, roomID, hub.lastRoomID)
	require.Empty(t, hub.lastExcludeID)

	var envelope wsapi.Message
	require.NoError(t, json.Unmarshal(hub.lastMessage, &envelope))
	require.Equal(t, wsapi.MessageTypeParticipantLeft, envelope.Type)

	var payload wsapi.ParticipantLeftPayload
	require.NoError(t, json.Unmarshal(envelope.Payload, &payload))
	require.Equal(t, participantID, payload.ParticipantID)
}
