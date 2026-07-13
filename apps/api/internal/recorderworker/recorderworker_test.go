package recorderworker

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestJobValidationRejectsExpiredOrUnscopedAuthority(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	job := Job{ProtocolVersion: ProtocolVersion, JobID: "job", TenantID: "tenant", SessionID: "session", Attempt: 1, FencingGeneration: 1, Role: RoleCapture, ArtifactClass: "bundle", Authorization: JobAuthorization{Scope: "capture", ExpiresAt: now.Add(time.Minute)}, ObjectIntents: []ObjectIntent{{Key: "tmp/a", URL: "https://objects.invalid/tmp/a", Method: "PUT", Conditional: "if-none-match:*", MaxBytes: 100, ExpiresAt: now.Add(time.Minute), OwnerReference: "recording"}}}
	if err := job.Validate(now); err != nil {
		t.Fatalf("valid job rejected: %v", err)
	}
	job.Authorization.ExpiresAt = now
	if err := job.Validate(now); err == nil {
		t.Fatal("expired authority accepted")
	}
}

func TestLayoutScreenTieAndStripLimit(t *testing.T) {
	participants := []Participant{{ID: "b", JoinAtMs: 1}, {ID: "a", JoinAtMs: 1}, {ID: "c", JoinAtMs: 2}, {ID: "d", JoinAtMs: 3}, {ID: "e", JoinAtMs: 4}, {ID: "f", JoinAtMs: 5}, {ID: "g", JoinAtMs: 6}, {ID: "h", JoinAtMs: 7}}
	decision, err := SelectLayout(5, LayoutPolicy{Version: "layout.v1", StripLimit: 6, HysteresisMs: 300, AudioWindowMs: 500}, participants, []LayoutEvent{{AtMs: 1, Kind: "screen_share", ParticipantID: "b", StartedAtMs: 1, Active: true}, {AtMs: 1, Kind: "screen_share", ParticipantID: "a", StartedAtMs: 1, Active: true}}, "c")
	if err != nil {
		t.Fatal(err)
	}
	if decision.PrimaryType != "screen" || decision.PrimaryID != "a" || len(decision.Strip) != 6 {
		t.Fatalf("unexpected decision: %+v", decision)
	}
	if decision.Strip[0] != "b" || decision.Strip[1] != "c" {
		t.Fatalf("unstable strip: %+v", decision.Strip)
	}
}

func TestStageTimelineUsesVersionedHysteresisDecisions(t *testing.T) {
	timeline, err := BuildStageTimeline(LayoutPolicy{Version: "layout.v1", StripLimit: 2, HysteresisMs: 100, AudioWindowMs: 500}, []Participant{{ID: "alice", JoinAtMs: 0}, {ID: "bob", JoinAtMs: 1}}, []LayoutEvent{{AtMs: 0, Kind: "audio_level", ParticipantID: "alice", AudioLevel: 5}, {AtMs: 0, Kind: "audio_level", ParticipantID: "bob", AudioLevel: 4}, {AtMs: 50, Kind: "audio_level", ParticipantID: "bob", AudioLevel: 9}, {AtMs: 150, Kind: "audio_level", ParticipantID: "bob", AudioLevel: 9}})
	if err != nil {
		t.Fatal(err)
	}
	if len(timeline.Decisions) != 3 || timeline.Decisions[1].PrimaryID != "alice" || timeline.Decisions[2].PrimaryID != "bob" {
		t.Fatalf("hysteresis timeline is not deterministic: %+v", timeline.Decisions)
	}
}

func TestStageTimelineExpiresStaleAudioLevels(t *testing.T) {
	timeline, err := BuildStageTimeline(LayoutPolicy{Version: "layout.v1", StripLimit: 2, AudioWindowMs: 100}, []Participant{{ID: "alice"}, {ID: "bob"}}, []LayoutEvent{{AtMs: 0, Kind: "audio_level", ParticipantID: "alice", AudioLevel: 100}, {AtMs: 1_000, Kind: "audio_level", ParticipantID: "bob", AudioLevel: 1}, {AtMs: 1_001, Kind: "audio_level", ParticipantID: "bob", AudioLevel: 1}})
	if err != nil {
		t.Fatal(err)
	}
	if got := timeline.Decisions[len(timeline.Decisions)-1].PrimaryID; got != "bob" {
		t.Fatalf("stale audio level retained primary %q, want bob", got)
	}
}

