package websocket

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// testMockRedis is a mock Redis client for testing
type testMockRedis struct{}

func (m *testMockRedis) Close() error { return nil }
func (m *testMockRedis) Publish(ctx context.Context, channel string, message []byte) error {
	return nil
}
func (m *testMockRedis) Subscribe(ctx context.Context, channel string) *redis.PubSub { return nil }
func (m *testMockRedis) Set(ctx context.Context, key string, value interface{}, expiration time.Duration) error {
	return nil
}
func (m *testMockRedis) Get(ctx context.Context, key string) (string, error) { return "", nil }
func (m *testMockRedis) Del(ctx context.Context, keys ...string) error       { return nil }
func (m *testMockRedis) Exists(ctx context.Context, keys ...string) (int64, error) {
	return 0, nil
}

func newTestHub() *Hub {
	return NewHub(&testMockRedis{}, nil)
}

func TestNewClient(t *testing.T) {
	hub := newTestHub()
	roomID := uuid.New()
	participantID := uuid.New()
	tenantID := uuid.New()

	client := NewClient(nil, hub, roomID, participantID, tenantID)

	assert.NotNil(t, client)
	assert.Equal(t, hub, client.hub)
	assert.Equal(t, roomID, client.roomID)
	assert.Equal(t, participantID, client.participantID)
	assert.Equal(t, tenantID, client.tenantID)
	assert.NotNil(t, client.send)
	assert.NotNil(t, client.done)
}

func TestClient_Close_Idempotent(t *testing.T) {
	hub := newTestHub()
	client := NewClient(nil, hub, uuid.New(), uuid.New(), uuid.New())

	// First close should succeed
	err := client.Close()
	assert.NoError(t, err)

	// Second close should also succeed (idempotent)
	err = client.Close()
	assert.NoError(t, err)
}

func TestClient_Send_AfterClose(t *testing.T) {
	hub := newTestHub()
	client := NewClient(nil, hub, uuid.New(), uuid.New(), uuid.New())

	client.Close()

	// Send should not panic after close
	assert.NotPanics(t, func() {
		client.Send([]byte("test message"))
	})
}

func TestClient_Send_BufferCapacity(t *testing.T) {
	hub := newTestHub()
	client := NewClient(nil, hub, uuid.New(), uuid.New(), uuid.New())

	// Send channel has capacity of 256
	for i := 0; i < 256; i++ {
		client.Send([]byte("message"))
	}

	// Should still have messages in buffer
	assert.Equal(t, 256, len(client.send))
}

func TestClient_Send_DoesNotBlockWhenBufferFull(t *testing.T) {
	hub := newTestHub()
	client := NewClient(nil, hub, uuid.New(), uuid.New(), uuid.New())

	for i := 0; i < cap(client.send); i++ {
		client.Send([]byte("message"))
	}

	done := make(chan struct{})
	go func() {
		client.Send([]byte("extra"))
		close(done)
	}()

	select {
	case <-done:
		// ok
	case <-time.After(100 * time.Millisecond):
		t.Fatal("Send blocked with full buffer")
	}
}

func TestClient_SendReliable_ClosesOnFullBuffer(t *testing.T) {
	hub := newTestHub()
	client := NewClient(nil, hub, uuid.New(), uuid.New(), uuid.New())

	// Fill send buffer.
	for i := 0; i < cap(client.send); i++ {
		client.send <- []byte("message")
	}

	client.SendReliable([]byte("extra"))

	select {
	case <-client.done:
		// ok
	case <-time.After(100 * time.Millisecond):
		t.Fatal("expected client to close on backpressure")
	}
}

func TestClient_Wait_AfterClose(t *testing.T) {
	hub := newTestHub()
	client := NewClient(nil, hub, uuid.New(), uuid.New(), uuid.New())

	// Close in a goroutine
	go func() {
		time.Sleep(50 * time.Millisecond)
		client.Close()
	}()

	// Wait should return after close
	done := make(chan struct{})
	go func() {
		client.Wait()
		close(done)
	}()

	select {
	case <-done:
		// Success
	case <-time.After(1 * time.Second):
		t.Fatal("Wait did not return after Close")
	}
}

