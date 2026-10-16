package postgres

import (
	"context"

	"fmt"

	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/episodediagnostics"
)

func upsertDiagnosticBranch(ctx context.Context, queries *sqlc.Queries, tenantID, diagnosticID pgtype.UUID, branch episodediagnostics.DiagnosticBranchDetail) error {
	_, err := queries.UpsertDiagnosticBranch(ctx, sqlc.UpsertDiagnosticBranchParams{TenantID: tenantID, DiagnosticID: diagnosticID, ID: requiredUUID(branch.ID), Kind: string(branch.Kind), State: string(branch.State), LeaseEndsAt: timestamptz(&branch.LeaseEndsAt), StartedAt: optionalTimePtr(branch.StartedAt), TerminalAt: optionalTimePtr(branch.TerminalAt), TerminalCursor: optionalInt64Value(branch.TerminalCursor), Attempts: int32(maxInt(branch.Attempts, 0)), FanInChildren: diagnosticStringSliceJSON(branch.FanInChildren), LateObservations: pgtype.Int4{Int32: int32(maxInt(branch.LateObservations, 0)), Valid: true}, UnknownReason: diagnosticText(string(branch.UnknownReason))})
	if err != nil {
		return fmt.Errorf("upsert diagnostic branch: %w", err)
	}
	return nil
}

func diagnosticStringSliceJSON(values []string) []byte {
	if values == nil {
		values = []string{}
	}
	return diagnosticBytes(mustJSON(values))
}

func optionalUUID(value string) pgtype.UUID {
	if value == "" {
		return pgtype.UUID{}
	}
	return requiredUUID(value)
}

func optionalTimePtr(value *time.Time) pgtype.Timestamptz {
	if value == nil {
		return pgtype.Timestamptz{}
	}
	return timestamptz(value)
}

func optionalInt64Value(value int64) pgtype.Int8 {
	if value <= 0 {
		return pgtype.Int8{}
	}
	return pgtype.Int8{Int64: value, Valid: true}
}

func optionalInt64ValuePtr(value *int64) pgtype.Int8 {
	if value == nil || *value <= 0 {
		return pgtype.Int8{}
	}
	return pgtype.Int8{Int64: *value, Valid: true}
}

func maxInt(value, fallback int) int {
	if value < fallback {
		return fallback
	}
	return value
}
