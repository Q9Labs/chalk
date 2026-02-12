package websocket

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/Q9Labs/chalk/internal/infrastructure/logging"
	"github.com/google/uuid"
	"nhooyr.io/websocket"
)

const (
	writeDeadline = 5 * time.Second
	readTimeout   = 0 // unlimited
)

type disconnectInfo struct {
	by     string
	code   websocket.StatusCode
	reason string
	err    string
}

// Client represents a single WebSocket connection
type Client struct {
	conn          *websocket.Conn
	hub           *Hub
	roomID        uuid.UUID
	participantID uuid.UUID
	tenantID      uuid.UUID
	send          chan []byte
	done          chan struct{}

	disconnectMu   sync.Mutex
	disconnectInfo disconnectInfo
}

// NewClient creates a new WebSocket client
func NewClient(conn *websocket.Conn, hub *Hub, roomID, participantID, tenantID uuid.UUID) *Client {
	return &Client{
		conn:          conn,
		hub:           hub,
		roomID:        roomID,
		participantID: participantID,
		tenantID:      tenantID,
		send:          make(chan []byte, 256),
		done:          make(chan struct{}),
	}
}

// Start starts the read and write pumps for the client
func (c *Client) Start(ctx context.Context) {
	go c.readPump(ctx)
	go c.writePump(ctx)
}

// Close closes the client connection
func (c *Client) Close() error {
	return c.CloseWith(websocket.StatusNormalClosure, "closing")
}

// CloseWith closes the client connection using the provided close code/reason.
func (c *Client) CloseWith(code websocket.StatusCode, reason string) error {
	select {
	case <-c.done:
		return nil
	default:
		close(c.done)
	}

	if c.conn != nil {
		return c.conn.Close(code, reason)
	}
	return nil
}

func (c *Client) setDisconnect(by string, code websocket.StatusCode, reason string, err error) {
	c.disconnectMu.Lock()
	defer c.disconnectMu.Unlock()

	// First writer wins; we only want one coherent reason in logs.
	if c.disconnectInfo.by != "" {
		return
	}

	c.disconnectInfo.by = by
	c.disconnectInfo.code = code
	c.disconnectInfo.reason = reason
	if err != nil {
		c.disconnectInfo.err = err.Error()
	}
}

func (c *Client) DisconnectInfo() (by string, code websocket.StatusCode, reason string, err string) {
	c.disconnectMu.Lock()
	defer c.disconnectMu.Unlock()
	return c.disconnectInfo.by, c.disconnectInfo.code, c.disconnectInfo.reason, c.disconnectInfo.err
}

// Send sends a message to the client
func (c *Client) Send(msg []byte) {
	select {
	case c.send <- msg:
		recordWSSendEnqueued()
	case <-c.done:
		// Client already closed
	default:
		recordWSSendDrop()
		// Drop message if the buffer is full to avoid blocking callers (e.g. HTTP handlers).
	}
}

// SendReliable sends a message to the client or disconnects the client if it
// cannot keep up.
//
// This is used for messages where dropping would cause state divergence
// (e.g. whiteboard scene updates/snapshots, permission changes).
func (c *Client) SendReliable(msg []byte) {
	select {
	case c.send <- msg:
		recordWSSendEnqueued()
	case <-c.done:
		// Client already closed
	default:
		recordWSSendBackpressureClose()
		attrs := []any{
			"event", "websocket.error",
			"error_kind", "backpressure",
			"reason", "send_buffer_full",
			"buffer_len", len(c.send),
			"buffer_cap", cap(c.send),
		}
		c.logger().Warn("websocket send buffer full; closing slow client", attrs...)
		if logging.AxiomEnabled() {
			logging.Stdout().Warn("websocket send buffer full; closing slow client", append(c.baseAttrs(), attrs...)...)
		}
		c.setDisconnect("server", websocket.StatusPolicyViolation, "backpressure: send buffer full", nil)
		_ = c.CloseWith(websocket.StatusPolicyViolation, "backpressure")
	}
}

