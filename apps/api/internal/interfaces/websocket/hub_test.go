package websocket

import (
	"context"
	"testing"
	"time"

	"github.com/Q9Labs/chalk/internal/domain"
	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/assert"
)

// MockRedisClient is a mock Redis client for testing
type MockRedisClient struct {
	published map[string][]byte
}

func (m *MockRedisClient) Close() error {
	return nil
}

func (m *MockRedisClient) Publish(ctx context.Context, channel string, message []byte) error {
	if m.published == nil {
		m.published = make(map[string][]byte)
	}
	m.published[channel] = message
	return nil
}

func (m *MockRedisClient) Subscribe(ctx context.Context, channel string) *redis.PubSub {
	return nil
}

func (m *MockRedisClient) Set(ctx context.Context, key string, value interface{}, expiration time.Duration) error {
	return nil
}

func (m *MockRedisClient) Get(ctx context.Context, key string) (string, error) {
	return "", nil
}

func (m *MockRedisClient) Del(ctx context.Context, keys ...string) error {
	return nil
}

func (m *MockRedisClient) Exists(ctx context.Context, keys ...string) (int64, error) {
	return 0, nil
}

// TestNewHub tests hub creation
func TestNewHub(t *testing.T) {
	mockRedis := &MockRedisClient{}
	hub := NewHub(mockRedis, nil)

	assert.NotNil(t, hub)
	assert.NotNil(t, hub.clients)
	assert.NotNil(t, hub.rooms)
	assert.NotNil(t, hub.register)
	assert.NotNil(t, hub.unregister)
}

// TestHubGetParticipantsInRoom tests retrieving participants from a room
func TestHubGetParticipantsInRoom(t *testing.T) {
	mockRedis := &MockRedisClient{}
	hub := NewHub(mockRedis, nil)
	defer hub.Close()

	roomID := uuid.New()
	participantID := uuid.New()

	// Create a mock client and add to hub manually
	hub.mu.Lock()
	if _, ok := hub.rooms[roomID]; !ok {
		hub.rooms[roomID] = make(map[uuid.UUID]*Client)
	}
	hub.rooms[roomID][participantID] = &Client{
		participantID: participantID,
		roomID:        roomID,
	}
	hub.mu.Unlock()

	// Get participants
	participants := hub.GetParticipantsInRoom(roomID)
	assert.Equal(t, 1, len(participants))
	assert.Equal(t, participantID, participants[0])
}

// TestHubBroadcastToRoom tests broadcasting to a room
func TestHubBroadcastToRoom(t *testing.T) {
	mockRedis := &MockRedisClient{}
	hub := NewHub(mockRedis, nil)
	defer hub.Close()

	roomID := uuid.New()

	// Create mock clients with send channels
	client1 := &Client{
		hub:           hub,
		participantID: uuid.New(),
		roomID:        roomID,
		send:          make(chan []byte, 10),
		done:          make(chan struct{}),
	}

	client2 := &Client{
		hub:           hub,
		participantID: uuid.New(),
		roomID:        roomID,
		send:          make(chan []byte, 10),
		done:          make(chan struct{}),
	}

	// Add clients to hub
	hub.mu.Lock()
	hub.rooms[roomID] = make(map[uuid.UUID]*Client)
	hub.rooms[roomID][client1.participantID] = client1
	hub.rooms[roomID][client2.participantID] = client2
	hub.mu.Unlock()

	// Broadcast message
	testMessage := []byte("test broadcast")
	hub.BroadcastToRoom(roomID, testMessage, "")

	// Verify both clients received the message
	msg1 := <-client1.send
	msg2 := <-client2.send

	assert.Equal(t, testMessage, msg1)
	assert.Equal(t, testMessage, msg2)
}

// TestHubBroadcastToRoomExclude tests broadcasting with exclusion
func TestHubBroadcastToRoomExclude(t *testing.T) {
	mockRedis := &MockRedisClient{}
	hub := NewHub(mockRedis, nil)
	defer hub.Close()

	roomID := uuid.New()
	excludeID := uuid.New()

	client1 := &Client{
		hub:           hub,
		participantID: excludeID,
		roomID:        roomID,
		send:          make(chan []byte, 10),
		done:          make(chan struct{}),
	}

	client2 := &Client{
		hub:           hub,
		participantID: uuid.New(),
		roomID:        roomID,
		send:          make(chan []byte, 10),
		done:          make(chan struct{}),
	}

	// Add clients to hub
	hub.mu.Lock()
	hub.rooms[roomID] = make(map[uuid.UUID]*Client)
	hub.rooms[roomID][client1.participantID] = client1
	hub.rooms[roomID][client2.participantID] = client2
	hub.mu.Unlock()

	// Broadcast with exclusion
	testMessage := []byte("test exclude")
	hub.BroadcastToRoom(roomID, testMessage, excludeID.String())

	// Only client2 should receive the message
	select {
	case msg := <-client2.send:
		assert.Equal(t, testMessage, msg)
	case <-time.After(100 * time.Millisecond):
		t.Fatal("client2 did not receive message")
	}

	// client1 should not have received anything
	select {
	case <-client1.send:
		t.Fatal("client1 should not have received message")
	case <-time.After(100 * time.Millisecond):
		// Expected
	}
}

