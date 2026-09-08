package recordingpresentation

import (
	"bytes"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type participantBuilderFixture struct {
	source        CompletionSource
	first, second utilities.ID
}

func newParticipantBuilderFixture(t *testing.T) participantBuilderFixture {
	t.Helper()
	ready := time.Date(2026, time.September, 8, 0, 0, 0, 0, time.UTC)
	first := testPresentationID(t, "00000000-0000-4000-8000-000000000001")
	second := testPresentationID(t, "00000000-0000-4000-8000-000000000002")
	profile, err := NewComposite720PProfile(strings.Repeat("a", 64))
	if err != nil {
		t.Fatal(err)
	}
	return participantBuilderFixture{
		first: first, second: second,
		source: CompletionSource{
			PresentationHandle: first,
			TenantID:           first,
			SpaceID:            first,
			EpisodeID:          first,
			RecordingID:        first,
			CaptureEpoch:       1,
			CaptureReadyAt:     ready,
			DurationMillis:     1000,
			Profile:            profile,
			SpaceName:          "Recorded space",

			EpisodeControlStartRevision:  1,
			EpisodeControlOriginRevision: 1,
			CapturePlanStartRevision:     1,
			BaselineControlState: []byte(fmt.Sprintf(
				`{"control_revision":1,"participants":[{"participant_id":%q,"display_name":"Alex","hand_raised":false,"admission_revision":1}]}`,
				first.String(),
			)),
		},
	}
}

func activeParticipant(id utilities.ID, displayName string, joinOrdinal int64) captureplan.ParticipantSnapshot {
	return captureplan.ParticipantSnapshot{
		ID: id, Generation: 1, DisplayName: displayName,
		JoinOrdinal: joinOrdinal, Lifecycle: captureplan.ParticipantActive,
	}
}

func participantTrack(id utilities.ID, source captureplane.TrackSource, suffix string) captureplan.TrackSnapshot {
	kind := captureplane.TrackKindVideo
	if source == captureplane.TrackSourceMicrophone {
		kind = captureplane.TrackKindAudio
	}
	return captureplan.TrackSnapshot{
		ParticipantID: id, ParticipantGeneration: 1, Source: source, Kind: kind,
		OwnerReference:       captureplane.ProviderReference("owner-" + suffix),
		TrackReference:       captureplane.ProviderReference("track-" + suffix),
		OwnerMID:             captureplane.ProviderReference("mid-" + suffix),
		PublicationReference: captureplan.PublicationReference("publication-" + suffix),
		RequestedLayer:       captureplane.TrackLayerAuto,
	}
}

func setParticipantPlan(
	t *testing.T,
	source *CompletionSource,
	controlCursor int64,
	participants []captureplan.ParticipantSnapshot,
	tracks []captureplan.TrackSnapshot,
) {
	t.Helper()
	plan := newParticipantPlan(t, *source, 1, 1, controlCursor, participants, tracks)
	source.CapturePlans = []CapturePlanFact{{
		Revision: 1, Plan: plan, CreatedAt: source.CaptureReadyAt.Add(-time.Second),
	}}
}

func newParticipantPlan(
	t *testing.T,
	source CompletionSource,
	captureEpoch, revision, controlCursor int64,
	participants []captureplan.ParticipantSnapshot,
	tracks []captureplan.TrackSnapshot,
) captureplan.Plan {
	t.Helper()
	plan, err := captureplan.NewPlan(captureplan.PlanInput{
		Authority: captureplan.PlanAuthority{
			PlanHandle: captureplan.PlanHandle(source.PresentationHandle.String()),
			TenantID:   source.TenantID, SpaceID: source.SpaceID, EpisodeID: source.EpisodeID,
			RecordingID: source.RecordingID, JobID: source.RecordingID,
			AttemptCount: int(captureEpoch), FencingGeneration: captureEpoch,
			CaptureEpoch:   captureplane.CaptureEpoch(captureEpoch),
			EnvelopeDigest: bytes.Repeat([]byte{1}, 32),
		},
		Revision: captureplane.PlanRevision(revision),
		Cursors: captureplan.PlanCursors{
			EpisodeControlRevision: controlCursor,
			ProviderIncarnation:    1,
			ProviderSequence:       1,
		},
		LayoutProfile:    captureplan.LayoutProfileComposite720PV1,
		ParticipantLimit: 10, InputBitrateBPS: 1_000_000,
		EffectiveDeadline: source.CaptureReadyAt.Add(time.Hour),
		StopState:         captureplan.StopStateRunning,
		Participants:      participants,
		Tracks:            tracks,
	})
	if err != nil {
		t.Fatal(err)
	}
	return plan
}

func TestPresentationReconcilesInitialPlanAtItsControlCursor(t *testing.T) {
	t.Run("join after cursor is retained without media", func(t *testing.T) {
		fixture := newParticipantBuilderFixture(t)
		fixture.source.EpisodeControlOriginRevision = 2
		fixture.source.EpisodeControlOriginEvents = []ControlEventFact{{
			Revision: 2,
			Name:     "participant_joined",
			Payload: []byte(fmt.Sprintf(
				`{"participant_id":%q,"display_name":"Jordan","admission_revision":2}`,
				fixture.second.String(),
			)),
			CreatedAt: fixture.source.CaptureReadyAt.Add(-500 * time.Millisecond),
		}}
		setParticipantPlan(t, &fixture.source, 1, []captureplan.ParticipantSnapshot{
			activeParticipant(fixture.first, "Alex", 1),
		}, nil)

		built, err := buildPresentation(fixture.source)
		if err != nil {
			t.Fatalf("build presentation: %v", err)
		}
		if len(built.Timeline.Initial.Participants) != 2 {
			t.Fatalf("participants = %v", built.Timeline.Initial.Participants)
		}
		joined := built.Timeline.Initial.Participants[1]
		if joined.ID != fixture.second.String() || !joined.Joined || !joined.MicrophoneMuted ||
			joined.CameraEnabled || joined.ScreenShareEnabled {
			t.Fatalf("participant joined after the plan cursor = %+v", joined)
		}
	})

	t.Run("join at cursor cannot be omitted", func(t *testing.T) {
		fixture := newParticipantBuilderFixture(t)
		fixture.source.EpisodeControlOriginRevision = 2
		fixture.source.EpisodeControlOriginEvents = []ControlEventFact{{
			Revision: 2,
			Name:     "participant_joined",
			Payload: []byte(fmt.Sprintf(
				`{"participant_id":%q,"display_name":"Jordan","admission_revision":2}`,
				fixture.second.String(),
			)),
			CreatedAt: fixture.source.CaptureReadyAt.Add(-500 * time.Millisecond),
		}}
		setParticipantPlan(t, &fixture.source, 2, []captureplan.ParticipantSnapshot{
			activeParticipant(fixture.first, "Alex", 1),
		}, nil)

		if _, err := buildPresentation(fixture.source); !errors.Is(err, ErrInvalidCompletionSource) {
			t.Fatalf("omitted participant accepted: %v", err)
		}
	})

	t.Run("rename after cursor preserves the origin name", func(t *testing.T) {
		fixture := newParticipantBuilderFixture(t)
		fixture.source.EpisodeControlOriginRevision = 2
		fixture.source.EpisodeControlOriginEvents = []ControlEventFact{{
			Revision: 2,
			Name:     "participant_display_name_changed",
			Payload: []byte(fmt.Sprintf(
				`{"participant_id":%q,"display_name":"Alexandra"}`,
				fixture.first.String(),
			)),
			CreatedAt: fixture.source.CaptureReadyAt.Add(-500 * time.Millisecond),
		}}
		setParticipantPlan(t, &fixture.source, 1, []captureplan.ParticipantSnapshot{
			activeParticipant(fixture.first, "Alex", 1),
		}, nil)

		built, err := buildPresentation(fixture.source)
		if err != nil {
			t.Fatalf("build presentation: %v", err)
		}
		if got := built.Timeline.Initial.Participants[0].DisplayName; got != "Alexandra" {
			t.Fatalf("origin display name = %q", got)
		}
	})

	t.Run("hand change after cursor is reflected at origin", func(t *testing.T) {
		fixture := newParticipantBuilderFixture(t)
		fixture.source.EpisodeControlOriginRevision = 2
		fixture.source.EpisodeControlOriginEvents = []ControlEventFact{{
			Revision: 2,
			Name:     "hand_raised",
			Payload: []byte(fmt.Sprintf(
				`{"participant_id":%q}`,
				fixture.first.String(),
			)),
			CreatedAt: fixture.source.CaptureReadyAt.Add(-500 * time.Millisecond),
		}}
		setParticipantPlan(t, &fixture.source, 1, []captureplan.ParticipantSnapshot{
			activeParticipant(fixture.first, "Alex", 1),
		}, nil)

		built, err := buildPresentation(fixture.source)
		if err != nil {
			t.Fatalf("build presentation: %v", err)
		}
		if !built.Timeline.Initial.Participants[0].HandRaised {
			t.Fatal("origin hand state was not retained")
		}
	})
}

func TestPresentationHidesInitialMediaForParticipantWhoLeftAfterPlanCursor(t *testing.T) {
	fixture := newParticipantBuilderFixture(t)
	fixture.source.EpisodeControlOriginRevision = 2
	fixture.source.EpisodeControlOriginEvents = []ControlEventFact{{
		Revision:  2,
		Name:      "participant_left",
		Payload:   []byte(fmt.Sprintf(`{"participant_id":%q}`, fixture.first.String())),
		CreatedAt: fixture.source.CaptureReadyAt.Add(-500 * time.Millisecond),
	}}
	tracks := []captureplan.TrackSnapshot{
		participantTrack(fixture.first, captureplane.TrackSourceCamera, "camera"),
		participantTrack(fixture.first, captureplane.TrackSourceScreen, "screen"),
	}
	setParticipantPlan(t, &fixture.source, 1, []captureplan.ParticipantSnapshot{
		activeParticipant(fixture.first, "Alex", 1),
	}, tracks)

	built, err := buildPresentation(fixture.source)
	if err != nil {
		t.Fatalf("build presentation: %v", err)
	}
	participant := built.Timeline.Initial.Participants[0]
	if participant.Joined || participant.CameraEnabled || participant.ScreenShareEnabled {
		t.Fatalf("departed participant = %+v", participant)
	}
	if len(built.Timeline.Initial.Media) != 2 {
		t.Fatalf("media catalog = %v", built.Timeline.Initial.Media)
	}
	for _, source := range built.Timeline.Initial.Media {
		if source.Visible {
			t.Fatalf("departed participant source remained visible: %+v", source)
		}
	}
	if got := built.Timeline.Initial.SharedContent.Kind; got != "none" {
		t.Fatalf("shared content kind = %q", got)
	}
}

func TestPresentationTrackEpochUsesOriginalCaptureAttemptIdentity(t *testing.T) {
	fixture := newParticipantBuilderFixture(t)
	fixture.source.CaptureEpoch = 2
	participant := activeParticipant(fixture.first, "Alex", 1)
	track := participantTrack(fixture.first, captureplane.TrackSourceCamera, "camera")
	reboundTrack := track
	reboundTrack.OwnerReference = "replacement-owner-camera"
	fixture.source.CapturePlans = []CapturePlanFact{
		{
			Revision:  1,
			Plan:      newParticipantPlan(t, fixture.source, 1, 1, 1, []captureplan.ParticipantSnapshot{participant}, []captureplan.TrackSnapshot{track}),
			CreatedAt: fixture.source.CaptureReadyAt.Add(-time.Second),
		},
		{
			Revision:  2,
			Plan:      newParticipantPlan(t, fixture.source, 1, 2, 1, []captureplan.ParticipantSnapshot{participant}, []captureplan.TrackSnapshot{track}),
			CreatedAt: fixture.source.CaptureReadyAt.Add(100 * time.Millisecond),
		},
		{
			Revision:  3,
			Plan:      newParticipantPlan(t, fixture.source, 1, 3, 1, []captureplan.ParticipantSnapshot{participant}, []captureplan.TrackSnapshot{reboundTrack}),
			CreatedAt: fixture.source.CaptureReadyAt.Add(150 * time.Millisecond),
		},
		{
			Revision:  4,
			Plan:      newParticipantPlan(t, fixture.source, 2, 1, 1, []captureplan.ParticipantSnapshot{participant}, []captureplan.TrackSnapshot{track}),
			CreatedAt: fixture.source.CaptureReadyAt.Add(200 * time.Millisecond),
		},
	}

	built, err := buildPresentation(fixture.source)
	if err != nil {
		t.Fatalf("build presentation: %v", err)
	}
	if len(built.Timeline.Initial.Media) != 1 || built.Timeline.Initial.Media[0].Epoch != 1 {
		t.Fatalf("initial media = %+v", built.Timeline.Initial.Media)
	}
	wantRetry, err := recordingbundle.ComposeTrackEpoch(2, 1)
	if err != nil {
		t.Fatal(err)
	}
	foundRebound := false
	var retrySource *MediaSource
	for _, event := range built.Timeline.Events {
		if changed, ok := event.(*MediaSourceChangedEvent); ok && changed.Source.Visible {
			if changed.Source.Epoch == 3 {
				foundRebound = true
			}
			source := changed.Source
			retrySource = &source
		}
	}
	if !foundRebound || retrySource == nil || retrySource.Epoch != int64(wantRetry) || retrySource.SourceID == built.Timeline.Initial.Media[0].SourceID {
		t.Fatalf("retry media source = %+v", retrySource)
	}
}

func TestPresentationRejectsInitialPlanThatDivergesAtItsControlCursor(t *testing.T) {
	for _, test := range []struct {
		name           string
		controlCursor  int64
		originRevision int64
		displayName    string
		originEvents   func(participantBuilderFixture) []ControlEventFact
	}{
		{
			name: "cursor before baseline", controlCursor: 0, originRevision: 1, displayName: "Alex",
		},
		{
			name: "cursor after origin", controlCursor: 2, originRevision: 1, displayName: "Alex",
		},
		{
			name: "display name mismatch", controlCursor: 1, originRevision: 1, displayName: "Wrong",
		},
		{
			name: "participant included after leave", controlCursor: 2, originRevision: 2, displayName: "Alex",
			originEvents: func(fixture participantBuilderFixture) []ControlEventFact {
				return []ControlEventFact{{
					Revision:  2,
					Name:      "participant_left",
					Payload:   []byte(fmt.Sprintf(`{"participant_id":%q}`, fixture.first.String())),
					CreatedAt: fixture.source.CaptureReadyAt.Add(-500 * time.Millisecond),
				}}
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := newParticipantBuilderFixture(t)
			fixture.source.EpisodeControlOriginRevision = test.originRevision
			if test.originEvents != nil {
				fixture.source.EpisodeControlOriginEvents = test.originEvents(fixture)
			}
			setParticipantPlan(t, &fixture.source, test.controlCursor, []captureplan.ParticipantSnapshot{
				activeParticipant(fixture.first, test.displayName, 1),
			}, nil)

			if _, err := buildPresentation(fixture.source); !errors.Is(err, ErrInvalidCompletionSource) {
				t.Fatalf("divergent plan accepted: %v", err)
			}
		})
	}
}

func TestWhiteboardFallbackDoesNotRestoreDepartedParticipantScreen(t *testing.T) {
	for _, test := range []struct {
		name          string
		leaveAtOrigin bool
	}{
		{name: "left before capture ready", leaveAtOrigin: true},
		{name: "left at fallback time"},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := newParticipantBuilderFixture(t)
			fallbackAt := fixture.source.CaptureReadyAt.Add(100 * time.Millisecond)
			if test.leaveAtOrigin {
				fixture.source.EpisodeControlOriginRevision = 2
				fixture.source.EpisodeControlOriginEvents = []ControlEventFact{{
					Revision:  2,
					Name:      "participant_left",
					Payload:   []byte(fmt.Sprintf(`{"participant_id":%q}`, fixture.first.String())),
					CreatedAt: fixture.source.CaptureReadyAt.Add(-100 * time.Millisecond),
				}}
			} else {
				fixture.source.EpisodeControlTailEvents = []ControlEventFact{{
					Revision:  2,
					Name:      "participant_left",
					Payload:   []byte(fmt.Sprintf(`{"participant_id":%q}`, fixture.first.String())),
					CreatedAt: fallbackAt,
				}}
			}
			setParticipantPlan(t, &fixture.source, 1, []captureplan.ParticipantSnapshot{
				activeParticipant(fixture.first, "Alex", 1),
			}, []captureplan.TrackSnapshot{
				participantTrack(fixture.first, captureplane.TrackSourceScreen, "screen"),
			})
			fixture.source.WhiteboardStartRevision = 1
			fixture.source.WhiteboardOriginRevision = 1
			fixture.source.InitialWhiteboard = &WhiteboardSnapshotFact{
				SceneID: "scene-1", Revision: 1, Presenting: true, AppState: []byte(`{}`),
			}
			presenting := false
			fixture.source.WhiteboardTailEvents = []WhiteboardEventFact{{
				OperationID: "stop-presenting", Name: "set_presentation", SceneID: "scene-1",
				Revision: 2, Presenting: &presenting, CompletedAt: fallbackAt,
			}}

			built, err := buildPresentation(fixture.source)
			if err != nil {
				t.Fatalf("build presentation: %v", err)
			}
			if got := built.Timeline.Initial.SharedContent.Kind; got != "whiteboard" {
				t.Fatalf("initial shared content kind = %q", got)
			}
			var fallback *SharedContentChangedEvent
			for _, event := range built.Timeline.Events {
				if value, ok := event.(*SharedContentChangedEvent); ok {
					fallback = value
				}
			}
			if fallback == nil || fallback.AtMillis != 100 || fallback.SharedContent.Kind != "none" {
				t.Fatalf("whiteboard fallback = %+v", fallback)
			}
		})
	}
}
