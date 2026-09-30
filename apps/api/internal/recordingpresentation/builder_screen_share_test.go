package recordingpresentation

import (
	"fmt"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
)

func TestPresentationScreenSharePlanTail(t *testing.T) {
	for _, test := range []struct {
		name        string
		finalScreen string
	}{
		{name: "share removed mid-Recording"},
		{name: "share replaced by another participant", finalScreen: "second"},
		{name: "share remains active at stop", finalScreen: "first"},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := newParticipantBuilderFixture(t)
			fixture.source.BaselineControlState = []byte(fmt.Sprintf(
				`{"control_revision":1,"participants":[{"participant_id":%q,"display_name":"Alex","hand_raised":false,"admission_revision":1},{"participant_id":%q,"display_name":"Jordan","hand_raised":false,"admission_revision":2}]}`,
				fixture.first.String(), fixture.second.String(),
			))
			participants := []captureplan.ParticipantSnapshot{
				activeParticipant(fixture.first, "Alex", 1),
				activeParticipant(fixture.second, "Jordan", 2),
			}
			firstScreen := participantTrack(fixture.first, captureplane.TrackSourceScreen, "first-screen")
			secondScreen := participantTrack(fixture.second, captureplane.TrackSourceScreen, "second-screen")
			setParticipantPlan(t, &fixture.source, 1, participants, nil)
			shareAt := fixture.source.CaptureReadyAt.Add(200 * time.Millisecond)
			changeAt := fixture.source.CaptureReadyAt.Add(400 * time.Millisecond)
			stopAt := fixture.source.CaptureReadyAt.Add(800 * time.Millisecond)
			var finalTracks []captureplan.TrackSnapshot
			switch test.finalScreen {
			case "first":
				finalTracks = []captureplan.TrackSnapshot{firstScreen}
			case "second":
				finalTracks = []captureplan.TrackSnapshot{secondScreen}
			}
			fixture.source.CapturePlans = append(fixture.source.CapturePlans,
				CapturePlanFact{Revision: 2, CreatedAt: shareAt, Plan: newParticipantPlan(t, fixture.source, 1, 2, 1, participants, []captureplan.TrackSnapshot{firstScreen})},
			)
			if test.finalScreen != "first" {
				fixture.source.CapturePlans = append(fixture.source.CapturePlans,
					CapturePlanFact{Revision: 3, CreatedAt: changeAt, Plan: newParticipantPlan(t, fixture.source, 1, 3, 1, participants, finalTracks)},
				)
			}
			stopRevision := int64(len(fixture.source.CapturePlans) + 1)
			fixture.source.CapturePlans = append(fixture.source.CapturePlans,
				CapturePlanFact{Revision: stopRevision, CreatedAt: stopAt, Plan: newParticipantPlan(t, fixture.source, 1, stopRevision, 1, participants, finalTracks, stopAt)},
			)

			built, err := buildPresentation(fixture.source)
			if err != nil {
				t.Fatalf("build presentation: %v", err)
			}
			if err := built.Timeline.Validate(); err != nil {
				t.Fatalf("validate timeline: %v", err)
			}

			var oldSourceID string
			var reveal, clear, hide, nextReveal, selectNext int
			for _, event := range built.Timeline.Events {
				switch value := event.(type) {
				case *MediaSourceChangedEvent:
					if value.AtMillis == 200 && value.Source.Kind == MediaKindScreenShare && value.Source.Visible {
						oldSourceID = value.Source.SourceID
						reveal = value.Sequence
					}
					if value.AtMillis == 400 && value.Source.SourceID == oldSourceID && !value.Source.Visible {
						hide = value.Sequence
					}
					if value.AtMillis == 400 && value.Source.ParticipantID == fixture.second.String() && value.Source.Visible {
						nextReveal = value.Sequence
					}
				case *SharedContentChangedEvent:
					if value.AtMillis == 400 && value.SharedContent.Kind == "none" {
						clear = value.Sequence
					}
					if value.AtMillis == 400 && value.SharedContent.ParticipantID == fixture.second.String() {
						selectNext = value.Sequence
					}
				}
			}
			if oldSourceID == "" || reveal == 0 {
				t.Fatal("initial screen share was not revealed")
			}
			if test.finalScreen == "first" {
				if clear != 0 || hide != 0 {
					t.Fatalf("active share was cleared at stop: clear=%d hide=%d", clear, hide)
				}
				return
			}
			if clear == 0 || hide == 0 || clear >= hide {
				t.Fatalf("shared content was not cleared before hiding old screen: clear=%d hide=%d", clear, hide)
			}
			if test.finalScreen == "second" && (nextReveal == 0 || selectNext <= nextReveal) {
				t.Fatalf("new screen was not selected after reveal: reveal=%d select=%d", nextReveal, selectNext)
			}
		})
	}
}
