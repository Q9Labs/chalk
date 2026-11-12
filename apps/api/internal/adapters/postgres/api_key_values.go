package postgres

import (
	"net/netip"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/apikeys"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func listTenantAPIKeysParams(tenantID utilities.ID, page pagination.PageRequest) sqlc.ListTenantAPIKeysParams {
	params := sqlc.ListTenantAPIKeysParams{
		TenantID: uuid(tenantID),
		PageSize: int32(page.Size() + 1),
	}
	if cursor := page.Cursor(); cursor != nil {
		params.CursorSet = true
		params.CursorCreatedAt = pgtype.Timestamptz{Time: cursor.CreatedAt, Valid: true}
		params.CursorID = uuid(cursor.ID)
	}
	return params
}

func mapAPIKeyRow(row sqlc.GetTenantAPIKeyRow) apikeys.Record {
	return apikeys.Record{
		KeyHash: row.KeyHash,
		Key: apikeys.Key{
			ID:              utilities.IDFromBytes(row.ID.Bytes),
			TenantID:        utilities.IDFromBytes(row.TenantID.Bytes),
			Name:            row.Name,
			Scopes:          apiKeyScopes(row.Scopes),
			Prefix:          row.KeyPrefix,
			CreatedByUserID: nullableID(row.CreatedByUserID),
			LastUsedAt:      nullableTimestamp(row.LastUsedAt),
			RevokedAt:       nullableTimestamp(row.RevokedAt),
			ExpiresAt:       timestamp(row.ExpiresAt),
			UpdatedAt:       timestamp(row.UpdatedAt),
			CreatedAt:       timestamp(row.CreatedAt),
		},
	}
}

func apiKeyScopeStrings(scopes []authentication.Scope) []string {
	values := make([]string, len(scopes))
	for index, scope := range scopes {
		values[index] = string(scope)
	}
	return values
}

func apiKeyScopes(values []string) []authentication.Scope {
	scopes := make([]authentication.Scope, len(values))
	for index, value := range values {
		scopes[index] = authentication.Scope(value)
	}
	return scopes
}

func validIPAddress(address netip.Addr) *netip.Addr {
	if !address.IsValid() {
		return nil
	}
	return &address
}
