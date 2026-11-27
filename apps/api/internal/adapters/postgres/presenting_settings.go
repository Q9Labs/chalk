package postgres

import "context"

type presentingSettingsQueries interface {
	PresentingEnabled(ctx context.Context, defaultEnabled bool) (bool, error)
}

// PresentingSettings is the one answer to "does this API serve Presenting". Servable is what this
// process wired at startup; the runtime override can only turn a servable Presenting off. The API
// publishes Servable to presenting_api_capability so Sync offers Presenting under the same answer.
type PresentingSettings struct {
	Queries  presentingSettingsQueries
	Servable bool
}

func (s PresentingSettings) Enabled(ctx context.Context) bool {
	if !s.Servable {
		return false
	}
	enabled, err := s.Queries.PresentingEnabled(ctx, true)
	return err == nil && enabled
}
