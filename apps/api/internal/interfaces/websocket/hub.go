package websocket

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"time"

	"github.com/Q9Labs/chalk/internal/domain"
	"github.com/Q9Labs/chalk/internal/infrastructure/logging"
	"github.com/google/uuid"
	redislib "github.com/redis/go-redis/v9"
)

type RedisInterface interface {
	Close() error
	Publish(ctx context.Context, channel string, message []byte) error
	Subscribe(ctx context.Context, channel string) *redislib.PubSub
	Set(ctx context.Context, key string, value interface{}, expiration time.Duration) error
	Get(ctx context.Context, key string) (string, error)
	Del(ctx context.Context, keys ...string) error
	Exists(ctx context.Context, keys ...string) (int64, error)
}

// TranscriptService interface for persisting transcripts
type TranscriptService interface {
	CreateTranscript(ctx context.Context, input TranscriptInput) error
}

// ParticipantService interface for marking participants as left
type ParticipantService interface {
	LeaveRoom(ctx context.Context, roomID, participantID uuid.UUID) error
}

// TranscriptInput matches the domain service input
type TranscriptInput struct {
	RoomID                  uuid.UUID
	ParticipantID           *uuid.UUID
	CloudflareParticipantID string
	SpeakerName             string
	Text                    string
	Confidence              *float32
	Language                string
	ExternalID              string
	Timestamp               time.Time
}

type Hub struct {
	clients         map[uuid.UUID]*Client
	rooms           map[uuid.UUID]map[uuid.UUID]*Client
	participantMeta map[uuid.UUID]domain.ParticipantMetadata
	roomRecording   map[uuid.UUID]*RoomRecordingState
	whiteboardState map[uuid.UUID]*WhiteboardState
	whiteboardStore WhiteboardStateStore

	register   chan *Client
	unregister chan *Client

	redisClient        RedisInterface
	transcriptService  TranscriptService
	participantService ParticipantService

	whiteboardPersistTimers map[uuid.UUID]*time.Timer

	mu sync.RWMutex

	ctx context.Context

	stop chan struct{}

	logger *slog.Logger
}

// RoomRecordingState tracks recording state for a room
type RoomRecordingState struct {
	IsRecording bool
	RecordingID *uuid.UUID
}

func NewHub(redisClient RedisInterface, logger *slog.Logger) *Hub {
	if logger == nil {
		logger = slog.Default()
	}
	return &Hub{
		clients:                 make(map[uuid.UUID]*Client),
		rooms:                   make(map[uuid.UUID]map[uuid.UUID]*Client),
		participantMeta:         make(map[uuid.UUID]domain.ParticipantMetadata),
		roomRecording:           make(map[uuid.UUID]*RoomRecordingState),
		whiteboardState:         make(map[uuid.UUID]*WhiteboardState),
		register:                make(chan *Client),
		unregister:              make(chan *Client),
		redisClient:             redisClient,
		ctx:                     context.Background(),
		stop:                    make(chan struct{}),
		whiteboardPersistTimers: make(map[uuid.UUID]*time.Timer),
		logger:                  logger.With("component", "ws_hub"),
	}
}

// SetTranscriptService sets the transcript service for persisting transcripts
func (h *Hub) SetTranscriptService(ts TranscriptService) {
	h.transcriptService = ts
}

// SetParticipantService sets the participant service for marking participants as left
func (h *Hub) SetParticipantService(ps ParticipantService) {
	h.participantService = ps
}

// SetWhiteboardStateStore sets the persistence layer for whiteboard state.
func (h *Hub) SetWhiteboardStateStore(store WhiteboardStateStore) {
	h.whiteboardStore = store
}

// GetTranscriptService returns the transcript service (may be nil)
func (h *Hub) GetTranscriptService() TranscriptService {
	return h.transcriptService
}

