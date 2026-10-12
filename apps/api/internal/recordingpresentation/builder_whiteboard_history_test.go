package recordingpresentation

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplan"
)

func TestWhiteboardHistoryScalesAndKeepsEachChange(t *testing.T) {
	for _, count := range []int{400, 1629, 5000} {
		t.Run(fmt.Sprint(count), func(t *testing.T) {
			fixture := newParticipantBuilderFixture(t)
			setParticipantPlan(t, &fixture.source, 1, []captureplan.ParticipantSnapshot{activeParticipant(fixture.first, "Alex", 1)}, nil)
			fixture.source.DurationMillis = int64(count+1) * 1600
			fixture.source.WhiteboardStartRevision = 1
			fixture.source.WhiteboardOriginRevision = 1
			fixture.source.InitialWhiteboard = &WhiteboardSnapshotFact{SceneID: "scene-1", Revision: 1, Presenting: true, AppState: json.RawMessage(`{}`)}
			for i := 0; i < count; i++ {
				fixture.source.WhiteboardTailEvents = append(fixture.source.WhiteboardTailEvents, WhiteboardEventFact{
					OperationID: fmt.Sprintf("write-%d", i), Name: "submit_update", SceneID: "scene-1", Revision: int64(i + 2),
					CompletedAt: fixture.source.CaptureReadyAt.Add(time.Duration(i+1) * 1600 * time.Millisecond),
					Elements:    []json.RawMessage{historyTestStroke(i)},
				})
			}
			// A late Participant does not reset the board or add another copy.
			fixture.source.EpisodeControlTailEvents = []ControlEventFact{{Revision: 2, Name: "participant_joined", Payload: []byte(fmt.Sprintf(`{"participant_id":%q,"display_name":"Jordan","admission_revision":2}`, fixture.second.String())), CreatedAt: fixture.source.CaptureReadyAt.Add(3 * time.Second)}}
			built, err := buildPresentation(fixture.source)
			if err != nil {
				t.Fatal(err)
			}
			var boards int
			for _, material := range built.Assets {
				if material.Asset.Kind != "whiteboard_state" {
					continue
				}
				boards++
				var history whiteboardHistoryWire
				if err := json.Unmarshal(material.Body, &history); err != nil {
					t.Fatal(err)
				}
				if history.SchemaVersion != "recording_whiteboard_history.v1" || len(history.Updates) != count || len(history.Initial.Elements) != 0 {
					t.Fatalf("unexpected history: updates=%d", len(history.Updates))
				}
				if len(material.Body) > count*300+500 {
					t.Fatalf("nonlinear history size %d", len(material.Body))
				}
			}
			var changes int
			for _, event := range built.Timeline.Events {
				if event, ok := event.(*SharedContentChangedEvent); ok && event.SharedContent.Kind == "whiteboard" {
					changes++
					if event.AtMillis != int64(changes)*1600 {
						t.Fatalf("change time = %d", event.AtMillis)
					}
				}
			}
			if boards != 1 || changes != count {
				t.Fatalf("boards=%d changes=%d", boards, changes)
			}
		})
	}
}

func TestWhiteboardHistoryClearHideAndPresentAgain(t *testing.T) {
	fixture := newParticipantBuilderFixture(t)
	setParticipantPlan(t, &fixture.source, 1, []captureplan.ParticipantSnapshot{activeParticipant(fixture.first, "Alex", 1)}, nil)
	fixture.source.WhiteboardStartRevision = 1
	fixture.source.WhiteboardOriginRevision = 1
	fixture.source.InitialWhiteboard = &WhiteboardSnapshotFact{SceneID: "scene-1", Revision: 1, Presenting: true, AppState: json.RawMessage(`{}`), Elements: []json.RawMessage{historyTestStroke(0)}}
	hidden, shown := false, true
	fixture.source.WhiteboardTailEvents = []WhiteboardEventFact{
		{OperationID: "hide", Name: "set_presentation", SceneID: "scene-1", Revision: 2, Presenting: &hidden},
		{OperationID: "hidden-write", Name: "submit_update", SceneID: "scene-1", Revision: 3, Elements: []json.RawMessage{historyTestStroke(1)}},
		{OperationID: "show", Name: "set_presentation", SceneID: "scene-1", Revision: 4, Presenting: &shown},
		{OperationID: "clear", Name: "clear", SceneID: "scene-2", Revision: 0},
		{OperationID: "write-after-clear", Name: "submit_update", SceneID: "scene-2", Revision: 1, Elements: []json.RawMessage{historyTestStroke(2)}},
		{OperationID: "duplicate-resend", Name: "submit_update", SceneID: "scene-2", Revision: 2, Elements: []json.RawMessage{historyTestStroke(2)}},
	}
	for i := range fixture.source.WhiteboardTailEvents {
		fixture.source.WhiteboardTailEvents[i].CompletedAt = fixture.source.CaptureReadyAt.Add(time.Duration(i+1) * 100 * time.Millisecond)
	}
	built, err := buildPresentation(fixture.source)
	if err != nil {
		t.Fatal(err)
	}
	var boards int
	for _, material := range built.Assets {
		if material.Asset.Kind != "whiteboard_state" {
			continue
		}
		boards++
		var history whiteboardHistoryWire
		if err := json.Unmarshal(material.Body, &history); err != nil {
			t.Fatal(err)
		}
		switch history.Initial.SceneID {
		case "scene-1":
			if len(history.Initial.Elements) != 1 || len(history.Updates) != 1 || history.Updates[0].Revision != 3 {
				t.Fatalf("hidden writing missing: %+v", history)
			}
		case "scene-2":
			if len(history.Initial.Elements) != 0 || len(history.Updates) != 1 || history.Updates[0].Elements[0].ID != "stroke-2" {
				t.Fatalf("clear leaked old writing: %+v", history)
			}
		default:
			t.Fatalf("unexpected scene: %+v", history)
		}
	}
	var changes int
	for _, event := range built.Timeline.Events {
		if _, ok := event.(*SharedContentChangedEvent); ok {
			changes++
		}
	}
	if boards != 2 || changes != 4 || built.Timeline.SourceCursors.WhiteboardEndRevision != 4 {
		t.Fatalf("boards=%d changes=%d cursors=%+v", boards, changes, built.Timeline.SourceCursors)
	}
}

