package postgres

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recordingpresentation"
)

type completionControlEventWire struct {
	Revision  int64           `json:"revision"`
	Name      string          `json:"event_name"`
	Payload   json.RawMessage `json:"payload"`
	CreatedAt time.Time       `json:"created_at"`
}

type completionCapturePlanWire struct {
	Revision        int64     `json:"revision"`
	CaptureEpoch    int64     `json:"capture_epoch"`
	SourceRevision  int64     `json:"source_revision"`
	PlanBytes       string    `json:"plan_bytes"`
	PlanFingerprint string    `json:"plan_fingerprint"`
	CreatedAt       time.Time `json:"created_at"`
}

type completionAttachmentWire struct {
	ID                      string `json:"attachment_id"`
	ObjectKey               string `json:"object_key"`
	ObjectETag              string `json:"object_etag"`
	ImmutableObjectIdentity string `json:"immutable_object_identity"`
	FileName                string `json:"original_filename"`
	MIMEType                string `json:"mime_type"`
	ByteLength              int64  `json:"byte_length"`
	SHA256                  string `json:"sha256"`
}

type completionChatMessageWire struct {
	ID                    string                     `json:"message_id"`
	Sequence              int64                      `json:"sequence"`
	ParticipantID         string                     `json:"participant_id"`
	ParticipantGeneration int64                      `json:"participant_generation"`
	DisplayName           string                     `json:"display_name"`
	Text                  string                     `json:"message_text"`
	CreatedAt             time.Time                  `json:"created_at"`
	Attachments           []completionAttachmentWire `json:"attachments"`
}

type completionWhiteboardSnapshotWire struct {
	SceneID    string            `json:"scene_id"`
	Revision   int64             `json:"revision"`
	Presenting bool              `json:"presenting"`
	AppState   json.RawMessage   `json:"app_state"`
	Elements   []json.RawMessage `json:"elements"`
}

type completionWhiteboardEventWire struct {
	Name        string            `json:"operation_name"`
	OperationID string            `json:"operation_id"`
	SceneID     string            `json:"scene_id"`
	Revision    int64             `json:"revision"`
	Elements    []json.RawMessage `json:"elements"`
	Presenting  *bool             `json:"presenting"`
	CompletedAt time.Time         `json:"completed_at"`
}

type completionWhiteboardFileWire struct {
	ID         string `json:"file_id"`
	ObjectKey  string `json:"object_key"`
	ObjectETag string `json:"object_etag"`
	MIMEType   string `json:"mime_type"`
	ByteLength int64  `json:"byte_length"`
	SHA256     string `json:"sha256"`
}

type completionReactionWire struct {
	ID                    string    `json:"reaction_id"`
	ParticipantID         string    `json:"participant_id"`
	ParticipantGeneration int64     `json:"participant_generation"`
	DisplayName           string    `json:"display_name"`
	Value                 string    `json:"reaction"`
	OccurredAt            time.Time `json:"occurred_at"`
	ExpiresAt             time.Time `json:"expires_at"`
}

func mapControlEventFact(value completionControlEventWire) recordingpresentation.ControlEventFact {
	return recordingpresentation.ControlEventFact{Revision: value.Revision, Name: value.Name, Payload: append(json.RawMessage(nil), value.Payload...), CreatedAt: value.CreatedAt}
}

func mapChatMessageFacts(values []completionChatMessageWire) ([]recordingpresentation.ChatMessageFact, error) {
	result := make([]recordingpresentation.ChatMessageFact, 0, len(values))
	for _, value := range values {
		fact := recordingpresentation.ChatMessageFact{
			ID: value.ID, Sequence: value.Sequence, ParticipantID: value.ParticipantID,
			ParticipantGeneration: value.ParticipantGeneration, DisplayName: value.DisplayName,
			Text: value.Text, CreatedAt: value.CreatedAt,
			Attachments: make([]recordingpresentation.ChatAttachmentFact, 0, len(value.Attachments)),
		}
		for _, attachment := range value.Attachments {
			etag := attachment.ObjectETag
			if etag == "" {
				etag = attachment.ImmutableObjectIdentity
			}
			object, err := completionObjectFact(attachment.ObjectKey, etag, attachment.MIMEType, attachment.ByteLength, attachment.SHA256)
			if err != nil {
				return nil, err
			}
			fact.Attachments = append(fact.Attachments, recordingpresentation.ChatAttachmentFact{ID: attachment.ID, FileName: attachment.FileName, Object: object})
		}
		result = append(result, fact)
	}
	return result, nil
}

func mapWhiteboardEventFacts(values []completionWhiteboardEventWire) []recordingpresentation.WhiteboardEventFact {
	result := make([]recordingpresentation.WhiteboardEventFact, 0, len(values))
	for _, value := range values {
		result = append(result, recordingpresentation.WhiteboardEventFact{
			OperationID: value.OperationID, Name: value.Name, SceneID: value.SceneID,
			Revision: value.Revision, Elements: cloneRawMessages(value.Elements),
			Presenting: cloneBool(value.Presenting), CompletedAt: value.CompletedAt,
		})
	}
	return result
}

func mapWhiteboardFileFacts(values []completionWhiteboardFileWire) ([]recordingpresentation.WhiteboardFileFact, error) {
	result := make([]recordingpresentation.WhiteboardFileFact, 0, len(values))
	for _, value := range values {
		object, err := completionObjectFact(value.ObjectKey, value.ObjectETag, value.MIMEType, value.ByteLength, value.SHA256)
		if err != nil {
			return nil, err
		}
		result = append(result, recordingpresentation.WhiteboardFileFact{ID: value.ID, Object: object})
	}
	return result, nil
}

func completionObjectFact(key, etag, contentType string, byteSize int64, digestHex string) (recordingpresentation.ObjectFact, error) {
	digest, err := hex.DecodeString(digestHex)
	if err != nil || len(digest) != 32 {
		return recordingpresentation.ObjectFact{}, recordingpresentation.ErrObjectFactsMismatch
	}
	return recordingpresentation.ObjectFact{Key: key, ETag: etag, ContentType: contentType, ByteSize: byteSize, SHA256: digest}, nil
}

func strictCompletionJSON[T any](payload []byte, destination *T) error {
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("recording presentation source contains trailing JSON")
		}
		return err
	}
	return nil
}

func cloneRawMessages(values []json.RawMessage) []json.RawMessage {
	result := make([]json.RawMessage, len(values))
	for index := range values {
		result[index] = append(json.RawMessage(nil), values[index]...)
	}
	return result
}

func cloneBool(value *bool) *bool {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func completionSourceError(field string, err error) error {
	return fmt.Errorf("%w: decode %s: %v", recordingpresentation.ErrInvalidCompletionSource, field, err)
}