// Wait blocks until the client is closed
func (c *Client) Wait() {
	<-c.done
}

func (c *Client) baseAttrs() []any {
	return []any{
		"participant_id", c.participantID,
		"room_id", c.roomID,
		"tenant_id", c.tenantID,
	}
}

func (c *Client) logger() *slog.Logger {
	return slog.Default().With(
		"component", "ws_client",
		"participant_id", c.participantID,
		"room_id", c.roomID,
		"tenant_id", c.tenantID,
	)
}

// readPump reads messages from the WebSocket connection
func (c *Client) readPump(ctx context.Context) {
	defer func() {
		c.hub.Unregister(c)
		c.Close()
	}()

	for {
		select {
		case <-c.done:
			return
		default:
		}

		_, data, err := c.conn.Read(ctx)
		if err != nil {
			if websocket.CloseStatus(err) == websocket.StatusNormalClosure {
				// Normal close. Keep it low-noise but preserve close code/reason for disconnect log.
				code := websocket.CloseStatus(err)
				reason := "normal_closure"
				var cerr websocket.CloseError
				if errors.As(err, &cerr) {
					code = cerr.Code
					if cerr.Reason != "" {
						reason = cerr.Reason
					}
				}
				c.setDisconnect("peer", code, reason, nil)
				return
			}
			if ctx.Err() != nil {
				c.setDisconnect("server", websocket.StatusGoingAway, "context_canceled", ctx.Err())
				return
			}
			code := websocket.CloseStatus(err)
			reason := "read_error"
			var cerr websocket.CloseError
			if errors.As(err, &cerr) {
				code = cerr.Code
				if cerr.Reason != "" {
					reason = cerr.Reason
				}
			}
			c.setDisconnect("peer", code, reason, err)
			c.logger().Error("websocket read error", "event", "websocket.error", "error_kind", "read", "error", err.Error(), "close_code", int(code), "close_reason", reason)
			if logging.AxiomEnabled() {
				logging.Stdout().Error("websocket read error", append(c.baseAttrs(),
					"event", "websocket.error",
					"error_kind", "read",
					"error", err.Error(),
					"close_code", int(code),
					"close_reason", reason,
				)...)
			}
			_ = c.CloseWith(websocket.StatusInternalError, "read error")
			return
		}

		var message Message
		if err := json.Unmarshal(data, &message); err != nil {
			c.logger().Warn("failed to unmarshal message", "event", "websocket.error", "error_kind", "invalid_message", "error", err.Error())
			if logging.AxiomEnabled() {
				logging.Stdout().Warn("failed to unmarshal message", append(c.baseAttrs(),
					"event", "websocket.error",
					"error_kind", "invalid_message",
					"error", err.Error(),
				)...)
			}
			c.sendErrorMessage("invalid_message", "Failed to parse message")
			continue
		}

		c.handleMessage(&message)
	}
}

