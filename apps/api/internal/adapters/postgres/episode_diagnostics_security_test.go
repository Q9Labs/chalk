package postgres

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

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
