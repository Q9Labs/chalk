package episodediagnostics

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"testing"
	"time"
)

type semanticFixtureCheckpoint struct {
	Key                  string `json:"key"`
	Class                string `json:"class"`
	DisplayOrder         int    `json:"displayOrder"`
	Predicate            string `json:"predicate"`
	DeadlineAt           string `json:"deadlineAt"`
	DeadlineMilliseconds int64  `json:"deadlineMilliseconds"`
}

type semanticActionFixture struct {
	Operation   string                      `json:"operation"`
	Variant     string                      `json:"variant"`
	Checkpoints []semanticFixtureCheckpoint `json:"checkpoints"`
	Events      []DiagnosticEventDraft      `json:"events"`
}

type semanticFixtureSet struct {
	Fixtures map[string]semanticActionFixture `json:"fixtures"`
}

func TestCheckpointCatalogMatchesTypeScriptSemanticFixtures(t *testing.T) {
	fixture := loadSemanticFixtureSet(t)
	wantByOperation := make(map[string]semanticActionFixture, len(fixture.Fixtures))
	for _, action := range fixture.Fixtures {
		if action.Variant != "expectation" {
			continue
		}
		if _, exists := wantByOperation[action.Operation]; exists {
			t.Fatalf("duplicate expectation fixture for %s", action.Operation)
		}
		wantByOperation[action.Operation] = action
	}
	if got, want := len(wantByOperation), len(ActionOperationKeys); got != want {
		t.Fatalf("semantic fixture action count = %d, want %d", got, want)
	}

	for _, operation := range ActionOperationKeys {
		want, ok := wantByOperation[operation]
		if !ok {
			t.Fatalf("semantic fixture is missing %s", operation)
		}
		got := checkpointDetails(operation, nil)
		if len(got) != len(want.Checkpoints) {
			t.Fatalf("%s checkpoint count = %d, want %d", operation, len(got), len(want.Checkpoints))
		}
		for index, checkpoint := range got {
			fixtureCheckpoint := want.Checkpoints[index]
			if checkpoint.Key != fixtureCheckpoint.Key || string(checkpoint.Class) != fixtureCheckpoint.Class || checkpoint.DisplayOrder != fixtureCheckpoint.DisplayOrder || checkpoint.Predicate != fixtureCheckpoint.Predicate {
				t.Fatalf("%s checkpoint[%d] = %+v, want %+v", operation, index, checkpoint, fixtureCheckpoint)
			}
		}
	}
}

func TestCheckpointCatalogPreservesExpectationDeadlines(t *testing.T) {
	fixture := loadSemanticFixtureSet(t)
	for _, action := range fixture.Fixtures {
		if action.Variant != "expectation" {
			continue
		}
		for _, want := range action.Checkpoints {
			deadline, err := time.Parse(time.RFC3339Nano, want.DeadlineAt)
			if err != nil {
				t.Fatalf("%s checkpoint %q deadline %q: %v", action.Operation, want.Key, want.DeadlineAt, err)
			}
			got := checkpointDetails(action.Operation, &DiagnosticEventExpectation{
				Checkpoint:      want.Key,
				CheckpointClass: CheckpointClass(want.Class),
				DeadlineAt:      &deadline,
			})
			if want.DisplayOrder >= len(got) {
				t.Fatalf("%s checkpoint %q display order %d is out of range", action.Operation, want.Key, want.DisplayOrder)
			}
			checkpoint := got[want.DisplayOrder]
			if checkpoint.Key != want.Key {
				t.Fatalf("%s checkpoint at display order %d = %q, want %q", action.Operation, want.DisplayOrder, checkpoint.Key, want.Key)
			}
			if checkpoint.DeadlineAt == nil || !checkpoint.DeadlineAt.Equal(deadline) {
				t.Fatalf("%s checkpoint %q deadline = %v, want %v", action.Operation, want.Key, checkpoint.DeadlineAt, deadline)
			}
		}
	}
}

