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

var allowedAttributes = map[string]struct{}{
	"action": {}, "checkpoint": {}, "reason": {}, "result": {}, "status": {}, "kind": {}, "direction": {}, "transport": {},
	"media_kind": {}, "track_state": {}, "permission": {}, "target_state": {}, "response_class": {}, "delivery_status": {},
	"storage_state": {}, "object_ref_class": {}, "attachment_type": {}, "size_bucket": {}, "safe_id_class": {}, "visibility": {},
	"recipient_count": {}, "projection_count": {}, "observable_recipient_count": {}, "attempt": {}, "retryable": {}, "budget_remaining": {},
	"backoff_ms": {}, "round_trip_1_ms": {}, "round_trip_2_ms": {}, "outstanding_age_1_ms": {}, "outstanding_age_2_ms": {},
	"duration_ms": {}, "latency_ms": {}, "bytes": {}, "count": {}, "cursor": {}, "sequence": {}, "grace_ms": {}, "deadline_ms": {},
	"state_version": {}, "policy_version": {}, "release_channel": {}, "close_code": {},
}

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
	"whiteboard.connect", "whiteboard.recover", "whiteboard.disconnect", "whiteboard.watchdog.replace",
}

var eventExtraRoots = []string{"coverage.started_late", "coverage.gap", "coverage.rejected", "operation.started", "operation.ended", "checkpoint.observed", "checkpoint.missed", "issue.opened", "issue.resolved", "branch.started", "branch.ended", "diagnostic.created", "diagnostic.ended", "diagnostic.completed", "whiteboard.connect", "whiteboard.recover", "whiteboard.disconnect"}

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

func FingerprintBytes(value []byte) string {
	digest := sha256.Sum256(value)
	return "sha256:" + hex.EncodeToString(digest[:])
}

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

func validEnvironment(environment Environment) bool {
	return environment == EnvironmentLocalhost || environment == EnvironmentDevelopment || environment == EnvironmentStaging || environment == EnvironmentProduction
}

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