// TestHubSendToParticipant tests sending to a specific participant
func TestHubSendToParticipant(t *testing.T) {
	mockRedis := &MockRedisClient{}
	hub := NewHub(mockRedis, nil)
	defer hub.Close()

	participantID := uuid.New()
	client := &Client{
		hub:           hub,
		participantID: participantID,
		roomID:        uuid.New(),
		send:          make(chan []byte, 10),
		done:          make(chan struct{}),
	}

	// Add client to hub
	hub.mu.Lock()
	hub.clients[participantID] = client
	hub.mu.Unlock()

	// Send to participant
	testMessage := []byte("direct message")
	hub.SendToParticipant(participantID, testMessage)

	// Verify message received
	msg := <-client.send
	assert.Equal(t, testMessage, msg)
}

// TestHubClose tests closing the hub
func TestHubClose(t *testing.T) {
	mockRedis := &MockRedisClient{}
	hub := NewHub(mockRedis, nil)

	client := &Client{
		hub:           hub,
		participantID: uuid.New(),
		roomID:        uuid.New(),
		send:          make(chan []byte, 10),
		done:          make(chan struct{}),
	}

	hub.mu.Lock()
	hub.clients[client.participantID] = client
	hub.mu.Unlock()

	hub.Close()

	assert.Equal(t, 0, len(hub.clients))
	assert.Equal(t, 0, len(hub.rooms))
}

func TestHubSetGetParticipantMetadata(t *testing.T) {
	mockRedis := &MockRedisClient{}
	hub := NewHub(mockRedis, nil)
	defer hub.Close()

	participantID := uuid.New()
	meta := domain.ParticipantMetadata{
		DisplayName: "Test User",
		Role:        "host",
		JoinedAt:    time.Now(),
	}

	hub.SetParticipantMetadata(participantID, meta)

	retrieved := hub.GetParticipantMetadata(participantID)
	assert.Equal(t, meta.DisplayName, retrieved.DisplayName)
	assert.Equal(t, meta.Role, retrieved.Role)
}

func TestHubRemoveParticipantMetadata(t *testing.T) {
	mockRedis := &MockRedisClient{}
	hub := NewHub(mockRedis, nil)
	defer hub.Close()

	participantID := uuid.New()
	meta := domain.ParticipantMetadata{
		DisplayName: "Test User",
		Role:        "participant",
		JoinedAt:    time.Now(),
	}

	hub.SetParticipantMetadata(participantID, meta)
	hub.RemoveParticipantMetadata(participantID)

	retrieved := hub.GetParticipantMetadata(participantID)
	assert.Equal(t, "", retrieved.DisplayName)
}

func TestHubSetRoomRecordingState(t *testing.T) {
	mockRedis := &MockRedisClient{}
	hub := NewHub(mockRedis, nil)
	defer hub.Close()

	roomID := uuid.New()
	recordingID := uuid.New()

	hub.SetRoomRecordingState(roomID, true, &recordingID)

	hub.mu.RLock()
	state := hub.roomRecording[roomID]
	hub.mu.RUnlock()

	assert.True(t, state.IsRecording)
	assert.Equal(t, recordingID, *state.RecordingID)
}

func TestHubGetRoomSnapshot(t *testing.T) {
	mockRedis := &MockRedisClient{}
	hub := NewHub(mockRedis, nil)
	defer hub.Close()

	roomID := uuid.New()
	participant1 := uuid.New()
	participant2 := uuid.New()
	recordingID := uuid.New()

	hub.SetParticipantMetadata(participant1, domain.ParticipantMetadata{
		DisplayName: "User 1",
		Role:        "host",
		JoinedAt:    time.Now(),
	})
	hub.SetParticipantMetadata(participant2, domain.ParticipantMetadata{
		DisplayName: "User 2",
		Role:        "participant",
		JoinedAt:    time.Now(),
	})

	hub.mu.Lock()
	hub.rooms[roomID] = make(map[uuid.UUID]*Client)
	hub.rooms[roomID][participant1] = &Client{
		participantID: participant1,
		roomID:        roomID,
		send:          make(chan []byte, 10),
		done:          make(chan struct{}),
	}
	hub.rooms[roomID][participant2] = &Client{
		participantID: participant2,
		roomID:        roomID,
		send:          make(chan []byte, 10),
		done:          make(chan struct{}),
	}
	hub.mu.Unlock()

	hub.SetRoomRecordingState(roomID, true, &recordingID)

	snapshot := hub.GetRoomSnapshot(roomID)

	assert.Equal(t, roomID, snapshot.RoomID)
	assert.Len(t, snapshot.Participants, 2)
	assert.True(t, snapshot.IsRecording)
	assert.Equal(t, recordingID, *snapshot.RecordingID)
	assert.Greater(t, snapshot.LastSeq, int64(0))
}

func TestHubGetRoomSnapshotEmptyRoom(t *testing.T) {
	mockRedis := &MockRedisClient{}
	hub := NewHub(mockRedis, nil)
	defer hub.Close()

	roomID := uuid.New()

	snapshot := hub.GetRoomSnapshot(roomID)

	assert.Equal(t, roomID, snapshot.RoomID)
	assert.Len(t, snapshot.Participants, 0)
	assert.False(t, snapshot.IsRecording)
	assert.Nil(t, snapshot.RecordingID)
}
