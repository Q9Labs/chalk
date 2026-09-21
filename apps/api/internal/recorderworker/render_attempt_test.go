package recorderworker

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recordingdecode"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/recordingpresentation"
	"github.com/q9labs/chalk/apps/api/internal/recordingrender"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestRenderAuthorityFromClaimCrossBindsImmutableEnvelope(t *testing.T) {
	now := time.Date(2026, time.September, 6, 15, 0, 0, 0, time.UTC)
	claim := productionRenderClaimForTest(t, now)

	authority, err := renderAuthorityFromClaim(claim, now)
	if err != nil {
		t.Fatalf("bind render authority: %v", err)
	}
	if authority.RecordingID.String() != claim.Envelope.RecordingID || authority.JobID.String() != claim.Envelope.JobID || authority.RenderInputHandle.String() != claim.Envelope.RenderInputHandle {
		t.Fatalf("render authority lost envelope identity: %#v", authority)
	}
	if authority.LeaseToken != claim.LeaseToken || !authority.LeaseExpiresAt.Equal(claim.LeaseExpiresAt) {
		t.Fatalf("render authority lost lease fence: %#v", authority)
	}

	claim.Envelope.PresentationSHA256 = strings.ToUpper(claim.Envelope.PresentationSHA256)
	if _, err := renderAuthorityFromClaim(claim, now); !errors.Is(err, ErrInvalidProductionRenderAttempt) {
		t.Fatalf("uppercase presentation checksum error = %v", err)
	}
}

func TestProductionRenderAttemptRenewLeaseUsesExactServerExpiry(t *testing.T) {
	now := time.Date(2026, time.September, 6, 15, 0, 0, 0, time.UTC)
	claim := productionRenderClaimForTest(t, now)
	authority, err := renderAuthorityFromClaim(claim, now)
	if err != nil {
		t.Fatal(err)
	}
	attempt := &ProductionRenderAttempt{config: ProductionRenderAttemptConfig{Now: func() time.Time { return now }}, authority: authority}
	lease, err := renderLeaseInput(claim, 30*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	serverExpiry := now.Add(23*time.Minute + 17*time.Second)
	if _, err := attempt.RenewLease(func() (recordingpipeline.LeaseInput, time.Time, error) { return lease, serverExpiry, nil }); err != nil {
		t.Fatalf("renew render authority: %v", err)
	}
	if got := attempt.currentAuthority().LeaseExpiresAt; !got.Equal(serverExpiry) {
		t.Fatalf("lease expiry = %s, want exact server value %s", got, serverExpiry)
	}

	stale := lease
	stale.FencingGeneration++
	if _, err := attempt.RenewLease(func() (recordingpipeline.LeaseInput, time.Time, error) { return stale, serverExpiry, nil }); !errors.Is(err, ErrInvalidProductionRenderAttempt) {
		t.Fatalf("stale fence error = %v", err)
	}
}

func TestProductionRenderAttemptAccessesAndClearsEveryCaptureEpochKey(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, time.September, 6, 15, 0, 0, 0, time.UTC)
	authority, err := renderAuthorityFromClaim(productionRenderClaimForTest(t, now), now)
	if err != nil {
		t.Fatal(err)
	}
	key1 := mustRenderAttemptID(t, "12121212-1212-4212-8212-121212121212")
	key3 := mustRenderAttemptID(t, "34343434-3434-4434-8434-343434343434")
	job := mustRenderAttemptID(t, "56565656-5656-4656-8656-565656565656")
	control := &renderKeyControlForTest{keyHandles: map[int64]utilities.ID{1: key1, 3: key3}, plaintext: make(map[int64][]byte)}
	attempt := &ProductionRenderAttempt{config: ProductionRenderAttemptConfig{Control: control}, authority: authority}
	capture := []recordingrender.DownloadableCaptureObject{
		{CaptureObject: recordingrender.CaptureObject{CaptureEpoch: 3, CaptureJobID: job, KeyHandle: key3, EnvelopeDigest: make([]byte, 32)}},
		{CaptureObject: recordingrender.CaptureObject{CaptureEpoch: 1, CaptureJobID: job, KeyHandle: key1, EnvelopeDigest: make([]byte, 32)}},
		{CaptureObject: recordingrender.CaptureObject{CaptureEpoch: 1, CaptureJobID: job, KeyHandle: key1, EnvelopeDigest: make([]byte, 32)}},
	}
	keys, err := attempt.accessCaptureKeys(context.Background(), capture)
	if err != nil {
		t.Fatalf("accessCaptureKeys() error = %v", err)
	}
	if len(control.inputs) != 2 || control.inputs[0].CaptureEpoch != 1 || control.inputs[1].CaptureEpoch != 3 || len(keys) != 2 || keys[0].CaptureEpoch != 1 || keys[1].CaptureEpoch != 3 {
		t.Fatalf("key accesses=%#v keys=%#v", control.inputs, keys)
	}
	clearDecodeDataKeys(keys)
	for epoch, plaintext := range control.plaintext {
		for _, value := range plaintext {
			if value != 0 {
				t.Fatalf("epoch %d plaintext was not cleared", epoch)
			}
		}
	}
}

