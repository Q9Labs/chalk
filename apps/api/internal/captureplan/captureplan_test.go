package captureplan

import (
	"bytes"
	"context"
	"errors"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestNewPlanCanonicalizesParticipantAndTrackOrder(t *testing.T) {
	first := participant(t, 1, 2, "First")
	second := participant(t, 2, 1, "Second")
	firstTrack := track(t, first, captureplane.TrackSourceCamera, captureplane.TrackKindVideo, "publication-first")
	secondTrack := track(t, second, captureplane.TrackSourceMicrophone, captureplane.TrackKindAudio, "publication-second")

	ordered, err := NewPlan(planInput(t, []ParticipantSnapshot{first, second}, []TrackSnapshot{firstTrack, secondTrack}))
	if err != nil {
		t.Fatalf("ordered plan: %v", err)
	}
	reversed, err := NewPlan(planInput(t, []ParticipantSnapshot{second, first}, []TrackSnapshot{secondTrack, firstTrack}))
	if err != nil {
		t.Fatalf("reversed plan: %v", err)
	}
	if !bytes.Equal(ordered.CanonicalJSON(), reversed.CanonicalJSON()) {
		t.Fatalf("canonical JSON differs for reordered facts:\n%s\n%s", ordered.CanonicalJSON(), reversed.CanonicalJSON())
	}
	if ordered.Fingerprint() != reversed.Fingerprint() {
		t.Fatalf("fingerprint differs for reordered facts: %x != %x", ordered.Fingerprint(), reversed.Fingerprint())
	}
	if got := ordered.Participants(); got[0].JoinOrdinal != 1 || got[1].JoinOrdinal != 2 {
		t.Fatalf("participants were not canonically ordered: %#v", got)
	}
	gotTracks := ordered.Tracks()
	if gotTracks[0].ParticipantID != firstTrack.ParticipantID {
		t.Fatalf("tracks were not canonically ordered: %#v", gotTracks)
	}

	participants := ordered.Participants()
	participants[0].DisplayName = "mutated"
	if ordered.Participants()[0].DisplayName == "mutated" {
		t.Fatal("participant accessor exposed mutable plan state")
	}
	authority := ordered.Authority()
	authority.EnvelopeDigest[0]++
	if ordered.Authority().EnvelopeDigest[0] == authority.EnvelopeDigest[0] {
		t.Fatal("authority accessor exposed mutable digest state")
	}
}

func TestNewPlanRejectsInvalidAndMismatchedFacts(t *testing.T) {
	participantSnapshot := participant(t, 1, 1, "Participant")
	valid := planInput(t, []ParticipantSnapshot{participantSnapshot}, []TrackSnapshot{track(t, participantSnapshot, captureplane.TrackSourceCamera, captureplane.TrackKindVideo, "publication")})

	cases := []struct {
		name string
		edit func(*PlanInput)
		want error
	}{
		{name: "missing authority ID", edit: func(input *PlanInput) { input.Authority.EpisodeID = utilities.ID{} }, want: ErrInvalidAuthority},
		{name: "zero revision", edit: func(input *PlanInput) { input.Revision = 0 }, want: ErrInvalidPlan},
		{name: "generation mismatch", edit: func(input *PlanInput) { input.Tracks[0].ParticipantGeneration++ }, want: ErrInvalidTrack},
		{name: "unknown lifecycle", edit: func(input *PlanInput) { input.Participants[0].Lifecycle = "joining" }, want: ErrInvalidParticipant},
		{name: "non-auto layer", edit: func(input *PlanInput) { input.Tracks[0].RequestedLayer = captureplane.TrackLayerHigh }, want: ErrInvalidTrack},
		{name: "over bitrate", edit: func(input *PlanInput) { input.InputBitrateBPS = MaximumInputBitrateBPS + 1 }, want: ErrInvalidPlan},
		{name: "over participant limit", edit: func(input *PlanInput) { input.ParticipantLimit = MaximumParticipants + 1 }, want: ErrInvalidPlan},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			input := clonePlanInput(valid)
			test.edit(&input)
			if _, err := NewPlan(input); !errors.Is(err, test.want) {
				t.Fatalf("error = %v, want %v", err, test.want)
			}
		})
	}
}

func TestServiceWaitReturnsNewerPlanImmediately(t *testing.T) {
	input := waitInput(t)
	newerInput := planInput(t, []ParticipantSnapshot{participant(t, 1, 1, "Participant")}, nil)
	newerInput.Revision = input.AfterRevision + 1
	newer, err := NewPlan(newerInput)
	if err != nil {
		t.Fatalf("newer plan: %v", err)
	}
	repository := repositoryFunc(func(context.Context, WaitInput) (Plan, error) { return newer, nil })
	service := NewServiceWithConfig(repository, Config{Now: func() time.Time { return testNow }, Wait: func(context.Context, time.Duration) error { t.Fatal("wait called for newer plan"); return nil }})
	got, err := service.Wait(context.Background(), input)
	if err != nil {
		t.Fatalf("wait: %v", err)
	}
	if got.Revision() != newer.Revision() {
		t.Fatalf("revision = %d, want %d", got.Revision(), newer.Revision())
	}
}

