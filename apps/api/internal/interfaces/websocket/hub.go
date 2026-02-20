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

	instanceID string

	roomSubRefcount map[uuid.UUID]int
	roomSubCancel   map[uuid.UUID]context.CancelFunc
	pubsubDedupe    *pubsubDedupe

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
	instanceID := logging.InstanceID()
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
		instanceID:              instanceID,
		roomSubRefcount:         make(map[uuid.UUID]int),
		roomSubCancel:           make(map[uuid.UUID]context.CancelFunc),
		pubsubDedupe:            newPubsubDedupe(2*time.Minute, 10_000),
		logger:                  logger.With("component", "ws_hub", "instance_id", instanceID),
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
			deltaReadEOFs := now.readEOFs - last.readEOFs
			deltaReadErrors := now.readErrors - last.readErrors
			deltaWriteErrors := now.writeErrors - last.writeErrors
			deltaPingErrors := now.pingErrors - last.pingErrors
			deltaEnqueued := now.sendEnqueued - last.sendEnqueued

			h.mu.RLock()
			clientCount := len(h.clients)
			roomCount := len(h.rooms)
			h.mu.RUnlock()

			attrs := []any{
				"event", "ws.metrics",
				"instance_id", h.instanceID,
				"interval_s", 60,
				"clients", clientCount,
				"rooms", roomCount,
				"sends_enqueued", deltaEnqueued,
				"sends_enqueued_total", now.sendEnqueued,
				"sends_dropped", deltaDrops,
				"sends_dropped_total", now.sendDrops,
				"backpressure_closes", deltaBackpressureCloses,
				"backpressure_closes_total", now.backpressureCloses,
				"read_eofs", deltaReadEOFs,
				"read_eofs_total", now.readEOFs,
				"read_errors", deltaReadErrors,
				"read_errors_total", now.readErrors,
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
	h.roomSubRefcount[client.roomID]++
	if h.roomSubRefcount[client.roomID] == 1 && h.redisClient != nil {
		// Start per-room subscription on first local client.
		parent := h.ctx
		if parent == nil {
			parent = context.Background()
		}
		subCtx, cancel := context.WithCancel(parent)
		h.roomSubCancel[client.roomID] = cancel
		go h.SubscribeToRoom(subCtx, client.roomID)
	}

	roomSize := len(h.rooms[client.roomID])

	attrs := []any{
		"event", "websocket.connect",
		"instance_id", h.instanceID,
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
	h.FanoutToRoomReliable(client.roomID, joinedData, client.participantID.String())
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

	// Per-room subscription lifecycle.
	if n, ok := h.roomSubRefcount[client.roomID]; ok && n > 0 {
		n--
		if n <= 0 {
			delete(h.roomSubRefcount, client.roomID)
			if cancel, ok := h.roomSubCancel[client.roomID]; ok {
				cancel()
				delete(h.roomSubCancel, client.roomID)
			}
		} else {
			h.roomSubRefcount[client.roomID] = n
		}
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
		"instance_id", h.instanceID,
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
		h.FanoutToRoomReliable(client.roomID, data, "")
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
		if cancel, ok := h.roomSubCancel[client.roomID]; ok {
			cancel()
			delete(h.roomSubCancel, client.roomID)
		}
		delete(h.roomSubRefcount, client.roomID)
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

// FanoutToRoomReliable broadcasts to local clients immediately then publishes to Redis for other instances.
func (h *Hub) FanoutToRoomReliable(roomID uuid.UUID, message []byte, excludeParticipantID string) {
	h.BroadcastToRoomReliable(roomID, message, excludeParticipantID)
	h.publishToRedis(roomID, PubSubReliable, message, excludeParticipantID)
}

// FanoutToRoomVolatile broadcasts to local clients immediately then publishes to Redis for other instances.
func (h *Hub) FanoutToRoomVolatile(roomID uuid.UUID, message []byte, excludeParticipantID string) {
	h.BroadcastToRoomVolatile(roomID, message, excludeParticipantID)
	h.publishToRedis(roomID, PubSubVolatile, message, excludeParticipantID)
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
	if h.redisClient == nil {
		return
	}
	channelName := "room:" + roomID.String()
	pubsub := h.redisClient.Subscribe(ctx, channelName)
	if pubsub == nil {
		h.logger.Error("redis subscribe returned nil pubsub",
			"event", "ws.redis.subscribe_error",
			"instance_id", h.instanceID,
			"room_id", roomID,
			"channel", channelName,
		)
		if logging.AxiomEnabled() {
			logging.Stdout().Error("redis subscribe returned nil pubsub",
				"event", "ws.redis.subscribe_error",
				"instance_id", h.instanceID,
				"room_id", roomID,
				"channel", channelName,
			)
		}
		return
	}
	defer pubsub.Close()

	h.logger.Info("redis subscribe started",
		"event", "ws.redis.subscribe_start",
		"instance_id", h.instanceID,
		"room_id", roomID,
		"channel", channelName,
	)
	if logging.AxiomEnabled() {
		logging.Stdout().Info("redis subscribe started",
			"event", "ws.redis.subscribe_start",
			"instance_id", h.instanceID,
			"room_id", roomID,
			"channel", channelName,
		)
	}
	defer func() {
		h.logger.Info("redis subscribe stopped",
			"event", "ws.redis.subscribe_stop",
			"instance_id", h.instanceID,
			"room_id", roomID,
			"channel", channelName,
		)
		if logging.AxiomEnabled() {
			logging.Stdout().Info("redis subscribe stopped",
				"event", "ws.redis.subscribe_stop",
				"instance_id", h.instanceID,
				"room_id", roomID,
				"channel", channelName,
			)
		}
	}()

	for {
		msg, err := pubsub.ReceiveMessage(ctx)
		if err != nil {
			if err == context.Canceled || err == redislib.Nil {
				return
			}
			h.logger.Error("redis subscription error",
				"event", "ws.redis.subscribe_error",
				"instance_id", h.instanceID,
				"room_id", roomID,
				"channel", channelName,
				"error", err.Error(),
			)
			if logging.AxiomEnabled() {
				logging.Stdout().Error("redis subscription error",
					"event", "ws.redis.subscribe_error",
					"instance_id", h.instanceID,
					"room_id", roomID,
					"channel", channelName,
					"error", err.Error(),
				)
			}
			continue
		}

		var env PubSubEnvelope
		if err := json.Unmarshal([]byte(msg.Payload), &env); err != nil {
			h.logger.Error("redis message decode error",
				"event", "ws.redis.decode_error",
				"instance_id", h.instanceID,
				"room_id", roomID,
				"channel", channelName,
				"payload_bytes", len(msg.Payload),
				"error", err.Error(),
			)
			if logging.AxiomEnabled() {
				logging.Stdout().Error("redis message decode error",
					"event", "ws.redis.decode_error",
					"instance_id", h.instanceID,
					"room_id", roomID,
					"channel", channelName,
					"payload_bytes", len(msg.Payload),
					"error", err.Error(),
				)
			}
			continue
		}

		if env.OriginInstanceID == h.instanceID {
			continue
		}
		if !h.pubsubDedupe.ShouldProcess(env.MessageID) {
			continue
		}

		switch env.Delivery {
		case PubSubVolatile:
			h.BroadcastToRoomVolatile(roomID, []byte(env.Data), env.ExcludeParticipantID)
		default:
			h.BroadcastToRoomReliable(roomID, []byte(env.Data), env.ExcludeParticipantID)
		}
	}
}

func (h *Hub) publishToRedis(roomID uuid.UUID, delivery PubSubDelivery, message []byte, excludeParticipantID string) {
	if h.redisClient == nil {
		return
	}

	env := PubSubEnvelope{
		MessageID:            uuid.NewString(),
		OriginInstanceID:     h.instanceID,
		RoomID:               roomID.String(),
		ExcludeParticipantID: excludeParticipantID,
		Delivery:             delivery,
		Data:                 message,
	}
	payload, err := json.Marshal(env)
	if err != nil {
		h.logger.Error("failed to marshal pubsub envelope",
			"event", "ws.redis.publish_error",
			"instance_id", h.instanceID,
			"room_id", roomID,
			"error", err.Error(),
		)
		if logging.AxiomEnabled() {
			logging.Stdout().Error("failed to marshal pubsub envelope",
				"event", "ws.redis.publish_error",
				"instance_id", h.instanceID,
				"room_id", roomID,
				"error", err.Error(),
			)
		}
		return
	}

	channelName := "room:" + roomID.String()
	err = h.redisClient.Publish(h.ctx, channelName, payload)
	if err != nil {
		h.logger.Error("redis publish error",
			"event", "ws.redis.publish_error",
			"instance_id", h.instanceID,
			"room_id", roomID,
			"channel", channelName,
			"message_id", env.MessageID,
			"origin_instance_id", env.OriginInstanceID,
			"delivery", string(delivery),
			"payload_bytes", len(payload),
			"error", err.Error(),
		)
		if logging.AxiomEnabled() {
			logging.Stdout().Error("redis publish error",
				"event", "ws.redis.publish_error",
				"instance_id", h.instanceID,
				"room_id", roomID,
				"channel", channelName,
				"message_id", env.MessageID,
				"origin_instance_id", env.OriginInstanceID,
				"delivery", string(delivery),
				"payload_bytes", len(payload),
				"error", err.Error(),
			)
		}
	}
}

// Close gracefully closes the hub
func (h *Hub) Close() {
	h.mu.Lock()
	defer h.mu.Unlock()

	close(h.stop)

	for _, cancel := range h.roomSubCancel {
		cancel()
	}
	h.roomSubCancel = make(map[uuid.UUID]context.CancelFunc)
	h.roomSubRefcount = make(map[uuid.UUID]int)

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
