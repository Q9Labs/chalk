package recordingpipeline

import (
	"bytes"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

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
