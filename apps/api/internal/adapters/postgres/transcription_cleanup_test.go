package postgres

import (
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
)

func TestGeneratedQuerierSatisfiesTranscriptionCleanupContract(t *testing.T) {
	var queries sqlc.Querier = sqlc.New(nil)
	if _, ok := queries.(cleanupQuerier); !ok {
		t.Fatal("generated querier does not satisfy the transcription cleanup contract")
	}
}
