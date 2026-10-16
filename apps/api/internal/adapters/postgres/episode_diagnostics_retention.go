package postgres

import (
	"context"
	"github.com/jackc/pgx/v5"

	"errors"
	"fmt"

	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/episodediagnostics"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func (r *EpisodeDiagnosticsRepository) Retain(ctx context.Context, now time.Time, limit int) (int, error) {
	if r.queryPool == nil {
		return 0, errDiagnosticsUnavailable
	}
	if limit <= 0 {
		limit = episodediagnostics.DefaultPageSize
	}
	if limit > episodediagnostics.MaxPageSize {
		limit = episodediagnostics.MaxPageSize
	}
	claimID, err := utilities.NewID()
	if err != nil {
		return 0, fmt.Errorf("generate diagnostic retention claim: %w", err)
	}
	claimedUntil := now.Add(time.Duration(diagnosticRetentionClaimSeconds) * time.Second)
	claims, err := sqlc.New(r.queryPool).ClaimExpiredDiagnostics(ctx, sqlc.ClaimExpiredDiagnosticsParams{NowAt: timestamptz(&now), ClaimToken: uuid(claimID), ClaimedUntil: timestamptz(&claimedUntil), PageLimit: int32(limit)})
	if err != nil {
		return 0, fmt.Errorf("claim expired diagnostics: %w", err)
	}
	deleted := 0
	for _, claim := range claims {
		for {
			rows, deleteErr := sqlc.New(r.queryPool).DeleteDiagnosticEventBatch(ctx, sqlc.DeleteDiagnosticEventBatchParams{TenantID: claim.TenantID, DiagnosticID: claim.ID, PageLimit: 10000})
			if deleteErr != nil {
				return deleted, fmt.Errorf("delete expired diagnostic events: %w", deleteErr)
			}
			if rows == 0 {
				break
			}
		}
		var removed sqlc.EpisodeDiagnostic
		err = withDiagnosticTx(ctx, r.queryPool, func(tx pgx.Tx) error {
			queries := sqlc.New(tx)
			if _, err := queries.DeleteDiagnosticProjectionChanges(ctx, sqlc.DeleteDiagnosticProjectionChangesParams{TenantID: claim.TenantID, DiagnosticID: claim.ID}); err != nil {
				return fmt.Errorf("delete expired diagnostic projection changes: %w", err)
			}
			if _, err := queries.DeleteDiagnosticReferences(ctx, sqlc.DeleteDiagnosticReferencesParams{TenantID: claim.TenantID, DiagnosticID: claim.ID}); err != nil {
				return fmt.Errorf("delete expired diagnostic references: %w", err)
			}
			if _, err := queries.DeleteDiagnosticProjectorState(ctx, sqlc.DeleteDiagnosticProjectorStateParams{TenantID: claim.TenantID, DiagnosticID: claim.ID}); err != nil {
				return fmt.Errorf("delete expired diagnostic projector state: %w", err)
			}
			removed, err = queries.DeleteDiagnosticRoot(ctx, sqlc.DeleteDiagnosticRootParams{TenantID: claim.TenantID, DiagnosticID: claim.ID, NowAt: timestamptz(&now), ClaimToken: uuid(claimID)})
			return err
		})
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return deleted, err
		}
		if removed.ID.Valid {
			deleted++
		}
	}
	return deleted, nil
}
