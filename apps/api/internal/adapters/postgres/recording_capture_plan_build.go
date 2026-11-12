package postgres

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/mediapublications"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type foldedCapturePlanState struct {
	ControlRevision int64                          `json:"control_revision"`
	Status          string                         `json:"status"`
	Participants    []foldedCapturePlanParticipant `json:"participants"`
}

type foldedCapturePlanParticipant struct {
	ParticipantID     string `json:"participant_id"`
	DisplayName       string `json:"display_name"`
	AdmissionRevision int64  `json:"admission_revision"`
}

type persistedCapturePlanParticipant struct {
	ParticipantID string `json:"participant_id"`
	Generation    int64  `json:"generation"`
	Status        string `json:"status"`
}

type persistedCapturePlanPublication struct {
	ParticipantID string  `json:"participant_id"`
	Source        string  `json:"source"`
	Enabled       bool    `json:"enabled"`
	PublicationID *string `json:"publication_id"`
}

func buildRecordingCapturePlan(source sqlc.GetRecordingCapturePlanSourceRow, input captureplan.WaitInput, revision int64, now time.Time) (captureplan.Plan, error) {
	envelope, err := recordingpipeline.DecodeRecorderJobEnvelope(source.EnvelopeBytes, source.EnvelopeDigest)
	if err != nil {
		return captureplan.Plan{}, fmt.Errorf("decode capture plan authority: %w", err)
	}
	if err := validateCapturePlanEnvelope(source, input, envelope); err != nil {
		return captureplan.Plan{}, err
	}

	var folded foldedCapturePlanState
	if err := json.Unmarshal(source.EpisodeFoldedState, &folded); err != nil {
		return captureplan.Plan{}, fmt.Errorf("decode capture plan folded state: %w", captureplan.ErrInvalidPlan)
	}
	stoppedEpisode := folded.Status == "ended" && source.StopRequestedAt.Valid
	if folded.ControlRevision != source.EpisodeControlRevision || (folded.Status != "active" && !stoppedEpisode) {
		return captureplan.Plan{}, fmt.Errorf("capture plan folded state is neither active nor durably stopped: %w", captureplan.ErrInvalidPlan)
	}
	var persistedParticipants []persistedCapturePlanParticipant
	if err := strictCapturePlanJSON(source.EpisodeParticipants, &persistedParticipants); err != nil {
		return captureplan.Plan{}, fmt.Errorf("decode capture plan participants: %w", captureplan.ErrInvalidPlan)
	}
	participants, participantGenerations, err := capturePlanParticipants(folded.Participants, persistedParticipants)
	if err != nil {
		return captureplan.Plan{}, err
	}
	var publications []persistedCapturePlanPublication
	if err := strictCapturePlanJSON(source.ProviderPublications, &publications); err != nil {
		return captureplan.Plan{}, fmt.Errorf("decode capture plan publications: %w", captureplan.ErrInvalidPlan)
	}
	tracks, err := capturePlanTracks(publications, participantGenerations)
	if err != nil {
		return captureplan.Plan{}, err
	}

	effectiveDeadline, err := time.Parse(time.RFC3339Nano, envelope.HardDeadline)
	if err != nil || !effectiveDeadline.Equal(timestamp(source.EndsAt)) {
		return captureplan.Plan{}, fmt.Errorf("capture plan deadline does not match reservation: %w", captureplan.ErrInvalidPlan)
	}
	stopState := captureplan.StopStateRunning
	var stopRequestedAt time.Time
	if source.StopRequestedAt.Valid {
		stopState = captureplan.StopStateRequested
		stopRequestedAt = timestamp(source.StopRequestedAt)
	} else if !now.Before(effectiveDeadline) {
		stopState = captureplan.StopStateRequested
		stopRequestedAt = effectiveDeadline
	}

	return captureplan.NewPlan(captureplan.PlanInput{
		Authority: captureplan.PlanAuthority{
			PlanHandle: captureplan.PlanHandle(envelope.PlanHandle), TenantID: input.TenantID,
			SpaceID: input.SpaceID, EpisodeID: input.EpisodeID, RecordingID: input.RecordingID,
			JobID: input.JobID, AttemptCount: input.AttemptCount, FencingGeneration: input.FencingGeneration,
			CaptureEpoch: input.CaptureEpoch, EnvelopeDigest: input.EnvelopeDigest,
		},
		Revision: captureplane.PlanRevision(revision),
		Cursors: captureplan.PlanCursors{
			EpisodeControlRevision: source.EpisodeControlRevision,
			ProviderIncarnation:    source.ProviderIncarnation, ProviderSequence: source.ProviderSequence,
		},
		LayoutProfile:    captureplan.LayoutProfile(envelope.LayoutProfile),
		ParticipantLimit: envelope.ParticipantLimit, InputBitrateBPS: envelope.InputBitrateBPS,
		EffectiveDeadline: effectiveDeadline, StopState: stopState, StopRequestedAt: stopRequestedAt,
		Participants: participants, Tracks: tracks,
	})
}