// writePump writes messages to the WebSocket connection
func (c *Client) writePump(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			c.setDisconnect("server", websocket.StatusGoingAway, "context_canceled", ctx.Err())
			return

		case <-c.done:
			c.setDisconnect("server", websocket.StatusNormalClosure, "done_closed", nil)
			return

		case data := <-c.send:
			ctx, cancel := context.WithTimeout(ctx, writeDeadline)
			err := c.conn.Write(ctx, websocket.MessageText, data)
			cancel()

			if err != nil {
				recordWSWriteError()
				code := websocket.CloseStatus(err)
				reason := "write_error"
				var cerr websocket.CloseError
				if errors.As(err, &cerr) {
					code = cerr.Code
					if cerr.Reason != "" {
						reason = cerr.Reason
					}
				}
				c.setDisconnect("server", code, reason, err)
				c.logger().Error("websocket write error", "event", "websocket.error", "error_kind", "write", "error", err.Error(), "close_code", int(code), "close_reason", reason)
				if logging.AxiomEnabled() {
					logging.Stdout().Error("websocket write error", append(c.baseAttrs(),
						"event", "websocket.error",
						"error_kind", "write",
						"error", err.Error(),
						"close_code", int(code),
						"close_reason", reason,
					)...)
				}
				// Ensure we don't leave a half-dead client registered with a growing send buffer.
				_ = c.CloseWith(websocket.StatusInternalError, "write error")
				return
			}

		case <-ticker.C:
			// Send ping
			pingMsg, _ := NewMessage(MessageTypePing, PingPayload{
				Timestamp: time.Now(),
			})
			data, _ := json.Marshal(pingMsg)

			ctx, cancel := context.WithTimeout(ctx, writeDeadline)
			err := c.conn.Write(ctx, websocket.MessageText, data)
			cancel()

			if err != nil {
				recordWSPingError()
				code := websocket.CloseStatus(err)
				reason := "ping_error"
				var cerr websocket.CloseError
				if errors.As(err, &cerr) {
					code = cerr.Code
					if cerr.Reason != "" {
						reason = cerr.Reason
					}
				}
				c.setDisconnect("server", code, reason, err)
				c.logger().Error("failed to send ping", "event", "websocket.error", "error_kind", "ping", "error", err.Error(), "close_code", int(code), "close_reason", reason)
				if logging.AxiomEnabled() {
					logging.Stdout().Error("failed to send ping", append(c.baseAttrs(),
						"event", "websocket.error",
						"error_kind", "ping",
						"error", err.Error(),
						"close_code", int(code),
						"close_reason", reason,
					)...)
				}
				_ = c.CloseWith(websocket.StatusInternalError, "ping error")
				return
			}
		}
	}
}

// handleMessage processes a message received from the client
func (c *Client) handleMessage(msg *Message) {
	switch msg.Type {
	case MessageTypeChatSend:
		c.handleChatMessage(msg)
	case MessageTypeReactionSnd:
		c.handleReaction(msg)
	case MessageTypeHandRaise:
		c.handleHandRaise()
	case MessageTypeHandLower:
		c.handleHandLower()
	case MessageTypePing:
		// Respond to client ping with pong
		pongMsg, _ := NewMessage(MessageTypePong, PongPayload{
			Timestamp: time.Now(),
		})
		data, _ := json.Marshal(pongMsg)
		c.Send(data)
	case MessageTypePong:
		// Just acknowledge, no action needed
	case MessageTypeWhiteboardUpdate:
		c.handleWhiteboardUpdate(msg)
	case MessageTypeWhiteboardSync:
		c.handleWhiteboardSync()
	case MessageTypeWhiteboardClear:
		c.handleWhiteboardClear()
	case MessageTypeWhiteboardCursor:
		c.handleWhiteboardCursor(msg)
	case MessageTypePermissionGrant:
		c.handlePermissionGrant(msg)
	case MessageTypePermissionRevoke:
		c.handlePermissionRevoke(msg)
	case MessageTypeWhiteboardOpen:
		c.handleWhiteboardOpen()
	case MessageTypeWhiteboardClose:
		c.handleWhiteboardClose()
	case MessageTypeTranscript:
		c.handleTranscript(msg)
	default:
		c.logger().Warn("unknown message type", "type", msg.Type)
	}
}

func (c *Client) handleChatMessage(msg *Message) {
	var payload ChatSendPayload
	if err := msg.UnmarshalPayload(&payload); err != nil {
		c.sendErrorMessage("invalid_payload", "Failed to parse chat message")
		return
	}

	if payload.Content == "" {
		c.sendErrorMessage("invalid_payload", "Content cannot be empty")
		return
	}

	meta := c.hub.GetParticipantMetadata(c.participantID)

	chatMsg, _ := NewMessage(MessageTypeChatMessage, ChatMessagePayload{
		ID:            uuid.New(),
		ParticipantID: c.participantID,
		DisplayName:   meta.DisplayName,
		Content:       payload.Content,
		Timestamp:     time.Now(),
	})

	msgData, _ := json.Marshal(chatMsg)
	c.hub.BroadcastToRoom(c.roomID, msgData, "")
}