func TestClient_handleMessage_ChatSend(t *testing.T) {
	hub := newTestHub()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go hub.Run(ctx)

	client := NewClient(nil, hub, uuid.New(), uuid.New(), uuid.New())
	hub.Register(client)
	time.Sleep(10 * time.Millisecond) // Wait for registration

	msg := &Message{
		Type:    MessageTypeChatSend,
		Payload: json.RawMessage(`{"content": "Hello world"}`),
	}

	// Should not panic
	assert.NotPanics(t, func() {
		client.handleMessage(msg)
	})
}

func TestClient_handleMessage_Reaction(t *testing.T) {
	hub := newTestHub()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go hub.Run(ctx)

	client := NewClient(nil, hub, uuid.New(), uuid.New(), uuid.New())
	hub.Register(client)
	time.Sleep(10 * time.Millisecond)

	msg := &Message{
		Type:    MessageTypeReactionSnd,
		Payload: json.RawMessage(`{"emoji": "👍"}`),
	}

	assert.NotPanics(t, func() {
		client.handleMessage(msg)
	})
}

func TestClient_handleMessage_HandRaise(t *testing.T) {
	hub := newTestHub()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go hub.Run(ctx)

	client := NewClient(nil, hub, uuid.New(), uuid.New(), uuid.New())
	hub.Register(client)
	time.Sleep(10 * time.Millisecond)

	msg := &Message{Type: MessageTypeHandRaise}

	assert.NotPanics(t, func() {
		client.handleMessage(msg)
	})
}

func TestClient_handleMessage_HandLower(t *testing.T) {
	hub := newTestHub()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go hub.Run(ctx)

	client := NewClient(nil, hub, uuid.New(), uuid.New(), uuid.New())
	hub.Register(client)
	time.Sleep(10 * time.Millisecond)

	msg := &Message{Type: MessageTypeHandLower}

	assert.NotPanics(t, func() {
		client.handleMessage(msg)
	})
}

func TestClient_handleMessage_Pong(t *testing.T) {
	hub := newTestHub()
	client := NewClient(nil, hub, uuid.New(), uuid.New(), uuid.New())

	msg := &Message{Type: MessageTypePong}

	// Pong should be acknowledged but no action
	assert.NotPanics(t, func() {
		client.handleMessage(msg)
	})
}

func TestClient_handleMessage_WhiteboardUpdate(t *testing.T) {
	hub := newTestHub()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go hub.Run(ctx)

	client := NewClient(nil, hub, uuid.New(), uuid.New(), uuid.New())
	hub.Register(client)
	time.Sleep(10 * time.Millisecond)

	msg := &Message{
		Type:    MessageTypeWhiteboardUpdate,
		Payload: json.RawMessage(`{"elements": [], "files": {}, "seq": 1}`),
	}

	assert.NotPanics(t, func() {
		client.handleMessage(msg)
	})
}

func TestClient_handleMessage_WhiteboardSync(t *testing.T) {
	hub := newTestHub()
	client := NewClient(nil, hub, uuid.New(), uuid.New(), uuid.New())

	msg := &Message{Type: MessageTypeWhiteboardSync}

	assert.NotPanics(t, func() {
		client.handleMessage(msg)
	})
}

func TestClient_handleMessage_WhiteboardClear(t *testing.T) {
	hub := newTestHub()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go hub.Run(ctx)

	client := NewClient(nil, hub, uuid.New(), uuid.New(), uuid.New())
	hub.Register(client)
	time.Sleep(10 * time.Millisecond)

	msg := &Message{Type: MessageTypeWhiteboardClear}

	assert.NotPanics(t, func() {
		client.handleMessage(msg)
	})
}

