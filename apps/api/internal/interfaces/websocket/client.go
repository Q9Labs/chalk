package websocket

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/google/uuid"
	"nhooyr.io/websocket"
)

const (
	writeDeadline = 5 * time.Second
	readTimeout   = 0 // unlimited
)

// Client represents a single WebSocket connection
type Client struct {
	conn          *websocket.Conn
	hub           *Hub
	roomID        uuid.UUID
	participantID uuid.UUID
	tenantID      uuid.UUID
	send          chan []byte
	done          chan struct{}
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
	select {
	case <-c.done:
		return nil
	default:
		close(c.done)
	}

	if c.conn != nil {
		return c.conn.Close(websocket.StatusNormalClosure, "closing")
	}
	return nil
}

// Send sends a message to the client
func (c *Client) Send(msg []byte) {
	select {
	case c.send <- msg:
	case <-c.done:
		// Client already closed
	}
}

// Wait blocks until the client is closed
func (c *Client) Wait() {
	<-c.done
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
				return
			}
			if ctx.Err() != nil {
				log.Printf("WebSocket context canceled for participant %s in room %s: %v", c.participantID, c.roomID, ctx.Err())
				return
			}
			log.Printf("WebSocket read error for participant %s in room %s: %v", c.participantID, c.roomID, err)
			return
		}

		var message Message
		if err := json.Unmarshal(data, &message); err != nil {
			log.Printf("Failed to unmarshal message: %v", err)
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
			log.Printf("WebSocket writePump context canceled for participant %s in room %s: %v", c.participantID, c.roomID, ctx.Err())
			return

		case <-c.done:
			return

		case data := <-c.send:
			ctx, cancel := context.WithTimeout(ctx, writeDeadline)
			err := c.conn.Write(ctx, websocket.MessageText, data)
			cancel()

			if err != nil {
				log.Printf("Failed to write message to participant %s: %v", c.participantID, err)
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
				log.Printf("Failed to send ping to participant %s: %v", c.participantID, err)
				return
			}
		}
	}
}

// handleMessage processes a message received from the client
func (c *Client) handleMessage(msg *Message) {
	log.Printf("[WS] handleMessage: type=%s from participant=%s room=%s", msg.Type, c.participantID, c.roomID)

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
		log.Printf("[WS] Unknown message type: %s", msg.Type)
	}
}

func (c *Client) handleChatMessage(msg *Message) {
	log.Printf("[Chat] handleChatMessage called from participant %s in room %s", c.participantID, c.roomID)

	var payload ChatSendPayload
	if err := msg.UnmarshalPayload(&payload); err != nil {
		log.Printf("[Chat] Failed to parse payload: %v", err)
		c.sendErrorMessage("invalid_payload", "Failed to parse chat message")
		return
	}

	log.Printf("[Chat] Received content: %s", payload.Content)

	if payload.Content == "" {
		log.Printf("[Chat] Empty content, rejecting")
		c.sendErrorMessage("invalid_payload", "Content cannot be empty")
		return
	}

	meta := c.hub.GetParticipantMetadata(c.participantID)
	log.Printf("[Chat] Sender metadata - DisplayName: %s", meta.DisplayName)

	chatMsg, _ := NewMessage(MessageTypeChatMessage, ChatMessagePayload{
		ID:            uuid.New(),
		ParticipantID: c.participantID,
		DisplayName:   meta.DisplayName,
		Content:       payload.Content,
		Timestamp:     time.Now(),
	})

	msgData, _ := json.Marshal(chatMsg)
	log.Printf("[Chat] Broadcasting message to room %s: %s", c.roomID, string(msgData))
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
	log.Printf("[WB-UPDATE] Received whiteboard.update from participant=%s room=%s", c.participantID, c.roomID)

	var payload WhiteboardUpdatePayload
	if err := msg.UnmarshalPayload(&payload); err != nil {
		log.Printf("[WB-UPDATE] ERROR: Failed to parse payload: %v", err)
		c.sendErrorMessage("invalid_payload", "Failed to parse whiteboard update")
		return
	}

	log.Printf("[WB-UPDATE] Payload: seq=%d, elements=%d bytes", payload.Seq, len(payload.Elements))

	meta := c.hub.GetParticipantMetadata(c.participantID)
	log.Printf("[WB-UPDATE] Sender metadata: displayName=%s", meta.DisplayName)

	// Broadcast to all participants in room
	dataMsg, _ := NewMessage(MessageTypeWhiteboardData, WhiteboardDataPayload{
		ParticipantID: c.participantID,
		DisplayName:   meta.DisplayName,
		Elements:      payload.Elements,
		Files:         payload.Files,
		Seq:           payload.Seq,
		Timestamp:     time.Now(),
	})

	msgData, _ := json.Marshal(dataMsg)
	log.Printf("[WB-UPDATE] Broadcasting whiteboard.data to room=%s, msgSize=%d bytes", c.roomID, len(msgData))
	c.hub.BroadcastToRoom(c.roomID, msgData, "")
	log.Printf("[WB-UPDATE] Broadcast complete")
}

