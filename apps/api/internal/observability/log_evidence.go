package observability

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"slices"
)

// LogEvidence writes each stored evidence row to logger, as one log line with the row's attributes.
// It is the export for an installation that has no Axiom ingest grant, so accepted telemetry
// reaches the ordinary logs instead of waiting in the outbox.
func LogEvidence(logger *slog.Logger) EvidenceExport {
	return func(ctx context.Context, rows []json.RawMessage) error {
		for _, raw := range rows {
			var stored struct {
				Attributes map[string]any `json:"attributes"`
			}
			if err := json.Unmarshal(raw, &stored); err != nil {
				return fmt.Errorf("read stored evidence row: %w", err)
			}
			keys := make([]string, 0, len(stored.Attributes))
			for key := range stored.Attributes {
				keys = append(keys, key)
			}
			slices.Sort(keys)
			attrs := make([]slog.Attr, 0, len(keys))
			for _, key := range keys {
				attrs = append(attrs, slog.Any(key, stored.Attributes[key]))
			}
			logger.LogAttrs(ctx, slog.LevelInfo, "SDK telemetry", attrs...)
		}
		return nil
	}
}
