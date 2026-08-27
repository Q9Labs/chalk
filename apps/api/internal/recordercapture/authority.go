package recordercapture

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/capturesignaling"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	ErrInvalidAuthority   = errors.New("invalid recorder capture authority")
	ErrAuthorityMismatch  = errors.New("recorder capture authority does not match capture plan")
	ErrInvalidPlan        = errors.New("invalid recorder capture plan")
	ErrStalePlan          = errors.New("recorder capture plan is stale")
	ErrPlanConflict       = errors.New("recorder capture plan conflicts with the active revision")
	ErrInvalidNegotiation = errors.New("invalid recorder capture negotiation")
	ErrNegotiationLoop    = errors.New("recorder capture negotiation exceeded its bound")
	ErrProtocol           = errors.New("invalid recorder capture signaling result")
	ErrNotBootstrapped    = errors.New("recorder capture connection is not bootstrapped")
	ErrDeadlineMismatch   = errors.New("recorder capture plan exceeds the attempt deadline")
	ErrDeadlineExpired    = errors.New("recorder capture attempt deadline expired")
	ErrLeaseRenewal       = errors.New("invalid recorder capture lease renewal")
	ErrCaptureClosed      = errors.New("recorder capture connection is closed")
)

// AttemptAuthority is the immutable authority for one recorder job attempt.
// It is derived from the server-issued envelope and is reused for every
// capture-plan and signaling command.
type AttemptAuthority struct {
	Envelope       recordingpipeline.RecorderJobEnvelope
	EnvelopeDigest []byte
	Lease          capturesignaling.WorkerLease

	TenantID          utilities.ID
	SpaceID           utilities.ID
	EpisodeID         utilities.ID
	RecordingID       utilities.ID
	JobID             utilities.ID
	PlanHandle        captureplan.PlanHandle
	SignalingHandle   capturesignaling.SignalingHandle
	AttemptCount      int
	FencingGeneration int64
	CaptureEpoch      captureplane.CaptureEpoch
	HardDeadline      time.Time
}

// NewAttemptAuthority validates the envelope, its digest, and the current
// lease. The lease is checked against the current UTC time.
func NewAttemptAuthority(envelope recordingpipeline.RecorderJobEnvelope, envelopeDigest []byte, lease capturesignaling.WorkerLease) (AttemptAuthority, error) {
	return NewAttemptAuthorityAt(envelope, envelopeDigest, lease, time.Now().UTC())
}