// Run starts the hub's main loop
func (h *Hub) Run(ctx context.Context) {
	h.ctx = ctx
	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()

	last := snapshotWSMetrics()

	for {
		select {
		case <-h.stop:
			return

		case client := <-h.register:
			h.registerClient(client)

		case client := <-h.unregister:
			h.unregisterClient(client)

		case <-ticker.C:
			now := snapshotWSMetrics()
			deltaDrops := now.sendDrops - last.sendDrops
			deltaBackpressureCloses := now.backpressureCloses - last.backpressureCloses
			deltaWriteErrors := now.writeErrors - last.writeErrors
			deltaPingErrors := now.pingErrors - last.pingErrors
			deltaEnqueued := now.sendEnqueued - last.sendEnqueued

			h.mu.RLock()
			clientCount := len(h.clients)
			roomCount := len(h.rooms)
			h.mu.RUnlock()

			attrs := []any{
				"event", "ws.metrics",
				"interval_s", 60,
				"clients", clientCount,
				"rooms", roomCount,
				"sends_enqueued", deltaEnqueued,
				"sends_enqueued_total", now.sendEnqueued,
				"sends_dropped", deltaDrops,
				"sends_dropped_total", now.sendDrops,
				"backpressure_closes", deltaBackpressureCloses,
				"backpressure_closes_total", now.backpressureCloses,
				"write_errors", deltaWriteErrors,
				"write_errors_total", now.writeErrors,
				"ping_errors", deltaPingErrors,
				"ping_errors_total", now.pingErrors,
			}

			// Dual-path: stdout for CloudWatch alarms; default logger for Axiom.
			logging.Stdout().Info("websocket metrics", attrs...)
			h.logger.Info("websocket metrics", attrs...)

			last = now
		}
	}
}

// Register registers a client with the hub
func (h *Hub) Register(client *Client) {
	h.register <- client
}

// Unregister unregisters a client from the hub
func (h *Hub) Unregister(client *Client) {
	h.unregister <- client
}

func (h *Hub) registerClient(client *Client) {
	h.mu.Lock()

	h.clients[client.participantID] = client

	if _, ok := h.rooms[client.roomID]; !ok {
		h.rooms[client.roomID] = make(map[uuid.UUID]*Client)
	}
	h.rooms[client.roomID][client.participantID] = client

	roomSize := len(h.rooms[client.roomID])

	attrs := []any{
		"event", "websocket.connect",
		"participant_id", client.participantID,
		"room_id", client.roomID,
		"tenant_id", client.tenantID,
		"room_size", roomSize,
	}
	if logging.AxiomEnabled() {
		logging.Stdout().Info("websocket.connect", attrs...)
	}
	h.logger.Info("websocket.connect", attrs...)

	connMsg, _ := NewMessage(MessageTypeConnected, ConnectedPayload{
		ParticipantID: client.participantID,
		RoomID:        client.roomID,
		TenantID:      client.tenantID,
	})
	connData, _ := json.Marshal(connMsg)
	client.SendReliable(connData)

	snapshot := h.getRoomSnapshotLocked(client.roomID)
	h.mu.Unlock()

	snapshotMsg, _ := NewMessage(MessageTypeRoomSnapshot, snapshot)
	snapshotData, _ := json.Marshal(snapshotMsg)
	client.SendReliable(snapshotData)

	meta := h.GetParticipantMetadata(client.participantID)
	joinedMsg, _ := NewMessage(MessageTypeParticipantJoined, ParticipantJoinedPayload{
		Participant: ParticipantPayload{
			ID:          client.participantID,
			RoomID:      client.roomID,
			DisplayName: meta.DisplayName,
			IsActive:    true,
			JoinedAt:    meta.JoinedAt,
		},
	})
	joinedData, _ := json.Marshal(joinedMsg)
	h.BroadcastToRoom(client.roomID, joinedData, client.participantID.String())
}

