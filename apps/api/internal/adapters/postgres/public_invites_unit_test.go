package postgres

import (
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
)

func TestExpectedProviderBindingRejectsAStaleReplacement(t *testing.T) {
	current := sqlc.SpacePublicArrival{
		Provider:        pgtype.Text{String: publicinvites.PublicProviderCloudflareSFU, Valid: true},
		ProviderSubject: pgtype.Text{String: "connection-2", Valid: true},
	}
	stale := publicinvites.UpdateArrivalStateInput{
		MatchProviderBinding:    true,
		ExpectedProvider:        publicinvites.PublicProviderCloudflareSFU,
		ExpectedProviderSubject: "connection-1",
	}
	if matchesExpectedProviderBinding(current, stale) {
		t.Fatal("stale replacement matched the current provider binding")
	}
	currentBinding := stale
	currentBinding.ExpectedProviderSubject = "connection-2"
	if !matchesExpectedProviderBinding(current, currentBinding) {
		t.Fatal("current replacement did not match the provider binding")
	}
}
