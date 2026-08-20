package publicinvites

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestNewLifecycleWorkerWithBatch(t *testing.T) {
	worker, err := NewLifecycleWorkerWithBatch(&lifecycleWorkerLifecycleFake{}, &lifecycleWorkerActionsFake{}, 7)
	if err != nil {
		t.Fatalf("construct lifecycle worker: %v", err)
	}
	if worker.batchSize != 7 {
		t.Fatalf("batch size = %d, want 7", worker.batchSize)
	}
}

func TestNewLifecycleWorkerWithBatchRejectsInvalidSize(t *testing.T) {
	for _, batchSize := range []int32{0, -1} {
		t.Run(fmt.Sprintf("batch_%d", batchSize), func(t *testing.T) {
			_, err := NewLifecycleWorkerWithBatch(&lifecycleWorkerLifecycleFake{}, &lifecycleWorkerActionsFake{}, batchSize)
			if !errors.Is(err, ErrInvalidLifecycleState) {
				t.Fatalf("construct lifecycle worker error = %v, want %v", err, ErrInvalidLifecycleState)
			}
		})
	}
}

func TestLifecycleWorkerArchivesDueLifecycle(t *testing.T) {
	now := time.Date(2026, 8, 19, 12, 0, 0, 0, time.UTC)
	lifecycle := lifecycleWorkerTestLifecycle(t, now)
	lifecyclePort := &lifecycleWorkerLifecycleFake{due: []AutoLifecycle{lifecycle}}
	actions := &lifecycleWorkerActionsFake{}
	worker := NewLifecycleWorker(lifecyclePort, actions)
	worker.now = func() time.Time { return now }
	worker.batchSize = 2
	worker.maxBatches = 1

	result, err := worker.Run(context.Background())
	if err != nil {
		t.Fatalf("run lifecycle worker: %v", err)
	}
	if result.Batches != 1 || result.Listed != 1 || result.Claimed != 1 || result.Archived != 1 {
		t.Fatalf("unexpected result: %+v", result)
	}
	if result.Retried != 0 || result.Skipped != 0 || result.Failed != 0 {
		t.Fatalf("unexpected non-success counts: %+v", result)
	}
	if lifecyclePort.archived.State != AutoLifecycleArchived {
		t.Fatalf("lifecycle state = %q, want archived", lifecyclePort.archived.State)
	}
	if lifecyclePort.claimCalls != 1 || lifecyclePort.archiveCalls != 1 {
		t.Fatalf("claim/archive calls = %d/%d, want 1/1", lifecyclePort.claimCalls, lifecyclePort.archiveCalls)
	}
	if len(actions.events) != 2 || actions.events[0] != "end" || actions.events[1] != "archive" {
		t.Fatalf("action events = %v, want [end archive]", actions.events)
	}
	if len(actions.inputs) != 2 {
		t.Fatalf("action inputs = %d, want 2", len(actions.inputs))
	}
	if actions.inputs[0].RequestKey != lifecycleActionRequestKey(lifecycle, "end") {
		t.Fatalf("end request key = %q", actions.inputs[0].RequestKey)
	}
	if actions.inputs[1].RequestKey != lifecycleActionRequestKey(lifecycle, "archive") {
		t.Fatalf("archive request key = %q", actions.inputs[1].RequestKey)
	}
	if actions.inputs[0].TenantID != lifecycle.TenantID || actions.inputs[0].SpaceID != lifecycle.SpaceID || actions.inputs[0].CreatorArrivalHandle != lifecycle.CreatorArrivalHandle {
		t.Fatalf("action identity = %+v, want tenant/space/arrival from lifecycle", actions.inputs[0])
	}
	if actions.inputs[0].RequestKey == actions.inputs[1].RequestKey {
		t.Fatal("episode and Space actions must have separate idempotency keys")
	}
}

func TestLifecycleWorkerConcurrentClaimIsNoOp(t *testing.T) {
	now := time.Date(2026, 8, 19, 12, 0, 0, 0, time.UTC)
	lifecyclePort := &lifecycleWorkerLifecycleFake{
		due:      []AutoLifecycle{lifecycleWorkerTestLifecycle(t, now)},
		claimErr: ErrInvalidLifecycleState,
	}
	actions := &lifecycleWorkerActionsFake{}
	worker := NewLifecycleWorker(lifecyclePort, actions)
	worker.now = func() time.Time { return now }
	worker.batchSize = 2
	worker.maxBatches = 1

	result, err := worker.Run(context.Background())
	if err != nil {
		t.Fatalf("run lifecycle worker: %v", err)
	}
	if result.Skipped != 1 || result.Claimed != 0 || result.Archived != 0 || result.Failed != 0 {
		t.Fatalf("unexpected concurrent-claim result: %+v", result)
	}
	if len(actions.events) != 0 {
		t.Fatalf("actions called after lost claim: %v", actions.events)
	}
}

