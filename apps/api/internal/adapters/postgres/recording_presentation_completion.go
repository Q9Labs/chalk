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
	payloads, err := decodeCompletionPayloads(row)
	if err != nil {
		return recordingpresentation.CompletionSource{}, err
	}
	source, err := completionSourceHeader(row, payloads.profile)
	if err != nil {
		return recordingpresentation.CompletionSource{}, err
	}
	if row.SchemaVersion != recordingpresentation.SchemaVersion || row.ProfileVersion != payloads.profile.Version ||
		!row.CaptureReadyAt.Valid || !row.EndedAt.Valid ||
		!timestamp(row.EndedAt).Equal(timestamp(row.CaptureReadyAt).Add(time.Duration(row.DurationMillis)*time.Millisecond)) {
		return recordingpresentation.CompletionSource{}, recordingpresentation.ErrInvalidCompletionSource
	}
	for _, value := range payloads.originControl {
		source.EpisodeControlOriginEvents = append(source.EpisodeControlOriginEvents, mapControlEventFact(value))
	}
	for _, value := range payloads.tailControl {
		source.EpisodeControlTailEvents = append(source.EpisodeControlTailEvents, mapControlEventFact(value))
	}
	if source.InitialChatMessages, err = mapChatMessageFacts(payloads.initialChat); err != nil {
		return recordingpresentation.CompletionSource{}, err
	}
	if source.ChatTailMessages, err = mapChatMessageFacts(payloads.tailChat); err != nil {
		return recordingpresentation.CompletionSource{}, err
	}
	source.WhiteboardOriginEvents = mapWhiteboardEventFacts(payloads.originWhiteboard)
	source.WhiteboardTailEvents = mapWhiteboardEventFacts(payloads.tailWhiteboard)
	if source.WhiteboardFiles, err = mapWhiteboardFileFacts(payloads.whiteboardFiles); err != nil {
		return recordingpresentation.CompletionSource{}, err
	}
	if source.CapturePlans, err = mapCapturePlanFacts(payloads.plans, row.CaptureEpoch); err != nil {
		return recordingpresentation.CompletionSource{}, err
	}
	for _, value := range payloads.reactions {
		source.Reactions = append(source.Reactions, recordingpresentation.ReactionFact{
			ID: value.ID, ParticipantID: value.ParticipantID, ParticipantGeneration: value.ParticipantGeneration,
			DisplayName: value.DisplayName, Value: value.Value, OccurredAt: value.OccurredAt, ExpiresAt: value.ExpiresAt,
		})
	}
	return source, nil
}

// completionPayloads are the JSON documents a completion source row carries, decoded strictly.
type completionPayloads struct {
	profile          recordingpresentation.Profile
	originControl    []completionControlEventWire
	tailControl      []completionControlEventWire
	initialChat      []completionChatMessageWire
	tailChat         []completionChatMessageWire
	originWhiteboard []completionWhiteboardEventWire
	tailWhiteboard   []completionWhiteboardEventWire
	whiteboardFiles  []completionWhiteboardFileWire
	plans            []completionCapturePlanWire
	reactions        []completionReactionWire
}

func decodeCompletion[T any](data []byte, what string) (T, error) {
	var value T
	if err := strictCompletionJSON(data, &value); err != nil {
		return value, completionSourceError(what, err)
	}
	return value, nil
}

func decodeCompletionPayloads(row sqlc.GetRecordingPresentationCompletionSourceRow) (completionPayloads, error) {
	var p completionPayloads
	var err error
	if p.profile, err = decodeCompletion[recordingpresentation.Profile](row.Profile, "profile"); err != nil {
		return p, err
	}
	if p.originControl, err = decodeCompletion[[]completionControlEventWire](row.EpisodeControlEvents, "origin control events"); err != nil {
		return p, err
	}
	if p.tailControl, err = decodeCompletion[[]completionControlEventWire]([]byte(row.EpisodeControlTailEventsJson), "tail control events"); err != nil {
		return p, err
	}
	if p.initialChat, err = decodeCompletion[[]completionChatMessageWire](row.InitialChatMessages, "initial chat"); err != nil {
		return p, err
	}
	if p.tailChat, err = decodeCompletion[[]completionChatMessageWire]([]byte(row.ChatTailMessagesJson), "tail chat"); err != nil {
		return p, err
	}
	if p.originWhiteboard, err = decodeCompletion[[]completionWhiteboardEventWire](row.WhiteboardEvents, "origin whiteboard events"); err != nil {
		return p, err
	}
	if p.tailWhiteboard, err = decodeCompletion[[]completionWhiteboardEventWire]([]byte(row.WhiteboardTailEventsJson), "tail whiteboard events"); err != nil {
		return p, err
	}
	if p.whiteboardFiles, err = decodeCompletion[[]completionWhiteboardFileWire]([]byte(row.WhiteboardFilesJson), "whiteboard files"); err != nil {
		return p, err
	}
	if p.plans, err = decodeCompletion[[]completionCapturePlanWire]([]byte(row.CapturePlansJson), "capture plans"); err != nil {
		return p, err
	}
	p.reactions, err = decodeCompletion[[]completionReactionWire]([]byte(row.ReactionsJson), "reactions")
	return p, err
}

// completionSourceHeader copies the row's scalar facts and the initial whiteboard snapshot.
func completionSourceHeader(row sqlc.GetRecordingPresentationCompletionSourceRow, profile recordingpresentation.Profile) (recordingpresentation.CompletionSource, error) {
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
		snapshot, err := decodeCompletion[completionWhiteboardSnapshotWire](row.WhiteboardSnapshot, "whiteboard snapshot")
		if err != nil {
			return recordingpresentation.CompletionSource{}, err
		}
		source.InitialWhiteboard = &recordingpresentation.WhiteboardSnapshotFact{
			SceneID: snapshot.SceneID, Revision: snapshot.Revision, Presenting: snapshot.Presenting,
			AppState: append(json.RawMessage(nil), snapshot.AppState...), Elements: cloneRawMessages(snapshot.Elements),
		}
	}
	return source, nil
}

// mapCapturePlanFacts decodes each stored capture plan and rejects one whose epoch or revision
// disagrees with its row, or that belongs to a later epoch than the capture.
func mapCapturePlanFacts(plans []completionCapturePlanWire, captureEpoch int64) ([]recordingpresentation.CapturePlanFact, error) {
	var facts []recordingpresentation.CapturePlanFact
	for _, value := range plans {
		planBytes, err := base64.StdEncoding.Strict().DecodeString(value.PlanBytes)
		if err != nil {
			return nil, completionSourceError("capture plan", err)
		}
		plan, err := captureplan.Decode(planBytes, value.PlanFingerprint)
		if err != nil {
			return nil, completionSourceError("capture plan", err)
		}
		authority := plan.Authority()
		if int64(authority.CaptureEpoch) != value.CaptureEpoch || int64(plan.Revision()) != value.SourceRevision || value.CaptureEpoch > captureEpoch {
			return nil, recordingpresentation.ErrInvalidCompletionSource
		}
		facts = append(facts, recordingpresentation.CapturePlanFact{Revision: value.Revision, Plan: plan, CreatedAt: value.CreatedAt})
	}
	return facts, nil
}
