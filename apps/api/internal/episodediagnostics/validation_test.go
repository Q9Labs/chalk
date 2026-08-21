package episodediagnostics

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func draftFixture() DiagnosticEventDraft {
	return DiagnosticEventDraft{
		Version: 1, EventID: "event01", ProducerOperationRef: "op01", ProducerSequence: 1,
		OccurredAt: time.Date(2026, 8, 4, 0, 0, 0, 0, time.UTC), Source: SourceSDK,
		Name: "chat.send", Phase: "intent", State: EventStarted,
		Attributes: DiagnosticAttributes{"status": "accepted", "retryable": false},
	}
}

func TestValidateDraftCanonicalAndFingerprint(t *testing.T) {
	validated, err := ValidateDraft(draftFixture())
	if err != nil {
		t.Fatalf("validate draft: %v", err)
	}
	if !strings.HasPrefix(validated.Fingerprint, "sha256:") || len(validated.Fingerprint) != len("sha256:")+64 {
		t.Fatalf("unexpected fingerprint %q", validated.Fingerprint)
	}
	if validated.SizeBytes != len(validated.Canonical) || validated.SizeBytes > MaxDiagnosticEventBytes {
		t.Fatalf("invalid canonical size: %d", validated.SizeBytes)
	}
	if !strings.HasPrefix(string(validated.Canonical), `{"attributes":`) {
		t.Fatalf("canonical keys are not sorted: %s", validated.Canonical)
	}
	if _, err := CanonicalEvent(DiagnosticEventDraft{Version: 1}); err == nil {
		t.Fatal("invalid draft was canonicalized")
	}
}

func TestValidateParticipantProjectionRejectsLegacyServerValues(t *testing.T) {
	participant := ParticipantProjectionV1{
		SchemaVersion:  "ParticipantProjection/v1",
		ParticipantID:  "participant01",
		AnonymousLabel: "Participant 1",
		IdentityKind:   "unknown",
		State:          "joined",
		Visibility:     "not_observable",
		VisibilityGaps: []string{"identity_redacted"},
		Display: ParticipantDisplay{
			Label:       DisplayValue{Value: "Participant 1"},
			RawIdentity: DisplayValue{UnknownReason: UnknownRedacted},
		},
	}
	if err := ValidateParticipantProjection(participant); err != nil {
		t.Fatalf("canonical Participant projection rejected: %v", err)
	}

	participant.AnonymousLabel = "participant-452a645d"
	participant.IdentityKind = "anonymous"
	participant.Visibility = "opaque"
	if err := ValidateParticipantProjection(participant); err == nil {
		t.Fatal("legacy server Participant projection was accepted")
	}
}

func TestValidateDraftRejectsUnknownAndUnsafeValues(t *testing.T) {
	event := draftFixture()
	event.Name = "made_up.action"
	if err := ValidateDiagnosticEventDraft(event); err == nil {
		t.Fatal("unknown action accepted")
	}
	event = draftFixture()
	event.Attributes = DiagnosticAttributes{"message": "chat text"}
	if err := ValidateDiagnosticEventDraft(event); err == nil {
		t.Fatal("content attribute accepted")
	}
	event = draftFixture()
	event.Phase = "transport"
	if err := ValidateDiagnosticEventDraft(event); err == nil {
		t.Fatal("unknown phase accepted")
	}
	event = draftFixture()
	event.Attributes = DiagnosticAttributes{"reason": strings.Repeat("x", 256), "result": strings.Repeat("y", 256), "status": strings.Repeat("z", 256), "kind": strings.Repeat("k", 256), "transport": strings.Repeat("t", 256), "visibility": strings.Repeat("v", 256), "object_ref_class": strings.Repeat("o", 256), "attachment_type": strings.Repeat("a", 256), "size_bucket": strings.Repeat("s", 256)}
	if err := ValidateDiagnosticEventDraft(event); err == nil {
		t.Fatal("oversized event accepted")
	}
}

