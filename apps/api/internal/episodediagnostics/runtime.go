package episodediagnostics

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/episodes"
)

const (
	DefaultRuntimeProjectorInterval   = 500 * time.Millisecond
	DefaultRuntimeReconcileInterval   = time.Second
	DefaultRuntimeDeadlineInterval    = time.Second
	DefaultRuntimeExportInterval      = time.Second
	DefaultRuntimeRetentionInterval   = time.Minute
	DefaultRuntimeProjectorBatch      = 200
	DefaultRuntimeReconcileBatch      = 100
	DefaultRuntimeDeadlineBatch       = 100
	DefaultRuntimeRetentionBatch      = 10000
	DefaultRuntimeEnsureQueueCapacity = 256
)

var ErrRuntimeNotConfigured = errors.New("episode diagnostics runtime repository is required")

// RuntimeConfig controls the bounded background work owned by a diagnostic
// runtime. A zero value uses the production-safe defaults above.
type RuntimeConfig struct {
	ProjectorInterval time.Duration
	ReconcileInterval time.Duration
	DeadlineInterval  time.Duration
	ExportInterval    time.Duration
	RetentionInterval time.Duration

	ProjectorBatch      int
	ReconcileBatch      int
	DeadlineBatch       int
	RetentionBatch      int
	WorkerID            string
	EnsureQueueCapacity int

	// Now and Clock are equivalent injection points. Clock is retained as an
	// alias for callers that use clock-oriented naming; Now takes precedence.
	Now   func() time.Time
	Clock func() time.Time
}

type Runtime struct {
	service     Service
	repository  Repository
	environment Environment
	config      RuntimeConfig
	logger      *slog.Logger
	now         func() time.Time
	ensureQueue chan episodes.Episode
	dropped     atomic.Uint64
}

