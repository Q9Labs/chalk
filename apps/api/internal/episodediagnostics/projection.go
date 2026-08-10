package episodediagnostics

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
)

const DefaultGracePeriod = 30 * time.Second

func timePtr(value time.Time) *time.Time { value = value.UTC(); return &value }
func int64Ptr(value int64) *int64        { return &value }

type ProjectionState struct {
	Diagnostic        EpisodeDiagnostic
	Events            map[string]AcceptedDiagnosticEvent
	EventFingerprints map[string]string
	Operations        map[string]DiagnosticOperationDetail
	OperationRefs     map[string]string
	ParentRefs        map[string]string
	Issues            map[string]DiagnosticIssueDetail
	Branches          map[string]DiagnosticBranchDetail
	Participants      map[string]ParticipantProjectionV1
	LastAppliedCursor int64
}

type ProjectionDelta struct {
	Cursor     int64
	Events     []AcceptedDiagnosticEvent
	Operations []DiagnosticOperationDetail
	Issues     []DiagnosticIssueDetail
	Branches   []DiagnosticBranchDetail
	Snapshot   *DiagnosticSnapshotV1
}

func NewProjectionState(diagnostic EpisodeDiagnostic) ProjectionState {
	if diagnostic.State == "" {
		diagnostic.State = DiagnosticLive
	}
	return ProjectionState{
		Diagnostic: diagnostic,
		Events:     make(map[string]AcceptedDiagnosticEvent), EventFingerprints: make(map[string]string),
		Operations: make(map[string]DiagnosticOperationDetail), OperationRefs: make(map[string]string), ParentRefs: make(map[string]string),
		Issues: make(map[string]DiagnosticIssueDetail), Branches: make(map[string]DiagnosticBranchDetail), Participants: make(map[string]ParticipantProjectionV1),
	}
}

func (state ProjectionState) Clone() ProjectionState {
	copy := NewProjectionState(state.Diagnostic)
	copy.LastAppliedCursor = state.LastAppliedCursor
	for key, value := range state.Events {
		copy.Events[key] = value
	}
	for key, value := range state.EventFingerprints {
		copy.EventFingerprints[key] = value
	}
	for key, value := range state.Operations {
		value.Checkpoints = append([]DiagnosticCheckpointDetail(nil), value.Checkpoints...)
		value.VisibilityGaps = append([]string(nil), value.VisibilityGaps...)
		copy.Operations[key] = value
	}
	for key, value := range state.OperationRefs {
		copy.OperationRefs[key] = value
	}
	for key, value := range state.ParentRefs {
		copy.ParentRefs[key] = value
	}
	for key, value := range state.Issues {
		copy.Issues[key] = value
	}
	for key, value := range state.Branches {
		value.FanInChildren = append([]string(nil), value.FanInChildren...)
		copy.Branches[key] = value
	}
	for key, value := range state.Participants {
		value.VisibilityGaps = append([]string(nil), value.VisibilityGaps...)
		copy.Participants[key] = value
	}
	return copy
}

// ReduceProjection is a pure reducer. It clones the supplied state, sorts a
// batch by durable cursor, and applies each semantic Event at most once.
func ReduceProjection(state ProjectionState, events []AcceptedDiagnosticEvent) (ProjectionState, error) {
	result := state.Clone()
	if result.Events == nil {
		result = NewProjectionState(state.Diagnostic)
	}
	sortedEvents := append([]AcceptedDiagnosticEvent(nil), events...)
	sort.SliceStable(sortedEvents, func(left, right int) bool {
		if sortedEvents[left].Cursor != sortedEvents[right].Cursor {
			return sortedEvents[left].Cursor < sortedEvents[right].Cursor
		}
		return sortedEvents[left].EventID < sortedEvents[right].EventID
	})
	for _, event := range sortedEvents {
		if err := applyAcceptedEvent(&result, event, nil); err != nil {
			return ProjectionState{}, err
		}
	}
	resolveParentRefs(&result)
	return result, nil
}

// ApplyEvents mutates a caller-owned state and returns bounded projection
// changes suitable for a stream delta.
func ApplyEvents(state *ProjectionState, events []AcceptedDiagnosticEvent) (ProjectionDelta, error) {
	if state == nil {
		return ProjectionDelta{}, errors.New("projection state is nil")
	}
	result, err := ReduceProjection(*state, events)
	if err != nil {
		return ProjectionDelta{}, err
	}
	delta := ProjectionDelta{Cursor: result.Diagnostic.ProjectedCursor}
	for _, event := range events {
		if existing, ok := result.Events[event.EventID]; ok && existing.Cursor >= event.Cursor {
			delta.Events = append(delta.Events, existing)
		}
	}
	for _, operation := range result.Operations {
		delta.Operations = append(delta.Operations, operation)
	}
	for _, issue := range result.Issues {
		delta.Issues = append(delta.Issues, issue)
	}
	for _, branch := range result.Branches {
		delta.Branches = append(delta.Branches, branch)
	}
	sort.Slice(delta.Operations, func(left, right int) bool { return delta.Operations[left].ID < delta.Operations[right].ID })
	sort.Slice(delta.Issues, func(left, right int) bool { return delta.Issues[left].ID < delta.Issues[right].ID })
	sort.Slice(delta.Branches, func(left, right int) bool { return delta.Branches[left].ID < delta.Branches[right].ID })
	*state = result
	return delta, nil
}

func ApplyDiagnosticEvents(state *ProjectionState, events []AcceptedDiagnosticEvent) (ProjectionDelta, error) {
	return ApplyEvents(state, events)
}

