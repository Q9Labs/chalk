package websocket

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"strings"
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
	// Ensure disconnect logs reflect the close frame we intend to send (when server-initiated).
	// First writer wins: peer close details from readPump won't get overwritten.
	c.setDisconnect("server", code, reason, nil)

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
			"close_code", int(websocket.StatusPolicyViolation),
			"close_reason", "backpressure",
			"buffer_len", len(c.send),
			"buffer_cap", cap(c.send),
		}
		c.logger().Warn("websocket send buffer full; closing slow client", attrs...)
		if logging.AxiomEnabled() {
			logging.Stdout().Warn("websocket send buffer full; closing slow client", append(c.baseAttrs(), attrs...)...)
		}
		// 1008 Policy Violation: we explicitly disconnect slow consumers to keep room state consistent.
		c.setDisconnect("server", websocket.StatusPolicyViolation, "backpressure", nil)
		_ = c.CloseWith(websocket.StatusPolicyViolation, "backpressure")
	}
}

// Wait blocks until the client is closed
func (c *Client) Wait() {
	<-c.done
}

func (c *Client) baseAttrs() []any {
	return []any{
		"instance_id", logging.InstanceID(),
		"participant_id", c.participantID,
		"room_id", c.roomID,
		"tenant_id", c.tenantID,
	}
}

func (c *Client) logger() *slog.Logger {
	return slog.Default().With(
		"component", "ws_client",
		"instance_id", logging.InstanceID(),
		"participant_id", c.participantID,
		"room_id", c.roomID,
		"tenant_id", c.tenantID,
	)
}

func isBenignReadDisconnect(err error) bool {
	if errors.Is(err, io.EOF) || errors.Is(err, net.ErrClosed) {
		return true
	}
	return strings.Contains(err.Error(), "use of closed network connection")
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
			// If we got a close frame, treat it as peer-initiated. Preserve exact code/reason.
			var cerr websocket.CloseError
			if errors.As(err, &cerr) {
				peerReason := cerr.Reason
				if peerReason == "" {
					peerReason = "peer_close"
				}
				c.setDisconnect("peer", cerr.Code, peerReason, nil)
				// Acknowledge close + ensure done is closed so writePump exits.
				_ = c.CloseWith(cerr.Code, "")
				return
			}
			if isBenignReadDisconnect(err) {
				recordWSReadEOF()
				c.setDisconnect("peer", websocket.StatusNormalClosure, "read_eof", nil)
				// Connection is already closed by peer/network; close local side cleanly.
				_ = c.CloseWith(websocket.StatusNormalClosure, "read_eof")
				return
			}
			if ctx.Err() != nil {
				// Server shutdown / request context cancellation.
				_ = c.CloseWith(websocket.StatusGoingAway, "context_canceled")
				return
			}
			// No close frame; treat as internal/network failure and close with 1011.
			recordWSReadError()
			c.setDisconnect("server", websocket.StatusInternalError, "read_error", err)
			c.logger().Error(
				"websocket read error",
				"event", "websocket.error",
				"error_kind", "read",
				"error", err.Error(),
				"close_code", int(websocket.StatusInternalError),
				"close_reason", "read_error",
			)
			if logging.AxiomEnabled() {
				logging.Stdout().Error("websocket read error", append(c.baseAttrs(),
					"event", "websocket.error",
					"error_kind", "read",
					"error", err.Error(),
					"close_code", int(websocket.StatusInternalError),
					"close_reason", "read_error",
				)...)
			}
			_ = c.CloseWith(websocket.StatusInternalError, "read_error")
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
			_ = c.CloseWith(websocket.StatusGoingAway, "context_canceled")
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
				// Treat write failures as internal errors; close with 1011.
				c.setDisconnect("server", websocket.StatusInternalError, "write_error", err)
				c.logger().Error(
					"websocket write error",
					"event", "websocket.error",
					"error_kind", "write",
					"error", err.Error(),
					"close_code", int(websocket.StatusInternalError),
					"close_reason", "write_error",
				)
				if logging.AxiomEnabled() {
					logging.Stdout().Error("websocket write error", append(c.baseAttrs(),
						"event", "websocket.error",
						"error_kind", "write",
						"error", err.Error(),
						"close_code", int(websocket.StatusInternalError),
						"close_reason", "write_error",
					)...)
				}
				// Ensure we don't leave a half-dead client registered with a growing send buffer.
				_ = c.CloseWith(websocket.StatusInternalError, "write_error")
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
				// Treat ping failures as internal errors; close with 1011.
				c.setDisconnect("server", websocket.StatusInternalError, "ping_error", err)
				c.logger().Error(
					"failed to send ping",
					"event", "websocket.error",
					"error_kind", "ping",
					"error", err.Error(),
					"close_code", int(websocket.StatusInternalError),
					"close_reason", "ping_error",
				)
				if logging.AxiomEnabled() {
					logging.Stdout().Error("failed to send ping", append(c.baseAttrs(),
						"event", "websocket.error",
						"error_kind", "ping",
						"error", err.Error(),
						"close_code", int(websocket.StatusInternalError),
						"close_reason", "ping_error",
					)...)
				}
				_ = c.CloseWith(websocket.StatusInternalError, "ping_error")
				return
			}
		}
	}
}

