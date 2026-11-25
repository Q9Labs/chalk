package postgres

import "context"

type presentingSettingsQueries interface {
	PresentingEnabled(ctx context.Context, defaultEnabled bool) (bool, error)
}

type PresentingSettings struct {
	Queries        presentingSettingsQueries
	DefaultEnabled bool
}

func (s PresentingSettings) Enabled(ctx context.Context) bool {
	enabled, err := s.Queries.PresentingEnabled(ctx, s.DefaultEnabled)
	return err == nil && enabled
}
