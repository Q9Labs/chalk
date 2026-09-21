package recordingpipeline

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type ClaimFacts struct {
	SpaceID                    utilities.ID
	PolicySnapshotVersion      string
	HardDeadline               time.Time
	CaptureEpoch               int64
	CaptureReadyAt             *time.Time
	CaptureKeyHandle           utilities.ID
	PresentationHandle         utilities.ID
	PresentationSchemaVersion  string
	PresentationProfileVersion string
	PresentationSHA256         []byte
	PresentationDurationMillis int64
}

func NewRecorderJobAuthority(job Job, facts ClaimFacts, claimRequestID utilities.ID, issuedAt time.Time) (JobAuthority, error) {
	if job.ID.IsZero() || job.TenantID.IsZero() || job.EpisodeID.IsZero() || job.RecordingID.IsZero() || facts.SpaceID.IsZero() {
		return JobAuthority{}, ErrInvalidEnvelope
	}
	if job.Kind != JobKindCapture && job.Kind != JobKindRender && job.Kind != JobKindTranscription || job.AttemptCount <= 0 || job.FencingGeneration <= 0 || facts.CaptureEpoch <= 0 {
		return JobAuthority{}, ErrInvalidEnvelope
	}
	if facts.PolicySnapshotVersion != SupportedPolicySnapshotVersion || facts.HardDeadline.IsZero() || claimRequestID.IsZero() {
		return JobAuthority{}, ErrInvalidEnvelope
	}
	if (job.Kind == JobKindRender || job.Kind == JobKindTranscription) && (facts.CaptureReadyAt == nil || facts.CaptureKeyHandle.IsZero() || facts.PresentationHandle.IsZero() || facts.PresentationSchemaVersion != "recording_presentation.v1" || facts.PresentationProfileVersion == "" || len(facts.PresentationSHA256) != sha256.Size || facts.PresentationDurationMillis <= 0) {
		return JobAuthority{}, ErrInvalidEnvelope
	}
	if job.Kind == JobKindCapture && (!facts.CaptureKeyHandle.IsZero() || !facts.PresentationHandle.IsZero() || facts.PresentationSchemaVersion != "" || facts.PresentationProfileVersion != "" || len(facts.PresentationSHA256) != 0 || facts.PresentationDurationMillis != 0) {
		return JobAuthority{}, ErrInvalidEnvelope
	}
	if issuedAt.IsZero() {
		issuedAt = time.Now().UTC()
	}
	var captureReadyAt *string
	if facts.CaptureReadyAt != nil {
		readyAt := facts.CaptureReadyAt.UTC()
		if readyAt.IsZero() || readyAt.After(issuedAt.UTC()) {
			return JobAuthority{}, ErrInvalidEnvelope
		}
		canonical := readyAt.Format(time.RFC3339Nano)
		captureReadyAt = &canonical
	}
	planHandle, err := utilities.NewID()
	if err != nil {
		return JobAuthority{}, fmt.Errorf("generate plan authority handle: %w", err)
	}
	signalingHandle, err := utilities.NewID()
	if err != nil {
		return JobAuthority{}, fmt.Errorf("generate signaling authority handle: %w", err)
	}
	keyHandle := facts.CaptureKeyHandle
	if job.Kind == JobKindCapture {
		keyHandle, err = utilities.NewID()
		if err != nil {
			return JobAuthority{}, fmt.Errorf("generate key authority handle: %w", err)
		}
	}
	objectHandle, err := utilities.NewID()
	if err != nil {
		return JobAuthority{}, fmt.Errorf("generate object authority handle: %w", err)
	}
	var renderInputHandle utilities.ID
	if job.Kind == JobKindRender || job.Kind == JobKindTranscription {
		renderInputHandle, err = utilities.NewID()
		if err != nil {
			return JobAuthority{}, fmt.Errorf("generate render input handle: %w", err)
		}
	}
	envelope := RecorderJobEnvelope{
		SchemaVersion:              RecorderJobSchemaVersion,
		TenantID:                   job.TenantID.String(),
		SpaceID:                    facts.SpaceID.String(),
		EpisodeID:                  job.EpisodeID.String(),
		RecordingID:                job.RecordingID.String(),
		JobID:                      job.ID.String(),
		Kind:                       job.Kind,
		AttemptCount:               job.AttemptCount,
		FencingGeneration:          job.FencingGeneration,
		CaptureEpoch:               facts.CaptureEpoch,
		PolicySnapshotVersion:      facts.PolicySnapshotVersion,
		HardDeadline:               facts.HardDeadline.UTC().Format(time.RFC3339Nano),
		CaptureReadyAt:             captureReadyAt,
		RenderInputHandle:          renderInputHandle.String(),
		PresentationHandle:         facts.PresentationHandle.String(),
		PresentationSchemaVersion:  facts.PresentationSchemaVersion,
		PresentationProfileVersion: facts.PresentationProfileVersion,
		PresentationSHA256:         hex.EncodeToString(facts.PresentationSHA256),
		PresentationDurationMillis: facts.PresentationDurationMillis,
		InitialPlanRevision:        RecorderInitialPlanRevision,
		BundleSchemaVersion:        RecordingBundleSchema,
		LayoutProfile:              RecordingLayoutProfile,
		ParticipantLimit:           MaximumEpisodeParticipants,
		InputBitrateBPS:            MaximumInputBitrateBPS,
		AudioCodec:                 "opus",
		VideoCodecs:                []string{"vp8", "h264"},
		PlanHandle:                 planHandle.String(),
		SignalingHandle:            signalingHandle.String(),
		KeyHandle:                  keyHandle.String(),
		ObjectHandle:               objectHandle.String(),
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
	if envelope.SchemaVersion != RecorderJobSchemaVersion && envelope.SchemaVersion != LegacyRecorderJobSchemaVersion {
		return RecorderJobEnvelope{}, ErrInvalidEnvelope
	}
	if envelope.SchemaVersion == LegacyRecorderJobSchemaVersion && envelope.CaptureReadyAt != nil {
		return RecorderJobEnvelope{}, ErrInvalidEnvelope
	}
	if envelope.CaptureReadyAt != nil {
		readyAt, err := time.Parse(time.RFC3339Nano, *envelope.CaptureReadyAt)
		if err != nil || readyAt.IsZero() || readyAt.Location() != time.UTC || readyAt.Format(time.RFC3339Nano) != *envelope.CaptureReadyAt {
			return RecorderJobEnvelope{}, ErrInvalidEnvelope
		}
	}
	if envelope.Kind == JobKindRender || envelope.Kind == JobKindTranscription {
		if envelope.CaptureReadyAt == nil || envelope.PresentationSchemaVersion != "recording_presentation.v1" || envelope.PresentationProfileVersion == "" || envelope.PresentationDurationMillis <= 0 {
			return RecorderJobEnvelope{}, ErrInvalidEnvelope
		}
		if _, err := utilities.ParseID(envelope.RenderInputHandle); err != nil {
			return RecorderJobEnvelope{}, ErrInvalidEnvelope
		}
		if _, err := utilities.ParseID(envelope.PresentationHandle); err != nil {
			return RecorderJobEnvelope{}, ErrInvalidEnvelope
		}
		presentationDigest, err := hex.DecodeString(envelope.PresentationSHA256)
		if err != nil || len(presentationDigest) != sha256.Size || envelope.PresentationSHA256 != strings.ToLower(envelope.PresentationSHA256) {
			return RecorderJobEnvelope{}, ErrInvalidEnvelope
		}
	} else if envelope.Kind == JobKindCapture {
		if envelope.RenderInputHandle != "" || envelope.PresentationHandle != "" || envelope.PresentationSchemaVersion != "" || envelope.PresentationProfileVersion != "" || envelope.PresentationSHA256 != "" || envelope.PresentationDurationMillis != 0 {
			return RecorderJobEnvelope{}, ErrInvalidEnvelope
		}
	} else {
		return RecorderJobEnvelope{}, ErrInvalidEnvelope
	}
	if envelope.BundleSchemaVersion != RecordingBundleSchema || envelope.LayoutProfile != RecordingLayoutProfile || envelope.InitialPlanRevision != RecorderInitialPlanRevision || envelope.ParticipantLimit != MaximumEpisodeParticipants || envelope.InputBitrateBPS != MaximumInputBitrateBPS || envelope.AudioCodec != "opus" || len(envelope.VideoCodecs) != 2 || envelope.VideoCodecs[0] != "vp8" || envelope.VideoCodecs[1] != "h264" {
		return RecorderJobEnvelope{}, ErrInvalidEnvelope
	}
	return envelope, nil
}

func EnvelopeDigestHex(digest []byte) string {
	return hex.EncodeToString(digest)
}