func TestAcceptEventAndReferenceGrammar(t *testing.T) {
	event, err := AcceptEvent(draftFixture(), "diag01", 7, time.Date(2026, 8, 4, 0, 0, 1, 0, time.UTC))
	if err != nil {
		t.Fatalf("accept event: %v", err)
	}
	if event.Cursor != 7 || event.DiagnosticID != "diag01" {
		t.Fatalf("accepted envelope lost identity: %+v", event)
	}
	if err := ValidateAcceptedEvent(event); err != nil {
		t.Fatalf("accepted event validation: %v", err)
	}
	cursor := int64(9)
	formatted, err := FormatReference(DiagnosticReference{Version: 1, Environment: EnvironmentDevelopment, DiagnosticID: "diag01", Focus: &DiagnosticReferenceFocus{Kind: ReferenceFocusIssue, ID: "issue01"}, Cursor: &cursor})
	if err != nil {
		t.Fatalf("format reference: %v", err)
	}
	parsed, err := ParseReference(formatted)
	if err != nil {
		t.Fatalf("parse reference: %v", err)
	}
	if parsed.Environment != EnvironmentDevelopment || parsed.Focus == nil || parsed.Focus.Kind != ReferenceFocusIssue || parsed.Cursor == nil || *parsed.Cursor != 9 {
		t.Fatalf("round trip mismatch: %+v", parsed)
	}
	productionReference := DiagnosticReference{Version: ContractVersion, Environment: EnvironmentProduction, DiagnosticID: "diag01"}
	productionFormatted, err := FormatReference(productionReference)
	if err != nil || productionFormatted != "chalkdiag:v1:production:diag01" {
		t.Fatalf("format production reference = %q, %v", productionFormatted, err)
	}
	productionParsed, err := ParseReference(productionFormatted)
	if err != nil || productionParsed != productionReference {
		t.Fatalf("parse production reference = %+v, %v; want %+v", productionParsed, err, productionReference)
	}
	for _, malformed := range []string{"chalkdiag:v1:preview:diag01", "chalkdiag:v1:development:diag01:span:x", "chalkdiag:v1:development:diag01@01", "chalkdiag:v1:development:diag01@9007199254740992"} {
		if _, err := ParseReference(malformed); err == nil {
			t.Fatalf("malformed reference accepted: %s", malformed)
		}
	}
}

func TestRedactionAndFilterFingerprint(t *testing.T) {
	redacted := RedactAttributes(DiagnosticAttributes{"status": "committed", "bytes": 4, "message": "secret", "token": "Bearer x"})
	if len(redacted.Attributes) != 2 || len(redacted.RedactedKeys) != 2 {
		t.Fatalf("unexpected redaction result: %+v", redacted)
	}
	left := FilterFingerprint(DiagnosticFilterV1{Source: SourceSDK, State: "failed"})
	right := FilterFingerprint(DiagnosticFilterV1{State: "failed", Source: SourceSDK})
	if left != right {
		t.Fatalf("filter fingerprint changed with field order: %s != %s", left, right)
	}
}

func TestFilterFingerprintPreservesExplicitZeroCursors(t *testing.T) {
	zero := int64(0)
	filter := DiagnosticFilterV1{
		SchemaVersion: "DiagnosticFilter/v1",
		Source:        SourceSDK,
		FromCursor:    &zero,
		ToCursor:      &zero,
	}
	const want = "sha256:bcde6b716f93fe0e4552685bb605fa6116afb0074ffbd755bf3d1780d365d67b"
	if got := FilterFingerprint(filter); got != want {
		t.Fatalf("fingerprint = %q, want TypeScript contract value %q", got, want)
	}
	if got := FilterFingerprint(DiagnosticFilterV1{SchemaVersion: "DiagnosticFilter/v1", Source: SourceSDK}); got == want {
		t.Fatalf("omitted and explicit-zero cursor filters share fingerprint %q", got)
	}
}

func TestFilterFingerprintMatchesCrossLanguageVector(t *testing.T) {
	zero := int64(0)
	seven := int64(7)
	filter := DiagnosticFilterV1{SchemaVersion: "DiagnosticFilter/v1", Source: SourceSDK, State: "failed", FromCursor: &zero, ToCursor: &seven}
	const want = "sha256:4768a58cf9cea3430698350c6aadf9b915085c9ea6f20d224fbc9940e26d89c0"
	if got := FilterFingerprint(filter); got != want {
		t.Fatalf("fingerprint = %q, want TypeScript contract vector %q", got, want)
	}
}

func TestAppendRequestWireShape(t *testing.T) {
	request := AppendDiagnosticEventsRequest{Version: 1, Producer: ProducerIdentity{ID: "sdk", InstanceID: "instance", Generation: 2}, Scope: &AppendScope{TenantID: "tenant", SpaceID: "space", EpisodeID: "episode"}, Events: []DiagnosticEventDraft{draftFixture()}}
	if err := ValidateAppendRequest(request); err != nil {
		t.Fatalf("append validation: %v", err)
	}
	encoded, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), `"environment"`) || !strings.Contains(string(encoded), `"instanceId"`) {
		t.Fatalf("append wire shape drifted: %s", encoded)
	}
}
