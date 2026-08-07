package episodediagnostics

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestRuntimeEpisodeCommittedIsBoundedAndNonBlocking(t *testing.T) {
	repository := &runtimeRepositoryFake{}
	runtime := NewRuntime(
		NewService(repository, EnvironmentDevelopment, nil, nil, nil),
		repository,
		EnvironmentDevelopment,
		RuntimeConfig{EnsureQueueCapacity: 1},
		nil,
	)

	done := make(chan struct{})
	go func() {
		runtime.EpisodeCommitted(episodes.Episode{})
		runtime.EpisodeCommitted(episodes.Episode{})
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("observer did not return")
	}

	if got := runtime.QueueLength(); got != 1 {
		t.Fatalf("queue length = %d, want 1", got)
	}
	if got := runtime.DroppedEpisodes(); got != 1 {
		t.Fatalf("dropped episodes = %d, want 1", got)
	}
}

func TestRuntimeRunsAllLoopsAndStopsOnCancellation(t *testing.T) {
	repository := &runtimeRepositoryFake{}
	runtime := NewRuntime(
		NewService(repository, EnvironmentDevelopment, nil, nil, nil),
		repository,
		EnvironmentDevelopment,
		RuntimeConfig{
			ProjectorInterval:   time.Millisecond,
			ReconcileInterval:   time.Millisecond,
			DeadlineInterval:    time.Millisecond,
			ExportInterval:      time.Millisecond,
			RetentionInterval:   time.Millisecond,
			ProjectorBatch:      2,
			ReconcileBatch:      3,
			DeadlineBatch:       4,
			RetentionBatch:      5,
			WorkerID:            "test-worker",
			EnsureQueueCapacity: 2,
		},
		nil,
	)
	runtime.EpisodeCommitted(episodes.Episode{})

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- runtime.Run(ctx) }()
	defer func() {
		cancel()
	}()

	waitForRuntime(t, func() bool {
		return repository.ensure.Load() > 0 &&
			repository.reconcile.Load() > 0 &&
			repository.project.Load() > 0 &&
			repository.deadline.Load() > 0 &&
			repository.export.Load() > 0 &&
			repository.retain.Load() > 0
	})
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("runtime returned error: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("runtime did not stop after cancellation")
	}
}

func TestRuntimeCycleFailuresAreBestEffort(t *testing.T) {
	repository := &runtimeRepositoryFake{err: errors.New("diagnostic store unavailable")}
	runtime := NewRuntime(
		NewService(repository, EnvironmentDevelopment, nil, nil, nil),
		repository,
		EnvironmentDevelopment,
		RuntimeConfig{
			ProjectorInterval: time.Millisecond,
			ReconcileInterval: time.Millisecond,
			DeadlineInterval:  time.Millisecond,
			ExportInterval:    time.Millisecond,
			RetentionInterval: time.Millisecond,
		},
		nil,
	)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- runtime.Run(ctx) }()
	waitForRuntime(t, func() bool {
		return repository.reconcile.Load() > 0 && repository.project.Load() > 0
	})
	select {
	case err := <-done:
		t.Fatalf("runtime stopped on best-effort failure: %v", err)
	default:
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("runtime returned error after cancellation: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("runtime did not stop after cancellation")
	}
}

func TestRuntimeCancellationWaitsForContextAwareRepositoryCalls(t *testing.T) {
	repository := &runtimeRepositoryFake{blockUntilContext: true}
	runtime := NewRuntime(
		NewService(repository, EnvironmentDevelopment, nil, nil, nil),
		repository,
		EnvironmentDevelopment,
		RuntimeConfig{
			ProjectorInterval: time.Hour,
			ReconcileInterval: time.Hour,
			DeadlineInterval:  time.Hour,
			ExportInterval:    time.Hour,
			RetentionInterval: time.Hour,
		},
		nil,
	)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- runtime.Run(ctx) }()
	time.Sleep(10 * time.Millisecond)
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("runtime returned error: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("runtime leaked a worker after cancellation")
	}
}

func waitForRuntime(t *testing.T, ready func() bool) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if ready() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("runtime did not execute the expected cycles")
}

