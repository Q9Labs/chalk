package observability

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"slices"
)

// LogEvidence writes each stored evidence row to logger, as one log line with the row's attributes.
// It is the export for an installation that has no Axiom ingest grant, so accepted telemetry
// reaches the ordinary logs instead of waiting in the outbox. The relay deletes a row once this
// returns, so a line the logger would drop is an error, not a success: the lines go out at the
// highest standard level, which no supported log level filters, and a logger that still has that
// level disabled keeps the rows queued. Each line names its producer in `evidence_service`,
// because the logger's own `service` is the API's.
func LogEvidence(logger *slog.Logger) EvidenceExport {
	return func(ctx context.Context, rows []json.RawMessage) error {
		if !logger.Enabled(ctx, slog.LevelError) {
			return errors.New("the service log drops evidence lines, so the rows stay queued")
		}
		for _, raw := range rows {
			var stored struct {
				Service struct {
					Name string `json:"name"`
				} `json:"service"`
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
			attrs := make([]slog.Attr, 0, len(keys)+1)
			if stored.Service.Name != "" {
				attrs = append(attrs, slog.String("evidence_service", stored.Service.Name))
			}
			for _, key := range keys {
				attrs = append(attrs, slog.Any(key, stored.Attributes[key]))
			}
			logger.LogAttrs(ctx, slog.LevelError, "call evidence", attrs...)
		}
		return nil
	}
}
