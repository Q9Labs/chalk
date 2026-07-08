package httpapi

import (
	"encoding/json"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func rawJSONValue(raw json.RawMessage) any {
	if len(raw) == 0 {
		return nil
	}

	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil
	}

	return value
}

func optionalIDString(id utilities.ID) *string {
	if id.IsZero() {
		return nil
	}

	value := id.String()
	return &value
}

func optionalTimestampString(value *time.Time) *string {
	if value == nil {
		return nil
	}

	formatted := utilities.FormatTimestamp(*value)
	return &formatted
}