func TestBundleEncryptionAuthenticatesMetadataAndFencing(t *testing.T) {
	bundle, err := NewBundleManifest("recording", "tenant", 0, 1, 1, 0, 10_000, "opus", "audio", "tmp/0", 4, Checksum([]byte("data")))
	if err != nil {
		t.Fatal(err)
	}
	provider := &MemoryKeyProvider{}
	envelope, err := EncryptBundle(context.Background(), provider, bundle.RecordingID, bundle, []byte("data"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := EncryptBundle(context.Background(), provider, bundle.RecordingID, bundle, []byte("tampered")); err == nil {
		t.Fatal("manifest size/checksum mismatch accepted")
	}
	key, err := provider.RecordingKey(context.Background(), bundle.RecordingID)
	if err != nil {
		t.Fatal(err)
	}
	plaintext, metadata, err := DecryptBundle(key, envelope)
	if err != nil {
		t.Fatal(err)
	}
	if string(plaintext) != "data" || metadata.ObjectKey != bundle.ObjectKey {
		t.Fatalf("bad decrypted bundle: %q %+v", plaintext, metadata)
	}
	envelope.Metadata = "dGFtcGVyZWQ"
	if _, _, err := DecryptBundle(key, envelope); err == nil {
		t.Fatal("tampered authenticated metadata accepted")
	}
	wrapped, err := WrapFixtureKey(key)
	if err != nil {
		t.Fatal(err)
	}
	wrapped.Ciphertext = wrapped.Ciphertext[:len(wrapped.Ciphertext)-1] + "A"
	if _, err := UnwrapFixtureKey(wrapped); err == nil {
		t.Fatal("tampered wrapped key accepted")
	}
	if err := ValidateBundleFencing(bundle, 2, 1); err == nil {
		t.Fatal("fenced bundle accepted")
	}
}

func TestTemporaryObjectKeyIsTenantScopedAndRandom(t *testing.T) {
	first, err := NewTemporaryObjectKey("tenant", "recording", 3)
	if err != nil {
		t.Fatal(err)
	}
	second, err := NewTemporaryObjectKey("tenant", "recording", 3)
	if err != nil {
		t.Fatal(err)
	}
	if first == second || !strings.HasPrefix(first, "tmp/tenant/recording/000003-") {
		t.Fatalf("temporary keys are not scoped/random: %q %q", first, second)
	}
}

func TestSpeakerManifestOverlapAndChunks(t *testing.T) {
	tracks := []AuthenticatedTrack{{ParticipantID: "alice", TrackID: "a1", Epoch: 1, Class: TrackAudio, StartMs: 0, EndMs: 8_000, Authorized: true, SourceHash: "ha"}, {ParticipantID: "bob", TrackID: "b1", Epoch: 1, Class: TrackAudio, StartMs: 0, EndMs: 8_000, Authorized: true, SourceHash: "hb"}}
	manifest, err := BuildSpeakerTurnManifest(tracks, []SpeechInterval{{ParticipantID: "alice", TrackID: "a1", Epoch: 1, StartMs: 1_000, EndMs: 3_000, SourceHash: "ha"}, {ParticipantID: "bob", TrackID: "b1", Epoch: 1, StartMs: 2_000, EndMs: 4_000, SourceHash: "hb"}}, "vad.v1")
	if err != nil {
		t.Fatal(err)
	}
	if len(manifest.Turns) != 4 || manifest.Turns[0].Overlap || !manifest.Turns[1].Overlap || !manifest.Turns[2].Overlap || manifest.Turns[3].Overlap {
		t.Fatalf("overlap not represented: %+v", manifest.Turns)
	}
	chunks, err := BuildAudioChunkPlan(manifest, 1_000, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(chunks) != 8 || chunks[0].Channels != 1 || chunks[0].SampleRate != 16000 || chunks[0].PolicyVersion != "vad.v1" {
		t.Fatalf("unexpected chunk plan: %+v", chunks)
	}
}

func TestPackEDFAndFFmpegPlan(t *testing.T) {
	schedule, err := PackEDF([]RenderJob{{ID: "late", DeadlineMs: 30, ServiceMs: 6}, {ID: "early", DeadlineMs: 10, ServiceMs: 4}, {ID: "third", DeadlineMs: 20, ServiceMs: 4}}, 2, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(schedule.Nodes) != 2 || schedule.Nodes[0].Jobs[0].ID != "early" {
		t.Fatalf("unexpected schedule: %+v", schedule)
	}
	deadlineSchedule, err := PackEDF([]RenderJob{{ID: "first", DeadlineMs: 10, ServiceMs: 10}, {ID: "second", DeadlineMs: 10, ServiceMs: 10}}, 2, 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(deadlineSchedule.Nodes) != 2 {
		t.Fatalf("deadline-constrained schedule used %d nodes, want 2", len(deadlineSchedule.Nodes))
	}
	plan, err := BuildFFmpegPlan("in.mkv", "out.mp4")
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(plan.Command, " ")
	for _, required := range []string{"1280:720", "-b:v 2M", "-maxrate 3M", "-c:a aac", "-b:a 128k"} {
		if !strings.Contains(joined, required) {
			t.Fatalf("ffmpeg plan missing %q: %s", required, joined)
		}
	}
}

func TestProviderPortsFailClosed(t *testing.T) {
	if _, err := (CloudflareCaptureProvider{}).Capture(Job{}); err != ErrProviderUnimplemented {
		t.Fatalf("capture provider did not fail closed: %v", err)
	}
	if _, err := (PionCaptureProvider{}).Capture(Job{}); err != ErrProviderUnimplemented {
		t.Fatalf("Pion provider did not fail closed: %v", err)
	}
	if _, err := (GPURenderProvider{}).Render(Job{}); err != ErrProviderUnimplemented {
		t.Fatalf("render provider did not fail closed: %v", err)
	}
}

type eventSink struct{ events []WorkerEvent }

func (s *eventSink) Report(_ context.Context, event WorkerEvent) error {
	s.events = append(s.events, event)
	return nil
}

type retryableEventSink struct {
	eventSink
	fail bool
}

func (s *retryableEventSink) Report(ctx context.Context, event WorkerEvent) error {
	if s.fail {
		s.fail = false
		return errors.New("transient report failure")
	}
	return s.eventSink.Report(ctx, event)
}

func TestRuntimeReportsBoundedLifecycle(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	job := Job{ProtocolVersion: ProtocolVersion, JobID: "job", TenantID: "tenant", SessionID: "session", Attempt: 1, FencingGeneration: 1, Role: RoleRender, ArtifactClass: "mp4", Authorization: JobAuthorization{Scope: "render", IssuedAt: now.Add(-time.Minute), ExpiresAt: now.Add(time.Minute)}, ObjectIntents: []ObjectIntent{{Key: "tmp/input", URL: "https://objects.invalid/tmp/input", Method: "GET", MaxBytes: 100, ExpiresAt: now.Add(time.Minute), OwnerReference: "recording"}}}
	sink := &eventSink{}
	runtime, err := NewRuntime(job, sink, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	if err := runtime.Progress(context.Background(), "render", 1, 2, 10, "tmp/input"); err != nil {
		t.Fatal(err)
	}
	if err := runtime.Complete(context.Background(), "recording.mp4", "sha", ResourceUse{}); err != nil {
		t.Fatal(err)
	}
	if err := runtime.Heartbeat(context.Background(), now.Add(time.Minute), ResourceUse{}); err == nil {
		t.Fatal("heartbeat accepted after terminal outcome")
	}
	if len(sink.events) != 2 {
		t.Fatalf("unexpected reports: %d", len(sink.events))
	}
	if sink.events[0].Type != EventProgress || sink.events[1].Terminal.Outcome != "succeeded" {
		t.Fatalf("unexpected lifecycle events: %+v", sink.events)
	}
}

func TestRuntimeRetriesFailedTerminalReport(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	job := Job{ProtocolVersion: ProtocolVersion, JobID: "job", TenantID: "tenant", SessionID: "session", Attempt: 1, FencingGeneration: 1, Role: RoleRender, ArtifactClass: "mp4", Authorization: JobAuthorization{Scope: "render", IssuedAt: now.Add(-time.Minute), ExpiresAt: now.Add(time.Minute)}, ObjectIntents: []ObjectIntent{{Key: "tmp/input", URL: "https://objects.invalid/tmp/input", Method: "GET", MaxBytes: 100, ExpiresAt: now.Add(time.Minute), OwnerReference: "recording"}}}
	sink := &retryableEventSink{fail: true}
	runtime, err := NewRuntime(job, sink, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	if err := runtime.Complete(context.Background(), "recording.mp4", "sha", ResourceUse{}); err == nil {
		t.Fatal("transient terminal report failure was hidden")
	}
	if err := runtime.Complete(context.Background(), "recording.mp4", "sha", ResourceUse{}); err != nil {
		t.Fatalf("terminal report retry failed: %v", err)
	}
}
