package postgres

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/episodediagnostics"
)

func TestDiagnosticOperationMappingUsesSafeIdentifierRegistry(t *testing.T) {
	startedAt := time.Date(2026, 8, 4, 12, 0, 0, 0, time.UTC)
	detail := mapDiagnosticOperation(sqlc.DiagnosticOperation{
		Kind:           "chat.send",
		State:          string(episodediagnostics.OperationRunning),
		Source:         string(episodediagnostics.SourceAPI),
		StartedAt:      pgtype.Timestamptz{Time: startedAt, Valid: true},
		TraceID:        pgtype.Text{String: "not-hex", Valid: true},
		SpanID:         pgtype.Text{String: "0123456789abcdef", Valid: true},
		ProviderID:     pgtype.Text{String: "hmac:v1:private", Valid: true},
		VisibilityGaps: []byte(`[]`),
	}, episodediagnostics.EpisodeDiagnostic{})

	traceID, ok := detail.TraceID.(episodediagnostics.SafeIdentifier)
	if !ok || traceID.Value != "" || traceID.Copyable || traceID.UnknownReason != episodediagnostics.UnknownInvalid {
		t.Fatalf("invalid trace projection = %#v, want registry-backed invalid omission", detail.TraceID)
	}
	spanID, ok := detail.SpanID.(episodediagnostics.SafeIdentifier)
	if !ok || spanID.Value != "0123456789abcdef" || !spanID.Copyable || spanID.UnknownReason != "" {
		t.Fatalf("valid span projection = %#v, want copyable registry value", detail.SpanID)
	}
	providerID, ok := detail.ProviderID.(episodediagnostics.SafeIdentifier)
	if !ok || providerID.Value != "" || providerID.Copyable || providerID.UnknownReason != episodediagnostics.UnknownProviderOpaque {
		t.Fatalf("provider projection = %#v, want opaque registry value", detail.ProviderID)
	}
}

func TestDiagnosticParticipantMappingMatchesPublicContract(t *testing.T) {
	participant := mapDiagnosticParticipant(sqlc.ListDiagnosticParticipantsRow{
		ParticipantID:        pgtype.UUID{Bytes: [16]byte{1}, Valid: true},
		LatestLifecycleName:  "participant.reconnect",
		LatestLifecycleState: string(episodediagnostics.EventObserved),
	}, 1)

	if participant.AnonymousLabel != "Participant 1" || participant.Display.Label.Value != "Participant 1" {
		t.Fatalf("participant label = %q / %q, want stable anonymous label", participant.AnonymousLabel, participant.Display.Label.Value)
	}
	if participant.IdentityKind != "unknown" || participant.State != "joined" || participant.Visibility != "not_observable" {
		t.Fatalf("participant contract values = identity %q, state %q, visibility %q", participant.IdentityKind, participant.State, participant.Visibility)
	}
	if err := episodediagnostics.ValidateParticipantProjection(participant); err != nil {
		t.Fatalf("mapped participant violates public contract: %v", err)
	}
}

func TestDiagnosticParticipantMappingReservesReconnectingForPendingReconnect(t *testing.T) {
	row := sqlc.ListDiagnosticParticipantsRow{
		ParticipantID:        pgtype.UUID{Bytes: [16]byte{1}, Valid: true},
		LatestLifecycleName:  "participant.reconnect",
		LatestLifecycleState: string(episodediagnostics.EventStarted),
	}
	if state := mapDiagnosticParticipant(row, 1).State; state != "reconnecting" {
		t.Fatalf("pending reconnect state = %q, want reconnecting", state)
	}
	row.LatestLifecycleState = string(episodediagnostics.EventSucceeded)
	if state := mapDiagnosticParticipant(row, 1).State; state != "joined" {
		t.Fatalf("completed reconnect state = %q, want joined", state)
	}
}