// NewRuntime builds the process-local supervisor. EpisodeCommitted is safe to
// call before Run and never waits for a worker or a database operation.
func NewRuntime(service Service, repository Repository, environment Environment, config RuntimeConfig, logger *slog.Logger) *Runtime {
	config = normalizeRuntimeConfig(config)
	if config.Now == nil {
		config.Now = config.Clock
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	if logger == nil {
		logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	return &Runtime{
		service:     service,
		repository:  repository,
		environment: environment,
		config:      config,
		logger:      logger,
		now:         config.Now,
		ensureQueue: make(chan episodes.Episode, config.EnsureQueueCapacity),
	}
}

func normalizeRuntimeConfig(config RuntimeConfig) RuntimeConfig {
	if config.ProjectorInterval <= 0 {
		config.ProjectorInterval = DefaultRuntimeProjectorInterval
	}
	if config.ReconcileInterval <= 0 {
		config.ReconcileInterval = DefaultRuntimeReconcileInterval
	}
	if config.DeadlineInterval <= 0 {
		config.DeadlineInterval = DefaultRuntimeDeadlineInterval
	}
	if config.ExportInterval <= 0 {
		config.ExportInterval = DefaultRuntimeExportInterval
	}
	if config.RetentionInterval <= 0 {
		config.RetentionInterval = DefaultRuntimeRetentionInterval
	}
	if config.ProjectorBatch <= 0 {
		config.ProjectorBatch = DefaultRuntimeProjectorBatch
	}
	if config.ReconcileBatch <= 0 {
		config.ReconcileBatch = DefaultRuntimeReconcileBatch
	}
	if config.DeadlineBatch <= 0 {
		config.DeadlineBatch = DefaultRuntimeDeadlineBatch
	}
	if config.RetentionBatch <= 0 {
		config.RetentionBatch = DefaultRuntimeRetentionBatch
	}
	if config.WorkerID == "" {
		config.WorkerID = "episode-diagnostics-runtime"
	}
	if config.EnsureQueueCapacity <= 0 {
		config.EnsureQueueCapacity = DefaultRuntimeEnsureQueueCapacity
	}
	return config
}

// EpisodeCommitted implements episodes.CommitObserver. A full queue records a
// bounded observation loss and returns immediately; the reconciler repairs
// missed observations from authoritative Episode rows.
func (r *Runtime) EpisodeCommitted(episode episodes.Episode) {
	if r == nil {
		return
	}
	select {
	case r.ensureQueue <- episode:
	default:
		r.dropped.Add(1)
	}
}

// DroppedEpisodes reports observer notifications discarded because the bounded
// ensure queue was full.
func (r *Runtime) DroppedEpisodes() uint64 {
	if r == nil {
		return 0
	}
	return r.dropped.Load()
}

// QueueLength reports queued, not-yet-ensured Episode notifications.
func (r *Runtime) QueueLength() int {
	if r == nil {
		return 0
	}
	return len(r.ensureQueue)
}

// Run supervises independent best-effort loops. A failed diagnostic operation
// is logged and retried on the next cycle; it never becomes a product failure.
// Run returns only after cancellation and all workers have stopped.
func (r *Runtime) Run(ctx context.Context) error {
	if r == nil || r.repository == nil {
		return ErrRuntimeNotConfigured
	}
	if ctx == nil {
		ctx = context.Background()
	}

	var workers sync.WaitGroup
	workers.Add(6)
	go func() {
		defer workers.Done()
		r.runEnsure(ctx)
	}()
	go func() {
		defer workers.Done()
		r.runPeriodic(ctx, "reconcile", r.config.ReconcileInterval, func(ctx context.Context) error {
			_, err := r.repository.Reconcile(ctx, r.environment, r.now(), r.config.ReconcileBatch)
			return err
		})
	}()
	go func() {
		defer workers.Done()
		r.runPeriodic(ctx, "projector", r.config.ProjectorInterval, func(ctx context.Context) error {
			_, err := r.repository.Project(ctx, r.config.WorkerID, r.config.ProjectorBatch)
			return err
		})
	}()
	go func() {
		defer workers.Done()
		r.runPeriodic(ctx, "deadline", r.config.DeadlineInterval, func(ctx context.Context) error {
			_, err := r.repository.ScanDeadlines(ctx, r.now(), r.config.DeadlineBatch)
			return err
		})
	}()
	go func() {
		defer workers.Done()
		r.runPeriodic(ctx, "export", r.config.ExportInterval, func(ctx context.Context) error {
			_, err := r.repository.RunExport(ctx, r.config.WorkerID)
			return err
		})
	}()
	go func() {
		defer workers.Done()
		r.runPeriodic(ctx, "retention", r.config.RetentionInterval, func(ctx context.Context) error {
			_, err := r.repository.Retain(ctx, r.now(), r.config.RetentionBatch)
			return err
		})
	}()

	workers.Wait()
	return nil
}

func (r *Runtime) runEnsure(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case episode := <-r.ensureQueue:
			if _, err := r.service.Ensure(ctx, episode, false); err != nil {
				r.recordFailure(ctx, "ensure", err)
			}
		}
	}
}

func (r *Runtime) runPeriodic(ctx context.Context, worker string, interval time.Duration, cycle func(context.Context) error) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	r.runCycle(ctx, worker, cycle)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			r.runCycle(ctx, worker, cycle)
		}
	}
}

func (r *Runtime) runCycle(ctx context.Context, worker string, cycle func(context.Context) error) {
	if ctx.Err() != nil {
		return
	}
	if err := cycle(ctx); err != nil {
		r.recordFailure(ctx, worker, err)
	}
}

func (r *Runtime) recordFailure(ctx context.Context, worker string, err error) {
	if err == nil || ctx.Err() != nil {
		return
	}
	r.logger.ErrorContext(ctx, "episode diagnostics runtime cycle failed",
		"event", "episode_diagnostics.runtime.cycle_failed",
		"worker", worker,
		"error", err,
	)
}