type runtimeRepositoryFake struct {
	err               error
	blockUntilContext bool
	ensure            atomic.Int32
	reconcile         atomic.Int32
	project           atomic.Int32
	deadline          atomic.Int32
	export            atomic.Int32
	retain            atomic.Int32
}

func (f *runtimeRepositoryFake) wait(ctx context.Context) error {
	if !f.blockUntilContext {
		return f.err
	}
	<-ctx.Done()
	return ctx.Err()
}

func (f *runtimeRepositoryFake) Ensure(ctx context.Context, _ AuthoritativeEpisode, _ Environment) (EpisodeDiagnostic, error) {
	f.ensure.Add(1)
	return EpisodeDiagnostic{}, f.wait(ctx)
}

func (f *runtimeRepositoryFake) Reconcile(ctx context.Context, _ Environment, _ time.Time, _ int) ([]EpisodeDiagnostic, error) {
	f.reconcile.Add(1)
	return nil, f.wait(ctx)
}

func (f *runtimeRepositoryFake) ResolveScope(context.Context, AppendScope, int64) (EpisodeDiagnostic, error) {
	return EpisodeDiagnostic{}, nil
}

func (f *runtimeRepositoryFake) Append(context.Context, EpisodeDiagnostic, *utilities.ID, []ValidatedEvent) (AppendDiagnosticEventsResult, error) {
	return AppendDiagnosticEventsResult{}, nil
}

func (f *runtimeRepositoryFake) Resolve(context.Context, DiagnosticReference) (EpisodeDiagnostic, error) {
	return EpisodeDiagnostic{}, nil
}

func (f *runtimeRepositoryFake) ResolveAlternate(context.Context, string, string, string) (DiagnosticReference, error) {
	return DiagnosticReference{}, nil
}

func (f *runtimeRepositoryFake) ReadSnapshot(context.Context, EpisodeDiagnostic, DiagnosticFilterV1, int) (DiagnosticSnapshotV1, error) {
	return DiagnosticSnapshotV1{}, nil
}

func (f *runtimeRepositoryFake) PageEvents(context.Context, EpisodeDiagnostic, DiagnosticFilterV1, *int64, *int64, int) (DiagnosticEventPageV1, error) {
	return DiagnosticEventPageV1{}, nil
}

func (f *runtimeRepositoryFake) PageOperations(context.Context, EpisodeDiagnostic, DiagnosticFilterV1, *int64, int) (DiagnosticOperationPageV1, error) {
	return DiagnosticOperationPageV1{}, nil
}

func (f *runtimeRepositoryFake) ListProjectionChanges(context.Context, EpisodeDiagnostic, int64, int) ([]ProjectionChange, error) {
	return nil, nil
}

func (f *runtimeRepositoryFake) Project(ctx context.Context, _ string, _ int) (int, error) {
	f.project.Add(1)
	return 0, f.wait(ctx)
}

func (f *runtimeRepositoryFake) ScanDeadlines(ctx context.Context, _ time.Time, _ int) (int, error) {
	f.deadline.Add(1)
	return 0, f.wait(ctx)
}

func (f *runtimeRepositoryFake) CreateExport(context.Context, EpisodeDiagnostic, OperatorPrincipal, int64, *int64, time.Time) (DiagnosticExportJob, error) {
	return DiagnosticExportJob{}, nil
}

func (f *runtimeRepositoryFake) GetExport(context.Context, EpisodeDiagnostic, OperatorPrincipal, utilities.ID) (DiagnosticExportJob, error) {
	return DiagnosticExportJob{}, nil
}

func (f *runtimeRepositoryFake) CancelExport(context.Context, EpisodeDiagnostic, OperatorPrincipal, utilities.ID, time.Time) (DiagnosticExportJob, error) {
	return DiagnosticExportJob{}, nil
}

func (f *runtimeRepositoryFake) ExportArtifact(context.Context, EpisodeDiagnostic, OperatorPrincipal, utilities.ID) (ExportArtifact, error) {
	return ExportArtifact{}, nil
}

func (f *runtimeRepositoryFake) RunExport(ctx context.Context, _ string) (bool, error) {
	f.export.Add(1)
	return false, f.wait(ctx)
}

func (f *runtimeRepositoryFake) Retain(ctx context.Context, _ time.Time, _ int) (int, error) {
	f.retain.Add(1)
	return 0, f.wait(ctx)
}