func validateCapturePlanEnvelope(source sqlc.GetRecordingCapturePlanSourceRow, input captureplan.WaitInput, envelope recordingpipeline.RecorderJobEnvelope) error {
	if envelope.Kind != recordingpipeline.JobKindCapture || envelope.PlanHandle != string(input.PlanHandle) ||
		envelope.TenantID != input.TenantID.String() || envelope.SpaceID != input.SpaceID.String() ||
		envelope.EpisodeID != input.EpisodeID.String() || envelope.RecordingID != input.RecordingID.String() ||
		envelope.JobID != input.JobID.String() || envelope.AttemptCount != input.AttemptCount ||
		envelope.FencingGeneration != input.FencingGeneration || envelope.CaptureEpoch != int64(input.CaptureEpoch) ||
		utilities.IDFromBytes(source.JobID.Bytes) != input.JobID || utilities.IDFromBytes(source.TenantID.Bytes) != input.TenantID ||
		utilities.IDFromBytes(source.SpaceID.Bytes) != input.SpaceID || utilities.IDFromBytes(source.EpisodeID.Bytes) != input.EpisodeID ||
		utilities.IDFromBytes(source.RecordingID.Bytes) != input.RecordingID || !bytes.Equal(source.EnvelopeDigest, input.EnvelopeDigest) {
		return captureplan.ErrPlanAuthorityMismatch
	}
	return nil
}

func capturePlanParticipants(folded []foldedCapturePlanParticipant, persisted []persistedCapturePlanParticipant) ([]captureplan.ParticipantSnapshot, map[utilities.ID]int64, error) {
	persistedByID := make(map[utilities.ID]persistedCapturePlanParticipant, len(persisted))
	for _, participant := range persisted {
		id, err := utilities.ParseID(participant.ParticipantID)
		if err != nil || participant.Generation <= 0 || (participant.Status != "active" && participant.Status != "leaving") {
			return nil, nil, fmt.Errorf("invalid persisted capture participant: %w", captureplan.ErrInvalidParticipant)
		}
		if _, exists := persistedByID[id]; exists {
			return nil, nil, fmt.Errorf("duplicate persisted capture participant: %w", captureplan.ErrInvalidParticipant)
		}
		persistedByID[id] = participant
	}
	result := make([]captureplan.ParticipantSnapshot, 0, len(folded))
	generations := make(map[utilities.ID]int64, len(folded))
	for _, participant := range folded {
		id, err := utilities.ParseID(participant.ParticipantID)
		persistedParticipant, exists := persistedByID[id]
		if err != nil || !exists {
			return nil, nil, fmt.Errorf("capture participant is missing from durable lifecycle: %w", captureplan.ErrInvalidParticipant)
		}
		result = append(result, captureplan.ParticipantSnapshot{
			ID: id, Generation: persistedParticipant.Generation, DisplayName: participant.DisplayName,
			JoinOrdinal: participant.AdmissionRevision, Lifecycle: captureplan.ParticipantActive,
		})
		generations[id] = persistedParticipant.Generation
		delete(persistedByID, id)
	}
	if len(persistedByID) != 0 {
		return nil, nil, fmt.Errorf("durable capture participants diverge from folded state: %w", captureplan.ErrInvalidParticipant)
	}
	return result, generations, nil
}

