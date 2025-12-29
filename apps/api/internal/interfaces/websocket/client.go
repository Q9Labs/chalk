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
			log.Printf("WebSocket read error for participant %s: %v", c.participantID, err)
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
	switch msg.Type {
	case MessageTypeChatSend:
		c.handleChatMessage(msg)
	case MessageTypeReactionSnd:
		c.handleReaction(msg)
	case MessageTypeHandRaise:
		c.handleHandRaise()
	case MessageTypeHandLower:
		c.handleHandLower()
	case MessageTypePong:
		// Just acknowledge, no action needed
	default:
		log.Printf("Unknown message type: %s", msg.Type)
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
