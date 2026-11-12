package postgres

import (
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func renderOptionalInt8(value *int64) pgtype.Int8 {
	if value == nil {
		return pgtype.Int8{}
	}
	return pgtype.Int8{Int64: *value, Valid: true}
}

func renderNullableInt64(value pgtype.Int8) *int64 {
	if !value.Valid {
		return nil
	}
	result := value.Int64
	return &result
}

func cloneRenderInt64(value *int64) *int64 {
	if value == nil {
		return nil
	}
	result := *value
	return &result
}

func equalRenderInt64(left, right *int64) bool {
	if left == nil || right == nil {
		return left == right
	}
	return *left == *right
}

func ids(values []pgtype.UUID) []utilities.ID {
	result := make([]utilities.ID, 0, len(values))
	for _, value := range values {
		if value.Valid {
			result = append(result, id(value))
		}
	}
	return result
}
