package provideroperations

import (
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestCanonicalizeOperationUsesProviderNeutralFields(t *testing.T) {
	tenant := testID(t, "10000000-0000-4000-8000-000000000001")
	session := testID(t, "10000000-0000-4000-8000-000000000002")
	participant := testID(t, "10000000-0000-4000-8000-000000000003")
	base := OperationInput{
		OperationID: "provider-operation-0001",
		Effect:      EffectGrantPublication, TenantID: tenant, SessionID: session,
		ParticipantSessionID: participant, PublicationSource: " CAMERA ",
	}
	first, err := Canonicalize(base)
	if err != nil {
		t.Fatalf("canonicalize first: %v", err)
	}
	second, err := Canonicalize(base)
	if err != nil {
		t.Fatalf("canonicalize second: %v", err)
	}
	if first.Fingerprint != second.Fingerprint {
		t.Fatal("canonical fingerprints differ for identical inputs")
	}
	if first.Input.PublicationSource != "camera" {
		t.Fatalf("source = %q, want camera", first.Input.PublicationSource)
	}
	if string(first.Payload) != `{"effect":"media.grant_publication","tenant_id":"10000000-0000-4000-8000-000000000001","session_id":"10000000-0000-4000-8000-000000000002","participant_session_id":"10000000-0000-4000-8000-000000000003","publication_source":"camera"}` {
		t.Fatalf("canonical payload = %s", first.Payload)
	}

	base.PublicationSource = "microphone"
	changed, err := Canonicalize(base)
	if err != nil {
		t.Fatalf("canonicalize changed: %v", err)
	}
	if first.Fingerprint == changed.Fingerprint {
		t.Fatal("changed source reused original fingerprint")
	}
}

func TestCanonicalizeOperationAllowsUnknownParticipantGeneration(t *testing.T) {
	input := OperationInput{
		OperationID: "provider-operation-0002", Effect: EffectRemoveParticipant,
		TenantID:             testID(t, "10000000-0000-4000-8000-000000000001"),
		SessionID:            testID(t, "10000000-0000-4000-8000-000000000002"),
		ParticipantSessionID: testID(t, "10000000-0000-4000-8000-000000000003"),
	}
	canonical, err := Canonicalize(input)
	if err != nil {
		t.Fatalf("canonicalize without generation: %v", err)
	}
	if string(canonical.Payload) != `{"effect":"media.remove_participant","tenant_id":"10000000-0000-4000-8000-000000000001","session_id":"10000000-0000-4000-8000-000000000002","participant_session_id":"10000000-0000-4000-8000-000000000003"}` {
		t.Fatalf("payload = %s", canonical.Payload)
	}
	input.ParticipantSessionID = utilities.ID{}
	input.ParticipantSessionGeneration = 1
	if _, err := Canonicalize(input); !errors.Is(err, ErrInvalidParticipantGeneration) {
		t.Fatalf("generation without participant error = %v", err)
	}
}

func TestCanonicalizeObservationSortsAndRejectsConflicts(t *testing.T) {
	input := ObservationInput{
		TenantID: testID(t, "10000000-0000-4000-8000-000000000001"), SessionID: testID(t, "10000000-0000-4000-8000-000000000002"),
		Incarnation: 7, Sequence: 2,
		Publications: []Publication{
			{ParticipantSessionID: testID(t, "10000000-0000-4000-8000-000000000004"), Source: "screen", Enabled: true},
			{ParticipantSessionID: testID(t, "10000000-0000-4000-8000-000000000003"), Source: "camera", Enabled: false},
		},
	}
	canonical, _, payload, err := CanonicalizeObservation(input)
	if err != nil {
		t.Fatalf("canonicalize observation: %v", err)
	}
	if canonical.Publications[0].ParticipantSessionID.String() != "10000000-0000-4000-8000-000000000003" {
		t.Fatalf("first participant = %s", canonical.Publications[0].ParticipantSessionID)
	}
	if string(payload) != `[{"participant_session_id":"10000000-0000-4000-8000-000000000003","source":"camera","enabled":false},{"participant_session_id":"10000000-0000-4000-8000-000000000004","source":"screen","enabled":true}]` {
		t.Fatalf("payload = %s", payload)
	}
	input.Publications = append(input.Publications, input.Publications[0])
	if _, _, _, err := CanonicalizeObservation(input); !errors.Is(err, ErrObservationConflict) {
		t.Fatalf("duplicate publication error = %v", err)
	}
}

func TestCompletionSeparatesUncertainAndRetryableStates(t *testing.T) {
	if err := (Completion{Outcome: OutcomeConfirmed}).Validate(); err != nil {
		t.Fatalf("confirmed completion: %v", err)
	}
	if err := (Completion{Outcome: OutcomeAmbiguous}).Validate(); !errors.Is(err, ErrNonTerminalOutcome) {
		t.Fatalf("ambiguous completion error = %v", err)
	}
	if err := (Completion{Outcome: OutcomeRetryableFailure}).Validate(); !errors.Is(err, ErrNonTerminalOutcome) {
		t.Fatalf("retryable completion error = %v", err)
	}
}

func testID(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatal(err)
	}
	return id
}