func TestInitialChatRetainsNewestWindow(t *testing.T) {
	fixture := newParticipantBuilderFixture(t)
	setParticipantPlan(t, &fixture.source, 1, []captureplan.ParticipantSnapshot{activeParticipant(fixture.first, "Alex", 1)}, nil)
	fixture.source.ChatStartSequence = 130
	for i := int64(1); i <= 130; i++ {
		fixture.source.InitialChatMessages = append(fixture.source.InitialChatMessages, ChatMessageFact{ID: fmt.Sprint(i), Sequence: i, ParticipantID: fixture.first.String(), DisplayName: "Alex", Text: "Hi", CreatedAt: fixture.source.CaptureReadyAt.Add(-time.Second)})
	}
	built, err := buildPresentation(fixture.source)
	if err != nil {
		t.Fatal(err)
	}
	if len(built.Timeline.Initial.Chat.Messages) != 100 || built.Timeline.Initial.Chat.Messages[0].Sequence != 31 {
		t.Fatalf("unexpected chat window: %+v", built.Timeline.Initial.Chat)
	}
}

func historyTestStroke(i int) json.RawMessage {
	return json.RawMessage(fmt.Sprintf(`{"id":"stroke-%d","type":"freedraw","version":1,"version_nonce":20,"index":"a%06d","is_deleted":false,"payload":{"points":[[0,0],[10,10]]}}`, i, i))
}

func TestWhiteboardHistoryKeepsFinalWinnerInLegacyDuplicateBatch(t *testing.T) {
	fixture := newParticipantBuilderFixture(t)
	setParticipantPlan(t, &fixture.source, 1, []captureplan.ParticipantSnapshot{activeParticipant(fixture.first, "Alex", 1)}, nil)
	fixture.source.WhiteboardStartRevision = 1
	fixture.source.WhiteboardOriginRevision = 1
	fixture.source.InitialWhiteboard = &WhiteboardSnapshotFact{SceneID: "scene-1", Revision: 1, Presenting: true, AppState: json.RawMessage(`{}`), Elements: []json.RawMessage{historyTestStroke(0)}}
	var element whiteboardElementWire
	if err := json.Unmarshal(historyTestStroke(0), &element); err != nil {
		t.Fatal(err)
	}
	var batch []json.RawMessage
	for _, version := range []int64{3, 2} {
		element.Version = version
		raw, err := json.Marshal(element)
		if err != nil {
			t.Fatal(err)
		}
		batch = append(batch, raw)
	}
	fixture.source.WhiteboardTailEvents = []WhiteboardEventFact{{OperationID: "legacy-duplicate", Name: "submit_update", SceneID: "scene-1", Revision: 2, Elements: batch, CompletedAt: fixture.source.CaptureReadyAt.Add(100 * time.Millisecond)}}
	built, err := buildPresentation(fixture.source)
	if err != nil {
		t.Fatal(err)
	}
	var history whiteboardHistoryWire
	if err := json.Unmarshal(built.Assets[0].Body, &history); err != nil {
		t.Fatal(err)
	}
	if len(history.Updates) != 1 || len(history.Updates[0].Elements) != 1 || history.Updates[0].Elements[0].Version != 3 {
		t.Fatalf("legacy winner regressed: %+v", history)
	}
}