// handleReaction processes a reaction and broadcasts it
func (c *Client) handleReaction(msg *Message) {
	var payload ReactionSendPayload
	if err := msg.UnmarshalPayload(&payload); err != nil {
		c.sendErrorMessage("invalid_payload", "Failed to parse reaction")
		return
	}

	if payload.Emoji == "" {
		c.sendErrorMessage("invalid_payload", "Emoji cannot be empty")
		return
	}

	// Create a reaction to broadcast
	reaction, _ := NewMessage(MessageTypeReaction, ReactionPayload{
		ParticipantID: c.participantID,
		Emoji:         payload.Emoji,
		Timestamp:     time.Now(),
	})

	msgData, _ := json.Marshal(reaction)
	c.hub.BroadcastToRoom(c.roomID, msgData, "")
}

// handleHandRaise broadcasts that a hand was raised
func (c *Client) handleHandRaise() {
	msg, _ := NewMessage(MessageTypeHandRaised, HandRaisedPayload{
		ParticipantID: c.participantID,
		Timestamp:     time.Now(),
	})

	msgData, _ := json.Marshal(msg)
	c.hub.BroadcastToRoom(c.roomID, msgData, "")
}

// handleHandLower broadcasts that a hand was lowered
func (c *Client) handleHandLower() {
	msg, _ := NewMessage(MessageTypeHandLowered, HandLoweredPayload{
		ParticipantID: c.participantID,
		Timestamp:     time.Now(),
	})

	msgData, _ := json.Marshal(msg)
	c.hub.BroadcastToRoom(c.roomID, msgData, "")
}

// sendErrorMessage sends an error message to the client
func (c *Client) sendErrorMessage(code, message string) {
	msg, _ := NewMessage(MessageTypeError, ErrorPayload{
		Code:    code,
		Message: message,
	})
	data, _ := json.Marshal(msg)
	c.Send(data)
}

// handleWhiteboardUpdate processes a whiteboard update and broadcasts it
func (c *Client) handleWhiteboardUpdate(msg *Message) {
	meta := c.hub.GetParticipantMetadata(c.participantID)

	var v2 WhiteboardUpdateV2Payload
	if err := msg.UnmarshalPayload(&v2); err != nil {
		c.sendErrorMessage("invalid_payload", "Failed to parse whiteboard update")
		return
	}

	// v2 message (schema_version: 2)
	if v2.SchemaVersion == 2 {
		if v2.SceneID == "" {
			c.sendErrorMessage("invalid_payload", "scene_id is required for schema_version=2")
			return
		}

		sceneID, applied := c.hub.UpdateWhiteboardState(c.roomID, v2)
		if !applied {
			// Stale epoch; heal sender with a fresh snapshot.
			payload := c.hub.GetWhiteboardSnapshot(c.roomID)
			snapshot, _ := NewMessage(MessageTypeWhiteboardSnapshot, payload)
			data, _ := json.Marshal(snapshot)
			c.SendReliable(data)
			return
		}

		schema := int64(2)
		syncAll := v2.SyncAll
		dataMsg, _ := NewMessage(MessageTypeWhiteboardData, WhiteboardDataPayload{
			SchemaVersion: &schema,
			SceneID:       &sceneID,
			SyncAll:       &syncAll,
			ParticipantID: c.participantID,
			DisplayName:   meta.DisplayName,
			Elements:      v2.Elements,
			Seq:           v2.Seq,
			Timestamp:     time.Now(),
		})

		msgData, _ := json.Marshal(dataMsg)
		// Relay to everyone except sender (no echo).
		c.hub.BroadcastToRoomReliable(c.roomID, msgData, c.participantID.String())
		return
	}

	// v1 message fallback → treat as v2 update with current epoch.
	var v1 WhiteboardUpdatePayload
	if err := msg.UnmarshalPayload(&v1); err != nil {
		c.sendErrorMessage("invalid_payload", "Failed to parse whiteboard update")
		return
	}

	snapshot := c.hub.GetWhiteboardSnapshot(c.roomID)
	sceneID := derefString(snapshot.SceneID)
	internal := WhiteboardUpdateV2Payload{
		SchemaVersion: 2,
		SceneID:       sceneID,
		SyncAll:       false,
		Elements:      v1.Elements,
		Seq:           v1.Seq,
	}
	_, _ = c.hub.UpdateWhiteboardState(c.roomID, internal)

	schema := int64(2)
	syncAll := false
	dataMsg, _ := NewMessage(MessageTypeWhiteboardData, WhiteboardDataPayload{
		SchemaVersion: &schema,
		SceneID:       &sceneID,
		SyncAll:       &syncAll,
		ParticipantID: c.participantID,
		DisplayName:   meta.DisplayName,
		Elements:      v1.Elements,
		Files:         v1.Files,
		Seq:           v1.Seq,
		Timestamp:     time.Now(),
	})

	msgData, _ := json.Marshal(dataMsg)
	c.hub.BroadcastToRoomReliable(c.roomID, msgData, c.participantID.String())
}

