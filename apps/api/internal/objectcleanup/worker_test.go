package objectcleanup

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
)

type claim struct{ key string }

type fakeRepository struct {
	batches   [][]claim
	claimErr  error
	completed []string
	inputs    []ClaimInput
	onDone    func()
}

func (r *fakeRepository) ClaimCleanup(_ context.Context, input ClaimInput) ([]claim, error) {
	r.inputs = append(r.inputs, input)
	if r.claimErr != nil {
		return nil, r.claimErr
	}
	if len(r.batches) == 0 {
		return nil, nil
	}
	next := r.batches[0]
	r.batches = r.batches[1:]
	return next, nil
}

func (r *fakeRepository) CompleteCleanup(_ context.Context, c claim) error {
	r.completed = append(r.completed, c.key)
	if r.onDone != nil {
		r.onDone()
	}
	return nil
}

type fakeObjects map[string]error

func (o fakeObjects) DeleteObject(_ context.Context, key string) error { return o[key] }

var testKind = Kind{Name: "things", Label: "thing", Scope: "test"}

func newTestWorker(repository *fakeRepository, objects fakeObjects, now time.Time) Worker[claim] {
	worker := NewWorker[claim](testKind, repository, objects, func(c claim) string { return c.key })
	worker.now = func() time.Time { return now }
	return worker
}

func TestRunDeletesClaimedObjectsAndCompletesThem(t *testing.T) {
	now := time.Date(2026, 11, 13, 12, 0, 0, 0, time.UTC)
	repository := &fakeRepository{batches: [][]claim{{{"a"}, {"gone"}, {"stuck"}}}}
	objects := fakeObjects{"gone": objectstorage.ErrObjectNotFound, "stuck": objectstorage.ErrStoreUnavailable}

	result, err := newTestWorker(repository, objects, now).Run(context.Background())

	if !errors.Is(err, objectstorage.ErrStoreUnavailable) {
		t.Fatalf("error = %v, want the store failure", err)
	}
	if result != (Result{Batches: 1, Claimed: 3, Deleted: 2, Failed: 1}) {
		t.Fatalf("result = %+v", result)
	}
	if len(repository.completed) != 2 || repository.completed[0] != "a" || repository.completed[1] != "gone" {
		t.Fatalf("completed = %v; an absent object counts as deleted and a failed delete stays claimed", repository.completed)
	}
	input := repository.inputs[0]
	if !input.EndedBefore.Equal(now.Add(-Retention)) || !input.LeaseUntil.Equal(now.Add(leaseDuration)) || input.Limit != batchSize {
		t.Fatalf("claim input = %+v", input)
	}
}

func TestRunStopsAtAShortBatchAndAtTheBatchCap(t *testing.T) {
	full := make([]claim, batchSize)
	for index := range full {
		full[index] = claim{key: "k"}
	}
	repository := &fakeRepository{batches: [][]claim{full, full, full, full, full, full}}
	result, err := newTestWorker(repository, fakeObjects{}, time.Now()).Run(context.Background())
	if err != nil || result.Batches != maxBatches || result.Deleted != maxBatches*batchSize {
		t.Fatalf("result = %+v, %v; want %d full batches", result, err, maxBatches)
	}

	repository = &fakeRepository{batches: [][]claim{{{"a"}}, {{"b"}}}}
	result, _ = newTestWorker(repository, fakeObjects{}, time.Now()).Run(context.Background())
	if result.Batches != 1 || result.Deleted != 1 {
		t.Fatalf("a short batch must end the run: %+v", result)
	}
}

func TestRunReportsAClaimFailureAndAnIncompleteWorker(t *testing.T) {
	claimErr := errors.New("database down")
	result, err := newTestWorker(&fakeRepository{claimErr: claimErr}, fakeObjects{}, time.Now()).Run(context.Background())
	if !errors.Is(err, claimErr) || result.Batches != 1 {
		t.Fatalf("result = %+v, error = %v", result, err)
	}

	var zero Worker[claim]
	if _, err := zero.Run(context.Background()); !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("a zero-value worker must return ErrInvalidConfig, got %v", err)
	}

	broken := NewWorker[claim](testKind, nil, fakeObjects{}, func(c claim) string { return c.key })
	if _, err := broken.Run(context.Background()); !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("error = %v, want ErrInvalidConfig", err)
	}
}

func TestSchedulerRunsACycleAndStopsWithItsContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cycleDone := make(chan struct{})
	repository := &fakeRepository{batches: [][]claim{{{"a"}}}, onDone: func() { close(cycleDone) }}
	worker := newTestWorker(repository, fakeObjects{}, time.Now())
	done := make(chan error, 1)
	go func() { done <- NewScheduler(worker, time.Hour, nil).Run(ctx) }()

	select {
	case <-cycleDone:
	case <-time.After(5 * time.Second):
		t.Fatal("the scheduler never ran a cycle")
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("Run = %v, want nil after cancellation", err)
	}

	var missing *Scheduler
	if err := missing.Run(context.Background()); !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("a nil scheduler must be invalid: %v", err)
	}
}

func TestErrorCodeNamesTheFailure(t *testing.T) {
	cases := map[string]error{
		"canceled":          context.Canceled,
		"object_not_found":  objectstorage.ErrObjectNotFound,
		"store_unavailable": objectstorage.ErrStoreUnavailable,
		"provider_failed":   objectstorage.ErrProviderFailed,
		"lease_lost":        ErrLeaseLost,
		"internal":          errors.New("other"),
	}
	for want, err := range cases {
		if got := errorCode(err); got != want {
			t.Errorf("errorCode(%v) = %q, want %q", err, got, want)
		}
	}
}
