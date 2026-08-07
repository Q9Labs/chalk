package episodediagnostics

import (
	"fmt"
	"sort"
	"strings"
	"time"
)

const (
	maxBriefItems = 100
	maxBriefGaps  = 64
)

func BuildAgentBrief(snapshot DiagnosticSnapshotV1, reference DiagnosticReference, now time.Time) AgentBriefV1 {
	focusedReference, _ := FormatReference(reference)
	base := reference
	base.Focus = nil
	base.Cursor = nil
	baseReference, _ := FormatReference(base)
	selectedCursor := reference.Cursor
	if selectedCursor == nil {
		cursor := snapshot.ProjectedCursor
		selectedCursor = &cursor
	}

	operationCount := snapshot.Summary.OperationCount
	if operationCount == 0 {
		operationCount = int64(len(snapshot.Operations))
	}
	issueCount := snapshot.Summary.IssueCount
	if issueCount == 0 {
		issueCount = int64(len(snapshot.Issues))
	}
	openIssues := snapshot.Summary.OpenIssueCount
	if openIssues == 0 {
		for _, issue := range snapshot.Issues {
			if issue.State == IssueOpen {
				openIssues++
			}
		}
	}
	gaps := briefGaps(snapshot)
	omissions := []string{
		"Diagnostic output never includes chat text, names, credentials, raw protocol payloads, media frames, or provider-private work.",
		"This brief is a bounded projection; use the resolver command for retained event evidence.",
	}
	if len(gaps) > 0 {
		omissions = append(omissions, "Missing upstream observations are reported as visibility gaps, not success.")
	}
	omissions = append(omissions, snapshot.Omissions...)

	brief := AgentBriefV1{
		SchemaVersion:   "AgentBrief/v1",
		Version:         1,
		Reference:       baseReference,
		CaptureTime:     snapshot.CapturedAt,
		SelectedCursor:  selectedCursor,
		RunEndCursor:    snapshot.RunEndCursor,
		ObservedSummary: fmt.Sprintf("%s Episode Diagnostic with %d operation%s, %d open issue%s, and %d retained Event%s.", snapshot.State, operationCount, plural(operationCount), openIssues, plural(openIssues), snapshot.Summary.EventCount, plural(snapshot.Summary.EventCount)),
		Environment:     snapshot.Environment,
		ResolverCommand: fmt.Sprintf("pnpm trace:inspect %s --format agent", focusedReference),
		ReleaseCommits:  briefReleases(snapshot.Operations),
		VisibleGaps:     gaps,
		EpisodeSummary:  fmt.Sprintf("Projection cursor %d of %d committed; %d participant%s and %d epilogue branch%s are visible.", snapshot.ProjectedCursor, snapshot.CommittedCursor, snapshot.Summary.ParticipantCount, plural(snapshot.Summary.ParticipantCount), len(snapshot.Branches), plural(int64(len(snapshot.Branches)))),
		Issues:          boundedIssues(snapshot.Issues),
		Operations:      boundedOperations(snapshot.Operations),
		Branches:        boundedBranches(snapshot.Branches),
		Counts: map[string]int64{
			"events":       snapshot.Summary.EventCount,
			"operations":   operationCount,
			"issues":       issueCount,
			"openIssues":   openIssues,
			"branches":     int64(len(snapshot.Branches)),
			"participants": snapshot.Summary.ParticipantCount,
		},
		Omissions: uniqueStrings(omissions),
	}
	if reference.Focus != nil {
		brief.FocusedReference = focusedReference
	}
	if brief.CaptureTime.IsZero() {
		brief.CaptureTime = now.UTC()
	}
	return brief
}