// handleMessage processes a message received from the client
func (c *Client) handleMessage(msg *Message) {
	switch msg.Type {
	case MessageTypeRoomSync:
		c.handleRoomSync(msg)
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
		c.logger().Warn("unknown message type", "event", "websocket.error", "error_kind", "unknown_message_type", "type", msg.Type)
		if logging.AxiomEnabled() {
			logging.Stdout().Warn("unknown message type", append(c.baseAttrs(),
				"event", "websocket.error",
				"error_kind", "unknown_message_type",
				"type", msg.Type,
			)...)
		}
	}
}

func (c *Client) handleRoomSync(msg *Message) {
	var payload RoomSyncPayload
	_ = msg.UnmarshalPayload(&payload) // best-effort; payload optional

	snapshot := c.hub.GetRoomSnapshot(c.roomID)
	snapshotMsg, _ := NewMessage(MessageTypeRoomSnapshot, snapshot)
	snapshotData, _ := json.Marshal(snapshotMsg)
	c.SendReliable(snapshotData)
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
	c.hub.FanoutToRoomReliable(c.roomID, msgData, "")
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
	c.hub.FanoutToRoomReliable(c.roomID, msgData, "")
}

// handleHandRaise broadcasts that a hand was raised
func (c *Client) handleHandRaise() {
	msg, _ := NewMessage(MessageTypeHandRaised, HandRaisedPayload{
		ParticipantID: c.participantID,
		Timestamp:     time.Now(),
	})

	msgData, _ := json.Marshal(msg)
	c.hub.FanoutToRoomReliable(c.roomID, msgData, "")
}

// handleHandLower broadcasts that a hand was lowered
func (c *Client) handleHandLower() {
	msg, _ := NewMessage(MessageTypeHandLowered, HandLoweredPayload{
		ParticipantID: c.participantID,
		Timestamp:     time.Now(),
	})

	msgData, _ := json.Marshal(msg)
	c.hub.FanoutToRoomReliable(c.roomID, msgData, "")
}

// sendErrorMessage sends an error message to the client
func (c *Client) sendErrorMessage(code, message string) {
	c.logger().Warn("websocket error message sent",
		"event", "websocket.app_error",
		"app_error_code", code,
		"app_error_message", message,
	)
	if logging.AxiomEnabled() {
		logging.Stdout().Warn("websocket error message sent", append(c.baseAttrs(),
			"event", "websocket.app_error",
			"app_error_code", code,
			"app_error_message", message,
		)...)
	}

	msg, _ := NewMessage(MessageTypeError, ErrorPayload{
		Code:    code,
		Message: message,
	})
	data, _ := json.Marshal(msg)
	c.Send(data)
}

func (c *Client) requireWhiteboardDrawAccess() bool {
	if c.hub.CanParticipantDraw(c.roomID, c.participantID) {
		return true
	}
	c.sendErrorMessage("forbidden", "You do not have whiteboard draw permissions")
	return false
}