func (h *Hub) unregisterClient(client *Client) {
	h.mu.Lock()

	delete(h.clients, client.participantID)
	delete(h.participantMeta, client.participantID)

	// Check if room exists and count remaining participants
	roomEmpty := false
	var roomSize int
	if room, ok := h.rooms[client.roomID]; ok {
		delete(room, client.participantID)
		roomSize = len(room)
		roomEmpty = roomSize == 0
	}

	h.mu.Unlock()

	// Mark participant as left in database (updates left_at timestamp)
	if h.participantService != nil {
		if err := h.participantService.LeaveRoom(h.ctx, client.roomID, client.participantID); err != nil {
			h.logger.Error("failed to mark participant as left",
				"participant_id", client.participantID,
				"room_id", client.roomID,
				"error", err.Error(),
			)
		}
	}

	// Use client.Close() which has proper channel close protection
	client.Close()

	by, code, reason, discErr := client.DisconnectInfo()
	unregAttrs := []any{
		"event", "websocket.disconnect",
		"participant_id", client.participantID,
		"room_id", client.roomID,
		"tenant_id", client.tenantID,
		"room_size", roomSize,
		"disconnect_by", by,
		"close_code", int(code),
		"close_reason", reason,
	}
	if discErr != "" {
		unregAttrs = append(unregAttrs, "error", discErr)
	}
	if logging.AxiomEnabled() {
		logging.Stdout().Info("websocket.disconnect", unregAttrs...)
	}
	h.logger.Info("websocket.disconnect", unregAttrs...)

	// Broadcast participant_left BEFORE removing room (only if room has other participants)
	if !roomEmpty {
		leftMsg, _ := NewMessage(MessageTypeParticipantLeft, ParticipantLeftPayload{
			ParticipantID: client.participantID,
		})
		data, _ := json.Marshal(leftMsg)
		h.BroadcastToRoom(client.roomID, data, "")
	}

	// Now clean up empty room
	if roomEmpty {
		// Clear persisted whiteboard state for privacy/ephemeral behavior.
		if h.whiteboardStore != nil {
			if err := h.whiteboardStore.Save(h.ctx, client.roomID, nil); err != nil {
				h.logger.Error("failed to clear persisted whiteboard state",
					"room_id", client.roomID,
					"error", err.Error(),
				)
			}
		}

		h.mu.Lock()
		delete(h.rooms, client.roomID)
		delete(h.roomRecording, client.roomID)
		delete(h.whiteboardState, client.roomID)
		if timer, ok := h.whiteboardPersistTimers[client.roomID]; ok {
			timer.Stop()
			delete(h.whiteboardPersistTimers, client.roomID)
		}
		h.mu.Unlock()
		h.logger.Info("room removed",
			"room_id", client.roomID,
			"reason", "last_participant_left",
		)
	}
}

// BroadcastToRoom broadcasts a message to all clients in a room
func (h *Hub) BroadcastToRoom(roomID uuid.UUID, message []byte, excludeParticipantID string) {
	h.BroadcastToRoomReliable(roomID, message, excludeParticipantID)
}

// BroadcastToRoomReliable broadcasts a message to all clients in a room and
// disconnects slow consumers (no silent drops).
func (h *Hub) BroadcastToRoomReliable(roomID uuid.UUID, message []byte, excludeParticipantID string) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	if room, ok := h.rooms[roomID]; ok {
		for participantID, client := range room {
			if excludeParticipantID != "" && participantID.String() == excludeParticipantID {
				continue
			}
			client.SendReliable(message)
		}
	}
}

// BroadcastToRoomVolatile broadcasts a message to all clients in a room but may
// drop if a client is slow. Use for high-frequency ephemeral messages (cursor).
func (h *Hub) BroadcastToRoomVolatile(roomID uuid.UUID, message []byte, excludeParticipantID string) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	if room, ok := h.rooms[roomID]; ok {
		for participantID, client := range room {
			if excludeParticipantID != "" && participantID.String() == excludeParticipantID {
				continue
			}
			client.Send(message)
		}
	}
}

// SendToParticipant sends a message to a specific participant
func (h *Hub) SendToParticipant(participantID uuid.UUID, message []byte) {
	h.mu.RLock()
	client, ok := h.clients[participantID]
	h.mu.RUnlock()

	if ok {
		client.SendReliable(message)
	}
}