func RenderAgentBriefMarkdown(brief AgentBriefV1) string {
	lines := []string{"# Chalk Diagnostic Brief", "", "- Schema: " + brief.SchemaVersion, "- Reference: " + brief.Reference}
	if brief.FocusedReference != "" {
		lines = append(lines, "- Focus: "+brief.FocusedReference)
	}
	lines = append(lines, "- Environment: "+string(brief.Environment), "- Captured: "+brief.CaptureTime.UTC().Format("2006-01-02T15:04:05.000Z"))
	if brief.SelectedCursor != nil {
		lines = append(lines, fmt.Sprintf("- Cursor: %d", *brief.SelectedCursor))
	}
	if brief.RunEndCursor != nil {
		lines = append(lines, fmt.Sprintf("- Run end cursor: %d", *brief.RunEndCursor))
	}
	lines = append(lines, "", "Observed: "+brief.ObservedSummary, "", "## Release")
	for _, release := range brief.ReleaseCommits {
		commit := release.SourceCommit
		if commit == "" {
			reason := release.UnknownReason
			if reason == "" {
				reason = UnknownNotAvailable
			}
			commit = fmt.Sprintf("unknown (%s)", reason)
		}
		lines = append(lines, fmt.Sprintf("- %s: %s", release.Release, commit))
	}
	lines = append(lines, "", "## Gaps")
	if len(brief.VisibleGaps) == 0 {
		lines = append(lines, "- None observed")
	} else {
		for _, gap := range brief.VisibleGaps {
			lines = append(lines, fmt.Sprintf("- %s: %s (%s)", gap.Kind, gap.Summary, gap.Reason))
		}
	}
	lines = append(lines, "", "## Counts")
	keys := make([]string, 0, len(brief.Counts))
	for key := range brief.Counts {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		lines = append(lines, fmt.Sprintf("- %s: %d", key, brief.Counts[key]))
	}
	lines = append(lines, "", "## Omissions")
	if len(brief.Omissions) == 0 {
		lines = append(lines, "- None")
	} else {
		for _, omission := range brief.Omissions {
			lines = append(lines, "- "+omission)
		}
	}
	lines = append(lines, "", fmt.Sprintf("Resolver: `%s`", brief.ResolverCommand))
	return strings.Join(lines, "\n")
}

func briefReleases(operations []DiagnosticOperationDetail) []AgentBriefRelease {
	seen := make(map[string]struct{})
	result := make([]AgentBriefRelease, 0)
	for _, operation := range operations {
		if operation.ReleaseID == "" {
			continue
		}
		key := operation.ReleaseID + "\x00" + operation.SourceCommit
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, AgentBriefRelease{Release: operation.ReleaseID, SourceCommit: operation.SourceCommit})
		if len(result) == 128 {
			break
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Release < result[j].Release })
	return result
}

func briefGaps(snapshot DiagnosticSnapshotV1) []AgentBriefGap {
	result := make([]AgentBriefGap, 0)
	seen := make(map[string]struct{})
	add := func(kind, summary, reason string) {
		if len(result) >= maxBriefGaps {
			return
		}
		key := kind + "\x00" + summary + "\x00" + reason
		if _, ok := seen[key]; ok {
			return
		}
		seen[key] = struct{}{}
		result = append(result, AgentBriefGap{Kind: kind, Summary: summary, Reason: reason})
	}
	for _, operation := range snapshot.Operations {
		for _, gap := range operation.VisibilityGaps {
			add("operation", gap, string(UnknownNotObservable))
		}
	}
	for _, issue := range snapshot.Issues {
		if issue.UnknownReason != "" {
			add("issue", issue.Summary, string(issue.UnknownReason))
		}
	}
	return result
}

func boundedOperations(values []DiagnosticOperationDetail) []DiagnosticOperationDetail {
	if len(values) > maxBriefItems {
		values = values[:maxBriefItems]
	}
	return append([]DiagnosticOperationDetail(nil), values...)
}

func boundedIssues(values []DiagnosticIssueDetail) []DiagnosticIssueDetail {
	if len(values) > maxBriefItems {
		values = values[:maxBriefItems]
	}
	return append([]DiagnosticIssueDetail(nil), values...)
}

func boundedBranches(values []DiagnosticBranchDetail) []DiagnosticBranchDetail {
	if len(values) > maxBriefItems {
		values = values[:maxBriefItems]
	}
	return append([]DiagnosticBranchDetail(nil), values...)
}

func plural(value int64) string {
	if value == 1 {
		return ""
	}
	return "s"
}

func uniqueStrings(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}
