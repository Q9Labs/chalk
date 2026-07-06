package postgres

import (
	"encoding/json"
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

func uuid(value utilities.ID) pgtype.UUID {
	if value.IsZero() {
		return pgtype.UUID{}
	}

	return pgtype.UUID{Bytes: value.Bytes(), Valid: true}
}

func nullableID(value pgtype.UUID) utilities.ID {
	if !value.Valid {
		return utilities.ID{}
	}

	return utilities.IDFromBytes(value.Bytes)
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

func jsonBytes(value json.RawMessage) []byte {
	if len(value) == 0 {
		return nil
	}

	return []byte(value)
}

func jsonRaw(value []byte) json.RawMessage {
	if len(value) == 0 {
		return nil
	}

	raw := make(json.RawMessage, len(value))
	copy(raw, value)
	return raw
}

func timestamp(value pgtype.Timestamptz) time.Time {
	if !value.Valid {
		return time.Time{}
	}

	return value.Time
}

func nullableTimestamp(value pgtype.Timestamptz) *time.Time {
	if !value.Valid {
		return nil
	}

	return &value.Time
}

func timestamptz(value *time.Time) pgtype.Timestamptz {
	if value == nil {
		return pgtype.Timestamptz{}
	}

	return pgtype.Timestamptz{Time: *value, Valid: true}
}
