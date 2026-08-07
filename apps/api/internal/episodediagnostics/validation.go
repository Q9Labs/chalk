package episodediagnostics

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	ContractVersion          = 1
	MaxDiagnosticEventBytes  = 2 * 1024
	MaxEventIDLength         = 128
	MaxOperationRefLength    = 128
	MaxEventNameLength       = 96
	MaxPhaseLength           = 48
	MaxAttributeCount        = 32
	MaxAttributeKeyLength    = 64
	MaxAttributeStringLength = 256
	MaxPageSize              = 1000
	MaxCursor                = int64(9007199254740991)
)

var (
	safeTokenPattern      = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:@+/=-]*$`)
	safeOpaquePattern     = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)
	safeClassPattern      = regexp.MustCompile(`^[a-z][a-z0-9]*(?:\.[a-z0-9_-]+)*$`)
	eventNamePattern      = regexp.MustCompile(`^[a-z][a-z0-9_.-]*$`)
	phasePattern          = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)
	printableASCII        = regexp.MustCompile(`^[\x20-\x7e]+$`)
	forbiddenKeyPattern   = regexp.MustCompile(`(?i)(?:text|content|body|payload|display.?name|filename|url|uri|token|secret|password|credential|cookie|authorization|exception|stack|sdp|ice|candidate|address|phone|email|webhook)`)
	forbiddenValuePattern = regexp.MustCompile(`(?i)(?:https?://|wss?://|bearer\s+[a-z0-9._~+/=-]+|-----begin|candidate:|v=0\r?\n|\b(?:\d{1,3}\.){3}\d{1,3}\b|[\w.+-]+@[\w.-]+\.[a-z]{2,})`)
)

var allowedPhases = map[string]struct{}{
	"intent": {}, "validation": {}, "authorized": {}, "denied": {}, "enqueued": {}, "attempt": {}, "retry": {},
	"started": {}, "observed": {}, "connected": {}, "authenticated": {}, "snapshot": {}, "live": {}, "reconnected": {},
	"disconnected": {}, "acquired": {}, "prepared": {}, "published": {}, "subscribed": {}, "first_frame": {},
	"committed": {}, "receipt": {}, "projected": {}, "paged": {}, "read": {}, "deduped": {}, "expired": {},
	"callback": {}, "finalized": {}, "delivered": {}, "exhausted": {}, "fan_in": {}, "unsupported": {},
	"succeeded": {}, "failed": {}, "cancelled": {}, "timed_out": {}, "not_observable": {}, "late_observed": {},
}

var allowedEventStates = map[EventState]struct{}{
	EventStarted: {}, EventObserved: {}, EventSucceeded: {}, EventFailed: {}, EventCancelled: {}, EventTimedOut: {}, EventNotObservable: {}, EventLateObserved: {},
}

var allowedSources = map[EventSource]struct{}{
	SourceUI: {}, SourceSDK: {}, SourceAPI: {}, SourceSync: {}, SourceRTC: {}, SourceProvider: {}, SourceWorker: {},
}

var allowedCheckpointClasses = map[CheckpointClass]struct{}{
	CheckpointRequired: {}, CheckpointConditional: {}, CheckpointBestEffort: {},
}

var allowedUnknownReasons = map[UnknownReason]struct{}{
	UnknownNotRetained: {}, UnknownNotObservable: {}, UnknownRedacted: {}, UnknownProviderOpaque: {}, UnknownExpired: {},
	UnknownNotAvailable: {}, UnknownInvalid: {}, UnknownDiagnosticsOff: {}, UnknownPermissionDenied: {}, UnknownReasonUnknown: {},
}

var allowedAttributes = map[string]struct{}{
	"action": {}, "checkpoint": {}, "reason": {}, "result": {}, "status": {}, "kind": {}, "direction": {}, "transport": {},
	"media_kind": {}, "track_state": {}, "permission": {}, "target_state": {}, "response_class": {}, "delivery_status": {},
	"storage_state": {}, "object_ref_class": {}, "attachment_type": {}, "size_bucket": {}, "safe_id_class": {}, "visibility": {},
	"recipient_count": {}, "projection_count": {}, "observable_recipient_count": {}, "attempt": {}, "retryable": {}, "budget_remaining": {},
	"duration_ms": {}, "latency_ms": {}, "bytes": {}, "count": {}, "cursor": {}, "sequence": {}, "grace_ms": {}, "deadline_ms": {},
	"state_version": {}, "policy_version": {}, "release_channel": {},
}

// ActionOperationKeys is the closed v1 action catalog. Event names may append
// a boundary suffix to one of these roots (for example chat.send.receipt).
var ActionOperationKeys = []string{
	"episode.emerge", "episode.start", "episode.end.natural", "episode.end.authorized", "episode.end.linger", "episode.end.deadline", "episode.deadline.extend",
	"access.request", "access.approve", "access.deny", "access.refresh",
	"participant.join", "participant.reconnect", "participant.rejoin", "participant.leave", "participant.rename", "participant.raised_hand.set",
	"microphone.publish", "microphone.unpublish", "microphone.recover", "camera.publish", "camera.unpublish", "camera.recover",
	"media_request.request", "media_request.accept", "media_request.decline", "media_request.expire",
	"screen.start", "screen.stop", "screen.unexpected_end", "screen.recover",
	"sync.connect", "sync.authenticate", "sync.snapshot", "sync.live", "sync.reconnect", "sync.disconnect",
	"chat.send", "chat.retry", "chat.page", "chat.read", "chat.attachment.prepare", "chat.attachment.commit", "chat.attachment.fail",
	"reaction.send", "reaction.dedupe", "reaction.expire",
	"admission.policy.snapshot", "admission.policy.change", "admission.request", "admission.admit", "admission.deny",
	"moderation.role.change", "moderation.capability.check", "moderation.microphone.disable", "moderation.camera.disable", "moderation.screen.disable", "moderation.remove", "moderation.ban",
	"recovery.access.refresh", "recovery.media.retry", "recovery.sync.retry", "recovery.budget.exhaust",
	"recording.start", "recording.stop", "recording.provider.callback", "recording.finalize",
	"transcription.start", "transcription.stop", "transcription.provider.callback", "transcription.finalize",
	"cleanup.resource.release", "cleanup.fan_in", "cleanup.complete",
	"artifact.reserve", "artifact.write", "artifact.commit", "artifact.fail",
	"webhook.enqueue", "webhook.attempt", "webhook.retry", "webhook.deliver", "webhook.exhaust",
	"whiteboard.unsupported",
}

