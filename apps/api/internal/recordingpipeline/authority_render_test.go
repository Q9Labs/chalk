package recordingpipeline

import (
	"bytes"
	"errors"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestRecorderAuthorityAcceptsCaptureReadyClockSkew(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 10, 3, 17, 0, 0, 0, time.UTC)
	for _, kind := range []JobKind{JobKindCapture, JobKindRender, JobKindTranscription} {
		t.Run(string(kind), func(t *testing.T) {
			job := Job{
				ID: renderAuthorityID(t, "50000000-0000-4000-8000-000000000001"), TenantID: renderAuthorityID(t, "50000000-0000-4000-8000-000000000002"),
				EpisodeID: renderAuthorityID(t, "50000000-0000-4000-8000-000000000003"), RecordingID: renderAuthorityID(t, "50000000-0000-4000-8000-000000000004"),
				Kind: kind, AttemptCount: 2, FencingGeneration: 9,
			}
			facts := ClaimFacts{
				SpaceID: renderAuthorityID(t, "50000000-0000-4000-8000-000000000005"), PolicySnapshotVersion: SupportedPolicySnapshotVersion,
				HardDeadline: now.Add(time.Hour), CaptureEpoch: 4, CompletionOnly: kind == JobKindCapture,
			}
			if kind != JobKindCapture {
				facts.CaptureKeyHandle = renderAuthorityID(t, "50000000-0000-4000-8000-000000000006")
				facts.PresentationHandle = renderAuthorityID(t, "50000000-0000-4000-8000-000000000007")
				facts.PresentationSchemaVersion = "recording_presentation.v1"
				facts.PresentationProfileVersion = "composite_720p_v1"
				facts.PresentationSHA256 = bytes.Repeat([]byte{0x61}, 32)
				facts.PresentationDurationMillis = 60_000
			}
			claimID := renderAuthorityID(t, "50000000-0000-4000-8000-000000000008")
			for _, skew := range []time.Duration{5 * time.Millisecond, 30 * time.Second, 30*time.Second + time.Nanosecond} {
				readyAt := now.Add(skew)
				facts.CaptureReadyAt = &readyAt
				authority, err := NewRecorderJobAuthority(job, facts, claimID, now)
				if skew > 30*time.Second {
					if !errors.Is(err, ErrInvalidEnvelope) {
						t.Fatalf("skew %s: error = %v, want invalid envelope", skew, err)
					}
					continue
				}
				if err != nil {
					t.Fatalf("skew %s: %v", skew, err)
				}
				if authority.Envelope.CaptureReadyAt == nil || *authority.Envelope.CaptureReadyAt != readyAt.Format(time.RFC3339Nano) {
					t.Fatalf("skew %s: capture-ready origin changed", skew)
				}
			}
		})
	}
}

func TestRenderAuthorityBindsFrozenPresentationAndCaptureKey(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 9, 6, 17, 0, 0, 0, time.UTC)
	readyAt := now.Add(-time.Minute)
	keyHandle := renderAuthorityID(t, "30000000-0000-4000-8000-000000000006")
	presentationHandle := renderAuthorityID(t, "30000000-0000-4000-8000-000000000007")
	presentationDigest := bytes.Repeat([]byte{0x61}, 32)
	job := Job{
		ID: renderAuthorityID(t, "30000000-0000-4000-8000-000000000001"), TenantID: renderAuthorityID(t, "30000000-0000-4000-8000-000000000002"),
		EpisodeID: renderAuthorityID(t, "30000000-0000-4000-8000-000000000003"), RecordingID: renderAuthorityID(t, "30000000-0000-4000-8000-000000000004"),
		Kind: JobKindRender, AttemptCount: 2, FencingGeneration: 9,
	}
	authority, err := NewRecorderJobAuthority(job, ClaimFacts{
		SpaceID: renderAuthorityID(t, "30000000-0000-4000-8000-000000000005"), PolicySnapshotVersion: SupportedPolicySnapshotVersion,
		HardDeadline: now.Add(time.Hour), CaptureEpoch: 4, CaptureReadyAt: &readyAt, CaptureKeyHandle: keyHandle,
		PresentationHandle: presentationHandle, PresentationSchemaVersion: "recording_presentation.v1",
		PresentationProfileVersion: "composite_720p_v1", PresentationSHA256: presentationDigest, PresentationDurationMillis: 60_000,
	}, renderAuthorityID(t, "30000000-0000-4000-8000-000000000008"), now)
	if err != nil {
		t.Fatalf("NewRecorderJobAuthority() error = %v", err)
	}
	if authority.Envelope.KeyHandle != keyHandle.String() || authority.Envelope.PresentationHandle != presentationHandle.String() || authority.Envelope.RenderInputHandle == "" || authority.Envelope.ObjectHandle == "" {
		t.Fatalf("render envelope did not bind immutable authority: %#v", authority.Envelope)
	}
	decoded, err := DecodeRecorderJobEnvelope(authority.EnvelopeBytes, authority.EnvelopeDigest)
	if err != nil {
		t.Fatalf("DecodeRecorderJobEnvelope() error = %v", err)
	}
	if decoded.PresentationSHA256 != EnvelopeDigestHex(presentationDigest) || decoded.PresentationDurationMillis != 60_000 {
		t.Fatalf("decoded presentation authority = %#v", decoded)
	}
}

func TestReplacementCaptureAuthorityAllowsPersistedOriginWithoutRenderFacts(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 9, 6, 17, 0, 0, 0, time.UTC)
	readyAt := now.Add(-time.Minute)
	job := Job{
		ID: renderAuthorityID(t, "40000000-0000-4000-8000-000000000001"), TenantID: renderAuthorityID(t, "40000000-0000-4000-8000-000000000002"),
		EpisodeID: renderAuthorityID(t, "40000000-0000-4000-8000-000000000003"), RecordingID: renderAuthorityID(t, "40000000-0000-4000-8000-000000000004"),
		Kind: JobKindCapture, AttemptCount: 2, FencingGeneration: 9,
	}
	authority, err := NewRecorderJobAuthority(job, ClaimFacts{
		SpaceID: renderAuthorityID(t, "40000000-0000-4000-8000-000000000005"), PolicySnapshotVersion: SupportedPolicySnapshotVersion,
		HardDeadline: now.Add(time.Hour), CaptureEpoch: 4, CaptureReadyAt: &readyAt,
	}, renderAuthorityID(t, "40000000-0000-4000-8000-000000000006"), now)
	if err != nil {
		t.Fatalf("NewRecorderJobAuthority() error = %v", err)
	}
	if authority.Envelope.CaptureReadyAt == nil || authority.Envelope.RenderInputHandle != "" || authority.Envelope.PresentationHandle != "" {
		t.Fatalf("replacement capture envelope = %#v", authority.Envelope)
	}
	if _, err := DecodeRecorderJobEnvelope(authority.EnvelopeBytes, authority.EnvelopeDigest); err != nil {
		t.Fatalf("DecodeRecorderJobEnvelope() error = %v", err)
	}
}

func renderAuthorityID(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatalf("ParseID(%q): %v", value, err)
	}
	return id
}
