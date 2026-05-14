package jobs

import (
	"context"

	"github.com/google/uuid"

	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
)

// DBTenantGetter implements TenantConfigGetter using the database queries.
type DBTenantGetter struct {
	queries *db.Queries
}

// NewDBTenantGetter creates a new database-backed tenant getter.
func NewDBTenantGetter(queries *db.Queries) *DBTenantGetter {
	return &DBTenantGetter{queries: queries}
}

// GetTenantByRoomID retrieves the tenant associated with a room.
func (g *DBTenantGetter) GetTenantByRoomID(ctx context.Context, roomID uuid.UUID) (*db.Tenant, error) {
	tenant, err := g.queries.GetTenantByRoomID(ctx, roomID)
	if err != nil {
		return nil, err
	}
	return &tenant, nil
}