// handleWhiteboardSync sends the current whiteboard state to the requesting client
func (c *Client) handleWhiteboardSync() {
	log.Printf("[WB-SYNC] Received whiteboard.sync request from participant=%s room=%s", c.participantID, c.roomID)

	// For now, send empty snapshot (persistence can be added later)
	snapshot, _ := NewMessage(MessageTypeWhiteboardSnapshot, WhiteboardSnapshotPayload{
		RoomID:   c.roomID,
		Elements: json.RawMessage("[]"),
		Files:    json.RawMessage("{}"),
		AppState: json.RawMessage("{}"),
		LastSeq:  0,
	})
	data, _ := json.Marshal(snapshot)
	log.Printf("[WB-SYNC] Sending empty snapshot to participant=%s, size=%d bytes", c.participantID, len(data))
	c.Send(data)
}

// handleWhiteboardClear broadcasts a whiteboard clear event
func (c *Client) handleWhiteboardClear() {
	meta := c.hub.GetParticipantMetadata(c.participantID)

	clearMsg, _ := NewMessage(MessageTypeWhiteboardData, WhiteboardDataPayload{
		ParticipantID: c.participantID,
		DisplayName:   meta.DisplayName,
		Elements:      json.RawMessage("[]"),
		Files:         json.RawMessage("{}"),
		Seq:           0,
		Timestamp:     time.Now(),
	})

	msgData, _ := json.Marshal(clearMsg)
	c.hub.BroadcastToRoom(c.roomID, msgData, "")
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
	c.hub.BroadcastToRoom(c.roomID, msgData, c.participantID.String())
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
	log.Printf("[WB-OPEN] Received whiteboard.open from participant=%s room=%s", c.participantID, c.roomID)

	meta := c.hub.GetParticipantMetadata(c.participantID)
	log.Printf("[WB-OPEN] Participant metadata: displayName=%s", meta.DisplayName)

	openedMsg, _ := NewMessage(MessageTypeWhiteboardOpened, WhiteboardOpenedPayload{
		ParticipantID: c.participantID,
		DisplayName:   meta.DisplayName,
		Timestamp:     time.Now(),
	})

	msgData, _ := json.Marshal(openedMsg)
	log.Printf("[WB-OPEN] Broadcasting whiteboard.opened to room=%s, msgSize=%d bytes", c.roomID, len(msgData))
	c.hub.BroadcastToRoom(c.roomID, msgData, "")
	log.Printf("[WB-OPEN] Broadcast complete")
}

// handleWhiteboardClose broadcasts that this participant closed the whiteboard
func (c *Client) handleWhiteboardClose() {
	log.Printf("[WB-CLOSE] Received whiteboard.close from participant=%s room=%s", c.participantID, c.roomID)

	closedMsg, _ := NewMessage(MessageTypeWhiteboardClosed, WhiteboardClosedPayload{
		ParticipantID: c.participantID,
		Timestamp:     time.Now(),
	})

	msgData, _ := json.Marshal(closedMsg)
	log.Printf("[WB-CLOSE] Broadcasting whiteboard.closed to room=%s, msgSize=%d bytes", c.roomID, len(msgData))
	c.hub.BroadcastToRoom(c.roomID, msgData, "")
	log.Printf("[WB-CLOSE] Broadcast complete")
}

// handleTranscript persists a transcript from the client SDK
func (c *Client) handleTranscript(msg *Message) {
	var payload TranscriptPayload
	if err := msg.UnmarshalPayload(&payload); err != nil {
		log.Printf("[TRANSCRIPT] Failed to parse payload: %v", err)
		c.sendErrorMessage("invalid_payload", "Failed to parse transcript")
		return
	}

	// Skip interim transcripts - only store final ones
	if payload.IsInterim {
		log.Printf("[TRANSCRIPT] Skipping interim transcript from participant=%s", c.participantID)
		return
	}

	log.Printf("[TRANSCRIPT] Received transcript from participant=%s: %s", c.participantID, payload.Text)

	// Check if transcript service is available
	ts := c.hub.GetTranscriptService()
	if ts == nil {
		log.Printf("[TRANSCRIPT] Warning: Transcript service not configured, skipping persistence")
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
		log.Printf("[TRANSCRIPT] Failed to persist transcript: %v", err)
		return
	}

	// Send ack back to client
	ackMsg, _ := NewMessage(MessageTypeTranscriptAck, TranscriptAckPayload{
		ID:        payload.ID,
		Timestamp: time.Now(),
	})
	ackData, _ := json.Marshal(ackMsg)
	c.Send(ackData)
	log.Printf("[TRANSCRIPT] Persisted and acknowledged transcript id=%s", payload.ID)
}
