package postgres

import "context"

type screenAnnotationQueries interface {
	ScreenAnnotationEnabled(ctx context.Context, defaultEnabled bool) (bool, error)
}

type ScreenAnnotationSettings struct {
	Queries        screenAnnotationQueries
	DefaultEnabled bool
}

// Enabled reads the runtime override, or the process default when no override exists.
// If the database cannot establish availability, do not advertise annotation.
func (s ScreenAnnotationSettings) Enabled(ctx context.Context) bool {
	enabled, err := s.Queries.ScreenAnnotationEnabled(ctx, s.DefaultEnabled)
	return err == nil && enabled
}