func TestLifecycleWorkerSchedulesBoundedRetry(t *testing.T) {
	now := time.Date(2026, 8, 19, 12, 0, 0, 0, time.UTC)
	lifecycle := lifecycleWorkerTestLifecycle(t, now)
	lifecycle.RetryCount = 2
	cause := errors.New("episode unavailable")
	lifecyclePort := &lifecycleWorkerLifecycleFake{due: []AutoLifecycle{lifecycle}}
	actions := &lifecycleWorkerActionsFake{endErr: cause}
	worker := NewLifecycleWorker(lifecyclePort, actions)
	worker.now = func() time.Time { return now }
	worker.batchSize = 2
	worker.maxBatches = 1
	worker.retryBase = 2 * time.Minute
	worker.retryMax = 5 * time.Minute

	result, err := worker.Run(context.Background())
	if !errors.Is(err, cause) {
		t.Fatalf("worker error = %v, want cause", err)
	}
	if result.Retried != 1 || result.Failed != 1 || result.Claimed != 1 || result.Archived != 0 {
		t.Fatalf("unexpected retry result: %+v", result)
	}
	if lifecyclePort.retryCalls != 1 {
		t.Fatalf("retry calls = %d, want 1", lifecyclePort.retryCalls)
	}
	if got := lifecyclePort.retryInput.ErrorFamily; got != "episode_end_failed" {
		t.Fatalf("retry error family = %q", got)
	}
	if got, want := lifecyclePort.retryInput.NextRetryAt, now.Add(5*time.Minute); !got.Equal(want) {
		t.Fatalf("next retry at = %s, want %s", got, want)
	}
	if len(actions.events) != 1 || actions.events[0] != "end" {
		t.Fatalf("action events = %v, want [end]", actions.events)
	}
}

func TestLifecycleWorkerCancellationStopsBeforeListing(t *testing.T) {
	lifecyclePort := &lifecycleWorkerLifecycleFake{}
	worker := NewLifecycleWorker(lifecyclePort, &lifecycleWorkerActionsFake{})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	result, err := worker.Run(ctx)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("worker error = %v, want context canceled", err)
	}
	if result != (LifecycleWorkerResult{}) {
		t.Fatalf("unexpected canceled result: %+v", result)
	}
	if lifecyclePort.listCalls != 0 {
		t.Fatalf("list calls = %d, want 0", lifecyclePort.listCalls)
	}
}

func TestLifecycleSchedulerStopsOnCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	runner := &lifecycleWorkerRunnerFake{run: func(context.Context) (LifecycleWorkerResult, error) {
		cancel()
		return LifecycleWorkerResult{Listed: 1}, nil
	}}
	scheduler := NewLifecycleScheduler(runner, time.Hour, slog.New(slog.NewTextHandler(io.Discard, nil)))

	if err := scheduler.Run(ctx); err != nil {
		t.Fatalf("run lifecycle scheduler: %v", err)
	}
	if runner.calls != 1 {
		t.Fatalf("worker calls = %d, want 1", runner.calls)
	}
}

func TestLifecycleSchedulerLogsCycleFailure(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var output bytes.Buffer
	runner := &lifecycleWorkerRunnerFake{run: func(context.Context) (LifecycleWorkerResult, error) {
		return LifecycleWorkerResult{}, errors.New("database unavailable")
	}}
	scheduler := NewLifecycleScheduler(runner, time.Hour, slog.New(slog.NewTextHandler(&output, nil)))
	time.AfterFunc(10*time.Millisecond, cancel)

	if err := scheduler.Run(ctx); err != nil {
		t.Fatalf("run lifecycle scheduler: %v", err)
	}
	if got := output.String(); !strings.Contains(got, `error="database unavailable"`) {
		t.Fatalf("failure log does not contain error: %s", got)
	}
}

func lifecycleWorkerTestLifecycle(t *testing.T, now time.Time) AutoLifecycle {
	t.Helper()
	tenantID := lifecycleWorkerTestID(t, "11111111-1111-4111-8111-111111111111")
	spaceID := lifecycleWorkerTestID(t, "22222222-2222-4222-8222-222222222222")
	arrivalHandle := lifecycleWorkerTestID(t, "33333333-3333-4333-8333-333333333333")
	return AutoLifecycle{
		TenantID:             tenantID,
		SpaceID:              spaceID,
		DeadlineAt:           now.Add(-time.Second),
		CreatorArrivalHandle: arrivalHandle,
		State:                AutoLifecycleActive,
		RetryCount:           0,
	}
}

