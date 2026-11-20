package sdktelemetry

import (
	"encoding/json"
	"time"
)

// EvidencePayload returns only accepted, newly settled rows. A rejected event
// is represented by a ledger gap, never by a payload that could fill that gap.
func EvidencePayload(batch Request, fresh []Event, received time.Time, stamp Stamp) ([]byte, error) {
	type row struct {
		Service    map[string]string `json:"service"`
		Attributes map[string]any    `json:"attributes"`
	}
	rows := make([]row, 0, len(fresh))
	for _, event := range fresh {
		if event.Rejection() != "" {
			continue
		}
		attributes := map[string]any{
			"source_id": batch.SourceID, "batch_id": batch.BatchID,
		}
		if event.record != nil {
			addFields(attributes, stamp.Record)
			for _, attr := range event.record.attrs() {
				attributes[attr.Key] = attr.Value.Any()
			}
		} else {
			addFields(attributes, stamp.Legacy)
			attributes["event"] = "sdk.telemetry"
			attributes["received_at"] = received.UTC().Format(time.RFC3339Nano)
			addFields(attributes, event.Attributes())
		}
		rows = append(rows, row{Service: map[string]string{"name": "chalk-api"}, Attributes: attributes})
	}
	if len(rows) == 0 {
		return nil, nil
	}
	return json.Marshal(rows)
}

func addFields(attributes map[string]any, fields []any) {
	for i := 0; i < len(fields); i += 2 {
		attributes[fields[i].(string)] = fields[i+1]
	}
}