func ProjectEvents(diagnostic EpisodeDiagnostic, events []AcceptedDiagnosticEvent) (ProjectionState, ProjectionDelta, error) {
	state := NewProjectionState(diagnostic)
	delta, err := ApplyEvents(&state, events)
	return state, delta, err
}

func (state *ProjectionState) Reduce(events []AcceptedDiagnosticEvent) error {
	result, err := ReduceProjection(*state, events)
	if err == nil {
		*state = result
	}
	return err
}

func eventFingerprint(event AcceptedDiagnosticEvent) (string, error) {
	if event.Fingerprint != "" {
		return event.Fingerprint, nil
	}
	return FingerprintEvent(event.DiagnosticEventDraft)
}

func applyAcceptedEvent(state *ProjectionState, event AcceptedDiagnosticEvent, delta *ProjectionDelta) error {
	fingerprint, err := eventFingerprint(event)
	if err != nil {
		return err
	}
	if previous, exists := state.EventFingerprints[event.EventID]; exists {
		if previous != fingerprint {
			return fmt.Errorf("event %q was accepted with a different fingerprint", event.EventID)
		}
		return nil
	}
	if err := ValidateAcceptedEvent(event); err != nil {
		return err
	}
	state.Events[event.EventID] = event
	state.EventFingerprints[event.EventID] = fingerprint
	if event.Cursor > state.Diagnostic.CommittedCursor {
		state.Diagnostic.CommittedCursor = event.Cursor
	}
	if event.Cursor > state.Diagnostic.ProjectedCursor {
		state.Diagnostic.ProjectedCursor = event.Cursor
	}
	if event.Cursor > state.LastAppliedCursor {
		state.LastAppliedCursor = event.Cursor
	}
	if delta != nil {
		delta.Cursor = event.Cursor
		delta.Events = append(delta.Events, event)
	}

	// A worker-generated branch terminal event is a branch ledger mutation, not
	// a new operation. Resolve and update the existing branch before the normal
	// operation reducer so a deadline scan cannot mint an orphan operation.
	if (event.Name == "branch.ended" || isSyntheticBranchDeadlineEvent(event)) && branchIDFor(event) != "" {
		branchID := branchIDFor(event)
		branch, exists := state.Branches[branchID]
		if !exists {
			// Branch slots are materialized before the episode ends. A late
			// terminal marker must never create a new slot.
			return nil
		}
		applyBranchEvent(&branch, event)
		state.Branches[branch.ID] = branch
		if delta != nil {
			delta.Branches = append(delta.Branches, branch)
		}
		return nil
	}

	operationID := operationIDFor(event)
	operation := ensureOperation(state, operationID, event)
	if event.ParentProducerOperationRef != "" {
		state.ParentRefs[operation.ID] = event.ParentProducerOperationRef
		if parentID := state.OperationRefs[event.ParentProducerOperationRef]; parentID != "" {
			operation.ParentID = parentID
		}
	}
	if event.ProducerOperationRef != "" {
		state.OperationRefs[event.ProducerOperationRef] = operation.ID
	}
	applyOperationEvent(state, &operation, event)
	state.Operations[operation.ID] = operation
	if delta != nil {
		delta.Operations = append(delta.Operations, operation)
	}

	if branchID := branchIDFor(event); branchID != "" {
		if _, exists := state.Branches[branchID]; !exists && state.Diagnostic.EpisodeEndedAt != nil {
			// Branch slots are authorized before the Episode ends. A callback
			// cannot mint a new slot after that authoritative boundary.
			recordUnregisteredBranchIssue(state, operation, event)
			return nil
		}
		if _, exists := state.Branches[branchID]; !exists && len(state.Branches) >= MaxSnapshotBranches {
			recordUnregisteredBranchIssue(state, operation, event)
			return nil
		}
		branch := ensureBranch(state, branchID, event)
		operation.BranchID = branch.ID
		state.Operations[operation.ID] = operation
		applyBranchEvent(&branch, event)
		state.Branches[branch.ID] = branch
		if delta != nil {
			delta.Branches = append(delta.Branches, branch)
		}
	}
	return nil
}

func recordUnregisteredBranchIssue(state *ProjectionState, operation DiagnosticOperationDetail, event AcceptedDiagnosticEvent) {
	id := issueID(operation.ID, "branch_unregistered", "")
	if existing, ok := state.Issues[id]; ok {
		if existing.LastObservedAt == nil || event.OccurredAt.After(*existing.LastObservedAt) {
			existing.LastObservedAt = timePtr(event.OccurredAt)
		}
		existing.Affected = affectedSubjectForEvent(event)
		state.Issues[id] = existing
		return
	}
	state.Issues[id] = DiagnosticIssueDetail{
		SchemaVersion: "IssueDetail/v1", ID: id, OperationID: operation.ID,
		Affected: affectedSubjectForEvent(event), Kind: "branch_unregistered", Severity: IssueWarning,
		State: IssueOpen, Summary: "Epilogue callback arrived without an authorized branch slot.",
		FirstObservedAt: event.OccurredAt, LastObservedAt: timePtr(event.OccurredAt), UnknownReason: UnknownNotAvailable,
	}
}

func resolveParentRefs(state *ProjectionState) {
	for operationID, parentRef := range state.ParentRefs {
		parentID := state.OperationRefs[parentRef]
		if parentID == "" || parentID == operationID {
			continue
		}
		operation := state.Operations[operationID]
		operation.ParentID = parentID
		state.Operations[operationID] = operation
	}
}