var eventExtraRoots = []string{"coverage.started_late", "coverage.gap", "coverage.rejected", "operation.started", "operation.ended", "checkpoint.observed", "checkpoint.missed", "issue.opened", "issue.resolved", "branch.started", "branch.ended", "diagnostic.created", "diagnostic.ended", "diagnostic.completed"}

var allowedEventNames = func() map[string]struct{} {
	set := make(map[string]struct{}, len(ActionOperationKeys)+len(eventExtraRoots))
	for _, name := range ActionOperationKeys {
		set[name] = struct{}{}
	}
	for _, name := range eventExtraRoots {
		set[name] = struct{}{}
	}
	return set
}()

type ValidationIssue struct {
	Path    string `json:"path"`
	Message string `json:"message"`
}

type ValidationError struct {
	Issues []ValidationIssue
}

func (e *ValidationError) Error() string {
	if len(e.Issues) == 0 {
		return "diagnostic contract validation failed"
	}
	parts := make([]string, 0, len(e.Issues))
	for _, issue := range e.Issues {
		parts = append(parts, issue.Path+": "+issue.Message)
	}
	return "diagnostic contract validation failed: " + strings.Join(parts, "; ")
}

type ValidatedEvent struct {
	Event         DiagnosticEventDraft
	Canonical     []byte
	CanonicalJSON string
	Fingerprint   string
	SizeBytes     int
}

func issue(path, message string) ValidationIssue {
	return ValidationIssue{Path: path, Message: message}
}
func addIssue(issues *[]ValidationIssue, path, message string) {
	*issues = append(*issues, issue(path, message))
}

func validDate(value time.Time) bool { return !value.IsZero() && value.Year() >= 1 }
func validToken(value string, max int) bool {
	return value != "" && len(value) <= max && safeTokenPattern.MatchString(value)
}

func allowedEventName(name string) bool {
	if !eventNamePattern.MatchString(name) {
		return false
	}
	for root := range allowedEventNames {
		if name == root || strings.HasPrefix(name, root+".") {
			return true
		}
	}
	return false
}

func validateAttributes(attributes DiagnosticAttributes, path string) []ValidationIssue {
	issues := make([]ValidationIssue, 0)
	if len(attributes) > MaxAttributeCount {
		addIssue(&issues, path, fmt.Sprintf("at most %d attributes are allowed", MaxAttributeCount))
	}
	for key, value := range attributes {
		if len(key) > MaxAttributeKeyLength || forbiddenKeyPattern.MatchString(key) {
			addIssue(&issues, path+"."+key, "attribute key is not allowlisted")
			continue
		}
		if _, ok := allowedAttributes[key]; !ok {
			addIssue(&issues, path+"."+key, "attribute key is not allowlisted")
			continue
		}
		switch typed := value.(type) {
		case bool:
		case string:
			if len(typed) > MaxAttributeStringLength || !printableASCII.MatchString(typed) || forbiddenValuePattern.MatchString(typed) {
				addIssue(&issues, path+"."+key, "attribute value is not safe or is too large")
			}
		case float32:
			if math.IsNaN(float64(typed)) || math.IsInf(float64(typed), 0) || math.Abs(float64(typed)) > float64(MaxCursor) {
				addIssue(&issues, path+"."+key, "attribute number is not finite or safe")
			}
		case float64:
			if math.IsNaN(typed) || math.IsInf(typed, 0) || math.Abs(typed) > float64(MaxCursor) {
				addIssue(&issues, path+"."+key, "attribute number is not finite or safe")
			}
		case int:
			if math.Abs(float64(typed)) > float64(MaxCursor) {
				addIssue(&issues, path+"."+key, "attribute number is not finite or safe")
			}
		case int8:
			if math.Abs(float64(typed)) > float64(MaxCursor) {
				addIssue(&issues, path+"."+key, "attribute number is not finite or safe")
			}
		case int16:
			if math.Abs(float64(typed)) > float64(MaxCursor) {
				addIssue(&issues, path+"."+key, "attribute number is not finite or safe")
			}
		case int32:
			if math.Abs(float64(typed)) > float64(MaxCursor) {
				addIssue(&issues, path+"."+key, "attribute number is not finite or safe")
			}
		case int64:
			if math.Abs(float64(typed)) > float64(MaxCursor) {
				addIssue(&issues, path+"."+key, "attribute number is not finite or safe")
			}
		case uint:
			if float64(typed) > float64(MaxCursor) {
				addIssue(&issues, path+"."+key, "attribute number is not finite or safe")
			}
		case uint8:
			if float64(typed) > float64(MaxCursor) {
				addIssue(&issues, path+"."+key, "attribute number is not finite or safe")
			}
		case uint16:
			if float64(typed) > float64(MaxCursor) {
				addIssue(&issues, path+"."+key, "attribute number is not finite or safe")
			}
		case uint32:
			if float64(typed) > float64(MaxCursor) {
				addIssue(&issues, path+"."+key, "attribute number is not finite or safe")
			}
		case uint64:
			if float64(typed) > float64(MaxCursor) {
				addIssue(&issues, path+"."+key, "attribute number is not finite or safe")
			}
		case json.Number:
			number, err := typed.Float64()
			if err != nil || math.IsNaN(number) || math.IsInf(number, 0) || math.Abs(number) > float64(MaxCursor) {
				addIssue(&issues, path+"."+key, "attribute number is not finite or safe")
			}
		default:
			addIssue(&issues, path+"."+key, "attribute value must be a boolean, number, or string")
		}
	}
	return issues
}

