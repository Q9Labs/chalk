package recordingpresentation

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplan"
)

func TestPrepareCompletionIgnoresPreOriginRecordingStatusTail(t *testing.T) {
	fixture := newParticipantBuilderFixture(t)
	source := fixture.source
	setParticipantPlan(t, &source, 1, []captureplan.ParticipantSnapshot{activeParticipant(fixture.first, "Alex", 1)}, nil)
	source.EpisodeControlTailEvents = []ControlEventFact{
		{Revision: 2, Name: "recording_status_changed", CreatedAt: source.CaptureReadyAt.Add(-13_778 * time.Microsecond)},
		{Revision: 3, Name: "hand_raised", Payload: []byte(fmt.Sprintf(`{"participant_id":%q}`, fixture.first.String())), CreatedAt: source.CaptureReadyAt.Add(100 * time.Millisecond)},
	}
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
		t.Fatalf("prepare completion with pre-origin recording status: %v", err)
	}
	timeline, err := Decode(store.objects[prepared.PresentationObject.Key].body)
	if err != nil {
		t.Fatal(err)
	}
	if timeline.SourceCursors.EpisodeControlEndRevision != 3 || len(timeline.Events) != 1 {
		t.Fatalf("control end/events = %d/%d, want 3/1", timeline.SourceCursors.EpisodeControlEndRevision, len(timeline.Events))
	}
	event, ok := timeline.Events[0].(*ParticipantHandRaisedChangedEvent)
	if !ok || event.AtMillis != 100 || event.ParticipantID != fixture.first.String() || !event.Raised {
		t.Fatalf("presentation event = %#v, want hand raised at 100 ms", timeline.Events[0])
	}
}

func TestControlTailStillRejectsPreOriginParticipantAndRevisionGaps(t *testing.T) {
	for _, test := range []struct {
		name string
		fact ControlEventFact
	}{
		{name: "participant timestamp", fact: ControlEventFact{Revision: 2, Name: "hand_raised"}},
		{name: "ignored event revision gap", fact: ControlEventFact{Revision: 3, Name: "recording_status_changed"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := newParticipantBuilderFixture(t)
			fact := test.fact
			fact.CreatedAt = fixture.source.CaptureReadyAt.Add(-time.Millisecond)
			fact.Payload = []byte(fmt.Sprintf(`{"participant_id":%q}`, fixture.first.String()))
			fixture.source.EpisodeControlTailEvents = []ControlEventFact{fact}
			if _, err := scheduleControlTail(fixture.source, func(int64, int, Event) {}); !errors.Is(err, ErrInvalidCompletionSource) {
				t.Fatalf("schedule invalid tail: %v", err)
			}
		})
	}
}
