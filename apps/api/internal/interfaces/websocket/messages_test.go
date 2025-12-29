package websocket

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestNewMessage tests creating a new message
func TestNewMessage(t *testing.T) {
	payload := ChatSendPayload{Content: "Hello"}
	msg, err := NewMessage(MessageTypeChatSend, payload)

	require.NoError(t, err)
	assert.Equal(t, MessageTypeChatSend, msg.Type)
	assert.NotNil(t, msg.Payload)
}

// TestUnmarshalPayload tests unmarshaling message payloads
func TestUnmarshalPayload(t *testing.T) {
	roomID := uuid.New()
	participantID := uuid.New()
	tenantID := uuid.New()

	payload := ConnectedPayload{
		ParticipantID: participantID,
		RoomID:        roomID,
		TenantID:      tenantID,
	}

	msg, err := NewMessage(MessageTypeConnected, payload)
	require.NoError(t, err)

	// Unmarshal back
	var unmarshaled ConnectedPayload
	err = msg.UnmarshalPayload(&unmarshaled)
	require.NoError(t, err)

	assert.Equal(t, payload.ParticipantID, unmarshaled.ParticipantID)
	assert.Equal(t, payload.RoomID, unmarshaled.RoomID)
	assert.Equal(t, payload.TenantID, unmarshaled.TenantID)
}

// TestChatMessagePayload tests chat message creation
func TestChatMessagePayload(t *testing.T) {
	payload := ChatMessagePayload{
		ID:            uuid.New(),
		ParticipantID: uuid.New(),
		DisplayName:   "John Doe",
		Content:       "Hello, world!",
		Timestamp:     time.Now(),
	}

	data, err := json.Marshal(payload)
	require.NoError(t, err)

	var unmarshaled ChatMessagePayload
	err = json.Unmarshal(data, &unmarshaled)
	require.NoError(t, err)

	assert.Equal(t, payload.ID, unmarshaled.ID)
	assert.Equal(t, payload.DisplayName, unmarshaled.DisplayName)
	assert.Equal(t, payload.Content, unmarshaled.Content)
}

// TestReactionPayload tests reaction creation
func TestReactionPayload(t *testing.T) {
	now := time.Now()
	payload := ReactionPayload{
		ParticipantID: uuid.New(),
		Emoji:         "👍",
		Timestamp:     now,
	}

	data, err := json.Marshal(payload)
	require.NoError(t, err)

	var unmarshaled ReactionPayload
	err = json.Unmarshal(data, &unmarshaled)
	require.NoError(t, err)

	assert.Equal(t, payload.ParticipantID, unmarshaled.ParticipantID)
	assert.Equal(t, payload.Emoji, unmarshaled.Emoji)
}

// TestHandRaisedPayload tests hand raised
func TestHandRaisedPayload(t *testing.T) {
	now := time.Now()
	payload := HandRaisedPayload{
		ParticipantID: uuid.New(),
		Timestamp:     now,
	}

	data, err := json.Marshal(payload)
	require.NoError(t, err)

	var unmarshaled HandRaisedPayload
	err = json.Unmarshal(data, &unmarshaled)
	require.NoError(t, err)

	assert.Equal(t, payload.ParticipantID, unmarshaled.ParticipantID)
}

// TestErrorPayload tests error payload
func TestErrorPayload(t *testing.T) {
	payload := ErrorPayload{
		Code:    "invalid_message",
		Message: "Message format is invalid",
	}

	msg, err := NewMessage(MessageTypeError, payload)
	require.NoError(t, err)

	var unmarshaled ErrorPayload
	err = msg.UnmarshalPayload(&unmarshaled)
	require.NoError(t, err)

	assert.Equal(t, payload.Code, unmarshaled.Code)
	assert.Equal(t, payload.Message, unmarshaled.Message)
}

// TestMessageMarshalUnmarshal tests full message round-trip
func TestMessageMarshalUnmarshal(t *testing.T) {
	chatPayload := ChatSendPayload{Content: "Test message"}
	msg, err := NewMessage(MessageTypeChatSend, chatPayload)
	require.NoError(t, err)

	// Marshal the message
	data, err := json.Marshal(msg)
	require.NoError(t, err)

	// Unmarshal back
	var unmarshaled Message
	err = json.Unmarshal(data, &unmarshaled)
	require.NoError(t, err)

	assert.Equal(t, MessageTypeChatSend, unmarshaled.Type)

	// Verify payload
	var payload ChatSendPayload
	err = unmarshaled.UnmarshalPayload(&payload)
	require.NoError(t, err)
	assert.Equal(t, "Test message", payload.Content)
}
