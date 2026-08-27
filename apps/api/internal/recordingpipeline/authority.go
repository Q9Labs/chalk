package recordingpipeline

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type ClaimFacts struct {
	SpaceID               utilities.ID
	PolicySnapshotVersion string
	HardDeadline          time.Time
	CaptureEpoch          int64
}

func NewRecorderJobAuthority(job Job, facts ClaimFacts, claimRequestID utilities.ID, issuedAt time.Time) (JobAuthority, error) {
	if job.ID.IsZero() || job.TenantID.IsZero() || job.EpisodeID.IsZero() || job.RecordingID.IsZero() || facts.SpaceID.IsZero() {
		return JobAuthority{}, ErrInvalidEnvelope
	}
	if job.Kind != JobKindCapture && job.Kind != JobKindRender || job.AttemptCount <= 0 || job.FencingGeneration <= 0 || facts.CaptureEpoch <= 0 {
		return JobAuthority{}, ErrInvalidEnvelope
	}
	if facts.PolicySnapshotVersion != SupportedPolicySnapshotVersion || facts.HardDeadline.IsZero() || claimRequestID.IsZero() {
		return JobAuthority{}, ErrInvalidEnvelope
	}
	if issuedAt.IsZero() {
		issuedAt = time.Now().UTC()
	}
	planHandle, err := utilities.NewID()
	if err != nil {
		return JobAuthority{}, fmt.Errorf("generate plan authority handle: %w", err)
	}
	signalingHandle, err := utilities.NewID()
	if err != nil {
		return JobAuthority{}, fmt.Errorf("generate signaling authority handle: %w", err)
	}
	keyHandle, err := utilities.NewID()
	if err != nil {
		return JobAuthority{}, fmt.Errorf("generate key authority handle: %w", err)
	}
	objectHandle, err := utilities.NewID()
	if err != nil {
		return JobAuthority{}, fmt.Errorf("generate object authority handle: %w", err)
	}
	envelope := RecorderJobEnvelope{
		SchemaVersion:         RecorderJobSchemaVersion,
		TenantID:              job.TenantID.String(),
		SpaceID:               facts.SpaceID.String(),
		EpisodeID:             job.EpisodeID.String(),
		RecordingID:           job.RecordingID.String(),
		JobID:                 job.ID.String(),
		Kind:                  job.Kind,
		AttemptCount:          job.AttemptCount,
		FencingGeneration:     job.FencingGeneration,
		CaptureEpoch:          facts.CaptureEpoch,
		PolicySnapshotVersion: facts.PolicySnapshotVersion,
		HardDeadline:          facts.HardDeadline.UTC().Format(time.RFC3339Nano),
		InitialPlanRevision:   RecorderInitialPlanRevision,
		BundleSchemaVersion:   RecordingBundleSchema,
		LayoutProfile:         RecordingLayoutProfile,
		ParticipantLimit:      MaximumEpisodeParticipants,
		InputBitrateBPS:       MaximumInputBitrateBPS,
		AudioCodec:            "opus",
		VideoCodecs:           []string{"vp8", "h264"},
		PlanHandle:            planHandle.String(),
		SignalingHandle:       signalingHandle.String(),
		KeyHandle:             keyHandle.String(),
		ObjectHandle:          objectHandle.String(),
	}
	bytes, err := json.Marshal(envelope)
	if err != nil {
		return JobAuthority{}, fmt.Errorf("marshal recorder job envelope: %w", err)
	}
	digest := sha256.Sum256(bytes)
	return JobAuthority{
		ClaimRequestID: claimRequestID,
		Envelope:       envelope,
		EnvelopeBytes:  bytes,
		EnvelopeDigest: append([]byte(nil), digest[:]...),
		IssuedAt:       issuedAt.UTC(),
	}, nil
}

func DecodeRecorderJobEnvelope(envelopeBytes, envelopeDigest []byte) (RecorderJobEnvelope, error) {
	if len(envelopeDigest) != sha256.Size {
		return RecorderJobEnvelope{}, ErrInvalidEnvelope
	}
	digest := sha256.Sum256(envelopeBytes)
	if !bytes.Equal(digest[:], envelopeDigest) {
		return RecorderJobEnvelope{}, ErrInvalidEnvelope
	}
	var envelope RecorderJobEnvelope
	if err := json.Unmarshal(envelopeBytes, &envelope); err != nil {
		return RecorderJobEnvelope{}, ErrInvalidEnvelope
	}
	if envelope.SchemaVersion != RecorderJobSchemaVersion || envelope.BundleSchemaVersion != RecordingBundleSchema || envelope.LayoutProfile != RecordingLayoutProfile || envelope.InitialPlanRevision != RecorderInitialPlanRevision || envelope.ParticipantLimit != MaximumEpisodeParticipants || envelope.InputBitrateBPS != MaximumInputBitrateBPS || envelope.AudioCodec != "opus" || len(envelope.VideoCodecs) != 2 || envelope.VideoCodecs[0] != "vp8" || envelope.VideoCodecs[1] != "h264" {
		return RecorderJobEnvelope{}, ErrInvalidEnvelope
	}
	return envelope, nil
}

func EnvelopeDigestHex(digest []byte) string {
	return hex.EncodeToString(digest)
}