// GetParticipantsInRoom returns all participants in a room
func (h *Hub) GetParticipantsInRoom(roomID uuid.UUID) []uuid.UUID {
	h.mu.RLock()
	defer h.mu.RUnlock()

	var participants []uuid.UUID
	if room, ok := h.rooms[roomID]; ok {
		for participantID := range room {
			participants = append(participants, participantID)
		}
	}
	return participants
}

func (h *Hub) IsParticipantInRoom(roomID, participantID uuid.UUID) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()

	room, ok := h.rooms[roomID]
	if !ok {
		return false
	}
	_, exists := room[participantID]
	return exists
}

func (h *Hub) SetParticipantMetadata(participantID uuid.UUID, meta domain.ParticipantMetadata) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.participantMeta[participantID] = meta
}

func (h *Hub) GetParticipantMetadata(participantID uuid.UUID) domain.ParticipantMetadata {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.participantMeta[participantID]
}

func (h *Hub) RemoveParticipantMetadata(participantID uuid.UUID) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.participantMeta, participantID)
}

// SetRoomRecordingState sets the recording state for a room
func (h *Hub) SetRoomRecordingState(roomID uuid.UUID, isRecording bool, recordingID *uuid.UUID) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.roomRecording[roomID] = &RoomRecordingState{
		IsRecording: isRecording,
		RecordingID: recordingID,
	}
}

// GetRoomSnapshot returns the current state of a room
func (h *Hub) GetRoomSnapshot(roomID uuid.UUID) RoomSnapshotPayload {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.getRoomSnapshotLocked(roomID)
}

func (h *Hub) getRoomSnapshotLocked(roomID uuid.UUID) RoomSnapshotPayload {
	var participants []ParticipantPayload
	if room, ok := h.rooms[roomID]; ok {
		for participantID := range room {
			meta := h.participantMeta[participantID]
			participants = append(participants, ParticipantPayload{
				ID:          participantID,
				RoomID:      roomID,
				DisplayName: meta.DisplayName,
				IsActive:    true,
				JoinedAt:    meta.JoinedAt,
			})
		}
	}

	snapshot := RoomSnapshotPayload{
		RoomID:       roomID,
		Participants: participants,
		IsRecording:  false,
		LastSeq:      time.Now().UnixMilli(),
	}

	if recording, ok := h.roomRecording[roomID]; ok {
		snapshot.IsRecording = recording.IsRecording
		snapshot.RecordingID = recording.RecordingID
	}

	return snapshot
}

// SubscribeToRoom subscribes to Redis channel for a room and broadcasts messages to local clients
func (h *Hub) SubscribeToRoom(ctx context.Context, roomID uuid.UUID) {
	channelName := "room:" + roomID.String()
	pubsub := h.redisClient.Subscribe(ctx, channelName)
	defer pubsub.Close()

	for {
		msg, err := pubsub.ReceiveMessage(ctx)
		if err != nil {
			if err == context.Canceled || err == redislib.Nil {
				return
			}
			h.logger.Error("redis subscription error",
				"room_id", roomID,
				"channel", channelName,
				"error", err.Error(),
			)
			continue
		}

		// Broadcast to local clients in this room
		h.BroadcastToRoom(roomID, []byte(msg.Payload), "")
	}
}

// PublishToRedis publishes a message to Redis for cross-instance broadcast
func (h *Hub) PublishToRedis(roomID uuid.UUID, message []byte) error {
	channelName := "room:" + roomID.String()
	return h.redisClient.Publish(h.ctx, channelName, message)
}

// Close gracefully closes the hub
func (h *Hub) Close() {
	h.mu.Lock()
	defer h.mu.Unlock()

	close(h.stop)

	// Close all client connections
	for _, client := range h.clients {
		client.Close()
	}

	h.clients = make(map[uuid.UUID]*Client)
	h.rooms = make(map[uuid.UUID]map[uuid.UUID]*Client)
}

// Stop signals the hub to stop running
func (h *Hub) Stop() {
	select {
	case <-h.stop:
	default:
		close(h.stop)
	}
}
