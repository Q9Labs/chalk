package postgres

import (
	"strings"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
)

func nullableOutcome(value pgtype.Text) *provideroperations.Outcome {
	if !value.Valid {
		return nil
	}
	outcome := provideroperations.Outcome(value.String)
	return &outcome
}

func providerNullableTextPointer(value pgtype.Text) *string {
	if !value.Valid {
		return nil
	}
	result := value.String
	return &result
}

func providerNullableTextValue(value pgtype.Text) string {
	if !value.Valid {
		return ""
	}
	return value.String
}

func sameReason(existing *string, requested *string) bool {
	if existing == nil || requested == nil {
		return existing == nil && requested == nil
	}
	return strings.TrimSpace(*existing) == strings.TrimSpace(*requested)
}

func providerOptionalInt8(value int64) pgtype.Int8 {
	if value == 0 {
		return pgtype.Int8{}
	}
	return pgtype.Int8{Int64: value, Valid: true}
}

func providerNullableInt64(value pgtype.Int8) int64 {
	if !value.Valid {
		return 0
	}
	return value.Int64
}

func providerText(value string) pgtype.Text {
	if value == "" {
		return pgtype.Text{}
	}
	return pgtype.Text{String: value, Valid: true}
}

func providerTextPointer(value *string) pgtype.Text {
	if value == nil {
		return pgtype.Text{}
	}
	return providerText(strings.TrimSpace(*value))
}
