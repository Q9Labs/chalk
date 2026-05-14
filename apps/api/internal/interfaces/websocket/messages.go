package websocket

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

// MessageType defines valid WebSocket message types
type MessageType string

const (
	// Server → Client messages
	MessageTypeConnected         MessageType = "connected"
	MessageTypeParticipantJoined MessageType = "participant.joined"
	MessageTypeParticipantLeft   MessageType = "participant.left"
	MessageTypeParticipantUpdate MessageType = "participant.updated"
	MessageTypeParticipantMute   MessageType = "participant.mute"
	MessageTypeParticipantUnmute MessageType = "participant.unmute"
	MessageTypeChatMessage       MessageType = "chat.message"
	MessageTypeChatRead          MessageType = "chat.read"
	MessageTypeReaction          MessageType = "reaction"
	MessageTypeHandRaised        MessageType = "hand.raised"
	MessageTypeHandLowered       MessageType = "hand.lowered"
	MessageTypeRoomUpdated       MessageType = "room.updated"
	MessageTypeRecordingStarted  MessageType = "recording.started"
	MessageTypeRecordingStopped  MessageType = "recording.stopped"
	MessageTypeError             MessageType = "error"
	MessageTypePing              MessageType = "ping"

	// Room state messages
	MessageTypeRoomSnapshot MessageType = "room.snapshot"
	MessageTypeRoomSync     MessageType = "room.sync" // Client requests sync

	// Client → Server messages
	MessageTypeChatSend    MessageType = "chat.send"
	MessageTypeReactionSnd MessageType = "reaction.send"
	MessageTypeHandRaise   MessageType = "hand.raise"
	MessageTypeHandLower   MessageType = "hand.lower"
	MessageTypePong        MessageType = "pong"

	// Whiteboard messages
	MessageTypeWhiteboardUpdate   MessageType = "whiteboard.update"
	MessageTypeWhiteboardSync     MessageType = "whiteboard.sync"
	MessageTypeWhiteboardClear    MessageType = "whiteboard.clear"
	MessageTypeWhiteboardCursor   MessageType = "whiteboard.cursor"
	MessageTypeWhiteboardSnapshot MessageType = "whiteboard.snapshot"
	MessageTypeWhiteboardData     MessageType = "whiteboard.data"
	MessageTypeWhiteboardOpen     MessageType = "whiteboard.open"
	MessageTypeWhiteboardClose    MessageType = "whiteboard.close"
	MessageTypeWhiteboardOpened   MessageType = "whiteboard.opened"
	MessageTypeWhiteboardClosed   MessageType = "whiteboard.closed"

	// Permission messages
	MessageTypePermissionGrant   MessageType = "permission.grant"
	MessageTypePermissionRevoke  MessageType = "permission.revoke"
	MessageTypePermissionChanged MessageType = "permission.changed"

	// Transcript messages
	MessageTypeTranscript    MessageType = "transcript"
	MessageTypeTranscriptAck MessageType = "transcript.ack"
)

