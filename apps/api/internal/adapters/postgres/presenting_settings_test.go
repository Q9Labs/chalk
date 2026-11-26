package postgres

import (
	"context"
	"errors"
	"testing"
)

type presentingQueriesFake struct {
	override *bool
	err      error
}

func (f presentingQueriesFake) PresentingEnabled(_ context.Context, defaultEnabled bool) (bool, error) {
	if f.err != nil {
		return false, f.err
	}
	if f.override != nil {
		return *f.override, nil
	}
	return defaultEnabled, nil
}

func TestPresentingSettingsNeverOfferWhatTheAPICannotServe(t *testing.T) {
	enabled, disabled := true, false
	tests := []struct {
		name     string
		servable bool
		queries  presentingQueriesFake
		want     bool
	}{
		{"servable without an override", true, presentingQueriesFake{}, true},
		{"servable with the override on", true, presentingQueriesFake{override: &enabled}, true},
		{"servable with the override off", true, presentingQueriesFake{override: &disabled}, false},
		{"servable but the database cannot answer", true, presentingQueriesFake{err: errors.New("down")}, false},
		{"not servable without an override", false, presentingQueriesFake{}, false},
		{"not servable even when the override is on", false, presentingQueriesFake{override: &enabled}, false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := PresentingSettings{Queries: test.queries, Servable: test.servable}.Enabled(t.Context())
			if got != test.want {
				t.Fatalf("Enabled() = %v, want %v", got, test.want)
			}
		})
	}
}