// NewAttemptAuthorityAt is the deterministic form used by tests and callers
// that already have a trusted clock.
func NewAttemptAuthorityAt(envelope recordingpipeline.RecorderJobEnvelope, envelopeDigest []byte, lease capturesignaling.WorkerLease, now time.Time) (AttemptAuthority, error) {
	if len(envelopeDigest) != sha256.Size {
		return AttemptAuthority{}, fmt.Errorf("%w: envelope digest", ErrInvalidAuthority)
	}
	envelopeBytes, err := json.Marshal(envelope)
	if err != nil {
		return AttemptAuthority{}, fmt.Errorf("%w: marshal envelope", ErrInvalidAuthority)
	}
	validatedEnvelope, err := recordingpipeline.DecodeRecorderJobEnvelope(envelopeBytes, envelopeDigest)
	if err != nil {
		return AttemptAuthority{}, fmt.Errorf("%w: envelope: %w", ErrInvalidAuthority, err)
	}
	if validatedEnvelope.Kind != recordingpipeline.JobKindCapture {
		return AttemptAuthority{}, fmt.Errorf("%w: job kind must be capture", ErrInvalidAuthority)
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	if err := lease.ValidateAt(now.UTC()); err != nil {
		return AttemptAuthority{}, fmt.Errorf("%w: lease: %w", ErrInvalidAuthority, err)
	}

	ids := []struct {
		name  string
		value string
		set   *utilities.ID
	}{
		{name: "tenant", value: validatedEnvelope.TenantID, set: new(utilities.ID)},
		{name: "space", value: validatedEnvelope.SpaceID, set: new(utilities.ID)},
		{name: "episode", value: validatedEnvelope.EpisodeID, set: new(utilities.ID)},
		{name: "recording", value: validatedEnvelope.RecordingID, set: new(utilities.ID)},
		{name: "job", value: validatedEnvelope.JobID, set: new(utilities.ID)},
	}
	for _, item := range ids {
		parsed, parseErr := parseCanonicalID(item.name, item.value)
		if parseErr != nil {
			return AttemptAuthority{}, fmt.Errorf("%w: %s id", ErrInvalidAuthority, item.name)
		}
		*item.set = parsed
	}
	planHandle, err := captureplane.NewProviderReference(validatedEnvelope.PlanHandle)
	if err != nil {
		return AttemptAuthority{}, fmt.Errorf("%w: plan handle", ErrInvalidAuthority)
	}
	if _, err := parseCanonicalID("plan", planHandle.String()); err != nil {
		return AttemptAuthority{}, fmt.Errorf("%w: plan handle", ErrInvalidAuthority)
	}
	signalingHandle, err := capturesignaling.NewSignalingHandle(validatedEnvelope.SignalingHandle)
	if err != nil {
		return AttemptAuthority{}, fmt.Errorf("%w: signaling handle", ErrInvalidAuthority)
	}
	if validatedEnvelope.CaptureEpoch <= 0 {
		return AttemptAuthority{}, fmt.Errorf("%w: capture epoch", ErrInvalidAuthority)
	}
	if validatedEnvelope.AttemptCount <= 0 || validatedEnvelope.FencingGeneration <= 0 {
		return AttemptAuthority{}, fmt.Errorf("%w: attempt fence", ErrInvalidAuthority)
	}
	hardDeadline, err := time.Parse(time.RFC3339Nano, validatedEnvelope.HardDeadline)
	if err != nil || hardDeadline.IsZero() || !hardDeadline.After(now.UTC()) || hardDeadline.UTC().Format(time.RFC3339Nano) != validatedEnvelope.HardDeadline {
		return AttemptAuthority{}, fmt.Errorf("%w: hard deadline", ErrInvalidAuthority)
	}
	validatedEnvelope.VideoCodecs = append([]string(nil), validatedEnvelope.VideoCodecs...)

	return AttemptAuthority{
		Envelope:          validatedEnvelope,
		EnvelopeDigest:    append([]byte(nil), envelopeDigest...),
		Lease:             capturesignaling.WorkerLease{Owner: lease.Owner, Token: lease.Token, ExpiresAt: lease.ExpiresAt.UTC()},
		TenantID:          *ids[0].set,
		SpaceID:           *ids[1].set,
		EpisodeID:         *ids[2].set,
		RecordingID:       *ids[3].set,
		JobID:             *ids[4].set,
		PlanHandle:        captureplan.PlanHandle(planHandle),
		SignalingHandle:   signalingHandle,
		AttemptCount:      validatedEnvelope.AttemptCount,
		FencingGeneration: validatedEnvelope.FencingGeneration,
		CaptureEpoch:      captureplane.CaptureEpoch(validatedEnvelope.CaptureEpoch),
		HardDeadline:      hardDeadline.UTC(),
	}, nil
}

func parseCanonicalID(name, value string) (utilities.ID, error) {
	if value == "" || strings.TrimSpace(value) != value {
		return utilities.ID{}, fmt.Errorf("%s ID is not canonical", name)
	}
	parsed, err := utilities.ParseID(value)
	if err != nil || parsed.String() != value {
		return utilities.ID{}, fmt.Errorf("%s ID is not canonical", name)
	}
	return parsed, nil
}

func (a AttemptAuthority) commandAuthority() capturesignaling.CommandAuthority {
	return capturesignaling.CommandAuthority{
		TenantID: a.TenantID, SpaceID: a.SpaceID, EpisodeID: a.EpisodeID,
		RecordingID: a.RecordingID, JobID: a.JobID, AttemptCount: a.AttemptCount,
		FencingGeneration: a.FencingGeneration, CaptureEpoch: a.CaptureEpoch,
		EnvelopeDigest: append([]byte(nil), a.EnvelopeDigest...),
	}
}

func (a AttemptAuthority) planAuthority() captureplan.PlanAuthority {
	return captureplan.PlanAuthority{
		PlanHandle: a.PlanHandle, TenantID: a.TenantID, SpaceID: a.SpaceID,
		EpisodeID: a.EpisodeID, RecordingID: a.RecordingID, JobID: a.JobID,
		AttemptCount: a.AttemptCount, FencingGeneration: a.FencingGeneration,
		CaptureEpoch: a.CaptureEpoch, EnvelopeDigest: append([]byte(nil), a.EnvelopeDigest...),
	}
}

func (a AttemptAuthority) metadata(revision captureplane.PlanRevision, operation captureplane.OperationKind, idempotencyKey string) captureplane.OperationMetadata {
	return captureplane.OperationMetadata{
		Identity: captureplane.CaptureIdentity{
			TenantID: a.TenantID, SpaceID: a.SpaceID, EpisodeID: a.EpisodeID, RecordingID: a.RecordingID,
		},
		CaptureEpoch: a.CaptureEpoch, PlanRevision: revision, IdempotencyKey: idempotencyKey,
	}
}

func (a AttemptAuthority) waitInput(afterRevision captureplane.PlanRevision, maxWait time.Duration) captureplan.WaitInput {
	return captureplan.NewWaitInput(a.planAuthority(), captureplan.WorkerLease{
		Owner: a.Lease.Owner, Token: a.Lease.Token, ExpiresAt: a.Lease.ExpiresAt,
	}, afterRevision, maxWait)
}

func (a AttemptAuthority) validatePlan(plan captureplan.Plan) error {
	if err := plan.Validate(); err != nil {
		return fmt.Errorf("%w: %w", ErrInvalidPlan, err)
	}
	actual := plan.Authority()
	expected := a.planAuthority()
	if actual.PlanHandle != expected.PlanHandle || actual.TenantID != expected.TenantID || actual.SpaceID != expected.SpaceID || actual.EpisodeID != expected.EpisodeID || actual.RecordingID != expected.RecordingID || actual.JobID != expected.JobID || actual.AttemptCount != expected.AttemptCount || actual.FencingGeneration != expected.FencingGeneration || actual.CaptureEpoch != expected.CaptureEpoch || !bytes.Equal(actual.EnvelopeDigest, expected.EnvelopeDigest) {
		return ErrAuthorityMismatch
	}
	if plan.Revision() == 0 {
		return fmt.Errorf("%w: revision", ErrInvalidPlan)
	}
	if !a.HardDeadline.IsZero() && plan.EffectiveDeadline().After(a.HardDeadline) {
		return ErrDeadlineMismatch
	}
	return nil
}