type renderKeyControlForTest struct {
	RenderAuthorityPort
	keyHandles map[int64]utilities.ID
	plaintext  map[int64][]byte
	inputs     []recordingrender.AccessKeyInput
}

func (control *renderKeyControlForTest) AccessRenderKey(_ context.Context, input recordingrender.AccessKeyInput) (recordingrender.DataKey, error) {
	control.inputs = append(control.inputs, input)
	plaintext := make([]byte, 32)
	for index := range plaintext {
		plaintext[index] = byte(input.CaptureEpoch)
	}
	control.plaintext[input.CaptureEpoch] = plaintext
	return recordingrender.DataKey{KeyHandle: control.keyHandles[input.CaptureEpoch], CaptureEpoch: input.CaptureEpoch, Plaintext: plaintext}, nil
}

func TestDeterministicRenderIDIsStableWithinFence(t *testing.T) {
	now := time.Date(2026, time.September, 6, 15, 0, 0, 0, time.UTC)
	authority, err := renderAuthorityFromClaim(productionRenderClaimForTest(t, now), now)
	if err != nil {
		t.Fatal(err)
	}
	first := deterministicRenderID(authority, "video")
	if again := deterministicRenderID(authority, "video"); first != again {
		t.Fatalf("retry identity changed: %s != %s", first, again)
	}
	if other := deterministicRenderID(authority, "manifest"); first == other {
		t.Fatalf("distinct render objects share identity %s", first)
	}
	authority.FencingGeneration++
	if nextFence := deterministicRenderID(authority, "video"); first == nextFence {
		t.Fatalf("new fence reused identity %s", first)
	}
}

func TestParticipantDisplayNameAtUsesRecordingTimeline(t *testing.T) {
	timeline := recordingpresentation.Timeline{
		Initial: recordingpresentation.Snapshot{Participants: []recordingpresentation.Participant{{ID: "participant-1", DisplayName: "Ada"}}},
		Events: []recordingpresentation.Event{
			recordingpresentation.ParticipantDisplayNameChangedEvent{EventBase: recordingpresentation.EventBase{AtMillis: 50}, ParticipantID: "participant-1", DisplayName: "Grace"},
			recordingpresentation.ParticipantJoinedEvent{EventBase: recordingpresentation.EventBase{AtMillis: 100}, Participant: recordingpresentation.Participant{ID: "participant-2", DisplayName: "Lin"}},
		},
	}
	if got := participantDisplayNameAt(timeline, "participant-1", 49); got != "Ada" {
		t.Fatalf("name before change = %q", got)
	}
	if got := participantDisplayNameAt(timeline, "participant-1", 50); got != "Grace" {
		t.Fatalf("name at change = %q", got)
	}
	if got := participantDisplayNameAt(timeline, "participant-2", 100); got != "Lin" {
		t.Fatalf("joined participant name = %q", got)
	}
}

func TestMicrophoneOverlapUsesHalfOpenIntervals(t *testing.T) {
	sources := []recordingdecode.Source{
		{SourceID: "one", StartMS: 0, EndMS: 100},
		{SourceID: "two", StartMS: 100, EndMS: 200},
		{SourceID: "three", StartMS: 50, EndMS: 150},
	}
	if !microphoneOverlap(sources, "one", 0, 100) {
		t.Fatal("strictly overlapping microphone was not detected")
	}
	if microphoneOverlap(sources[:2], "one", 0, 100) {
		t.Fatal("touching half-open microphone intervals were treated as overlap")
	}
}

