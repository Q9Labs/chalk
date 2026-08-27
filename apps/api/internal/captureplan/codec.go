package captureplan

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const MaximumEncodedPlanBytes = 2 << 20

var (
	ErrPlanPayloadTooLarge     = errors.New("capture plan payload is too large")
	ErrPlanFingerprintAbsent   = errors.New("capture plan fingerprint is absent")
	ErrPlanFingerprintMatch    = errors.New("capture plan fingerprint does not match payload")
	ErrPlanFingerprintMismatch = ErrPlanFingerprintMatch
)

// DecodePlan reconstructs a Plan through NewPlan and verifies that the
// provider-supplied fingerprint is the fingerprint of the reconstructed
// canonical value. The payload is bounded and rejects unknown or trailing JSON.
func DecodePlan(payload []byte, expectedFingerprint string) (Plan, error) {
	if len(payload) > MaximumEncodedPlanBytes {
		return Plan{}, ErrPlanPayloadTooLarge
	}
	expected, err := decodeFingerprint(expectedFingerprint)
	if err != nil {
		return Plan{}, err
	}

	var encoded canonicalPlan
	if err := decodeStrictJSON(payload, &encoded); err != nil {
		return Plan{}, fmt.Errorf("decode capture plan: %w", err)
	}
	input, err := encoded.planInput()
	if err != nil {
		return Plan{}, err
	}
	plan, err := NewPlan(input)
	if err != nil {
		return Plan{}, fmt.Errorf("reconstruct capture plan: %w", err)
	}
	if !bytes.Equal(plan.FingerprintBytes(), expected) {
		return Plan{}, ErrPlanFingerprintMatch
	}
	return plan, nil
}

// Decode is kept as a short package-level alias for transport adapters.
func Decode(payload []byte, expectedFingerprint string) (Plan, error) {
	return DecodePlan(payload, expectedFingerprint)
}

func decodeFingerprint(value string) ([]byte, error) {
	if strings.TrimSpace(value) == "" {
		return nil, ErrPlanFingerprintAbsent
	}
	decoded, err := hex.DecodeString(strings.TrimSpace(value))
	if err != nil || len(decoded) != 32 {
		return nil, fmt.Errorf("%w: expected SHA-256 hex", ErrPlanFingerprintMatch)
	}
	return decoded, nil
}

func (p canonicalPlan) planInput() (PlanInput, error) {
	authority, err := p.Authority.planAuthority()
	if err != nil {
		return PlanInput{}, err
	}
	participants := make([]ParticipantSnapshot, len(p.Participants))
	for i, value := range p.Participants {
		id, err := utilities.ParseID(value.ID)
		if err != nil {
			return PlanInput{}, fmt.Errorf("decode capture plan participant %d: %w", i, ErrInvalidParticipant)
		}
		participants[i] = ParticipantSnapshot{
			ID: id, Generation: value.Generation, DisplayName: value.DisplayName,
			JoinOrdinal: value.JoinOrdinal, Lifecycle: value.Lifecycle,
		}
	}
	tracks := make([]TrackSnapshot, len(p.Tracks))
	for i, value := range p.Tracks {
		participantID, err := utilities.ParseID(value.ParticipantID)
		if err != nil {
			return PlanInput{}, fmt.Errorf("decode capture plan track %d: %w", i, ErrInvalidTrack)
		}
		tracks[i] = TrackSnapshot{
			ParticipantID: participantID, ParticipantGeneration: value.ParticipantGeneration,
			Source: value.Source, Kind: value.Kind,
			OwnerReference: value.OwnerReference, TrackReference: value.TrackReference,
			OwnerMID: value.OwnerMID, PublicationReference: value.PublicationReference,
			RequestedLayer: value.RequestedLayer,
		}
	}
	deadline, err := time.Parse(time.RFC3339Nano, p.EffectiveDeadline)
	if err != nil {
		return PlanInput{}, fmt.Errorf("decode capture plan deadline: %w", ErrInvalidPlan)
	}
	var stopRequestedAt time.Time
	if p.StopRequestedAt != "" {
		stopRequestedAt, err = time.Parse(time.RFC3339Nano, p.StopRequestedAt)
		if err != nil {
			return PlanInput{}, fmt.Errorf("decode capture plan stop request: %w", ErrInvalidPlan)
		}
	}
	return PlanInput{
		Authority: authority, Revision: captureplane.PlanRevision(p.Revision), Cursors: p.Cursors,
		LayoutProfile: p.LayoutProfile, ParticipantLimit: p.ParticipantLimit,
		InputBitrateBPS: p.InputBitrateBPS, EffectiveDeadline: deadline,
		StopState: p.StopState, StopRequestedAt: stopRequestedAt,
		Participants: participants, Tracks: tracks,
	}, nil
}

func (a canonicalAuthority) planAuthority() (PlanAuthority, error) {
	tenantID, err := utilities.ParseID(a.TenantID)
	if err != nil {
		return PlanAuthority{}, fmt.Errorf("decode capture plan authority: %w", ErrInvalidAuthority)
	}
	spaceID, err := utilities.ParseID(a.SpaceID)
	if err != nil {
		return PlanAuthority{}, fmt.Errorf("decode capture plan authority: %w", ErrInvalidAuthority)
	}
	episodeID, err := utilities.ParseID(a.EpisodeID)
	if err != nil {
		return PlanAuthority{}, fmt.Errorf("decode capture plan authority: %w", ErrInvalidAuthority)
	}
	recordingID, err := utilities.ParseID(a.RecordingID)
	if err != nil {
		return PlanAuthority{}, fmt.Errorf("decode capture plan authority: %w", ErrInvalidAuthority)
	}
	jobID, err := utilities.ParseID(a.JobID)
	if err != nil {
		return PlanAuthority{}, fmt.Errorf("decode capture plan authority: %w", ErrInvalidAuthority)
	}
	digest, err := hex.DecodeString(strings.TrimSpace(a.EnvelopeDigest))
	if err != nil || len(digest) != 32 {
		return PlanAuthority{}, fmt.Errorf("decode capture plan authority digest: %w", ErrInvalidAuthority)
	}
	return PlanAuthority{
		PlanHandle: a.PlanHandle, TenantID: tenantID, SpaceID: spaceID,
		EpisodeID: episodeID, RecordingID: recordingID, JobID: jobID,
		AttemptCount: a.AttemptCount, FencingGeneration: a.FencingGeneration,
		CaptureEpoch: captureplane.CaptureEpoch(a.CaptureEpoch), EnvelopeDigest: digest,
	}, nil
}

func decodeStrictJSON(payload []byte, destination any) error {
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	var trailing json.RawMessage
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return errors.New("trailing JSON")
		}
		return err
	}
	return nil
}