func TestSemanticFixturesValidateAndProjectAcrossAllActions(t *testing.T) {
	fixture := loadSemanticFixtureSet(t)
	fixtureIDs := make([]string, 0, len(fixture.Fixtures))
	for fixtureID := range fixture.Fixtures {
		fixtureIDs = append(fixtureIDs, fixtureID)
	}
	sort.Strings(fixtureIDs)

	for _, fixtureID := range fixtureIDs {
		action := fixture.Fixtures[fixtureID]
		t.Run(fixtureID, func(t *testing.T) {
			if len(action.Events) == 0 {
				t.Fatal("semantic fixture has no events")
			}
			accepted := make([]AcceptedDiagnosticEvent, 0, len(action.Events))
			for index, event := range action.Events {
				if event.Name != action.Operation {
					t.Fatalf("event[%d] name = %q, want %q", index, event.Name, action.Operation)
				}
				if event.Expectation == nil {
					t.Fatalf("event[%d] has no checkpoint expectation", index)
				}
				acceptedEvent, err := AcceptEvent(event, "fixture-diagnostic", int64(index+1), event.OccurredAt.Add(time.Second))
				if err != nil {
					t.Fatalf("accept event[%d]: %v", index, err)
				}
				accepted = append(accepted, acceptedEvent)
			}

			state, _, err := ProjectEvents(EpisodeDiagnostic{
				ID:               "fixture-diagnostic",
				Environment:      EnvironmentDevelopment,
				State:            DiagnosticLive,
				EpisodeStartedAt: action.Events[0].OccurredAt,
			}, accepted)
			if err != nil {
				t.Fatalf("project events: %v", err)
			}
			if got, want := len(state.Events), len(action.Events); got != want {
				t.Fatalf("projected event count = %d, want %d", got, want)
			}
			if got, want := len(state.Operations), 1; got != want {
				t.Fatalf("projected operation count = %d, want %d", got, want)
			}
			operation := state.Operations[operationIDFor(accepted[0])]
			assertFixtureCheckpoints(t, operation, action.Checkpoints)

			switch action.Variant {
			case "expectation":
				if operation.State != OperationRunning {
					t.Fatalf("expectation operation state = %s, want running", operation.State)
				}
			case "success":
				if action.Operation == "whiteboard.unsupported" {
					if operation.State != OperationStalled {
						t.Fatalf("unsupported success operation state = %s, want stalled", operation.State)
					}
					if len(openFixtureIssues(state)) == 0 {
						t.Fatal("unsupported success fixture did not retain a visibility issue")
					}
					break
				}
				if operation.State != OperationSucceeded {
					t.Fatalf("success operation state = %s, want succeeded", operation.State)
				}
				if issues := openFixtureIssues(state); len(issues) != 0 {
					t.Fatalf("success fixture opened issues: %+v", issues)
				}
				for index, checkpoint := range operation.Checkpoints {
					if checkpoint.State != CheckpointObserved {
						t.Fatalf("success checkpoint[%d] state = %s, want observed", index, checkpoint.State)
					}
					if checkpoint.EvidenceCursor == 0 {
						t.Fatalf("success checkpoint[%d] has no evidence cursor", index)
					}
				}
			case "failure_or_gap":
				if action.Operation == "whiteboard.unsupported" {
					if operation.State != OperationStalled {
						t.Fatalf("unsupported operation state = %s, want stalled", operation.State)
					}
				} else if operation.State != OperationFailed {
					t.Fatalf("failure operation state = %s, want failed", operation.State)
				}
				if len(openFixtureIssues(state)) == 0 {
					t.Fatal("failure fixture did not open an issue")
				}
			default:
				t.Fatalf("unknown fixture variant %q", action.Variant)
			}
		})
	}
}

func assertFixtureCheckpoints(t *testing.T, operation DiagnosticOperationDetail, want []semanticFixtureCheckpoint) {
	t.Helper()
	if len(operation.Checkpoints) != len(want) {
		t.Fatalf("checkpoint count = %d, want %d", len(operation.Checkpoints), len(want))
	}
	for index, checkpoint := range operation.Checkpoints {
		fixtureCheckpoint := want[index]
		if checkpoint.Key != fixtureCheckpoint.Key || string(checkpoint.Class) != fixtureCheckpoint.Class || checkpoint.DisplayOrder != fixtureCheckpoint.DisplayOrder || checkpoint.Predicate != fixtureCheckpoint.Predicate {
			t.Fatalf("checkpoint[%d] = %+v, want %+v", index, checkpoint, fixtureCheckpoint)
		}
	}
}

func openFixtureIssues(state ProjectionState) []DiagnosticIssueDetail {
	issues := make([]DiagnosticIssueDetail, 0)
	for _, issue := range state.Issues {
		if issue.State == IssueOpen {
			issues = append(issues, issue)
		}
	}
	return issues
}

func loadSemanticFixtureSet(t *testing.T) semanticFixtureSet {
	t.Helper()
	_, sourcePath, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	fixturePath := filepath.Join(filepath.Dir(sourcePath), "..", "..", "..", "..", "packages", "diagnostics-contracts", "fixtures", "semantic-events.v1.json")
	contents, err := os.ReadFile(fixturePath)
	if err != nil {
		t.Fatalf("read TypeScript semantic fixture %s: %v", fixturePath, err)
	}
	var fixture semanticFixtureSet
	if err := json.Unmarshal(contents, &fixture); err != nil {
		t.Fatalf("decode TypeScript semantic fixture: %v", err)
	}
	return fixture
}