func lifecycleWorkerTestID(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatalf("parse test ID %q: %v", value, err)
	}
	return id
}

type lifecycleWorkerLifecycleFake struct {
	due          []AutoLifecycle
	listErr      error
	claimErr     error
	archiveErr   error
	retryErr     error
	claimed      AutoLifecycle
	archived     AutoLifecycle
	retryInput   RetryAutoLifecycleInput
	listCalls    int
	claimCalls   int
	archiveCalls int
	retryCalls   int
}

func (f *lifecycleWorkerLifecycleFake) CreateAutoLifecycle(context.Context, AutoLifecycle) (AutoLifecycle, error) {
	return AutoLifecycle{}, nil
}

func (f *lifecycleWorkerLifecycleFake) GetAutoLifecycle(context.Context, utilities.ID, utilities.ID) (AutoLifecycle, error) {
	return f.claimed, nil
}

func (f *lifecycleWorkerLifecycleFake) ListDueAutoLifecycles(context.Context, time.Time, int32) ([]AutoLifecycle, error) {
	f.listCalls++
	if f.listErr != nil {
		return nil, f.listErr
	}
	return append([]AutoLifecycle(nil), f.due...), nil
}

func (f *lifecycleWorkerLifecycleFake) MarkAutoLifecycleArchiving(_ context.Context, tenantID, spaceID utilities.ID) (AutoLifecycle, error) {
	f.claimCalls++
	if f.claimErr != nil {
		return AutoLifecycle{}, f.claimErr
	}
	for _, lifecycle := range f.due {
		if lifecycle.TenantID == tenantID && lifecycle.SpaceID == spaceID {
			f.claimed = lifecycle
			f.claimed.State = AutoLifecycleArchiving
			return f.claimed, nil
		}
	}
	return AutoLifecycle{}, ErrAutoLifecycleNotFound
}

func (f *lifecycleWorkerLifecycleFake) MarkAutoLifecycleArchived(_ context.Context, tenantID, spaceID utilities.ID) (AutoLifecycle, error) {
	f.archiveCalls++
	if f.archiveErr != nil {
		return AutoLifecycle{}, f.archiveErr
	}
	if f.claimed.TenantID != tenantID || f.claimed.SpaceID != spaceID {
		return AutoLifecycle{}, ErrAutoLifecycleNotFound
	}
	f.archived = f.claimed
	f.archived.State = AutoLifecycleArchived
	return f.archived, nil
}

func (f *lifecycleWorkerLifecycleFake) RetryAutoLifecycle(_ context.Context, input RetryAutoLifecycleInput) (AutoLifecycle, error) {
	f.retryCalls++
	f.retryInput = input
	if f.retryErr != nil {
		return AutoLifecycle{}, f.retryErr
	}
	f.claimed.State = AutoLifecycleActive
	f.claimed.RetryCount++
	f.claimed.NextRetryAt = &input.NextRetryAt
	f.claimed.LastErrorFamily = input.ErrorFamily
	return f.claimed, nil
}

var _ Lifecycle = (*lifecycleWorkerLifecycleFake)(nil)

type lifecycleWorkerActionsFake struct {
	endErr     error
	archiveErr error
	events     []string
	inputs     []LifecycleActionInput
}

func (f *lifecycleWorkerActionsFake) EndEpisode(_ context.Context, input LifecycleActionInput) error {
	f.events = append(f.events, "end")
	f.inputs = append(f.inputs, input)
	return f.endErr
}

func (f *lifecycleWorkerActionsFake) ArchiveSpace(_ context.Context, input LifecycleActionInput) error {
	f.events = append(f.events, "archive")
	f.inputs = append(f.inputs, input)
	return f.archiveErr
}

var _ LifecycleActions = (*lifecycleWorkerActionsFake)(nil)

type lifecycleWorkerRunnerFake struct {
	run   func(context.Context) (LifecycleWorkerResult, error)
	calls int
}

func (f *lifecycleWorkerRunnerFake) Run(ctx context.Context) (LifecycleWorkerResult, error) {
	f.calls++
	return f.run(ctx)
}

var _ LifecycleCycleRunner = (*lifecycleWorkerRunnerFake)(nil)