func TestClient_handleMessage_WhiteboardCursor(t *testing.T) {
	hub := newTestHub()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go hub.Run(ctx)

	client := NewClient(nil, hub, uuid.New(), uuid.New(), uuid.New())
	hub.Register(client)
	time.Sleep(10 * time.Millisecond)

	msg := &Message{
		Type:    MessageTypeWhiteboardCursor,
		Payload: json.RawMessage(`{"x": 100.5, "y": 200.5}`),
	}

	assert.NotPanics(t, func() {
		client.handleMessage(msg)
	})
}

func TestClient_handleMessage_PermissionGrant(t *testing.T) {
	hub := newTestHub()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go hub.Run(ctx)

	client := NewClient(nil, hub, uuid.New(), uuid.New(), uuid.New())
	hub.Register(client)
	time.Sleep(10 * time.Millisecond)

	participantID := uuid.New()
	msg := &Message{
		Type:    MessageTypePermissionGrant,
		Payload: json.RawMessage(`{"participant_id": "` + participantID.String() + `", "feature": "whiteboard"}`),
	}

	assert.NotPanics(t, func() {
		client.handleMessage(msg)
	})
}

func TestClient_handleMessage_PermissionRevoke(t *testing.T) {
	hub := newTestHub()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go hub.Run(ctx)

	client := NewClient(nil, hub, uuid.New(), uuid.New(), uuid.New())
	hub.Register(client)
	time.Sleep(10 * time.Millisecond)

	participantID := uuid.New()
	msg := &Message{
		Type:    MessageTypePermissionRevoke,
		Payload: json.RawMessage(`{"participant_id": "` + participantID.String() + `", "feature": "whiteboard"}`),
	}

	assert.NotPanics(t, func() {
		client.handleMessage(msg)
	})
}

func TestClient_handleMessage_WhiteboardOpen(t *testing.T) {
	hub := newTestHub()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go hub.Run(ctx)

	client := NewClient(nil, hub, uuid.New(), uuid.New(), uuid.New())
	hub.Register(client)
	time.Sleep(10 * time.Millisecond)

	msg := &Message{Type: MessageTypeWhiteboardOpen}

	assert.NotPanics(t, func() {
		client.handleMessage(msg)
	})
}

func TestClient_handleMessage_WhiteboardClose(t *testing.T) {
	hub := newTestHub()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go hub.Run(ctx)

	client := NewClient(nil, hub, uuid.New(), uuid.New(), uuid.New())
	hub.Register(client)
	time.Sleep(10 * time.Millisecond)

	msg := &Message{Type: MessageTypeWhiteboardClose}

	assert.NotPanics(t, func() {
		client.handleMessage(msg)
	})
}

func TestClient_handleMessage_UnknownType(t *testing.T) {
	hub := newTestHub()
	client := NewClient(nil, hub, uuid.New(), uuid.New(), uuid.New())

	msg := &Message{Type: "unknown.type"}

	// Unknown types should be logged but not panic
	assert.NotPanics(t, func() {
		client.handleMessage(msg)
	})
}

func TestClient_handleChatMessage_EmptyContent(t *testing.T) {
	hub := newTestHub()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go hub.Run(ctx)

	client := NewClient(nil, hub, uuid.New(), uuid.New(), uuid.New())
	hub.Register(client)
	time.Sleep(10 * time.Millisecond)

	msg := &Message{
		Type:    MessageTypeChatSend,
		Payload: json.RawMessage(`{"content": ""}`),
	}

	// Should send error message for empty content
	assert.NotPanics(t, func() {
		client.handleMessage(msg)
	})
}

func TestClient_handleReaction_EmptyEmoji(t *testing.T) {
	hub := newTestHub()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go hub.Run(ctx)

	client := NewClient(nil, hub, uuid.New(), uuid.New(), uuid.New())
	hub.Register(client)
	time.Sleep(10 * time.Millisecond)

	msg := &Message{
		Type:    MessageTypeReactionSnd,
		Payload: json.RawMessage(`{"emoji": ""}`),
	}

	// Should send error message for empty emoji
	assert.NotPanics(t, func() {
		client.handleMessage(msg)
	})
}