func operationIDFor(event AcceptedDiagnosticEvent) string {
	if event.OperationID != "" {
		return event.OperationID
	}
	key := event.EventID
	if event.ProducerOperationRef != "" {
		key = event.ProducerOperationRef
	}
	return deterministicUUID("operation", key)
}

func deterministicUUID(namespace, value string) string {
	digest := sha256.Sum256([]byte(namespace + "|" + value))
	digest[6] = (digest[6] & 0x0f) | 0x50
	digest[8] = (digest[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", digest[0:4], digest[4:6], digest[6:8], digest[8:10], digest[10:16])
}

func operationKind(eventName string) string {
	best := ""
	for _, root := range ActionOperationKeys {
		if eventName == root || strings.HasPrefix(eventName, root+".") {
			if len(root) > len(best) {
				best = root
			}
		}
	}
	if best != "" {
		return best
	}
	if index := strings.LastIndex(eventName, "."); index > 0 {
		return eventName[:index]
	}
	return eventName
}

func ensureOperation(state *ProjectionState, operationID string, event AcceptedDiagnosticEvent) DiagnosticOperationDetail {
	if existing, ok := state.Operations[operationID]; ok {
		if existing.ParticipantID == "" {
			existing.ParticipantID = event.ParticipantID
		}
		return existing
	}
	kind := operationKind(event.Name)
	expectationVersion := 1
	if event.Expectation != nil && event.Expectation.Version > 0 {
		expectationVersion = event.Expectation.Version
	}
	operation := DiagnosticOperationDetail{SchemaVersion: "OperationDetail/v1", ID: operationID, Kind: kind, ExpectationVersion: expectationVersion, State: OperationRunning, Attempt: 0, StartedAt: event.OccurredAt, FirstEvidenceCursor: event.Cursor, ParticipantID: event.ParticipantID, Checkpoints: checkpointDetails(kind, event.Expectation), Source: event.Source}
	if event.Correlation != nil {
		operation.RetryGroup = safeIdentifier("chalk.retry", event.Correlation.RetryGroupRef)
		operation.Attempt = int(event.Correlation.Attempt)
		operation.RequestID = safeIdentifier("chalk.request", event.Correlation.RequestID)
		operation.CommandID = safeIdentifier("chalk.command", event.Correlation.CommandID)
		operation.ProviderID = safeIdentifier("provider", event.Correlation.ProviderID)
		operation.ProviderLookupID = event.Correlation.ProviderID
		operation.JourneyID = safeIdentifier("chalk.journey", event.Correlation.JourneyID)
		operation.TraceID = safeIdentifier("w3c.trace", event.Correlation.TraceID)
		operation.SpanID = safeIdentifier("w3c.span", event.Correlation.SpanID)
	}
	if event.Release != nil {
		operation.ReleaseID = event.Release.ID
		operation.SourceCommit = event.Release.SourceCommit
	}
	recomputeOperationDeadline(&operation)
	return operation
}

func checkpointForEvent(operation DiagnosticOperationDetail, event AcceptedDiagnosticEvent) int {
	key := ""
	if event.Expectation != nil && !(event.Phase == "intent" && event.State == EventStarted) {
		key = event.Expectation.Checkpoint
	}
	if key == "" {
		key = checkpointKeyForPhase(event.Phase, operation.Checkpoints)
	}
	if key == "" {
		if event.State == EventStarted {
			key = "intent"
		} else if event.State == EventSucceeded || event.State == EventFailed || event.State == EventCancelled || event.State == EventTimedOut {
			key = "terminal"
		}
	}
	for index, checkpoint := range operation.Checkpoints {
		if checkpoint.Key == key {
			return index
		}
	}
	return -1
}

func checkpointKeyForPhase(phase string, checkpoints []DiagnosticCheckpointDetail) string {
	mapped := map[string]string{"intent": "intent", "validation": "validation", "authorized": "authorization", "denied": "capability_decision", "committed": "durable_commit", "receipt": "sender_receipt", "paged": "paging_visibility", "projected": "recipient_projection", "first_frame": "remote_first_frame", "permission": "permission", "acquired": "track_acquisition", "published": "sfu_publication", "subscribed": "remote_subscription", "unsupported": "unsupported", "expired": "server_expiry", "delivered": "target_delivery", "finalized": "terminal"}
	if key := mapped[phase]; key != "" {
		for _, checkpoint := range checkpoints {
			if checkpoint.Key == key {
				return key
			}
		}
	}
	for _, checkpoint := range checkpoints {
		if checkpoint.Key == phase {
			return phase
		}
	}
	return ""
}

func applyOperationEvent(state *ProjectionState, operation *DiagnosticOperationDetail, event AcceptedDiagnosticEvent) {
	if operation.StartedAt.IsZero() || event.OccurredAt.Before(operation.StartedAt) {
		operation.StartedAt = event.OccurredAt
	}
	if event.Release != nil {
		operation.ReleaseID = event.Release.ID
		operation.SourceCommit = event.Release.SourceCommit
	}
	if event.Correlation != nil {
		operation.Attempt = int(event.Correlation.Attempt)
		if event.Correlation.RetryGroupRef != "" {
			operation.RetryGroup = safeIdentifier("chalk.retry", event.Correlation.RetryGroupRef)
		}
		operation.RequestID = safeIdentifier("chalk.request", event.Correlation.RequestID)
		operation.CommandID = safeIdentifier("chalk.command", event.Correlation.CommandID)
		operation.ProviderID = safeIdentifier("provider", event.Correlation.ProviderID)
		if event.Correlation.ProviderID != "" {
			operation.ProviderLookupID = event.Correlation.ProviderID
		}
		operation.JourneyID = safeIdentifier("chalk.journey", event.Correlation.JourneyID)
		operation.TraceID = safeIdentifier("w3c.trace", event.Correlation.TraceID)
		operation.SpanID = safeIdentifier("w3c.span", event.Correlation.SpanID)
	}
	index := checkpointForEvent(*operation, event)
	if index >= 0 {
		checkpoint := &operation.Checkpoints[index]
		checkpoint.EvidenceCursor = event.Cursor
		switch event.State {
		case EventStarted, EventObserved, EventSucceeded:
			checkpoint.State = CheckpointObserved
		case EventNotObservable:
			checkpoint.State = CheckpointNotObservable
			checkpoint.UnknownReason = UnknownNotObservable
		case EventLateObserved:
			checkpoint.State = CheckpointLateObserved
		default:
			checkpoint.State = CheckpointMissed
		}
		if checkpoint.State == CheckpointObserved || checkpoint.State == CheckpointLateObserved {
			resolveCheckpointIssues(state, operation.ID, checkpoint.Key, event.OccurredAt)
		} else {
			openCheckpointIssue(state, *operation, *checkpoint, event)
		}
	}
	if event.Name == "checkpoint.missed" && event.State == EventTimedOut {
		operation.State = OperationStalled
		deadline := operation.DeadlineAt
		if event.Expectation != nil && event.Expectation.DeadlineAt != nil {
			deadline = timePtr(event.Expectation.DeadlineAt.UTC())
		}
		if deadline != nil {
			operation.DeadlineAt = deadline
			graceEnds := deadline.Add(DefaultGracePeriod)
			operation.GraceEndsAt = timePtr(graceEnds)
		}
		operation.EndedAt = nil
		return
	}
	switch event.State {
	case EventStarted, EventObserved:
		if operation.State == "" || operation.State == OperationSucceeded {
			operation.State = OperationRunning
		}
	case EventSucceeded:
		if allRequiredObserved(operation.Checkpoints) {
			operation.State = OperationSucceeded
			operation.EndedAt = timePtr(event.OccurredAt)
			operation.DurationMilliseconds = durationMilliseconds(operation.StartedAt, event.OccurredAt)
			resolveOperationIssues(state, operation.ID, event.OccurredAt)
		}
	case EventFailed:
		operation.State = OperationFailed
		operation.EndedAt = timePtr(event.OccurredAt)
		operation.ErrorClass = eventAttributeString(event, "reason", "failed")
		operation.DurationMilliseconds = durationMilliseconds(operation.StartedAt, event.OccurredAt)
		openOperationIssue(state, *operation, "operation_failed", IssueError, event)
	case EventCancelled:
		operation.State = OperationCancelled
		operation.EndedAt = timePtr(event.OccurredAt)
		operation.DurationMilliseconds = durationMilliseconds(operation.StartedAt, event.OccurredAt)
	case EventTimedOut:
		operation.State = OperationTimedOut
		operation.EndedAt = timePtr(event.OccurredAt)
		operation.DurationMilliseconds = durationMilliseconds(operation.StartedAt, event.OccurredAt)
		openOperationIssue(state, *operation, "operation_timed_out", IssueError, event)
	case EventNotObservable:
		if operation.State == OperationRunning {
			operation.State = OperationStalled
		}
		openOperationIssue(state, *operation, "visibility_gap", IssueWarning, event)
	case EventLateObserved:
		if operation.State == OperationStalled && (operation.GraceEndsAt == nil || !event.OccurredAt.After(*operation.GraceEndsAt)) {
			if allRequiredObserved(operation.Checkpoints) {
				operation.State = OperationSucceeded
				operation.EndedAt = timePtr(event.OccurredAt)
				operation.DurationMilliseconds = durationMilliseconds(operation.StartedAt, event.OccurredAt)
			}
			resolveOperationIssues(state, operation.ID, event.OccurredAt)
		} else {
			openOperationIssue(state, *operation, "late_observed", IssueWarning, event)
		}
	}
	recomputeOperationDeadline(operation)
}

func recomputeOperationDeadline(operation *DiagnosticOperationDetail) {
	if operation == nil {
		return
	}
	var earliest *time.Time
	for _, checkpoint := range operation.Checkpoints {
		if checkpoint.State != CheckpointPending || checkpoint.DeadlineAt == nil || checkpoint.Class == CheckpointBestEffort {
			continue
		}
		candidate := checkpoint.DeadlineAt.UTC()
		if earliest == nil || candidate.Before(*earliest) {
			earliest = &candidate
		}
	}
	if earliest == nil {
		operation.DeadlineAt = nil
		if operation.State != OperationStalled {
			operation.GraceEndsAt = nil
		}
		return
	}
	operation.DeadlineAt = earliest
	if operation.State != OperationStalled {
		operation.GraceEndsAt = nil
	}
}

func allRequiredObserved(checkpoints []DiagnosticCheckpointDetail) bool {
	for _, checkpoint := range checkpoints {
		if checkpoint.Class == CheckpointRequired && checkpoint.State != CheckpointObserved && checkpoint.State != CheckpointLateObserved {
			return false
		}
	}
	return true
}
func durationMilliseconds(start, end time.Time) int64 {
	if start.IsZero() || end.IsZero() || end.Before(start) {
		return 0
	}
	return end.Sub(start).Milliseconds()
}
func eventAttributeString(event AcceptedDiagnosticEvent, key, fallback string) string {
	if value, ok := event.Attributes[key].(string); ok && value != "" {
		return value
	}
	return fallback
}

func issueID(operationID, kind, checkpoint string) string {
	return deterministicUUID("issue", operationID+"|"+kind+"|"+checkpoint)
}
func openCheckpointIssue(state *ProjectionState, operation DiagnosticOperationDetail, checkpoint DiagnosticCheckpointDetail, event AcceptedDiagnosticEvent) {
	if checkpoint.Class == CheckpointBestEffort {
		return
	}
	kind := "checkpoint_missed"
	severity := IssueError
	summary := "Required checkpoint was not confirmed."
	if checkpoint.State == CheckpointNotObservable {
		kind = "visibility_gap"
		severity = IssueWarning
		summary = "Checkpoint was not observable at this boundary."
	}
	id := issueID(operation.ID, kind, checkpoint.Key)
	existing, ok := state.Issues[id]
	if ok && existing.State == IssueOpen {
		existing.LastObservedAt = timePtr(event.OccurredAt)
		if existing.Affected == nil {
			existing.Affected = affectedSubjectForEvent(event)
		}
		state.Issues[id] = existing
		return
	}
	state.Issues[id] = DiagnosticIssueDetail{SchemaVersion: "IssueDetail/v1", ID: id, OperationID: operation.ID, Affected: affectedSubjectForEvent(event), Kind: kind, Severity: severity, State: IssueOpen, Summary: summary, FirstObservedAt: event.OccurredAt, LastObservedAt: timePtr(event.OccurredAt), LastConfirmedCheckpoint: lastConfirmed(operation.Checkpoints), MissingCheckpoint: checkpoint.Key, UnknownReason: checkpoint.UnknownReason}
}

func openOperationIssue(state *ProjectionState, operation DiagnosticOperationDetail, kind string, severity IssueSeverity, event AcceptedDiagnosticEvent) {
	id := issueID(operation.ID, kind, "")
	existing, ok := state.Issues[id]
	if ok && existing.State == IssueOpen {
		existing.LastObservedAt = timePtr(event.OccurredAt)
		if existing.Affected == nil {
			existing.Affected = affectedSubjectForEvent(event)
		}
		state.Issues[id] = existing
		return
	}
	state.Issues[id] = DiagnosticIssueDetail{SchemaVersion: "IssueDetail/v1", ID: id, OperationID: operation.ID, Affected: affectedSubjectForEvent(event), Kind: kind, Severity: severity, State: IssueOpen, Summary: "Operation ended without a successful terminal path.", FirstObservedAt: event.OccurredAt, LastObservedAt: timePtr(event.OccurredAt), LastConfirmedCheckpoint: lastConfirmed(operation.Checkpoints)}
}

// affectedSubjectForEvent uses only authoritative participant metadata or the
// closed EventSource enum. It never copies a provider/customer identifier into
// a user-facing issue shape.
func affectedSubjectForEvent(event AcceptedDiagnosticEvent) *DiagnosticAffectedSubject {
	if event.ParticipantID != "" && safeTokenPattern.MatchString(event.ParticipantID) && len(event.ParticipantID) <= MaxOperationRefLength {
		identifier, ok := SafeIdentifierFor("chalk.participant", event.ParticipantID).(SafeIdentifier)
		if ok {
			return &DiagnosticAffectedSubject{Kind: "participant", Identifier: identifier}
		}
	}
	if _, ok := allowedSources[event.Source]; !ok {
		return nil
	}
	identifier, ok := SafeIdentifierFor("chalk.service", string(event.Source)).(SafeIdentifier)
	if !ok {
		return nil
	}
	return &DiagnosticAffectedSubject{Kind: "service", Identifier: identifier}
}
func lastConfirmed(checkpoints []DiagnosticCheckpointDetail) string {
	confirmed := ""
	order := -1
	for _, checkpoint := range checkpoints {
		if (checkpoint.State == CheckpointObserved || checkpoint.State == CheckpointLateObserved) && checkpoint.DisplayOrder > order {
			confirmed = checkpoint.Key
			order = checkpoint.DisplayOrder
		}
	}
	return confirmed
}
func resolveCheckpointIssues(state *ProjectionState, operationID, checkpoint string, at time.Time) {
	for id, issue := range state.Issues {
		if issue.OperationID == operationID && issue.MissingCheckpoint == checkpoint && issue.State == IssueOpen {
			issue.State = IssueResolved
			issue.ResolvedAt = timePtr(at)
			issue.LastObservedAt = timePtr(at)
			state.Issues[id] = issue
		}
	}
}
func resolveOperationIssues(state *ProjectionState, operationID string, at time.Time) {
	for id, issue := range state.Issues {
		if issue.OperationID == operationID && issue.State == IssueOpen {
			issue.State = IssueResolved
			issue.ResolvedAt = timePtr(at)
			issue.LastObservedAt = timePtr(at)
			state.Issues[id] = issue
		}
	}
}

func branchIDFor(event AcceptedDiagnosticEvent) string {
	if event.BranchID != "" {
		return event.BranchID
	}
	kind := operationKind(event.Name)
	root := strings.Split(kind, ".")[0]
	switch root {
	case "cleanup", "recording", "transcription", "artifact", "webhook":
		if event.ProducerOperationRef != "" {
			return deterministicUUID("branch", root+"|"+event.ProducerOperationRef)
		}
		return deterministicUUID("branch", root)
	}
	return ""
}

func isSyntheticBranchDeadlineEvent(event AcceptedDiagnosticEvent) bool {
	if event.Name == "operation.ended" || event.Source != SourceWorker || event.State != EventTimedOut || event.Phase != "timed_out" {
		return false
	}
	reason, ok := event.Attributes["reason"].(string)
	return ok && reason == "deadline"
}
func branchKind(name string) BranchKind {
	switch strings.Split(operationKind(name), ".")[0] {
	case "cleanup":
		return BranchCleanup
	case "recording":
		return BranchRecording
	case "transcription":
		return BranchTranscription
	case "artifact":
		return BranchArtifact
	default:
		return BranchWebhook
	}
}
func ensureBranch(state *ProjectionState, branchID string, event AcceptedDiagnosticEvent) DiagnosticBranchDetail {
	if branch, ok := state.Branches[branchID]; ok {
		return branch
	}
	leaseEndsAt := event.OccurredAt.Add(MaximumEpilogueLease)
	if state.Diagnostic.EpisodeEndedAt != nil && !state.Diagnostic.EpisodeEndedAt.IsZero() {
		leaseEndsAt = state.Diagnostic.EpisodeEndedAt.UTC().Add(MaximumEpilogueLease)
	}
	if event.Expectation != nil && event.Expectation.DeadlineAt != nil && event.Expectation.DeadlineAt.Before(leaseEndsAt) {
		leaseEndsAt = event.Expectation.DeadlineAt.UTC()
	}
	return DiagnosticBranchDetail{SchemaVersion: "BranchDetail/v1", ID: branchID, Kind: branchKind(event.Name), State: BranchPending, LeaseEndsAt: leaseEndsAt, Attempts: 0}
}
func applyBranchEvent(branch *DiagnosticBranchDetail, event AcceptedDiagnosticEvent) {
	if terminalBranchState(branch.State) {
		// A callback after a terminal branch is evidence of lateness, never a
		// reopening signal. Preserve the terminal state and count the callback.
		branch.LateObservations++
		return
	}
	if branch.StartedAt == nil {
		branch.StartedAt = timePtr(event.OccurredAt)
	}
	if event.Correlation != nil && event.Correlation.Attempt > int64(branch.Attempts) {
		branch.Attempts = int(event.Correlation.Attempt)
	}
	if value, ok := event.Attributes["attempt"].(int); ok && value > branch.Attempts {
		branch.Attempts = value
	}
	switch event.State {
	case EventStarted, EventObserved:
		branch.State = BranchRunning
	case EventSucceeded:
		branch.State = BranchSucceeded
		branch.TerminalAt = timePtr(event.OccurredAt)
		branch.TerminalCursor = event.Cursor
	case EventFailed:
		branch.State = BranchFailed
		branch.TerminalAt = timePtr(event.OccurredAt)
		branch.TerminalCursor = event.Cursor
	case EventCancelled:
		branch.State = BranchCancelled
		branch.TerminalAt = timePtr(event.OccurredAt)
		branch.TerminalCursor = event.Cursor
	case EventTimedOut:
		branch.State = BranchTimedOut
		branch.TerminalAt = timePtr(event.OccurredAt)
		branch.TerminalCursor = event.Cursor
	case EventLateObserved:
		branch.LateObservations++
	}
}

func (state ProjectionState) ScanStalls(now time.Time) ProjectionDelta {
	result := state.Clone()
	delta := ProjectionDelta{Cursor: result.Diagnostic.ProjectedCursor}
	for id, operation := range result.Operations {
		if operation.State != OperationRunning && operation.State != OperationRetrying && operation.State != OperationStalled {
			continue
		}
		for index := range operation.Checkpoints {
			checkpoint := &operation.Checkpoints[index]
			if checkpoint.State != CheckpointPending || checkpoint.DeadlineAt == nil || now.Before(*checkpoint.DeadlineAt) || checkpoint.Class == CheckpointBestEffort {
				continue
			}
			checkpoint.State = CheckpointMissed
			operation.State = OperationStalled
			graceEnds := checkpoint.DeadlineAt.Add(DefaultGracePeriod)
			operation.GraceEndsAt = timePtr(graceEnds)
			operation.DeadlineAt = checkpoint.DeadlineAt
			openCheckpointIssue(&result, operation, *checkpoint, AcceptedDiagnosticEvent{DiagnosticEventDraft: DiagnosticEventDraft{OccurredAt: now}, Cursor: result.Diagnostic.ProjectedCursor})
		}
		if operation.State == OperationStalled && operation.GraceEndsAt != nil && now.After(*operation.GraceEndsAt) {
			operation.State = OperationTimedOut
			operation.EndedAt = operation.GraceEndsAt
			operation.DurationMilliseconds = durationMilliseconds(operation.StartedAt, *operation.GraceEndsAt)
		}
		result.Operations[id] = operation
		delta.Operations = append(delta.Operations, operation)
	}
	return resultDelta(result, delta)
}

func resultDelta(state ProjectionState, delta ProjectionDelta) ProjectionDelta {
	for _, issue := range state.Issues {
		delta.Issues = append(delta.Issues, issue)
	}
	sort.Slice(delta.Operations, func(left, right int) bool { return delta.Operations[left].ID < delta.Operations[right].ID })
	sort.Slice(delta.Issues, func(left, right int) bool { return delta.Issues[left].ID < delta.Issues[right].ID })
	return delta
}

func (state *ProjectionState) ApplyStalls(now time.Time) ProjectionDelta {
	result := state.ScanStalls(now)
	next := state.Clone()
	for _, operation := range result.Operations {
		next.Operations[operation.ID] = operation
	}
	for _, issue := range result.Issues {
		next.Issues[issue.ID] = issue
	}
	*state = next
	return result
}

func (state ProjectionState) Snapshot(reference string, capturedAt time.Time) DiagnosticSnapshotV1 {
	if capturedAt.IsZero() {
		capturedAt = time.Now().UTC()
	}
	snapshot := DiagnosticSnapshotV1{SchemaVersion: "DiagnosticSnapshot/v1", Reference: reference, Environment: state.Diagnostic.Environment, State: state.Diagnostic.State, CapturedAt: capturedAt.UTC(), CommittedCursor: state.Diagnostic.CommittedCursor, ProjectedCursor: state.Diagnostic.ProjectedCursor, RunEndCursor: state.Diagnostic.RunEndCursor, Summary: DiagnosticSummary{EventCount: int64(len(state.Events)), OperationCount: int64(len(state.Operations)), IssueCount: int64(len(state.Issues)), ParticipantCount: int64(len(state.Participants))}, Operations: make([]DiagnosticOperationDetail, 0, len(state.Operations)), Issues: make([]DiagnosticIssueDetail, 0, len(state.Issues)), Branches: make([]DiagnosticBranchDetail, 0, len(state.Branches))}
	for _, operation := range state.Operations {
		snapshot.Operations = append(snapshot.Operations, operation)
	}
	for _, issue := range state.Issues {
		snapshot.Issues = append(snapshot.Issues, issue)
	}
	for _, branch := range state.Branches {
		snapshot.Branches = append(snapshot.Branches, branch)
	}
	for _, participant := range state.Participants {
		snapshot.Participants = append(snapshot.Participants, participant)
	}
	sort.Slice(snapshot.Operations, func(left, right int) bool { return snapshot.Operations[left].ID < snapshot.Operations[right].ID })
	sort.Slice(snapshot.Issues, func(left, right int) bool { return snapshot.Issues[left].ID < snapshot.Issues[right].ID })
	sort.Slice(snapshot.Branches, func(left, right int) bool { return snapshot.Branches[left].ID < snapshot.Branches[right].ID })
	sort.Slice(snapshot.Participants, func(left, right int) bool {
		return snapshot.Participants[left].ParticipantID < snapshot.Participants[right].ParticipantID
	})
	snapshot.Summary.OpenIssueCount = 0
	for _, issue := range snapshot.Issues {
		if issue.State == IssueOpen {
			snapshot.Summary.OpenIssueCount++
		}
	}
	snapshot.Run = pointer(runProjection(state))
	snapshot.Graph = pointer(graphProjection(state))
	snapshot.Flame = pointer(flameProjection(state))
	snapshot.Epilogue = pointer(epilogueProjection(state))
	return snapshot
}

func pointer[T any](value T) *T { return &value }

func runProjection(state ProjectionState) RunProjectionV1 {
	started := state.Diagnostic.EpisodeStartedAt
	elapsed := int64(0)
	end := time.Now().UTC()
	if !started.IsZero() {
		if state.Diagnostic.EpisodeEndedAt != nil {
			end = *state.Diagnostic.EpisodeEndedAt
		}
		elapsed = durationMilliseconds(started, end)
	}
	active, open := int64(0), int64(0)
	latest, missing := "", ""
	latestOrder, missingOrder := -1, 1<<30
	lanes := []RunParticipantLane{}
	for _, operation := range state.Operations {
		if operation.State == OperationRunning || operation.State == OperationRetrying || operation.State == OperationStalled {
			active++
		}
		if operation.State == OperationStalled {
			if missing == "" {
				missing = firstMissing(operation.Checkpoints)
			}
		}
		confirmed := lastConfirmed(operation.Checkpoints)
		for _, checkpoint := range operation.Checkpoints {
			if checkpoint.State == CheckpointObserved || checkpoint.State == CheckpointLateObserved {
				if checkpoint.DisplayOrder > latestOrder {
					latest, latestOrder = checkpoint.Key, checkpoint.DisplayOrder
				}
			}
			if checkpoint.State == CheckpointMissed && checkpoint.DisplayOrder < missingOrder {
				missing, missingOrder = checkpoint.Key, checkpoint.DisplayOrder
			}
		}
		_ = confirmed
	}
	for _, issue := range state.Issues {
		if issue.State == IssueOpen {
			open++
		}
	}
	stateValue := string(state.Diagnostic.State)
	if stateValue == "" {
		stateValue = "live"
	}
	projection := RunProjectionV1{SchemaVersion: "RunProjection/v1", State: stateValue, StartedAt: started, EndedAt: state.Diagnostic.EpisodeEndedAt, ElapsedMilliseconds: elapsed, ParticipantCount: int64(len(state.Participants)), ActiveOperationCount: active, OpenIssueCount: open, ParticipantLanes: lanes}
	if latest != "" {
		projection.LatestConfirmedBoundary = pointer(DisplayValue{Value: latest})
	}
	if missing != "" {
		projection.FirstMissingBoundary = pointer(DisplayValue{Value: missing})
	}
	return projection
}
func firstMissing(checkpoints []DiagnosticCheckpointDetail) string {
	for _, checkpoint := range checkpoints {
		if checkpoint.Class == CheckpointRequired && checkpoint.State != CheckpointObserved && checkpoint.State != CheckpointLateObserved {
			return checkpoint.Key
		}
	}
	return ""
}

func graphProjection(state ProjectionState) GraphProjectionV1 {
	nodes := map[string]GraphNode{}
	edges := map[string]GraphEdge{}
	for _, operation := range state.Operations {
		nodeID := string(operation.Source)
		if nodeID == "" {
			nodeID = "unknown"
		}
		node := nodes[nodeID]
		node.ID = nodeID
		node.Kind = graphKind(operation.Source)
		node.Label = nodeID
		node.OperationCount++
		if operation.State == OperationFailed || operation.State == OperationTimedOut {
			node.State = "failed"
		} else if operation.State == OperationStalled {
			node.State = "stalled"
		} else if operation.State == OperationRunning || operation.State == OperationRetrying {
			node.State = "active"
		} else if node.State == "" {
			node.State = "healthy"
		}
		nodes[nodeID] = node
		if operation.ParentID != "" {
			parent, ok := state.Operations[operation.ParentID]
			if ok {
				from, to := string(parent.Source), string(operation.Source)
				edgeID := from + "->" + to
				edge := edges[edgeID]
				if edge.OperationIDs == nil {
					edge.OperationIDs = []string{}
				}
				if edge.IssueIDs == nil {
					edge.IssueIDs = []string{}
				}
				edge.ID = edgeID
				edge.From = from
				edge.To = to
				edge.State = node.State
				edge.OperationIDs = appendUnique(edge.OperationIDs, operation.ID)
				edges[edgeID] = edge
			}
		}
	}
	for _, issue := range state.Issues {
		if operation, ok := state.Operations[issue.OperationID]; ok {
			node := nodes[string(operation.Source)]
			node.IssueCount++
			if issue.State == IssueOpen && node.State == "healthy" {
				node.State = "stalled"
			}
			nodes[string(operation.Source)] = node
		}
	}
	projection := GraphProjectionV1{SchemaVersion: "GraphProjection/v1", Nodes: []GraphNode{}, Edges: []GraphEdge{}}
	for _, node := range nodes {
		projection.Nodes = append(projection.Nodes, node)
	}
	for _, edge := range edges {
		sort.Strings(edge.OperationIDs)
		projection.Edges = append(projection.Edges, edge)
	}
	sort.Slice(projection.Nodes, func(left, right int) bool { return projection.Nodes[left].ID < projection.Nodes[right].ID })
	sort.Slice(projection.Edges, func(left, right int) bool { return projection.Edges[left].ID < projection.Edges[right].ID })
	projection.Summary.NodeCount = int64(len(projection.Nodes))
	projection.Summary.EdgeCount = int64(len(projection.Edges))
	for _, node := range projection.Nodes {
		if node.State == "active" {
			projection.Summary.ActiveCount++
		}
		if node.State == "failed" {
			projection.Summary.FailedCount++
		}
		if node.State == "unobservable" {
			projection.Summary.UnobservableCount++
		}
	}
	return projection
}
func graphKind(source EventSource) string {
	switch source {
	case SourceUI:
		return "ui"
	case SourceSDK:
		return "sdk"
	case SourceAPI:
		return "api"
	case SourceSync:
		return "sync"
	case SourceRTC:
		return "media"
	case SourceProvider:
		return "provider"
	case SourceWorker:
		return "worker"
	default:
		return "unknown"
	}
}
func appendUnique(values []string, value string) []string {
	for _, existing := range values {
		if existing == value {
			return values
		}
	}
	return append(values, value)
}

func flameProjection(state ProjectionState) FlameProjectionV1 {
	lanes := map[string]FlameLane{}
	for _, operation := range state.Operations {
		laneID := string(operation.Source)
		if laneID == "" {
			laneID = "unknown"
		}
		lane := lanes[laneID]
		lane.ID = laneID
		lane.Label = laneID
		lane.Source = operation.Source
		bar := FlameBar{ID: operation.ID, OperationID: operation.ID, StartAt: operation.StartedAt, EndAt: operation.EndedAt, State: operation.State, Attempt: operation.Attempt}
		if retry, ok := operation.RetryGroup.(SafeIdentifier); ok {
			bar.RetryGroup = retry.Value
		}
		lane.Bars = append(lane.Bars, bar)
		lanes[laneID] = lane
	}
	projection := FlameProjectionV1{SchemaVersion: "FlameProjection/v1", Lanes: []FlameLane{}, Buckets: []FlameBucket{}, Heat: []FlameHeat{}}
	for _, lane := range lanes {
		sort.Slice(lane.Bars, func(left, right int) bool {
			if lane.Bars[left].StartAt.Equal(lane.Bars[right].StartAt) {
				return lane.Bars[left].ID < lane.Bars[right].ID
			}
			return lane.Bars[left].StartAt.Before(lane.Bars[right].StartAt)
		})
		projection.Lanes = append(projection.Lanes, lane)
	}
	sort.Slice(projection.Lanes, func(left, right int) bool { return projection.Lanes[left].ID < projection.Lanes[right].ID })
	return projection
}

func epilogueProjection(state ProjectionState) EpilogueProjectionV1 {
	projection := EpilogueProjectionV1{SchemaVersion: "EpilogueProjection/v1", State: "pending", Branches: []DiagnosticBranchDetail{}}
	for _, branch := range state.Branches {
		projection.Branches = append(projection.Branches, branch)
		if branch.State == BranchPending || branch.State == BranchRunning {
			projection.OpenBranchCount++
		} else {
			projection.TerminalBranchCount++
		}
		if branch.TerminalCursor > projection.LatestTerminalCursor {
			projection.LatestTerminalCursor = branch.TerminalCursor
		}
	}
	sort.Slice(projection.Branches, func(left, right int) bool { return projection.Branches[left].ID < projection.Branches[right].ID })
	if len(projection.Branches) == 0 {
		projection.State = "pending"
	} else if projection.OpenBranchCount == 0 {
		projection.State = "complete"
	} else {
		projection.State = "live"
	}
	if state.Diagnostic.EpilogueCompletedAt != nil {
		projection.State = "complete"
		projection.CompletedAt = state.Diagnostic.EpilogueCompletedAt
	}
	return projection
}
