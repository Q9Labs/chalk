package postgres

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/providerbridge"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// SourceGrants reads the grants whose forwarding leases the API renews. It reads
// Sync's durable authorization tables, which share the API's database.
type SourceGrants struct{ queries *sqlc.Queries }

func NewSourceGrants(db sqlc.DBTX) SourceGrants {
	return SourceGrants{queries: sqlc.New(db)}
}

func (s SourceGrants) ListRenewableSourceGrants(ctx context.Context, after providerbridge.SourceGrant, limit int) ([]providerbridge.SourceGrant, error) {
	rows, err := s.queries.ListRenewableSourceGrants(ctx, sqlc.ListRenewableSourceGrantsParams{
		AfterTenantID:      uuidOrZero(after.TenantID),
		AfterEpisodeID:     uuidOrZero(after.EpisodeID),
		AfterParticipantID: uuidOrZero(after.ParticipantID),
		AfterSource:        after.Source,
		PageSize:           int32(min(limit, 10_000)),
	})
	if err != nil {
		return nil, fmt.Errorf("list renewable source grants: %w", err)
	}
	grants := make([]providerbridge.SourceGrant, 0, len(rows))
	for _, row := range rows {
		grants = append(grants, providerbridge.SourceGrant{
			TenantID:      nullableID(row.TenantID),
			EpisodeID:     nullableID(row.EpisodeID),
			Node:          row.Node,
			ParticipantID: nullableID(row.ParticipantID),
			Source:        row.Source,
			Revision:      row.ControlRevision,
		})
	}
	return grants, nil
}

// uuidOrZero keeps the zero ID as the all-zero UUID rather than null, so the
// first page's row comparison has a lower bound instead of matching nothing.
func uuidOrZero(id utilities.ID) pgtype.UUID {
	return pgtype.UUID{Bytes: id.Bytes(), Valid: true}
}
