package postgres

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/journeys"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestJourneyLedgerFailurePreservesClassificationAndCause(t *testing.T) {
	cause := errors.New("database unavailable")
	err := journeyLedgerFailure("append event", cause)

	if !errors.Is(err, journeys.ErrJourneyLedgerUnavailable) {
		t.Fatalf("error = %v, want journey ledger unavailable classification", err)
	}
	if !errors.Is(err, cause) {
		t.Fatalf("error = %v, want original database cause", err)
	}
}

func TestJourneyReadFailurePreservesUnavailableClassification(t *testing.T) {
	pool, err := pgxpool.New(context.Background(), "postgres://postgres:postgres@127.0.0.1:1/chalk")
	if err != nil {
		t.Fatalf("new pool: %v", err)
	}
	pool.Close()
	journeyID, err := utilities.ParseID("11111111-1111-4111-8111-111111111111")
	if err != nil {
		t.Fatalf("parse journey id: %v", err)
	}

	_, err = NewJourneyRepository(pool).Get(context.Background(), journeyID)
	if !errors.Is(err, journeys.ErrJourneyLedgerUnavailable) {
		t.Fatalf("error = %v, want journey ledger unavailable classification", err)
	}
}
