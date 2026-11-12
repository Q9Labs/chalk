package postgres

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
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
