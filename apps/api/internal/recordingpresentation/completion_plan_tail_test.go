package recordingpresentation

import (
	"bytes"
	"context"
	"errors"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
)

func preOriginPlanSource(t *testing.T) CompletionSource {
	t.Helper()
	fixture := newParticipantBuilderFixture(t)
	source := fixture.source
	participants := []captureplan.ParticipantSnapshot{activeParticipant(fixture.first, "Alex", 1)}
	setParticipantPlan(t, &source, 1, participants, nil)
	source.CapturePlans = append(source.CapturePlans, CapturePlanFact{
		Revision: 2,
		Plan: newParticipantPlan(t, source, 1, 2, 1, participants,
			[]captureplan.TrackSnapshot{participantTrack(fixture.first, captureplane.TrackSourceMicrophone, "microphone")}),
		// The API freezes the origin cursor before the worker reports its clock.
		CreatedAt: source.CaptureReadyAt.Add(-67_914 * time.Microsecond),
	})
	return source
}

func TestPrepareCompletionRetainsPreOriginCapturePlanAtZero(t *testing.T) {
	source := preOriginPlanSource(t)
	store := newPresentationMemoryStore()
	freezer, err := NewFreezer(staticCompletionSourceReader{source: source}, store)
	if err != nil {
		t.Fatal(err)
	}
	prepared, err := freezer.Prepare(context.Background(), CompletionAuthority{
		JobID: source.RecordingID, AttemptCount: 1, FencingGeneration: 1, CaptureEpoch: 1,
		EnvelopeDigest: bytes.Repeat([]byte{1}, 32), LeaseToken: "capture-lease", LeaseOwner: "capture-worker",
	})
	if err != nil {
		t.Fatalf("prepare captured media with pre-origin plan: %v", err)
	}
	timeline, err := Decode(store.objects[prepared.PresentationObject.Key].body)
	if err != nil {
		t.Fatal(err)
	}
	if timeline.SourceCursors.CapturePlanEndRevision != 2 || len(timeline.Events) != 2 {
		t.Fatalf("plan end/events = %d/%d, want 2/2", timeline.SourceCursors.CapturePlanEndRevision, len(timeline.Events))
	}
	for _, event := range timeline.Events {
		if event.eventBase().AtMillis != 0 {
			t.Fatalf("pre-origin event = %#v, want offset zero", event)
		}
	}
	if event, ok := timeline.Events[1].(*ParticipantMicrophoneChangedEvent); !ok || event.Muted {
		t.Fatalf("microphone update lost: %#v", timeline.Events[1])
	}
}

func TestPreOriginCapturePlanStillRejectsCorruption(t *testing.T) {
	for _, name := range []string{"zero timestamp", "after duration", "revision gap"} {
		t.Run(name, func(t *testing.T) {
			source := preOriginPlanSource(t)
			switch name {
			case "zero timestamp":
				source.CapturePlans[1].CreatedAt = time.Time{}
			case "after duration":
				source.CapturePlans[1].CreatedAt = source.CaptureReadyAt.Add(2 * time.Second)
			case "revision gap":
				source.CapturePlans[1].Revision = 3
			}
			if _, err := buildPresentation(source); !errors.Is(err, ErrInvalidCompletionSource) {
				t.Fatalf("corrupt plan accepted: %v", err)
			}
		})
	}
}
