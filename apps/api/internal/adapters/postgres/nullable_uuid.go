package postgres

import (
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/platform/utilities"
)

func nullableUUID(id utilities.ID) pgtype.UUID {
	if id.IsZero() {
		return pgtype.UUID{}
	}
	return uuid(id)
}