func TestServiceWaitTimesOutOnNoChange(t *testing.T) {
	input := waitInput(t)
	input.MaxWait = 3 * time.Millisecond
	clock := &advancingClock{current: testNow}
	repository := repositoryFunc(func(context.Context, WaitInput) (Plan, error) { return Plan{}, ErrNoChange })
	service := NewServiceWithConfig(repository, Config{
		Now:          clock.Now,
		PollInterval: time.Millisecond,
		Wait: func(_ context.Context, duration time.Duration) error {
			clock.current = clock.current.Add(duration)
			return nil
		},
	})
	if _, err := service.Wait(context.Background(), input); !errors.Is(err, ErrWaitTimeout) {
		t.Fatalf("error = %v, want %v", err, ErrWaitTimeout)
	}
}

func TestServiceWaitPropagatesContextCancellation(t *testing.T) {
	input := waitInput(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	repository := repositoryFunc(func(context.Context, WaitInput) (Plan, error) {
		t.Fatal("repository called after cancellation")
		return Plan{}, nil
	})
	service := NewServiceWithConfig(repository, Config{Now: func() time.Time { return testNow }})
	if _, err := service.Wait(ctx, input); !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want context cancellation", err)
	}
}

func TestServiceWaitRejectsReturnedPlanWithMismatchedAuthority(t *testing.T) {
	input := waitInput(t)
	planFacts := planInput(t, []ParticipantSnapshot{participant(t, 1, 1, "Participant")}, nil)
	planFacts.Authority.SpaceID = mustID(t, "66666666-6666-4666-8666-666666666666")
	planFacts.Revision = input.AfterRevision + 1
	plan, err := NewPlan(planFacts)
	if err != nil {
		t.Fatalf("mismatched plan: %v", err)
	}
	service := NewServiceWithConfig(repositoryFunc(func(context.Context, WaitInput) (Plan, error) { return plan, nil }), Config{Now: func() time.Time { return testNow }})
	if _, err := service.Wait(context.Background(), input); !errors.Is(err, ErrPlanAuthorityMismatch) {
		t.Fatalf("error = %v, want authority mismatch", err)
	}
}

type repositoryFunc func(context.Context, WaitInput) (Plan, error)

func (f repositoryFunc) Reconcile(ctx context.Context, input WaitInput) (Plan, error) {
	return f(ctx, input)
}

type advancingClock struct{ current time.Time }

func (c *advancingClock) Now() time.Time { return c.current }

var testNow = time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)

func planInput(t *testing.T, participants []ParticipantSnapshot, tracks []TrackSnapshot) PlanInput {
	t.Helper()
	return PlanInput{
		Authority:         authority(t),
		Revision:          2,
		Cursors:           PlanCursors{EpisodeControlRevision: 2, ProviderIncarnation: 2, ProviderSequence: 2},
		LayoutProfile:     LayoutProfileComposite720PV1,
		ParticipantLimit:  MaximumParticipants,
		InputBitrateBPS:   MaximumInputBitrateBPS,
		EffectiveDeadline: testNow.Add(time.Hour),
		StopState:         StopStateRunning,
		Participants:      participants,
		Tracks:            tracks,
	}
}

func clonePlanInput(input PlanInput) PlanInput {
	input.Authority.EnvelopeDigest = append([]byte(nil), input.Authority.EnvelopeDigest...)
	input.Participants = append([]ParticipantSnapshot(nil), input.Participants...)
	input.Tracks = append([]TrackSnapshot(nil), input.Tracks...)
	return input
}

func authority(t *testing.T) PlanAuthority {
	t.Helper()
	return PlanAuthority{
		PlanHandle:        PlanHandle("66666666-6666-4666-8666-666666666666"),
		TenantID:          mustID(t, "11111111-1111-4111-8111-111111111111"),
		SpaceID:           mustID(t, "22222222-2222-4222-8222-222222222222"),
		EpisodeID:         mustID(t, "33333333-3333-4333-8333-333333333333"),
		RecordingID:       mustID(t, "44444444-4444-4444-8444-444444444444"),
		JobID:             mustID(t, "55555555-5555-4555-8555-555555555555"),
		AttemptCount:      1,
		FencingGeneration: 1,
		CaptureEpoch:      1,
		EnvelopeDigest:    bytes.Repeat([]byte{0x42}, 32),
	}
}

func waitInput(t *testing.T) WaitInput {
	t.Helper()
	authority := authority(t)
	return NewWaitInput(authority, WorkerLease{Owner: "worker-1", Token: "lease-1", ExpiresAt: testNow.Add(time.Minute)}, 1, 10*time.Millisecond)
}

func participant(t *testing.T, byteValue byte, joinOrdinal int64, name string) ParticipantSnapshot {
	t.Helper()
	return ParticipantSnapshot{ID: utilities.IDFromBytes([16]byte{byteValue}), Generation: 1, DisplayName: name, JoinOrdinal: joinOrdinal, Lifecycle: ParticipantActive}
}

func track(t *testing.T, participant ParticipantSnapshot, source captureplane.TrackSource, kind captureplane.TrackKind, publication string) TrackSnapshot {
	t.Helper()
	return TrackSnapshot{
		ParticipantID: participant.ID, ParticipantGeneration: participant.Generation,
		Source: source, Kind: kind,
		OwnerReference:       captureplane.ProviderReference("owner-" + publication),
		TrackReference:       captureplane.ProviderReference("track-" + publication),
		OwnerMID:             captureplane.ProviderReference("mid-" + publication),
		PublicationReference: PublicationReference(publication), RequestedLayer: captureplane.TrackLayerAuto,
	}
}

func mustID(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatalf("parse ID %q: %v", value, err)
	}
	return id
}