// handleWhiteboardSync sends the current whiteboard state to the requesting client
func (c *Client) handleWhiteboardSync() {
	payload := c.hub.GetWhiteboardSnapshot(c.roomID)
	snapshot, _ := NewMessage(MessageTypeWhiteboardSnapshot, payload)
	data, _ := json.Marshal(snapshot)
	c.SendReliable(data)
}

// handleWhiteboardClear broadcasts a whiteboard clear event
func (c *Client) handleWhiteboardClear() {
	meta := c.hub.GetParticipantMetadata(c.participantID)

	sceneID := c.hub.ClearWhiteboardState(c.roomID)

	schema := int64(2)
	syncAll := true
	seq := time.Now().UnixMilli()
	clearMsg, _ := NewMessage(MessageTypeWhiteboardData, WhiteboardDataPayload{
		SchemaVersion: &schema,
		SceneID:       &sceneID,
		SyncAll:       &syncAll,
		ParticipantID: c.participantID,
		DisplayName:   meta.DisplayName,
		Elements:      json.RawMessage("[]"),
		Files:         json.RawMessage("{}"),
		Seq:           seq,
		Timestamp:     time.Now(),
	})

	msgData, _ := json.Marshal(clearMsg)
	c.hub.BroadcastToRoomReliable(c.roomID, msgData, "")
}

// handleWhiteboardCursor broadcasts cursor position to other participants
func (c *Client) handleWhiteboardCursor(msg *Message) {
	var payload struct {
		X float64 `json:"x"`
		Y float64 `json:"y"`
	}
	if err := msg.UnmarshalPayload(&payload); err != nil {
		return // Silently ignore cursor errors
	}

	meta := c.hub.GetParticipantMetadata(c.participantID)

	cursorMsg, _ := NewMessage(MessageTypeWhiteboardCursor, WhiteboardCursorPayload{
		ParticipantID: c.participantID,
		DisplayName:   meta.DisplayName,
		X:             payload.X,
		Y:             payload.Y,
		Timestamp:     time.Now(),
	})

	msgData, _ := json.Marshal(cursorMsg)
	// Broadcast to others (not self) - exclude sender
	c.hub.BroadcastToRoomVolatile(c.roomID, msgData, c.participantID.String())
}

// handlePermissionGrant broadcasts a permission grant event
// API-HIGH-04: Only hosts can grant permissions
func (c *Client) handlePermissionGrant(msg *Message) {
	// Check if caller is host
	meta := c.hub.GetParticipantMetadata(c.participantID)
	if meta.Role != "host" {
		c.sendErrorMessage("forbidden", "Only hosts can grant permissions")
		return
	}

	var payload PermissionGrantPayload
	if err := msg.UnmarshalPayload(&payload); err != nil {
		c.sendErrorMessage("invalid_payload", "Failed to parse permission grant")
		return
	}

	// Broadcast permission change
	changeMsg, _ := NewMessage(MessageTypePermissionChanged, PermissionChangedPayload{
		ParticipantID: payload.ParticipantID,
		Feature:       payload.Feature,
		CanDraw:       true,
		GrantedBy:     c.participantID,
		Timestamp:     time.Now(),
	})

	msgData, _ := json.Marshal(changeMsg)
	c.hub.BroadcastToRoom(c.roomID, msgData, "")
}