// Message is the top-level WebSocket message structure
type Message struct {
	Type    MessageType     `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

// ConnectedPayload is sent when a client connects
type ConnectedPayload struct {
	ParticipantID uuid.UUID `json:"participant_id"`
	RoomID        uuid.UUID `json:"room_id"`
	TenantID      uuid.UUID `json:"tenant_id"`
}

// ParticipantPayload contains participant information
type ParticipantPayload struct {
	ID          uuid.UUID `json:"id"`
	RoomID      uuid.UUID `json:"room_id"`
	DisplayName string    `json:"display_name"`
	IsActive    bool      `json:"is_active"`
	JoinedAt    time.Time `json:"joined_at"`
}

// ParticipantJoinedPayload is sent when a participant joins
type ParticipantJoinedPayload struct {
	Participant ParticipantPayload `json:"participant"`
}

// ParticipantLeftPayload is sent when a participant leaves
type ParticipantLeftPayload struct {
	ParticipantID uuid.UUID `json:"participant_id"`
}

// ParticipantUpdatedPayload is sent when a participant's state changes
type ParticipantUpdatedPayload struct {
	Participant ParticipantPayload `json:"participant"`
}

// ParticipantControlPayload is used for host moderation actions like mute/unmute.
// - Client → Server: requested_by omitted
// - Server → Client: requested_by set to the host participant_id
type ParticipantControlPayload struct {
	ParticipantID uuid.UUID  `json:"participant_id"`
	RequestedBy   *uuid.UUID `json:"requested_by,omitempty"`
}

// ChatMessagePayload contains a chat message
type ChatMessagePayload struct {
	ID            uuid.UUID                `json:"id"`
	ParticipantID uuid.UUID                `json:"participant_id"`
	DisplayName   string                   `json:"display_name"`
	Content       string                   `json:"content"`
	Timestamp     time.Time                `json:"timestamp"`
	Attachments   []ChatAttachmentPayload  `json:"attachments,omitempty"`
	ReadBy        []ChatReadReceiptPayload `json:"read_by,omitempty"`
}

type ChatAttachmentPayload struct {
	ID        uuid.UUID `json:"id"`
	FileName  string    `json:"file_name"`
	MimeType  string    `json:"mime_type"`
	SizeBytes int64     `json:"size_bytes"`
	Kind      string    `json:"kind"`
}

type ChatReadReceiptPayload struct {
	ParticipantID uuid.UUID `json:"participant_id"`
	DisplayName   string    `json:"display_name"`
	ReadAt        time.Time `json:"read_at"`
}

// ReactionPayload contains an emoji reaction
type ReactionPayload struct {
	ParticipantID uuid.UUID `json:"participant_id"`
	Emoji         string    `json:"emoji"`
	Timestamp     time.Time `json:"timestamp"`
}

// HandRaisedPayload is sent when a participant raises their hand
type HandRaisedPayload struct {
	ParticipantID uuid.UUID `json:"participant_id"`
	Timestamp     time.Time `json:"timestamp"`
}

// HandLoweredPayload is sent when a participant lowers their hand
type HandLoweredPayload struct {
	ParticipantID uuid.UUID `json:"participant_id"`
	Timestamp     time.Time `json:"timestamp"`
}

// RoomPayload contains room information
type RoomPayload struct {
	ID        uuid.UUID  `json:"id"`
	TenantID  uuid.UUID  `json:"tenant_id"`
	Name      string     `json:"name"`
	IsActive  bool       `json:"is_active"`
	StartedAt time.Time  `json:"started_at"`
	EndedAt   *time.Time `json:"ended_at,omitempty"`
}

// RoomUpdatedPayload is sent when room state changes
type RoomUpdatedPayload struct {
	Room RoomPayload `json:"room"`
}

// RoomSnapshotPayload contains full room state sent on connection
type RoomSnapshotPayload struct {
	RoomID       uuid.UUID            `json:"room_id"`
	Participants []ParticipantPayload `json:"participants"`
	IsRecording  bool                 `json:"is_recording"`
	RecordingID  *uuid.UUID           `json:"recording_id,omitempty"`
	LastSeq      int64                `json:"last_seq"`
	Messages     []ChatMessagePayload `json:"messages,omitempty"`
}

// RoomSyncPayload is sent by client to request a room snapshot
type RoomSyncPayload struct {
	LastSeq int64 `json:"last_seq"`
}

// RecordingStartedPayload is sent when recording begins
type RecordingStartedPayload struct {
	RecordingID uuid.UUID `json:"recording_id"`
	Timestamp   time.Time `json:"timestamp"`
}

// RecordingStoppedPayload is sent when recording ends
type RecordingStoppedPayload struct {
	RecordingID uuid.UUID `json:"recording_id"`
	Timestamp   time.Time `json:"timestamp"`
}

// ErrorPayload contains error information
type ErrorPayload struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// ChatSendPayload is sent by client to send a chat message
type ChatSendPayload struct {
	Content       string      `json:"content"`
	AttachmentIDs []uuid.UUID `json:"attachment_ids,omitempty"`
}

type ChatReadPayload struct {
	ReadThroughMessageID uuid.UUID `json:"read_through_message_id"`
}

type ChatReadPayloadOut struct {
	MessageIDs    []uuid.UUID `json:"message_ids"`
	ParticipantID uuid.UUID   `json:"participant_id"`
	DisplayName   string      `json:"display_name"`
	ReadAt        time.Time   `json:"read_at"`
}

// ReactionSendPayload is sent by client to send a reaction
type ReactionSendPayload struct {
	Emoji string `json:"emoji"`
}

// PingPayload is sent by server to test connection
type PingPayload struct {
	Timestamp time.Time `json:"timestamp"`
}

// PongPayload is sent by client in response to ping
type PongPayload struct {
	Timestamp time.Time `json:"timestamp"`
}

// WhiteboardUpdatePayload - client sends drawing changes
//
// NOTE: Elements are Excalidraw-native JSON objects; do not transform nested keys.
type WhiteboardUpdatePayload struct {
	SchemaVersion int64           `json:"schema_version"` // must be 2
	SceneID       string          `json:"scene_id"`
	SyncAll       bool            `json:"sync_all"`
	Elements      json.RawMessage `json:"elements"` // Excalidraw elements array
	Seq           int64           `json:"seq"`      // monotonic per-sender
}

// WhiteboardDataPayload - server broadcasts to room
type WhiteboardDataPayload struct {
	SchemaVersion int64           `json:"schema_version"`
	SceneID       string          `json:"scene_id"`
	SyncAll       bool            `json:"sync_all"`
	ParticipantID uuid.UUID       `json:"participant_id"`
	DisplayName   string          `json:"display_name"`
	Elements      json.RawMessage `json:"elements"`
	Files         json.RawMessage `json:"files,omitempty"`
	Seq           int64           `json:"seq"`
	Timestamp     time.Time       `json:"timestamp"`
}

// WhiteboardSnapshotPayload - full state sent on join
type WhiteboardSnapshotPayload struct {
	SchemaVersion int64           `json:"schema_version"`
	RoomID        uuid.UUID       `json:"room_id"`
	SceneID       string          `json:"scene_id"`
	Elements      json.RawMessage `json:"elements"`
	Files         json.RawMessage `json:"files"`
	AppState      json.RawMessage `json:"app_state"`
	UpdatedAtMs   int64           `json:"updated_at_ms"`
	LastSeq       int64           `json:"last_seq"`
}

// WhiteboardCursorPayload - cursor position updates
type WhiteboardCursorPayload struct {
	ParticipantID uuid.UUID `json:"participant_id"`
	DisplayName   string    `json:"display_name"`
	X             float64   `json:"x"`
	Y             float64   `json:"y"`
	Timestamp     time.Time `json:"timestamp"`
}

// PermissionGrantPayload - host grants drawing permission
type PermissionGrantPayload struct {
	ParticipantID uuid.UUID `json:"participant_id"`
	Feature       string    `json:"feature"` // "whiteboard"
}

// PermissionChangedPayload - broadcast permission change
type PermissionChangedPayload struct {
	ParticipantID uuid.UUID `json:"participant_id"`
	Feature       string    `json:"feature"`
	CanDraw       bool      `json:"can_draw"`
	GrantedBy     uuid.UUID `json:"granted_by"`
	Timestamp     time.Time `json:"timestamp"`
}

// WhiteboardOpenedPayload - broadcast when whiteboard is opened
type WhiteboardOpenedPayload struct {
	ParticipantID uuid.UUID `json:"participant_id"`
	DisplayName   string    `json:"display_name"`
	Timestamp     time.Time `json:"timestamp"`
}

// WhiteboardClosedPayload - broadcast when whiteboard is closed
type WhiteboardClosedPayload struct {
	ParticipantID uuid.UUID `json:"participant_id"`
	Timestamp     time.Time `json:"timestamp"`
}

// TranscriptPayload - client sends transcript from Cloudflare AI
type TranscriptPayload struct {
	ID            string   `json:"id"`            // External ID from Cloudflare
	ParticipantID string   `json:"participantId"` // Cloudflare participant ID
	SpeakerName   string   `json:"speakerName"`
	Text          string   `json:"text"`
	Timestamp     string   `json:"timestamp"` // ISO 8601 string
	IsInterim     bool     `json:"isInterim"`
	Confidence    *float32 `json:"confidence,omitempty"`
}

// TranscriptAckPayload - server acknowledges transcript receipt
type TranscriptAckPayload struct {
	ID        string    `json:"id"` // External ID that was saved
	Timestamp time.Time `json:"timestamp"`
}

// NewMessage creates a new message with the given type and payload
func NewMessage(msgType MessageType, payload interface{}) (*Message, error) {
	data, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	return &Message{
		Type:    msgType,
		Payload: data,
	}, nil
}

// UnmarshalPayload unmarshals the payload into the given interface
func (m *Message) UnmarshalPayload(v interface{}) error {
	return json.Unmarshal(m.Payload, v)
}
