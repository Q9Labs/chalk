package episodediagnostics

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"
)

func contractBriefFixture(t *testing.T) AgentBriefV1 {
	t.Helper()
	captureTime, err := time.Parse(time.RFC3339Nano, "2026-08-04T00:00:00.000Z")
	if err != nil {
		t.Fatalf("parse contract fixture capture time: %v", err)
	}
	selectedCursor := int64(7)
	firstGapCursor := int64(6)
	return AgentBriefV1{
		SchemaVersion:    "AgentBrief/v1",
		Version:          1,
		Reference:        "chalkdiag:v1:development:diag01@7",
		FocusedReference: "chalkdiag:v1:development:diag01:issue:issue01@7",
		CaptureTime:      captureTime,
		SelectedCursor:   &selectedCursor,
		ObservedSummary:  "Chat send stalled at sender receipt.",
		Environment:      EnvironmentDevelopment,
		ResolverCommand:  "pnpm trace:inspect chalkdiag:v1:development:diag01:issue:issue01@7 --format agent",
		ReleaseCommits:   []AgentBriefRelease{{Release: "dev-2026.08.04", SourceCommit: "abc123"}},
		VisibleGaps:      []AgentBriefGap{{Kind: "checkpoint", Summary: "Sender receipt was not observable.", Reason: "not_observable", FirstCursor: &firstGapCursor}},
		Counts:           map[string]int64{"events": 7, "operations": 1, "issues": 1},
		Omissions:        []string{"raw chat text", "raw provider payloads"},
	}
}

func TestRenderAgentBriefMarkdownMatchesContractFixtureRenderer(t *testing.T) {
	brief := contractBriefFixture(t)
	got := RenderAgentBriefMarkdown(brief)
	want := strings.Join([]string{
		"# Chalk Diagnostic Brief",
		"",
		"- Schema: AgentBrief/v1",
		"- Reference: chalkdiag:v1:development:diag01@7",
		"- Focus: chalkdiag:v1:development:diag01:issue:issue01@7",
		"- Environment: development",
		"- Captured: 2026-08-04T00:00:00.000Z",
		"- Cursor: 7",
		"",
		"Observed: Chat send stalled at sender receipt.",
		"",
		"## Release",
		"- dev-2026.08.04: abc123",
		"",
		"## Gaps",
		"- checkpoint: Sender receipt was not observable. (not_observable)",
		"",
		"## Counts",
		"- events: 7",
		"- issues: 1",
		"- operations: 1",
		"",
		"## Omissions",
		"- raw chat text",
		"- raw provider payloads",
		"",
		"Resolver: `pnpm trace:inspect chalkdiag:v1:development:diag01:issue:issue01@7 --format agent`",
	}, "\n")
	if got != want {
		t.Fatalf("Markdown renderer drifted from diagnostics-contracts fixture renderer:\n--- got ---\n%s\n--- want ---\n%s", got, want)
	}
}

func TestBuildAgentBriefBoundsCollectionsAndRetainsSafeOmissions(t *testing.T) {
	const itemCount = maxBriefItems + 40
	startedAt := time.Date(2026, 8, 4, 0, 0, 0, 0, time.UTC)
	snapshot := DiagnosticSnapshotV1{
		SchemaVersion:   "DiagnosticSnapshot/v1",
		Reference:       "chalkdiag:v1:development:diag01@130",
		Environment:     EnvironmentDevelopment,
		State:           DiagnosticLive,
		CapturedAt:      startedAt,
		CommittedCursor: itemCount,
		ProjectedCursor: itemCount,
		Summary:         DiagnosticSummary{EventCount: itemCount, OperationCount: itemCount, IssueCount: itemCount, OpenIssueCount: itemCount, ParticipantCount: 2},
	}
	for index := 0; index < itemCount; index++ {
		id := fmt.Sprintf("%03d", index)
		snapshot.Operations = append(snapshot.Operations, DiagnosticOperationDetail{
			SchemaVersion:      "OperationDetail/v1",
			ID:                 "op-" + id,
			Kind:               "chat.send",
			ExpectationVersion: 1,
			State:              OperationRunning,
			StartedAt:          startedAt,
			Checkpoints:        []DiagnosticCheckpointDetail{{Key: "intent", Class: CheckpointRequired, State: CheckpointPending}},
			Source:             SourceSDK,
			ReleaseID:          "release-" + id,
			SourceCommit:       "commit-" + id,
			VisibilityGaps:     []string{"gap-" + id},
		})
		snapshot.Issues = append(snapshot.Issues, DiagnosticIssueDetail{
			ID:              "issue-" + id,
			Kind:            "checkpoint",
			Severity:        IssueWarning,
			State:           IssueOpen,
			Summary:         "issue " + id,
			FirstObservedAt: startedAt,
		})
		snapshot.Branches = append(snapshot.Branches, DiagnosticBranchDetail{
			ID:          "branch-" + id,
			Kind:        BranchCleanup,
			State:       BranchPending,
			LeaseEndsAt: startedAt.Add(time.Hour),
		})
	}
	cursor := int64(130)
	brief := BuildAgentBrief(snapshot, DiagnosticReference{Version: 1, Environment: EnvironmentDevelopment, DiagnosticID: "diag01", Cursor: &cursor}, startedAt)

	if len(brief.Operations) != maxBriefItems || len(brief.Issues) != maxBriefItems || len(brief.Branches) != maxBriefItems {
		t.Fatalf("brief detail bounds drifted: operations=%d issues=%d branches=%d", len(brief.Operations), len(brief.Issues), len(brief.Branches))
	}
	if len(brief.VisibleGaps) != maxBriefGaps {
		t.Fatalf("visible gap bound = %d, want %d", len(brief.VisibleGaps), maxBriefGaps)
	}
	if len(brief.ReleaseCommits) != 128 {
		t.Fatalf("release bound = %d, want 128", len(brief.ReleaseCommits))
	}
	if len(brief.Omissions) != 3 {
		t.Fatalf("omissions were not unique and bounded: %+v", brief.Omissions)
	}
	if brief.Counts["events"] != itemCount || brief.Counts["participants"] != 2 {
		t.Fatalf("brief counts lost summary values: %+v", brief.Counts)
	}
	if err := ValidateAgentBrief(brief); err != nil {
		t.Fatalf("bounded brief failed contract validation: %v", err)
	}
}