// ValidateAttributes validates the scalar allowlist without accepting any
// content-bearing key or value.
func ValidateAttributes(attributes DiagnosticAttributes) error {
	issues := validateAttributes(attributes, "$.attributes")
	if len(issues) > 0 {
		return &ValidationError{Issues: issues}
	}
	return nil
}

type RedactionResult struct {
	Attributes   DiagnosticAttributes
	RedactedKeys []string
	RejectedKeys []string
}

// RedactAttributes is deliberately conservative: unknown and content-bearing
// fields are removed, while malformed scalar values are reported separately.
func RedactAttributes(attributes DiagnosticAttributes) RedactionResult {
	result := RedactionResult{Attributes: make(DiagnosticAttributes)}
	for key, value := range attributes {
		if _, allowed := allowedAttributes[key]; !allowed || forbiddenKeyPattern.MatchString(key) {
			result.RedactedKeys = append(result.RedactedKeys, key)
			continue
		}
		if scalarSafe(value) {
			result.Attributes[key] = value
		} else {
			result.RejectedKeys = append(result.RejectedKeys, key)
		}
	}
	sort.Strings(result.RedactedKeys)
	sort.Strings(result.RejectedKeys)
	if len(result.Attributes) > MaxAttributeCount {
		keys := make([]string, 0, len(result.Attributes))
		for key := range result.Attributes {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys[MaxAttributeCount:] {
			delete(result.Attributes, key)
			result.RejectedKeys = append(result.RejectedKeys, key)
		}
		sort.Strings(result.RejectedKeys)
	}
	return result
}

func scalarSafe(value any) bool {
	switch typed := value.(type) {
	case bool:
		return true
	case string:
		return len(typed) <= MaxAttributeStringLength && printableASCII.MatchString(typed) && !forbiddenValuePattern.MatchString(typed)
	case float32:
		return !math.IsNaN(float64(typed)) && !math.IsInf(float64(typed), 0) && math.Abs(float64(typed)) <= float64(MaxCursor)
	case float64:
		return !math.IsNaN(typed) && !math.IsInf(typed, 0) && math.Abs(typed) <= float64(MaxCursor)
	case int:
		return math.Abs(float64(typed)) <= float64(MaxCursor)
	case int8:
		return math.Abs(float64(typed)) <= float64(MaxCursor)
	case int16:
		return math.Abs(float64(typed)) <= float64(MaxCursor)
	case int32:
		return math.Abs(float64(typed)) <= float64(MaxCursor)
	case int64:
		return math.Abs(float64(typed)) <= float64(MaxCursor)
	case uint:
		return float64(typed) <= float64(MaxCursor)
	case uint8:
		return float64(typed) <= float64(MaxCursor)
	case uint16:
		return float64(typed) <= float64(MaxCursor)
	case uint32:
		return float64(typed) <= float64(MaxCursor)
	case uint64:
		return float64(typed) <= float64(MaxCursor)
	case json.Number:
		number, err := typed.Float64()
		return err == nil && !math.IsNaN(number) && !math.IsInf(number, 0) && math.Abs(number) <= float64(MaxCursor)
	default:
		return false
	}
}

func validateExpectation(expectation *DiagnosticEventExpectation, issues *[]ValidationIssue) {
	if expectation == nil {
		return
	}
	if !validToken(expectation.Name, MaxEventNameLength) {
		addIssue(issues, "$.expectation.name", "expectation name is not a safe token")
	}
	if expectation.Version < 1 || expectation.Version > 255 {
		addIssue(issues, "$.expectation.version", "expectation version must be between 1 and 255")
	}
	if !validToken(expectation.Checkpoint, 96) {
		addIssue(issues, "$.expectation.checkpoint", "checkpoint is not a safe token")
	}
	if _, ok := allowedCheckpointClasses[expectation.CheckpointClass]; !ok {
		addIssue(issues, "$.expectation.checkpointClass", "checkpoint class is not allowlisted")
	}
	if expectation.DeadlineAt != nil && !validDate(*expectation.DeadlineAt) {
		addIssue(issues, "$.expectation.deadlineAt", "deadlineAt must be a valid date-time")
	}
}

func validateCorrelation(correlation *DiagnosticEventCorrelation, issues *[]ValidationIssue) {
	if correlation == nil {
		return
	}
	for key, value := range map[string]string{"journeyId": correlation.JourneyID, "traceId": correlation.TraceID, "spanId": correlation.SpanID, "requestId": correlation.RequestID, "commandId": correlation.CommandID, "providerId": correlation.ProviderID, "retryGroupRef": correlation.RetryGroupRef} {
		if value != "" && !validToken(value, MaxOperationRefLength) {
			addIssue(issues, "$.correlation."+key, "correlation ID is not a safe token")
		}
	}
	if correlation.Attempt < 0 || correlation.Attempt > 1_000_000 {
		addIssue(issues, "$.correlation.attempt", "attempt must be a bounded non-negative integer")
	}
}

func validateDraft(event DiagnosticEventDraft) []ValidationIssue {
	issues := make([]ValidationIssue, 0)
	if event.Version != ContractVersion {
		addIssue(&issues, "$.version", "only event contract version 1 is supported")
	}
	if !validToken(event.EventID, MaxEventIDLength) {
		addIssue(&issues, "$.eventId", "eventId is not a safe token")
	}
	if event.ProducerOperationRef != "" && !validToken(event.ProducerOperationRef, MaxOperationRefLength) {
		addIssue(&issues, "$.producerOperationRef", "producerOperationRef is not a safe token")
	}
	if event.ParentProducerOperationRef != "" && !validToken(event.ParentProducerOperationRef, MaxOperationRefLength) {
		addIssue(&issues, "$.parentProducerOperationRef", "parentProducerOperationRef is not a safe token")
	}
	if event.ProducerSequence < 0 || event.ProducerSequence > MaxCursor {
		addIssue(&issues, "$.producerSequence", "producerSequence must be a safe non-negative integer")
	}
	if !validDate(event.OccurredAt) {
		addIssue(&issues, "$.occurredAt", "occurredAt must be a valid date-time")
	}
	if _, ok := allowedSources[event.Source]; !ok {
		addIssue(&issues, "$.source", "source is not allowlisted")
	}
	if len(event.Name) == 0 || len(event.Name) > MaxEventNameLength || !allowedEventName(event.Name) {
		addIssue(&issues, "$.name", "event name is not in the closed action/event allowlist")
	}
	if len(event.Phase) == 0 || len(event.Phase) > MaxPhaseLength || !phasePattern.MatchString(event.Phase) {
		addIssue(&issues, "$.phase", "event phase is not allowlisted")
	} else if _, ok := allowedPhases[event.Phase]; !ok {
		addIssue(&issues, "$.phase", "event phase is not allowlisted")
	}
	if _, ok := allowedEventStates[event.State]; !ok {
		addIssue(&issues, "$.state", "event state is not allowlisted")
	}
	if event.ParticipantID != "" && !validToken(event.ParticipantID, MaxOperationRefLength) {
		addIssue(&issues, "$.participantId", "authoritative participant ID is not a safe token")
	}
	validateExpectation(event.Expectation, &issues)
	validateCorrelation(event.Correlation, &issues)
	if event.Release != nil {
		if !validToken(event.Release.ID, 128) {
			addIssue(&issues, "$.release.id", "release id is not a safe token")
		}
		if event.Release.SourceCommit != "" && !validToken(event.Release.SourceCommit, 128) {
			addIssue(&issues, "$.release.sourceCommit", "sourceCommit is not a safe token")
		}
	}
	issues = append(issues, validateAttributes(event.Attributes, "$.attributes")...)
	return issues
}

// ValidateDraft performs the complete v1 intake validation and returns the
// exact bytes used for idempotency and the named fingerprint.
func ValidateDraft(event DiagnosticEventDraft) (ValidatedEvent, error) {
	issues := validateDraft(event)
	if len(issues) > 0 {
		return ValidatedEvent{}, &ValidationError{Issues: issues}
	}
	canonical, err := canonicalEvent(event)
	if err != nil {
		return ValidatedEvent{}, err
	}
	if len(canonical) > MaxDiagnosticEventBytes {
		return ValidatedEvent{}, &ValidationError{Issues: []ValidationIssue{issue("$", fmt.Sprintf("encoded event is %d bytes; maximum is %d", len(canonical), MaxDiagnosticEventBytes))}}
	}
	fingerprint := FingerprintBytes(canonical)
	return ValidatedEvent{Event: event, Canonical: canonical, CanonicalJSON: string(canonical), Fingerprint: fingerprint, SizeBytes: len(canonical)}, nil
}

func ValidateDiagnosticEventDraft(event DiagnosticEventDraft) error {
	_, err := ValidateDraft(event)
	return err
}
func ValidateEventDraft(event DiagnosticEventDraft) error { return ValidateDiagnosticEventDraft(event) }

func eventMap(event DiagnosticEventDraft) map[string]any {
	value := map[string]any{"version": event.Version, "eventId": event.EventID, "producerSequence": event.ProducerSequence, "occurredAt": event.OccurredAt.UTC().Format(time.RFC3339Nano), "source": string(event.Source), "name": event.Name, "phase": event.Phase, "state": string(event.State)}
	if event.ProducerOperationRef != "" {
		value["producerOperationRef"] = event.ProducerOperationRef
	}
	if event.ParentProducerOperationRef != "" {
		value["parentProducerOperationRef"] = event.ParentProducerOperationRef
	}
	if event.Expectation != nil {
		expectation := map[string]any{"name": event.Expectation.Name, "version": event.Expectation.Version, "checkpoint": event.Expectation.Checkpoint, "checkpointClass": string(event.Expectation.CheckpointClass)}
		if event.Expectation.DeadlineAt != nil {
			expectation["deadlineAt"] = event.Expectation.DeadlineAt.UTC().Format(time.RFC3339Nano)
		}
		value["expectation"] = expectation
	}
	if event.Correlation != nil {
		correlation := map[string]any{}
		for key, item := range map[string]string{"journeyId": event.Correlation.JourneyID, "traceId": event.Correlation.TraceID, "spanId": event.Correlation.SpanID, "requestId": event.Correlation.RequestID, "commandId": event.Correlation.CommandID, "providerId": event.Correlation.ProviderID, "retryGroupRef": event.Correlation.RetryGroupRef} {
			if item != "" {
				correlation[key] = item
			}
		}
		if event.Correlation.Attempt != 0 {
			correlation["attempt"] = event.Correlation.Attempt
		}
		value["correlation"] = correlation
	}
	if event.Release != nil {
		release := map[string]any{"id": event.Release.ID}
		if event.Release.SourceCommit != "" {
			release["sourceCommit"] = event.Release.SourceCommit
		}
		value["release"] = release
	}
	if len(event.Attributes) > 0 {
		value["attributes"] = event.Attributes
	}
	return value
}

func canonicalEvent(event DiagnosticEventDraft) ([]byte, error) {
	return CanonicalJSON(eventMap(event))
}

// CanonicalEvent returns key-sorted JSON after validating the draft.
func CanonicalEvent(event DiagnosticEventDraft) ([]byte, error) {
	validated, err := ValidateDraft(event)
	if err != nil {
		return nil, err
	}
	return validated.Canonical, nil
}
func EncodeDiagnosticEvent(event DiagnosticEventDraft) ([]byte, error) { return CanonicalEvent(event) }
func FingerprintEvent(event DiagnosticEventDraft) (string, error) {
	validated, err := ValidateDraft(event)
	if err != nil {
		return "", err
	}
	return validated.Fingerprint, nil
}
func FingerprintDiagnosticEvent(event DiagnosticEventDraft) (string, error) {
	return FingerprintEvent(event)
}

func FingerprintBytes(value []byte) string {
	digest := sha256.Sum256(value)
	return "sha256:" + hex.EncodeToString(digest[:])
}

func AcceptEvent(event DiagnosticEventDraft, diagnosticID string, cursor int64, receivedAt time.Time) (AcceptedDiagnosticEvent, error) {
	validated, err := ValidateDraft(event)
	if err != nil {
		return AcceptedDiagnosticEvent{}, err
	}
	if !validToken(diagnosticID, 128) {
		return AcceptedDiagnosticEvent{}, &ValidationError{Issues: []ValidationIssue{issue("$.diagnosticId", "diagnosticId is not a safe token")}}
	}
	if cursor < 0 || cursor > MaxCursor {
		return AcceptedDiagnosticEvent{}, &ValidationError{Issues: []ValidationIssue{issue("$.cursor", "cursor must be a safe non-negative integer")}}
	}
	if !validDate(receivedAt) {
		return AcceptedDiagnosticEvent{}, &ValidationError{Issues: []ValidationIssue{issue("$.receivedAt", "receivedAt must be a valid date-time")}}
	}
	accepted := AcceptedDiagnosticEvent{DiagnosticEventDraft: validated.Event, DiagnosticID: diagnosticID, Cursor: cursor, ReceivedAt: receivedAt.UTC(), Fingerprint: validated.Fingerprint}
	encoded, err := canonicalAcceptedEvent(accepted)
	if err != nil {
		return AcceptedDiagnosticEvent{}, err
	}
	if len(encoded) > MaxDiagnosticEventBytes {
		return AcceptedDiagnosticEvent{}, &ValidationError{Issues: []ValidationIssue{issue("$", "encoded accepted event exceeds 2 KiB")}}
	}
	return accepted, nil
}

func AcceptDiagnosticEvent(event DiagnosticEventDraft, diagnosticID string, cursor int64, receivedAt time.Time) (AcceptedDiagnosticEvent, error) {
	return AcceptEvent(event, diagnosticID, cursor, receivedAt)
}

func acceptedEventMap(event AcceptedDiagnosticEvent) map[string]any {
	value := eventMap(event.DiagnosticEventDraft)
	value["diagnosticId"] = event.DiagnosticID
	value["cursor"] = event.Cursor
	value["receivedAt"] = event.ReceivedAt.UTC().Format(time.RFC3339Nano)
	value["fingerprint"] = event.Fingerprint
	return value
}
func canonicalAcceptedEvent(event AcceptedDiagnosticEvent) ([]byte, error) {
	return CanonicalJSON(acceptedEventMap(event))
}

func ValidateAcceptedEvent(event AcceptedDiagnosticEvent) error {
	validated, err := ValidateDraft(event.DiagnosticEventDraft)
	if err != nil {
		return err
	}
	if !validToken(event.DiagnosticID, 128) || event.Cursor < 0 || event.Cursor > MaxCursor || !validDate(event.ReceivedAt) {
		return errors.New("accepted event envelope is invalid")
	}
	if event.Fingerprint != validated.Fingerprint {
		return errors.New("fingerprint does not match canonical event")
	}
	encoded, err := canonicalAcceptedEvent(event)
	if err != nil {
		return err
	}
	if len(encoded) > MaxDiagnosticEventBytes {
		return errors.New("encoded accepted event exceeds 2 KiB")
	}
	return nil
}

// CanonicalJSON recursively sorts object keys and preserves JSON numbers.
func CanonicalJSON(value any) ([]byte, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var decoded any
	if err := decoder.Decode(&decoded); err != nil {
		return nil, err
	}
	return encodeCanonicalValue(decoded)
}

func encodeCanonicalValue(value any) ([]byte, error) {
	switch typed := value.(type) {
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		var output bytes.Buffer
		output.WriteByte('{')
		for index, key := range keys {
			if index > 0 {
				output.WriteByte(',')
			}
			encodedKey, _ := json.Marshal(key)
			output.Write(encodedKey)
			output.WriteByte(':')
			encodedValue, err := encodeCanonicalValue(typed[key])
			if err != nil {
				return nil, err
			}
			output.Write(encodedValue)
		}
		output.WriteByte('}')
		return output.Bytes(), nil
	case []any:
		var output bytes.Buffer
		output.WriteByte('[')
		for index, item := range typed {
			if index > 0 {
				output.WriteByte(',')
			}
			encoded, err := encodeCanonicalValue(item)
			if err != nil {
				return nil, err
			}
			output.Write(encoded)
		}
		output.WriteByte(']')
		return output.Bytes(), nil
	default:
		return json.Marshal(typed)
	}
}

var referencePattern = regexp.MustCompile(`^chalkdiag:v1:([a-z]+):([A-Za-z0-9][A-Za-z0-9_-]{0,127})(?::(op|issue|event):([A-Za-z0-9][A-Za-z0-9_-]{0,127}))?(?:@([0-9]+))?$`)

func validEnvironment(environment Environment) bool {
	return environment == EnvironmentLocalhost || environment == EnvironmentDevelopment || environment == EnvironmentStaging
}
func ValidEnvironment(environment Environment) bool { return validEnvironment(environment) }

func FormatReference(reference DiagnosticReference) (string, error) {
	if reference.Version != ContractVersion || !validEnvironment(reference.Environment) || !safeOpaquePattern.MatchString(reference.DiagnosticID) {
		return "", errors.New("invalid diagnostic reference")
	}
	formatted := "chalkdiag:v1:" + string(reference.Environment) + ":" + reference.DiagnosticID
	if reference.Focus != nil {
		if (reference.Focus.Kind != ReferenceFocusOperation && reference.Focus.Kind != ReferenceFocusIssue && reference.Focus.Kind != ReferenceFocusEvent) || !safeOpaquePattern.MatchString(reference.Focus.ID) {
			return "", errors.New("invalid diagnostic focus")
		}
		formatted += ":" + string(reference.Focus.Kind) + ":" + reference.Focus.ID
	}
	if reference.Cursor != nil && (*reference.Cursor < 0 || *reference.Cursor > MaxCursor) {
		return "", errors.New("diagnostic cursor is out of bounds")
	}
	if reference.Cursor != nil {
		formatted += "@" + strconv.FormatInt(*reference.Cursor, 10)
	}
	return formatted, nil
}

func FormatDiagnosticReference(reference DiagnosticReference) (string, error) {
	return FormatReference(reference)
}

func ParseReference(input string) (DiagnosticReference, error) {
	match := referencePattern.FindStringSubmatch(input)
	if match == nil {
		return DiagnosticReference{}, errors.New("malformed diagnostic reference")
	}
	environment := Environment(match[1])
	if !validEnvironment(environment) {
		return DiagnosticReference{}, errors.New("diagnostic environment is not enabled")
	}
	reference := DiagnosticReference{Version: ContractVersion, Environment: environment, DiagnosticID: match[2]}
	if match[3] != "" {
		reference.Focus = &DiagnosticReferenceFocus{Kind: ReferenceFocusKind(match[3]), ID: match[4]}
	}
	if match[5] != "" {
		if len(match[5]) > 1 && strings.HasPrefix(match[5], "0") {
			return DiagnosticReference{}, errors.New("diagnostic cursor has leading zero")
		}
		cursor, err := strconv.ParseInt(match[5], 10, 64)
		if err != nil || cursor > MaxCursor {
			return DiagnosticReference{}, errors.New("diagnostic cursor is out of bounds")
		}
		reference.Cursor = int64Ptr(cursor)
	}
	return reference, nil
}

func ParseDiagnosticReference(input string) (DiagnosticReference, error) {
	return ParseReference(input)
}

func SafeOpaqueID(value string) bool { return safeOpaquePattern.MatchString(value) }

// FilterFingerprint is stable across struct field order and only includes the
// v1 filter fields that are present.
func FilterFingerprint(filter DiagnosticFilterV1) string {
	if filter.SchemaVersion == "" {
		filter.SchemaVersion = "DiagnosticFilter/v1"
	}
	value := map[string]any{"schemaVersion": filter.SchemaVersion}
	if filter.ParticipantID != "" {
		value["participantId"] = filter.ParticipantID
	}
	if filter.Source != "" {
		value["source"] = string(filter.Source)
	}
	if filter.OperationKind != "" {
		value["operationKind"] = filter.OperationKind
	}
	if filter.State != "" {
		value["state"] = filter.State
	}
	if filter.IssueState != "" {
		value["issueState"] = string(filter.IssueState)
	}
	if filter.ReleaseID != "" {
		value["releaseId"] = filter.ReleaseID
	}
	if filter.JourneyID != "" {
		value["journeyId"] = filter.JourneyID
	}
	if filter.TraceID != "" {
		value["traceId"] = filter.TraceID
	}
	if filter.SpanID != "" {
		value["spanId"] = filter.SpanID
	}
	if filter.RequestID != "" {
		value["requestId"] = filter.RequestID
	}
	if filter.CommandID != "" {
		value["commandId"] = filter.CommandID
	}
	if filter.ProviderID != "" {
		value["providerId"] = filter.ProviderID
	}
	if filter.FromCursor != nil {
		value["fromCursor"] = *filter.FromCursor
	}
	if filter.ToCursor != nil {
		value["toCursor"] = *filter.ToCursor
	}
	if !filter.FromTime.IsZero() {
		value["fromTime"] = filter.FromTime.UTC().Format(time.RFC3339Nano)
	}
	if !filter.ToTime.IsZero() {
		value["toTime"] = filter.ToTime.UTC().Format(time.RFC3339Nano)
	}
	canonical, _ := CanonicalJSON(value)
	return FingerprintBytes(canonical)
}

func FingerprintDiagnosticFilter(filter DiagnosticFilterV1) string { return FilterFingerprint(filter) }
func ValidateFilter(filter DiagnosticFilterV1) error {
	if filter.SchemaVersion != "" && filter.SchemaVersion != "DiagnosticFilter/v1" {
		return errors.New("unsupported DiagnosticFilter/v1 schema")
	}
	for key, value := range map[string]string{"participantId": filter.ParticipantID, "operationKind": filter.OperationKind, "releaseId": filter.ReleaseID, "journeyId": filter.JourneyID, "traceId": filter.TraceID} {
		if value != "" && !validToken(value, 160) {
			return fmt.Errorf("%s is not safe", key)
		}
	}
	if filter.SpanID != "" && filter.TraceID == "" {
		return errors.New("spanId requires traceId")
	}
	for key, value := range map[string]string{"spanId": filter.SpanID, "requestId": filter.RequestID, "commandId": filter.CommandID, "providerId": filter.ProviderID} {
		if value != "" && !validToken(value, 160) {
			return fmt.Errorf("%s is not safe", key)
		}
	}
	if filter.Source != "" {
		if _, ok := allowedSources[filter.Source]; !ok {
			return errors.New("source is not allowlisted")
		}
	}
	if filter.IssueState != "" && filter.IssueState != IssueOpen && filter.IssueState != IssueResolved {
		return errors.New("issue state is not allowlisted")
	}
	for _, cursor := range []*int64{filter.FromCursor, filter.ToCursor} {
		if cursor != nil && (*cursor < 0 || *cursor > MaxCursor) {
			return errors.New("cursor filter is out of bounds")
		}
	}
	if !filter.FromTime.IsZero() && !validDate(filter.FromTime) || !filter.ToTime.IsZero() && !validDate(filter.ToTime) {
		return errors.New("time filter is invalid")
	}
	if filter.FromCursor != nil && filter.ToCursor != nil && *filter.FromCursor > *filter.ToCursor {
		return errors.New("cursor filter range is inverted")
	}
	return nil
}

func ValidateAppendRequest(request AppendDiagnosticEventsRequest) error {
	if request.Version != 0 && request.Version != ContractVersion {
		return errors.New("unsupported append contract version")
	}
	if request.Producer.ID == "" || request.Producer.InstanceID == "" || request.Producer.Generation < 0 {
		return errors.New("append producer identity is invalid")
	}
	if request.Scope != nil {
		for key, value := range map[string]string{"tenantId": request.Scope.TenantID, "spaceId": request.Scope.SpaceID, "episodeId": request.Scope.EpisodeID} {
			if value == "" {
				return fmt.Errorf("append scope %s is required", key)
			}
		}
	}
	if len(request.Events) == 0 || len(request.Events) > MaxPageSize {
		return errors.New("append request must contain a bounded event batch")
	}
	for index, event := range request.Events {
		if err := ValidateDiagnosticEventDraft(event); err != nil {
			return fmt.Errorf("event %d: %w", index, err)
		}
	}
	return nil
}

func ValidateReference(reference DiagnosticReference) error {
	_, err := FormatReference(reference)
	return err
}
func ValidateDiagnosticReferenceString(value string) error {
	_, err := ParseReference(value)
	return err
}

func ValidateCheckpoint(checkpoint DiagnosticCheckpointDetail) error {
	if !validToken(checkpoint.Key, 96) {
		return errors.New("checkpoint key is not safe")
	}
	if _, ok := allowedCheckpointClasses[checkpoint.Class]; !ok {
		return errors.New("checkpoint class is not allowlisted")
	}
	if checkpoint.DisplayOrder < 0 || checkpoint.DisplayOrder > MaxPageSize {
		return errors.New("checkpoint display order is out of bounds")
	}
	if checkpoint.State != CheckpointPending && checkpoint.State != CheckpointObserved && checkpoint.State != CheckpointMissed && checkpoint.State != CheckpointNotObservable && checkpoint.State != CheckpointLateObserved {
		return errors.New("checkpoint state is not allowlisted")
	}
	if checkpoint.DeadlineAt != nil && !validDate(*checkpoint.DeadlineAt) {
		return errors.New("checkpoint deadline is invalid")
	}
	if checkpoint.EvidenceCursor < 0 || checkpoint.EvidenceCursor > MaxCursor {
		return errors.New("checkpoint evidence cursor is out of bounds")
	}
	if checkpoint.UnknownReason != "" {
		if _, ok := allowedUnknownReasons[checkpoint.UnknownReason]; !ok {
			return errors.New("checkpoint unknown reason is not allowlisted")
		}
	}
	return nil
}
func ValidateDiagnosticCheckpoint(checkpoint DiagnosticCheckpointDetail) error {
	return ValidateCheckpoint(checkpoint)
}

func ValidateOperation(operation DiagnosticOperationDetail) error {
	if !validToken(operation.ID, 128) || !validToken(operation.Kind, 128) {
		return errors.New("operation identity is not safe")
	}
	if operation.ExpectationVersion < 1 || operation.Attempt < 0 || !validDate(operation.StartedAt) {
		return errors.New("operation contract metadata is invalid")
	}
	if _, ok := allowedSources[operation.Source]; !ok {
		return errors.New("operation source is not allowlisted")
	}
	allowedStates := map[OperationState]struct{}{OperationRunning: {}, OperationRetrying: {}, OperationSucceeded: {}, OperationFailed: {}, OperationStalled: {}, OperationCancelled: {}, OperationTimedOut: {}}
	if _, ok := allowedStates[operation.State]; !ok {
		return errors.New("operation state is not allowlisted")
	}
	for _, checkpoint := range operation.Checkpoints {
		if err := ValidateCheckpoint(checkpoint); err != nil {
			return err
		}
	}
	return nil
}
func ValidateDiagnosticOperation(operation DiagnosticOperationDetail) error {
	return ValidateOperation(operation)
}

func ValidateIssue(value DiagnosticIssueDetail) error {
	if !validToken(value.ID, 128) || !validToken(value.Kind, 96) || value.Summary == "" || len(value.Summary) > 256 || !validDate(value.FirstObservedAt) {
		return errors.New("issue fields are invalid")
	}
	if value.Severity != IssueInfo && value.Severity != IssueWarning && value.Severity != IssueError && value.Severity != IssueCritical {
		return errors.New("issue severity is not allowlisted")
	}
	if value.State != IssueOpen && value.State != IssueResolved {
		return errors.New("issue state is not allowlisted")
	}
	if value.UnknownReason != "" {
		if _, ok := allowedUnknownReasons[value.UnknownReason]; !ok {
			return errors.New("issue unknown reason is not allowlisted")
		}
	}
	return nil
}
func ValidateDiagnosticIssue(value DiagnosticIssueDetail) error { return ValidateIssue(value) }

func ValidateBranch(branch DiagnosticBranchDetail) error {
	if !validToken(branch.ID, 128) || !validDate(branch.LeaseEndsAt) || branch.Attempts < 0 {
		return errors.New("branch fields are invalid")
	}
	if branch.Kind != BranchCleanup && branch.Kind != BranchRecording && branch.Kind != BranchTranscription && branch.Kind != BranchArtifact && branch.Kind != BranchWebhook {
		return errors.New("branch kind is not allowlisted")
	}
	if branch.State != BranchPending && branch.State != BranchRunning && branch.State != BranchSucceeded && branch.State != BranchFailed && branch.State != BranchCancelled && branch.State != BranchTimedOut {
		return errors.New("branch state is not allowlisted")
	}
	return nil
}
func ValidateDiagnosticBranch(branch DiagnosticBranchDetail) error { return ValidateBranch(branch) }

func ValidateSnapshot(snapshot DiagnosticSnapshotV1) error {
	if snapshot.SchemaVersion != "DiagnosticSnapshot/v1" || snapshot.Reference == "" || !validEnvironment(snapshot.Environment) || snapshot.CommittedCursor < 0 || snapshot.ProjectedCursor < 0 || snapshot.ProjectedCursor > snapshot.CommittedCursor {
		return errors.New("snapshot envelope is invalid")
	}
	if err := ValidateDiagnosticReferenceString(snapshot.Reference); err != nil {
		return err
	}
	if len(snapshot.Operations) > MaxPageSize || len(snapshot.Issues) > MaxPageSize || len(snapshot.Branches) > MaxPageSize || len(snapshot.Participants) > MaxPageSize {
		return errors.New("snapshot projection is unbounded")
	}
	for _, operation := range snapshot.Operations {
		if err := ValidateOperation(operation); err != nil {
			return err
		}
	}
	for _, issue := range snapshot.Issues {
		if err := ValidateIssue(issue); err != nil {
			return err
		}
	}
	for _, branch := range snapshot.Branches {
		if err := ValidateBranch(branch); err != nil {
			return err
		}
	}
	return nil
}
func ValidateDiagnosticSnapshot(snapshot DiagnosticSnapshotV1) error {
	return ValidateSnapshot(snapshot)
}

func ValidateAgentBrief(brief AgentBriefV1) error {
	if brief.SchemaVersion != "AgentBrief/v1" || brief.Version != 1 || !validEnvironment(brief.Environment) || !validDate(brief.CaptureTime) || brief.ObservedSummary == "" || len(brief.ObservedSummary) > 512 || !strings.HasPrefix(brief.ResolverCommand, "pnpm trace:inspect ") {
		return errors.New("agent brief envelope is invalid")
	}
	if err := ValidateDiagnosticReferenceString(brief.Reference); err != nil {
		return err
	}
	if brief.FocusedReference != "" {
		if err := ValidateDiagnosticReferenceString(brief.FocusedReference); err != nil {
			return err
		}
	}
	if len(brief.ReleaseCommits) > 128 || len(brief.VisibleGaps) > MaxPageSize || len(brief.Omissions) > MaxPageSize {
		return errors.New("agent brief is unbounded")
	}
	for key, count := range brief.Counts {
		if !regexp.MustCompile(`^[a-z][A-Za-z0-9_]{0,63}$`).MatchString(key) || count < 0 {
			return errors.New("agent brief count is unsafe")
		}
	}
	return nil
}
func ValidateAgentBriefV1(brief AgentBriefV1) error { return ValidateAgentBrief(brief) }

func ValidateExportManifest(manifest DiagnosticExportManifestV1) error {
	if manifest.SchemaVersion != "DiagnosticBundle/v1" || manifest.CursorFrom < 0 || manifest.CursorTo < manifest.CursorFrom || manifest.EventCount < 0 || manifest.OmissionCount < 0 {
		return errors.New("export manifest envelope is invalid")
	}
	if err := ValidateDiagnosticReferenceString(manifest.Reference); err != nil {
		return err
	}
	if len(manifest.Checksums) > MaxPageSize {
		return errors.New("export checksums are unbounded")
	}
	for key, value := range manifest.Checksums {
		if !regexp.MustCompile(`^[A-Za-z0-9_.-]{1,128}$`).MatchString(key) || value == "" || len(value) > 256 {
			return errors.New("export checksum is unsafe")
		}
	}
	if manifest.SplitParts < 0 {
		return errors.New("export split parts is invalid")
	}
	return nil
}
func ValidateDiagnosticExportManifest(manifest DiagnosticExportManifestV1) error {
	return ValidateExportManifest(manifest)
}

func ValidateExportJob(job DiagnosticExportJob) error {
	if job.SchemaVersion != "ExportJob/v1" || !validToken(job.JobID, 128) || !validDate(job.CreatedAt) || !validDate(job.LeaseEndsAt) || job.CursorFrom < 0 || job.CursorTo < 0 {
		return errors.New("export job envelope is invalid")
	}
	if err := ValidateDiagnosticReferenceString(job.Reference); err != nil {
		return err
	}
	switch job.State {
	case ExportQueued, ExportRunning, ExportSucceeded, ExportFailed, ExportCancelled, ExportExpired:
	default:
		return errors.New("export job state is not allowlisted")
	}
	if job.Manifest != nil {
		if err := ValidateExportManifest(*job.Manifest); err != nil {
			return err
		}
	}
	if job.Progress != nil && (job.Progress.ProcessedEvents < 0 || job.Progress.TotalEvents < 0 || job.Progress.CurrentCursor < 0 || job.Progress.Percent < 0 || job.Progress.Percent > 100) {
		return errors.New("export job progress is invalid")
	}
	if job.DownloadURL != "" && !strings.HasPrefix(job.DownloadURL, "/_internal/") {
		return errors.New("download URL is not internal")
	}
	return nil
}
func ValidateDiagnosticExportJob(job DiagnosticExportJob) error { return ValidateExportJob(job) }

func CanonicalTime(value time.Time) string {
	if value.IsZero() {
		return ""
	}
	return value.UTC().Format(time.RFC3339Nano)
}