// handlePermissionRevoke broadcasts a permission revoke event
// API-HIGH-04: Only hosts can revoke permissions
func (c *Client) handlePermissionRevoke(msg *Message) {
	// Check if caller is host
	meta := c.hub.GetParticipantMetadata(c.participantID)
	if meta.Role != "host" {
		c.sendErrorMessage("forbidden", "Only hosts can revoke permissions")
		return
	}

	var payload PermissionGrantPayload
	if err := msg.UnmarshalPayload(&payload); err != nil {
		c.sendErrorMessage("invalid_payload", "Failed to parse permission revoke")
		return
	}

	changeMsg, _ := NewMessage(MessageTypePermissionChanged, PermissionChangedPayload{
		ParticipantID: payload.ParticipantID,
		Feature:       payload.Feature,
		CanDraw:       false,
		GrantedBy:     c.participantID,
		Timestamp:     time.Now(),
	})

	msgData, _ := json.Marshal(changeMsg)
	c.hub.BroadcastToRoom(c.roomID, msgData, "")
}

// handleWhiteboardOpen broadcasts that this participant opened the whiteboard
func (c *Client) handleWhiteboardOpen() {
	meta := c.hub.GetParticipantMetadata(c.participantID)

	openedMsg, _ := NewMessage(MessageTypeWhiteboardOpened, WhiteboardOpenedPayload{
		ParticipantID: c.participantID,
		DisplayName:   meta.DisplayName,
		Timestamp:     time.Now(),
	})

	msgData, _ := json.Marshal(openedMsg)
	c.hub.BroadcastToRoom(c.roomID, msgData, "")
}

// handleWhiteboardClose broadcasts that this participant closed the whiteboard
func (c *Client) handleWhiteboardClose() {
	closedMsg, _ := NewMessage(MessageTypeWhiteboardClosed, WhiteboardClosedPayload{
		ParticipantID: c.participantID,
		Timestamp:     time.Now(),
	})

	msgData, _ := json.Marshal(closedMsg)
	c.hub.BroadcastToRoom(c.roomID, msgData, "")
}

// handleTranscript persists a transcript from the client SDK
func (c *Client) handleTranscript(msg *Message) {
	var payload TranscriptPayload
	if err := msg.UnmarshalPayload(&payload); err != nil {
		c.sendErrorMessage("invalid_payload", "Failed to parse transcript")
		return
	}

	// Skip interim transcripts - only store final ones
	if payload.IsInterim {
		return
	}

	// Check if transcript service is available
	ts := c.hub.GetTranscriptService()
	if ts == nil {
		return
	}

	// Parse timestamp from ISO 8601 string
	timestamp, err := time.Parse(time.RFC3339, payload.Timestamp)
	if err != nil {
		timestamp = time.Now()
	}

	// Persist the transcript
	err = ts.CreateTranscript(context.Background(), TranscriptInput{
		RoomID:                  c.roomID,
		ParticipantID:           &c.participantID,
		CloudflareParticipantID: payload.ParticipantID,
		SpeakerName:             payload.SpeakerName,
		Text:                    payload.Text,
		Confidence:              payload.Confidence,
		ExternalID:              payload.ID,
		Timestamp:               timestamp,
	})
	if err != nil {
		c.logger().Error("failed to persist transcript",
			"transcript_id", payload.ID,
			"error", err.Error(),
		)
		return
	}

	// Send ack back to client
	ackMsg, _ := NewMessage(MessageTypeTranscriptAck, TranscriptAckPayload{
		ID:        payload.ID,
		Timestamp: time.Now(),
	})
	ackData, _ := json.Marshal(ackMsg)
	c.Send(ackData)
}