func TestServiceBriefReturnsValidatedMarkdownResponse(t *testing.T) {
	briefSnapshot := DiagnosticSnapshotV1{
		SchemaVersion:   "DiagnosticSnapshot/v1",
		Reference:       serviceReference(),
		Environment:     EnvironmentDevelopment,
		State:           DiagnosticLive,
		CapturedAt:      time.Date(2026, 8, 4, 0, 0, 0, 0, time.UTC),
		CommittedCursor: 7,
		ProjectedCursor: 7,
		Summary:         DiagnosticSummary{EventCount: 7, OperationCount: 1, IssueCount: 1, OpenIssueCount: 1},
	}
	repository := &repositoryStub{
		resolveFn: func(_ context.Context, _ DiagnosticReference) (EpisodeDiagnostic, error) {
			return serviceDiagnosticFixture(), nil
		},
		readSnapshotFn: func(_ context.Context, _ EpisodeDiagnostic, _ DiagnosticFilterV1, _ int) (DiagnosticSnapshotV1, error) {
			return briefSnapshot, nil
		},
	}
	service := NewService(repository, EnvironmentDevelopment, nil, &auditWriterStub{}, nil)
	response, err := service.Brief(context.Background(), serviceOperator(), serviceReference(), "markdown", 0, "")
	if err != nil {
		t.Fatalf("service brief: %v", err)
	}
	if response.SchemaVersion != "AgentBriefResponse/v1" || response.Format != "markdown" || response.Markdown != RenderAgentBriefMarkdown(response.Brief) {
		t.Fatalf("unexpected AgentBrief response envelope: %+v", response)
	}
	if err := ValidateAgentBrief(response.Brief); err != nil {
		t.Fatalf("service brief failed contract validation: %v", err)
	}
}

func TestServiceBriefNarrowsAroundCursorAndBranch(t *testing.T) {
	observedAt := time.Date(2026, 8, 4, 12, 0, 0, 0, time.UTC)
	branchID := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	matchingOperationID := "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	repository := &repositoryStub{
		resolveFn: func(_ context.Context, _ DiagnosticReference) (EpisodeDiagnostic, error) {
			return serviceDiagnosticFixture(), nil
		},
		pageEventsFn: func(_ context.Context, _ EpisodeDiagnostic, _ DiagnosticFilterV1, after, before *int64, limit int) (DiagnosticEventPageV1, error) {
			if after == nil || *after != 9 || before == nil || *before != 11 || limit != 1 {
				t.Fatalf("unexpected cursor window: after=%v before=%v limit=%d", after, before, limit)
			}
			return DiagnosticEventPageV1{Events: []AcceptedDiagnosticEvent{{DiagnosticEventDraft: DiagnosticEventDraft{OccurredAt: observedAt}, Cursor: 10}}}, nil
		},
		readSnapshotFn: func(_ context.Context, _ EpisodeDiagnostic, filter DiagnosticFilterV1, _ int) (DiagnosticSnapshotV1, error) {
			if !filter.FromTime.Equal(observedAt.Add(-30*time.Second)) || !filter.ToTime.Equal(observedAt.Add(30*time.Second)) {
				t.Fatalf("unexpected around filter: %+v", filter)
			}
			return DiagnosticSnapshotV1{
				Reference: serviceReference(), Environment: EnvironmentDevelopment, State: DiagnosticEnded, CapturedAt: observedAt,
				Operations: []DiagnosticOperationDetail{{ID: matchingOperationID, BranchID: branchID}, {ID: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", BranchID: "other"}},
				Issues:     []DiagnosticIssueDetail{{ID: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", OperationID: matchingOperationID, State: IssueOpen}, {ID: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", OperationID: "other", State: IssueOpen}},
				Branches:   []DiagnosticBranchDetail{{ID: branchID}, {ID: "ffffffff-ffff-4fff-8fff-ffffffffffff"}},
			}, nil
		},
	}
	service := NewService(repository, EnvironmentDevelopment, nil, &auditWriterStub{}, nil)
	response, err := service.Brief(context.Background(), serviceOperator(), serviceReference()+"@10", "compact", 30, branchID)
	if err != nil {
		t.Fatalf("service brief: %v", err)
	}
	if len(response.Brief.Operations) != 1 || response.Brief.Operations[0].ID != matchingOperationID || len(response.Brief.Issues) != 1 || len(response.Brief.Branches) != 1 {
		t.Fatalf("brief was not narrowed to branch: %+v", response.Brief)
	}
	joined := strings.Join(response.Brief.Omissions, " ")
	if !strings.Contains(joined, "30 seconds around cursor 10") || !strings.Contains(joined, branchID) {
		t.Fatalf("selection omissions missing: %v", response.Brief.Omissions)
	}
}