func TestFilteredDiagnosticParticipantKeepsRosterOrdinal(t *testing.T) {
	first := pgtype.UUID{Bytes: [16]byte{15: 1}, Valid: true}
	second := pgtype.UUID{Bytes: [16]byte{15: 2}, Valid: true}
	rows := []sqlc.ListDiagnosticParticipantsRow{{ParticipantID: first}, {ParticipantID: second}}
	queries := diagnosticParticipantQueriesStub{rows: rows, selected: sqlc.GetDiagnosticParticipantProjectionRow{ParticipantID: second, Ordinal: 2}}

	all, err := loadDiagnosticParticipantProjections(context.Background(), &queries, pgtype.UUID{}, pgtype.UUID{}, pgtype.UUID{}, 100)
	if err != nil {
		t.Fatal(err)
	}
	filtered, err := loadDiagnosticParticipantProjections(context.Background(), &queries, pgtype.UUID{}, pgtype.UUID{}, second, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 2 || len(filtered) != 1 {
		t.Fatalf("participant counts = all %d, filtered %d", len(all), len(filtered))
	}
	if filtered[0].AnonymousLabel != all[1].AnonymousLabel || filtered[0].AnonymousLabel != "Participant 2" {
		t.Fatalf("filtered label = %q, want stable %q", filtered[0].AnonymousLabel, all[1].AnonymousLabel)
	}
	if queries.getCalls != 1 {
		t.Fatalf("filtered participant queries = %d, want one indexed lookup", queries.getCalls)
	}
}

func TestFilteredDiagnosticParticipantMissingReturnsEmptyAfterOneLookup(t *testing.T) {
	queries := diagnosticParticipantQueriesStub{}
	participants, err := loadDiagnosticParticipantProjections(context.Background(), &queries, pgtype.UUID{}, pgtype.UUID{}, pgtype.UUID{Bytes: [16]byte{15: 3}, Valid: true}, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(participants) != 0 {
		t.Fatalf("missing participant result count = %d, want empty", len(participants))
	}
	if queries.getCalls != 1 {
		t.Fatalf("missing participant queries = %d, want one indexed lookup", queries.getCalls)
	}
}

type diagnosticParticipantQueriesStub struct {
	rows     []sqlc.ListDiagnosticParticipantsRow
	selected sqlc.GetDiagnosticParticipantProjectionRow
	getCalls int
}

func (s diagnosticParticipantQueriesStub) ListDiagnosticParticipants(_ context.Context, params sqlc.ListDiagnosticParticipantsParams) ([]sqlc.ListDiagnosticParticipantsRow, error) {
	return s.rows[:min(len(s.rows), int(params.PageLimit))], nil
}

func (s *diagnosticParticipantQueriesStub) GetDiagnosticParticipantProjection(_ context.Context, params sqlc.GetDiagnosticParticipantProjectionParams) (sqlc.GetDiagnosticParticipantProjectionRow, error) {
	s.getCalls++
	if s.selected.ParticipantID.Valid && s.selected.ParticipantID.Bytes == params.ParticipantID.Bytes {
		return s.selected, nil
	}
	return sqlc.GetDiagnosticParticipantProjectionRow{}, pgx.ErrNoRows
}

func TestDiagnosticEventOperatorMappingOmitsProviderHMAC(t *testing.T) {
	row := sqlc.DiagnosticEvent{
		EventID:      "event_provider_opaque",
		EventVersion: 1,
		Name:         "sync.connect",
		Phase:        "connected",
		State:        string(episodediagnostics.EventSucceeded),
		Source:       string(episodediagnostics.SourceSync),
		ProviderID:   pgtype.Text{String: "hmac:v1:provider-secret", Valid: true},
		OccurredAt:   pgtype.Timestamptz{Time: time.Date(2026, 8, 4, 12, 0, 0, 0, time.UTC), Valid: true},
		ReceivedAt:   pgtype.Timestamptz{Time: time.Date(2026, 8, 4, 12, 0, 1, 0, time.UTC), Valid: true},
	}

	internal := mapDiagnosticEventForProjection(row)
	if internal.Correlation == nil || internal.Correlation.ProviderID == "" {
		t.Fatalf("internal projection lost provider lookup value: %+v", internal.Correlation)
	}
	public := mapDiagnosticEventForOperator(row)
	if public.Correlation != nil && public.Correlation.ProviderID != "" {
		t.Fatalf("operator event exposed provider lookup value: %+v", public.Correlation)
	}
	encoded, err := json.Marshal(public)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "hmac:v1:provider-secret") {
		t.Fatalf("operator event JSON exposed provider HMAC: %s", encoded)
	}
}

func TestDiagnosticIssueMappingDoesNotTrustPersistedSafeIdentifierFlags(t *testing.T) {
	issue := mapDiagnosticIssue(sqlc.DiagnosticIssue{
		Kind:               "missing_checkpoint",
		Severity:           string(episodediagnostics.IssueWarning),
		State:              string(episodediagnostics.IssueOpen),
		Summary:            "checkpoint evidence is missing",
		FirstObservedAt:    pgtype.Timestamptz{Time: time.Date(2026, 8, 4, 12, 0, 0, 0, time.UTC), Valid: true},
		AffectedKind:       pgtype.Text{String: "provider", Valid: true},
		AffectedIDClass:    pgtype.Text{String: "provider", Valid: true},
		AffectedIDValue:    pgtype.Text{String: "raw-provider-secret", Valid: true},
		AffectedIDCopyable: pgtype.Bool{Bool: true, Valid: true},
	}, episodediagnostics.EpisodeDiagnostic{})

	if issue.Affected == nil || issue.Affected.Identifier.Value != "" || issue.Affected.Identifier.Copyable || issue.Affected.Identifier.UnknownReason != episodediagnostics.UnknownProviderOpaque {
		t.Fatalf("affected identifier = %#v, want registry-backed opaque value", issue.Affected)
	}
}