func TestPersistFileRejectsNonRegularOrEmptyInput(t *testing.T) {
	attempt := &ProductionRenderAttempt{}
	for _, path := range []string{t.TempDir(), writeEmptyRenderFile(t)} {
		if _, err := attempt.persistFile(context.Background(), recordingrender.PurposeRecordingVideo, "video", path, nil); !errors.Is(err, ErrInvalidProductionRenderAttempt) {
			t.Fatalf("invalid render object %q error = %v", path, err)
		}
	}
}

func TestValidateTimelineRequiresInstalledFrozenUIBuild(t *testing.T) {
	installed := strings.Repeat("a", 64)
	input := recordingrender.ResolvedInput{
		PresentationSchemaVersion:  recordingrender.PresentationSchemaVersion,
		PresentationProfileVersion: "composite_720p_v1",
		RecordingID:                mustRenderAttemptID(t, "55555555-5555-4555-8555-555555555555"),
		EpisodeID:                  mustRenderAttemptID(t, "44444444-4444-4444-8444-444444444444"),
		CaptureEpoch:               4,
		DurationMillis:             1_000,
	}
	timeline := recordingpresentation.Timeline{
		SchemaVersion: recordingpresentation.SchemaVersion,
		RecordingID:   input.RecordingID.String(),
		EpisodeID:     input.EpisodeID.String(),
		Clock: recordingpresentation.Clock{
			Origin: "capture_ready", Timebase: "recording_relative_ms", CaptureEpoch: input.CaptureEpoch, DurationMillis: input.DurationMillis,
		},
		Initial: recordingpresentation.Snapshot{Profile: recordingpresentation.Profile{
			Version: input.PresentationProfileVersion, UIBuildSHA256: installed,
			Viewport: recordingpresentation.Viewport{Width: 1280, Height: 720, DeviceScaleFactor: 1},
		}},
	}
	attempt := &ProductionRenderAttempt{config: ProductionRenderAttemptConfig{UIBuildRegistry: UIBuildRegistry{builds: map[string]struct{}{installed: {}}}}}
	if err := attempt.validateTimeline(input, timeline); err != nil {
		t.Fatalf("installed frozen UI build rejected: %v", err)
	}
	timeline.Initial.Profile.UIBuildSHA256 = strings.Repeat("b", 64)
	if err := attempt.validateTimeline(input, timeline); !errors.Is(err, ErrInvalidProductionRenderAttempt) {
		t.Fatalf("uninstalled frozen UI build error = %v", err)
	}
}

func writeEmptyRenderFile(t *testing.T) string {
	t.Helper()
	path := t.TempDir() + "/empty.mp4"
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func productionRenderClaimForTest(t *testing.T, now time.Time) ClaimResult {
	t.Helper()
	readyAt := now.Add(-time.Minute).Format(time.RFC3339Nano)
	return ClaimResult{
		ClaimRequestID: mustRenderAttemptID(t, "11111111-1111-4111-8111-111111111111"),
		Envelope: recordingpipeline.RecorderJobEnvelope{
			TenantID: "22222222-2222-4222-8222-222222222222", SpaceID: "33333333-3333-4333-8333-333333333333",
			EpisodeID: "44444444-4444-4444-8444-444444444444", RecordingID: "55555555-5555-4555-8555-555555555555",
			JobID: "66666666-6666-4666-8666-666666666666", Kind: recordingpipeline.JobKindRender,
			AttemptCount: 2, FencingGeneration: 3, CaptureEpoch: 4, CaptureReadyAt: &readyAt,
			HardDeadline:      now.Add(30 * time.Minute).Format(time.RFC3339Nano),
			RenderInputHandle: "77777777-7777-4777-8777-777777777777", PresentationHandle: "88888888-8888-4888-8888-888888888888",
			PresentationSHA256: strings.Repeat("a", 64), KeyHandle: "99999999-9999-4999-8999-999999999999",
			ObjectHandle: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		},
		EnvelopeDigest: make([]byte, 32), LeaseToken: "lease-token", LeaseOwner: "render-worker", LeaseExpiresAt: now.Add(30 * time.Minute),
	}
}

func mustRenderAttemptID(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatal(err)
	}
	return id
}
