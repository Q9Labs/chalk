package postgres

import (
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// nullableText is the read-side mirror of text: sqlc exposes nullable text
// as pgtype.Text, while the domain/API model represents nullable strings with
// *string so JSON can naturally encode them as null.
func nullableText(value pgtype.Text) *string {
	if !value.Valid {
		return nil
	}

	return &value.String
}

// text is the adapter boundary from domain nullable strings into pgx's
// nullable text type. Keeping this conversion here prevents pgtype from leaking
// into service packages.
func text(value *string) pgtype.Text {
	if value == nil {
		return pgtype.Text{}
	}

	return pgtype.Text{String: *value, Valid: true}
}

// requiredText exists for non-null text columns in partial updates. sqlc
// generates string for NOT NULL text columns; the paired Set flag decides
// whether Postgres uses this value or keeps the existing one.
func requiredText(value utilities.OptionalString) string {
	if value.Value == nil {
		return ""
	}

	return *value.Value
}

func timestamp(value pgtype.Timestamptz) time.Time {
	if !value.Valid {
		return time.Time{}
	}

	return value.Time
}
