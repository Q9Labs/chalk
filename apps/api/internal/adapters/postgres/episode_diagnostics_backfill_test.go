package postgres

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/episodediagnostics"
)

func TestEpisodeReferenceBackfillStopsAfterEmptyBatch(t *testing.T) {
	state := newEpisodeReferenceBackfillState()
	var listCalls, insertCalls atomic.Int32
	list := func(context.Context, sqlc.ListEpisodeDiagnosticsMissingEpisodeReferenceParams) ([]sqlc.ListEpisodeDiagnosticsMissingEpisodeReferenceRow, error) {
		if listCalls.Add(1) == 1 {
			return []sqlc.ListEpisodeDiagnosticsMissingEpisodeReferenceRow{{}}, nil
		}
		return nil, nil
	}
	insert := func(context.Context, sqlc.ListEpisodeDiagnosticsMissingEpisodeReferenceRow) error {
		insertCalls.Add(1)
		return nil
	}

	if err := state.run(context.Background(), episodediagnostics.EnvironmentDevelopment, 10, list, insert); err != nil {
		t.Fatalf("first backfill: %v", err)
	}
	if err := state.run(context.Background(), episodediagnostics.EnvironmentDevelopment, 10, list, insert); err != nil {
		t.Fatalf("drain backfill: %v", err)
	}
	if err := state.run(context.Background(), episodediagnostics.EnvironmentDevelopment, 10, list, insert); err != nil {
		t.Fatalf("completed backfill: %v", err)
	}

	if got := listCalls.Load(); got != 2 {
		t.Fatalf("list calls = %d, want 2", got)
	}
	if got := insertCalls.Load(); got != 1 {
		t.Fatalf("insert calls = %d, want 1", got)
	}
}

func TestEpisodeReferenceBackfillRetriesFailuresBeforeMarkingComplete(t *testing.T) {
	state := newEpisodeReferenceBackfillState()
	var listCalls, insertCalls atomic.Int32
	insertErr := errors.New("reference store unavailable")
	list := func(context.Context, sqlc.ListEpisodeDiagnosticsMissingEpisodeReferenceParams) ([]sqlc.ListEpisodeDiagnosticsMissingEpisodeReferenceRow, error) {
		listCalls.Add(1)
		return []sqlc.ListEpisodeDiagnosticsMissingEpisodeReferenceRow{{}}, nil
	}
	insert := func(context.Context, sqlc.ListEpisodeDiagnosticsMissingEpisodeReferenceRow) error {
		if insertCalls.Add(1) == 1 {
			return insertErr
		}
		return nil
	}

	if err := state.run(context.Background(), episodediagnostics.EnvironmentDevelopment, 10, list, insert); !errors.Is(err, insertErr) {
		t.Fatalf("first backfill error = %v, want %v", err, insertErr)
	}
	if err := state.run(context.Background(), episodediagnostics.EnvironmentDevelopment, 10, list, insert); err != nil {
		t.Fatalf("retry backfill: %v", err)
	}
	if err := state.run(context.Background(), episodediagnostics.EnvironmentDevelopment, 10,
		func(context.Context, sqlc.ListEpisodeDiagnosticsMissingEpisodeReferenceParams) ([]sqlc.ListEpisodeDiagnosticsMissingEpisodeReferenceRow, error) {
			listCalls.Add(1)
			return nil, nil
		}, insert); err != nil {
		t.Fatalf("empty backfill: %v", err)
	}

	if got := listCalls.Load(); got != 3 {
		t.Fatalf("list calls = %d, want 3", got)
	}
	if got := insertCalls.Load(); got != 2 {
		t.Fatalf("insert calls = %d, want 2", got)
	}
}

func TestEpisodeReferenceBackfillRetriesListFailures(t *testing.T) {
	state := newEpisodeReferenceBackfillState()
	var listCalls atomic.Int32
	listErr := errors.New("reference query unavailable")
	list := func(context.Context, sqlc.ListEpisodeDiagnosticsMissingEpisodeReferenceParams) ([]sqlc.ListEpisodeDiagnosticsMissingEpisodeReferenceRow, error) {
		if listCalls.Add(1) == 1 {
			return nil, listErr
		}
		return nil, nil
	}
	insert := func(context.Context, sqlc.ListEpisodeDiagnosticsMissingEpisodeReferenceRow) error {
		t.Fatal("insert called after empty list")
		return nil
	}

	if err := state.run(context.Background(), episodediagnostics.EnvironmentDevelopment, 10, list, insert); !errors.Is(err, listErr) {
		t.Fatalf("first backfill error = %v, want %v", err, listErr)
	}
	if err := state.run(context.Background(), episodediagnostics.EnvironmentDevelopment, 10, list, insert); err != nil {
		t.Fatalf("retry backfill: %v", err)
	}
	if got := listCalls.Load(); got != 2 {
		t.Fatalf("list calls = %d, want 2", got)
	}
}

func TestEpisodeReferenceBackfillSerializesConcurrentRuns(t *testing.T) {
	state := newEpisodeReferenceBackfillState()
	var listCalls atomic.Int32
	list := func(context.Context, sqlc.ListEpisodeDiagnosticsMissingEpisodeReferenceParams) ([]sqlc.ListEpisodeDiagnosticsMissingEpisodeReferenceRow, error) {
		listCalls.Add(1)
		return nil, nil
	}
	insert := func(context.Context, sqlc.ListEpisodeDiagnosticsMissingEpisodeReferenceRow) error {
		t.Fatal("insert called for an empty batch")
		return nil
	}

	var workers sync.WaitGroup
	workers.Add(2)
	for range 2 {
		go func() {
			defer workers.Done()
			if err := state.run(context.Background(), episodediagnostics.EnvironmentDevelopment, 10, list, insert); err != nil {
				t.Errorf("concurrent backfill: %v", err)
			}
		}()
	}
	workers.Wait()

	if got := listCalls.Load(); got != 1 {
		t.Fatalf("list calls = %d, want 1", got)
	}
}