func TestClient_handleChatMessage_InvalidPayload(t *testing.T) {
	hub := newTestHub()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go hub.Run(ctx)

	client := NewClient(nil, hub, uuid.New(), uuid.New(), uuid.New())
	hub.Register(client)
	time.Sleep(10 * time.Millisecond)

	msg := &Message{
		Type:    MessageTypeChatSend,
		Payload: json.RawMessage(`{invalid json}`),
	}

	// Should send error message for invalid payload
	assert.NotPanics(t, func() {
		client.handleMessage(msg)
	})
}

func TestClient_sendErrorMessage(t *testing.T) {
	hub := newTestHub()
	client := NewClient(nil, hub, uuid.New(), uuid.New(), uuid.New())

	// Should not panic
	assert.NotPanics(t, func() {
		client.sendErrorMessage("test_error", "Test error message")
	})

	// Check that message was queued
	select {
	case msg := <-client.send:
		var parsed Message
		err := json.Unmarshal(msg, &parsed)
		require.NoError(t, err)
		assert.Equal(t, MessageTypeError, parsed.Type)
	default:
		t.Fatal("No message was sent")
	}
}

func TestClient_handleWhiteboardCursor_InvalidPayload(t *testing.T) {
	hub := newTestHub()
	client := NewClient(nil, hub, uuid.New(), uuid.New(), uuid.New())

	msg := &Message{
		Type:    MessageTypeWhiteboardCursor,
		Payload: json.RawMessage(`{invalid}`),
	}

	// Invalid cursor payloads are silently ignored
	assert.NotPanics(t, func() {
		client.handleMessage(msg)
	})
}

func TestClient_handlePermissionGrant_InvalidPayload(t *testing.T) {
	hub := newTestHub()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go hub.Run(ctx)

	client := NewClient(nil, hub, uuid.New(), uuid.New(), uuid.New())
	hub.Register(client)
	time.Sleep(10 * time.Millisecond)

	msg := &Message{
		Type:    MessageTypePermissionGrant,
		Payload: json.RawMessage(`{invalid}`),
	}

	// Should send error for invalid payload
	assert.NotPanics(t, func() {
		client.handleMessage(msg)
	})
}

func TestClient_handleWhiteboardUpdate_InvalidPayload(t *testing.T) {
	hub := newTestHub()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go hub.Run(ctx)

	client := NewClient(nil, hub, uuid.New(), uuid.New(), uuid.New())
	hub.Register(client)
	time.Sleep(10 * time.Millisecond)

	msg := &Message{
		Type:    MessageTypeWhiteboardUpdate,
		Payload: json.RawMessage(`{invalid}`),
	}

	// Should send error for invalid payload
	assert.NotPanics(t, func() {
		client.handleMessage(msg)
	})
}

func TestNewMessage_ChatMessage(t *testing.T) {
	payload := ChatMessagePayload{
		ID:            uuid.New(),
		ParticipantID: uuid.New(),
		DisplayName:   "Test User",
		Content:       "Hello world",
		Timestamp:     time.Now(),
	}

	msg, err := NewMessage(MessageTypeChatMessage, payload)
	require.NoError(t, err)
	assert.Equal(t, MessageTypeChatMessage, msg.Type)
	assert.NotNil(t, msg.Payload)
}

func TestNewMessage_Ping(t *testing.T) {
	payload := PingPayload{
		Timestamp: time.Now(),
	}

	msg, err := NewMessage(MessageTypePing, payload)
	require.NoError(t, err)
	assert.Equal(t, MessageTypePing, msg.Type)
}

func TestNewMessage_Error(t *testing.T) {
	payload := ErrorPayload{
		Code:    "test_error",
		Message: "Test error message",
	}

	msg, err := NewMessage(MessageTypeError, payload)
	require.NoError(t, err)
	assert.Equal(t, MessageTypeError, msg.Type)
}