// handleWhiteboardUpdate processes a whiteboard update and broadcasts it
func (c *Client) handleWhiteboardUpdate(msg *Message) {
	if !c.requireWhiteboardDrawAccess() {
		return
	}

	meta := c.hub.GetParticipantMetadata(c.participantID)

	var update WhiteboardUpdatePayload
	if err := msg.UnmarshalPayload(&update); err != nil {
		c.sendErrorMessage("invalid_payload", "Failed to parse whiteboard update")
		return
	}

	if update.SchemaVersion != 2 {
		c.sendErrorMessage("unsupported_version", "whiteboard.update requires schema_version=2")
		return
	}

	if update.SceneID == "" {
		c.sendErrorMessage("invalid_payload", "scene_id is required for schema_version=2")
		return
	}

	sceneID, applied := c.hub.UpdateWhiteboardState(c.roomID, update)
	if !applied {
		// Stale epoch; heal sender with a fresh snapshot.
		payload := c.hub.GetWhiteboardSnapshot(c.roomID)
		snapshot, _ := NewMessage(MessageTypeWhiteboardSnapshot, payload)
		data, _ := json.Marshal(snapshot)
		c.SendReliable(data)
		return
	}

	dataMsg, _ := NewMessage(MessageTypeWhiteboardData, WhiteboardDataPayload{
		SchemaVersion: 2,
		SceneID:       sceneID,
		SyncAll:       update.SyncAll,
		ParticipantID: c.participantID,
		DisplayName:   meta.DisplayName,
		Elements:      update.Elements,
		Seq:           update.Seq,
		Timestamp:     time.Now(),
	})

	msgData, _ := json.Marshal(dataMsg)
	c.hub.FanoutToRoomReliable(c.roomID, msgData, c.participantID.String())
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
	if !c.requireWhiteboardDrawAccess() {
		return
	}

	meta := c.hub.GetParticipantMetadata(c.participantID)

	sceneID := c.hub.ClearWhiteboardState(c.roomID)

	seq := time.Now().UnixMilli()
	clearMsg, _ := NewMessage(MessageTypeWhiteboardData, WhiteboardDataPayload{
		SchemaVersion: 2,
		SceneID:       sceneID,
		SyncAll:       true,
		ParticipantID: c.participantID,
		DisplayName:   meta.DisplayName,
		Elements:      json.RawMessage("[]"),
		Files:         json.RawMessage("{}"),
		Seq:           seq,
		Timestamp:     time.Now(),
	})

	msgData, _ := json.Marshal(clearMsg)
	c.hub.FanoutToRoomReliable(c.roomID, msgData, "")
}

// handleWhiteboardCursor broadcasts cursor position to other participants
func (c *Client) handleWhiteboardCursor(msg *Message) {
	if !c.requireWhiteboardDrawAccess() {
		return
	}

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
	c.hub.FanoutToRoomVolatile(c.roomID, msgData, c.participantID.String())
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
	if !c.hub.CanHostOverrideWhiteboard(c.roomID) {
		c.sendErrorMessage("forbidden", "Host overrides are disabled for this tenant")
		return
	}

	var payload PermissionGrantPayload
	if err := msg.UnmarshalPayload(&payload); err != nil {
		c.sendErrorMessage("invalid_payload", "Failed to parse permission grant")
		return
	}
	c.hub.SetParticipantWhiteboardPermission(c.roomID, payload.ParticipantID, true)

	// Broadcast permission change
	changeMsg, _ := NewMessage(MessageTypePermissionChanged, PermissionChangedPayload{
		ParticipantID: payload.ParticipantID,
		Feature:       payload.Feature,
		CanDraw:       true,
		GrantedBy:     c.participantID,
		Timestamp:     time.Now(),
	})

	msgData, _ := json.Marshal(changeMsg)
	c.hub.FanoutToRoomReliable(c.roomID, msgData, "")
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
	if !c.hub.CanHostOverrideWhiteboard(c.roomID) {
		c.sendErrorMessage("forbidden", "Host overrides are disabled for this tenant")
		return
	}

	var payload PermissionGrantPayload
	if err := msg.UnmarshalPayload(&payload); err != nil {
		c.sendErrorMessage("invalid_payload", "Failed to parse permission revoke")
		return
	}
	c.hub.SetParticipantWhiteboardPermission(c.roomID, payload.ParticipantID, false)

	changeMsg, _ := NewMessage(MessageTypePermissionChanged, PermissionChangedPayload{
		ParticipantID: payload.ParticipantID,
		Feature:       payload.Feature,
		CanDraw:       false,
		GrantedBy:     c.participantID,
		Timestamp:     time.Now(),
	})

	msgData, _ := json.Marshal(changeMsg)
	c.hub.FanoutToRoomReliable(c.roomID, msgData, "")
}

// handleWhiteboardOpen broadcasts that this participant opened the whiteboard
func (c *Client) handleWhiteboardOpen() {
	if !c.requireWhiteboardDrawAccess() {
		return
	}

	meta := c.hub.GetParticipantMetadata(c.participantID)

	openedMsg, _ := NewMessage(MessageTypeWhiteboardOpened, WhiteboardOpenedPayload{
		ParticipantID: c.participantID,
		DisplayName:   meta.DisplayName,
		Timestamp:     time.Now(),
	})

	msgData, _ := json.Marshal(openedMsg)
	c.hub.FanoutToRoomReliable(c.roomID, msgData, "")
}

// handleWhiteboardClose broadcasts that this participant closed the whiteboard
func (c *Client) handleWhiteboardClose() {
	if !c.requireWhiteboardDrawAccess() {
		return
	}

	closedMsg, _ := NewMessage(MessageTypeWhiteboardClosed, WhiteboardClosedPayload{
		ParticipantID: c.participantID,
		Timestamp:     time.Now(),
	})

	msgData, _ := json.Marshal(closedMsg)
	c.hub.FanoutToRoomReliable(c.roomID, msgData, "")
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