func capturePlanTracks(publications []persistedCapturePlanPublication, participantGenerations map[utilities.ID]int64) ([]captureplan.TrackSnapshot, error) {
	tracks := make([]captureplan.TrackSnapshot, 0, len(publications))
	for _, publication := range publications {
		// Shared tab audio is not part of the recording format yet.
		if publication.Source == "screen_audio" {
			continue
		}
		if publication.Enabled && publication.PublicationID == nil {
			return nil, fmt.Errorf("invalid capture publication identity: %w", captureplan.ErrInvalidTrack)
		}
		if !publication.Enabled {
			continue
		}
		participantID, err := utilities.ParseID(publication.ParticipantID)
		if err != nil {
			return nil, fmt.Errorf("invalid capture publication identity: %w", captureplan.ErrInvalidTrack)
		}
		generation, participantExists := participantGenerations[participantID]
		// Provider observations can precede admission or outlive departure.
		// Only the current participant snapshot authorizes a capture track.
		if !participantExists {
			continue
		}
		reference, err := mediapublications.ParseReference(*publication.PublicationID)
		if err != nil || !reference.HasMID || !reference.HasParticipantGeneration || reference.ParticipantGeneration != generation {
			return nil, fmt.Errorf("invalid capture publication reference: %w", captureplan.ErrInvalidTrack)
		}
		ownerReference, ownerErr := captureplane.NewProviderReference(reference.ConnectionID)
		trackReference, trackErr := captureplane.NewProviderReference(reference.TrackName)
		ownerMID, midErr := captureplane.NewProviderReference(reference.MID)
		kind, kindErr := capturePlanTrackKind(publication.Source)
		if ownerErr != nil || trackErr != nil || midErr != nil || kindErr != nil {
			return nil, fmt.Errorf("invalid capture provider track: %w", captureplan.ErrInvalidTrack)
		}
		tracks = append(tracks, captureplan.TrackSnapshot{
			ParticipantID: participantID, ParticipantGeneration: generation,
			Source: captureplane.TrackSource(publication.Source), Kind: kind,
			OwnerReference: ownerReference, TrackReference: trackReference, OwnerMID: ownerMID,
			PublicationReference: captureplan.PublicationReference(*publication.PublicationID),
			RequestedLayer:       captureplane.TrackLayerAuto,
		})
	}
	return tracks, nil
}

func capturePlanTrackKind(source string) (captureplane.TrackKind, error) {
	switch captureplane.TrackSource(source) {
	case captureplane.TrackSourceMicrophone:
		return captureplane.TrackKindAudio, nil
	case captureplane.TrackSourceCamera, captureplane.TrackSourceScreen:
		return captureplane.TrackKindVideo, nil
	default:
		return "", captureplan.ErrInvalidTrack
	}
}

func validateStoredCapturePlan(plan sqlc.RecordingCapturePlan, input captureplan.WaitInput) error {
	if utilities.IDFromBytes(plan.PlanHandle.Bytes).String() != string(input.PlanHandle) ||
		utilities.IDFromBytes(plan.JobID.Bytes) != input.JobID || plan.AttemptCount != int32(input.AttemptCount) ||
		plan.FencingGeneration != input.FencingGeneration || plan.CaptureEpoch != int64(input.CaptureEpoch) ||
		utilities.IDFromBytes(plan.TenantID.Bytes) != input.TenantID || utilities.IDFromBytes(plan.SpaceID.Bytes) != input.SpaceID ||
		utilities.IDFromBytes(plan.EpisodeID.Bytes) != input.EpisodeID || utilities.IDFromBytes(plan.RecordingID.Bytes) != input.RecordingID ||
		!bytes.Equal(plan.EnvelopeDigest, input.EnvelopeDigest) {
		return captureplan.ErrPlanAuthorityMismatch
	}
	fingerprint := sha256.Sum256(plan.PlanBytes)
	if !bytes.Equal(fingerprint[:], plan.PlanFingerprint) || plan.PlanSchemaVersion != captureplan.SchemaVersion {
		return captureplan.ErrInvalidPlan
	}
	return nil
}

func strictCapturePlanJSON[T any](payload []byte, destination *T) error {
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("capture plan JSON contains trailing data")
	}
	return nil
}

func uuidString(value string) pgtype.UUID {
	id, err := utilities.ParseID(value)
	if err != nil {
		return pgtype.UUID{}
	}
	return uuid(id)
}
