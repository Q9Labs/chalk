package postgres

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/recordingpresentation"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type recordingPresentationCompletionQuerier interface {
	GetRecordingPresentationCompletionSource(context.Context, sqlc.GetRecordingPresentationCompletionSourceParams) (sqlc.GetRecordingPresentationCompletionSourceRow, error)
}

type RecordingPresentationCompletionSourceRepository struct {
	queries recordingPresentationCompletionQuerier
}

func NewRecordingPresentationCompletionSourceRepository(queries recordingPresentationCompletionQuerier) RecordingPresentationCompletionSourceRepository {
	return RecordingPresentationCompletionSourceRepository{queries: queries}
}

func (repository RecordingPresentationCompletionSourceRepository) LoadCompletionSource(ctx context.Context, authority recordingpresentation.CompletionAuthority) (recordingpresentation.CompletionSource, error) {
	if repository.queries == nil {
		return recordingpresentation.CompletionSource{}, recordingpresentation.ErrCompletionSourceNotFound
	}
	if err := authority.Validate(); err != nil {
		return recordingpresentation.CompletionSource{}, err
	}
	row, err := repository.queries.GetRecordingPresentationCompletionSource(ctx, sqlc.GetRecordingPresentationCompletionSourceParams{
		JobID: uuid(authority.JobID), AttemptCount: int32(authority.AttemptCount),
		FencingGeneration: authority.FencingGeneration, CaptureEpoch: authority.CaptureEpoch,
		EnvelopeDigest: authority.EnvelopeDigest, LeaseToken: authority.LeaseToken, LeaseOwner: authority.LeaseOwner,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return recordingpresentation.CompletionSource{}, recordingpresentation.ErrCompletionSourceNotFound
	}
	if err != nil {
		return recordingpresentation.CompletionSource{}, fmt.Errorf("load recording presentation completion source: %w", err)
	}
	return mapRecordingPresentationCompletionSource(row)
}

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

func mapRecordingPresentationCompletionSource(row sqlc.GetRecordingPresentationCompletionSourceRow) (recordingpresentation.CompletionSource, error) {
	var profile recordingpresentation.Profile
	if err := strictCompletionJSON(row.Profile, &profile); err != nil {
		return recordingpresentation.CompletionSource{}, completionSourceError("profile", err)
	}
	var originControl []completionControlEventWire
	if err := strictCompletionJSON(row.EpisodeControlEvents, &originControl); err != nil {
		return recordingpresentation.CompletionSource{}, completionSourceError("origin control events", err)
	}
	var tailControl []completionControlEventWire
	if err := strictCompletionJSON([]byte(row.EpisodeControlTailEventsJson), &tailControl); err != nil {
		return recordingpresentation.CompletionSource{}, completionSourceError("tail control events", err)
	}
	var initialChat []completionChatMessageWire
	if err := strictCompletionJSON(row.InitialChatMessages, &initialChat); err != nil {
		return recordingpresentation.CompletionSource{}, completionSourceError("initial chat", err)
	}
	var tailChat []completionChatMessageWire
	if err := strictCompletionJSON([]byte(row.ChatTailMessagesJson), &tailChat); err != nil {
		return recordingpresentation.CompletionSource{}, completionSourceError("tail chat", err)
	}
	var originWhiteboard []completionWhiteboardEventWire
	if err := strictCompletionJSON(row.WhiteboardEvents, &originWhiteboard); err != nil {
		return recordingpresentation.CompletionSource{}, completionSourceError("origin whiteboard events", err)
	}
	var tailWhiteboard []completionWhiteboardEventWire
	if err := strictCompletionJSON([]byte(row.WhiteboardTailEventsJson), &tailWhiteboard); err != nil {
		return recordingpresentation.CompletionSource{}, completionSourceError("tail whiteboard events", err)
	}
	var whiteboardFiles []completionWhiteboardFileWire
	if err := strictCompletionJSON([]byte(row.WhiteboardFilesJson), &whiteboardFiles); err != nil {
		return recordingpresentation.CompletionSource{}, completionSourceError("whiteboard files", err)
	}
	var plans []completionCapturePlanWire
	if err := strictCompletionJSON([]byte(row.CapturePlansJson), &plans); err != nil {
		return recordingpresentation.CompletionSource{}, completionSourceError("capture plans", err)
	}
	var reactions []completionReactionWire
	if err := strictCompletionJSON([]byte(row.ReactionsJson), &reactions); err != nil {
		return recordingpresentation.CompletionSource{}, completionSourceError("reactions", err)
	}

	source := recordingpresentation.CompletionSource{
		PresentationHandle: utilities.IDFromBytes(row.PresentationHandle.Bytes),
		TenantID:           utilities.IDFromBytes(row.TenantID.Bytes), SpaceID: utilities.IDFromBytes(row.SpaceID.Bytes),
		EpisodeID: utilities.IDFromBytes(row.EpisodeID.Bytes), RecordingID: utilities.IDFromBytes(row.RecordingID.Bytes),
		CaptureEpoch: row.CaptureEpoch, CaptureReadyAt: timestamp(row.CaptureReadyAt), DurationMillis: row.DurationMillis,
		Profile: profile, SpaceName: row.SpaceName,
		EpisodeControlStartRevision:  row.EpisodeControlStartRevision,
		EpisodeControlOriginRevision: row.EpisodeControlEndRevision,
		ChatStartSequence:            row.ChatStartSequence,
		WhiteboardStartRevision:      row.WhiteboardStartRevision, WhiteboardOriginRevision: row.WhiteboardEndRevision,
		CapturePlanStartRevision: row.CapturePlanStartRevision,
		BaselineControlState:     append(json.RawMessage(nil), row.EpisodeFoldedState...),
	}
	if row.ChatRetainedFloorSequence.Valid {
		value := row.ChatRetainedFloorSequence.Int64
		source.ChatRetainedFloorSequence = &value
	}
	if len(row.WhiteboardSnapshot) > 0 {
		var snapshot completionWhiteboardSnapshotWire
		if err := strictCompletionJSON(row.WhiteboardSnapshot, &snapshot); err != nil {
			return recordingpresentation.CompletionSource{}, completionSourceError("whiteboard snapshot", err)
		}
		source.InitialWhiteboard = &recordingpresentation.WhiteboardSnapshotFact{
			SceneID: snapshot.SceneID, Revision: snapshot.Revision, Presenting: snapshot.Presenting,
			AppState: append(json.RawMessage(nil), snapshot.AppState...), Elements: cloneRawMessages(snapshot.Elements),
		}
	}

	if row.SchemaVersion != recordingpresentation.SchemaVersion || row.ProfileVersion != profile.Version ||
		!row.CaptureReadyAt.Valid || !row.EndedAt.Valid ||
		!timestamp(row.EndedAt).Equal(timestamp(row.CaptureReadyAt).Add(time.Duration(row.DurationMillis)*time.Millisecond)) {
		return recordingpresentation.CompletionSource{}, recordingpresentation.ErrInvalidCompletionSource
	}
	for _, value := range originControl {
		source.EpisodeControlOriginEvents = append(source.EpisodeControlOriginEvents, mapControlEventFact(value))
	}
	for _, value := range tailControl {
		source.EpisodeControlTailEvents = append(source.EpisodeControlTailEvents, mapControlEventFact(value))
	}
	var err error
	source.InitialChatMessages, err = mapChatMessageFacts(initialChat)
	if err != nil {
		return recordingpresentation.CompletionSource{}, err
	}
	source.ChatTailMessages, err = mapChatMessageFacts(tailChat)
	if err != nil {
		return recordingpresentation.CompletionSource{}, err
	}
	source.WhiteboardOriginEvents = mapWhiteboardEventFacts(originWhiteboard)
	source.WhiteboardTailEvents = mapWhiteboardEventFacts(tailWhiteboard)
	source.WhiteboardFiles, err = mapWhiteboardFileFacts(whiteboardFiles)
	if err != nil {
		return recordingpresentation.CompletionSource{}, err
	}
	for _, value := range plans {
		planBytes, decodeErr := base64.StdEncoding.Strict().DecodeString(value.PlanBytes)
		if decodeErr != nil {
			return recordingpresentation.CompletionSource{}, completionSourceError("capture plan", decodeErr)
		}
		plan, decodeErr := captureplan.Decode(planBytes, value.PlanFingerprint)
		if decodeErr != nil {
			return recordingpresentation.CompletionSource{}, completionSourceError("capture plan", decodeErr)
		}
		authority := plan.Authority()
		if int64(authority.CaptureEpoch) != value.CaptureEpoch || int64(plan.Revision()) != value.SourceRevision || value.CaptureEpoch > row.CaptureEpoch {
			return recordingpresentation.CompletionSource{}, recordingpresentation.ErrInvalidCompletionSource
		}
		source.CapturePlans = append(source.CapturePlans, recordingpresentation.CapturePlanFact{Revision: value.Revision, Plan: plan, CreatedAt: value.CreatedAt})
	}
	for _, value := range reactions {
		source.Reactions = append(source.Reactions, recordingpresentation.ReactionFact{
			ID: value.ID, ParticipantID: value.ParticipantID, ParticipantGeneration: value.ParticipantGeneration,
			DisplayName: value.DisplayName, Value: value.Value, OccurredAt: value.OccurredAt, ExpiresAt: value.ExpiresAt,
		})
	}
	return source, nil
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
