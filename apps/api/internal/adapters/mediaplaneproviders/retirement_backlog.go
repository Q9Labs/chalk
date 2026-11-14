package mediaplaneproviders

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/metric"
)

// RetirementBacklog is the retirement debt still unpaid: how many allocations an Episode left
// that no node has acknowledged yet, and how long the oldest has waited. A debt is the Episode's
// durable ownership of the cleanup, so a node that stays silent shows up here and nowhere else.
type RetirementBacklog struct {
	Count  int
	Oldest time.Duration
}

// backlogCell holds the numbers the last worker pass read, so the health endpoint and the metrics
// never query the database themselves.
type backlogCell struct {
	mu       sync.Mutex
	backlog  RetirementBacklog
	observed bool
}

func (c *backlogCell) set(backlog RetirementBacklog) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.backlog, c.observed = backlog, true
}

func (c *backlogCell) get() (RetirementBacklog, bool) {
	if c == nil {
		return RetirementBacklog{}, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.backlog, c.observed
}

// RetirementBacklog is the backlog the last pass of the retirement worker saw, and false before
// the first pass.
func (r Registry) RetirementBacklog() (RetirementBacklog, bool) {
	return r.backlog.get()
}

var (
	backlogMeter = otel.Meter("github.com/q9labs/chalk/apps/api/internal/adapters/mediaplaneproviders")

	backlogCount, _ = backlogMeter.Int64ObservableGauge(
		"chalk.sfu.retirement_debts",
		metric.WithDescription("Retirement debts no Chalk SFU node has acknowledged yet"),
		metric.WithUnit("{debt}"),
	)
	backlogOldest, _ = backlogMeter.Float64ObservableGauge(
		"chalk.sfu.retirement_debt_oldest_age",
		metric.WithDescription("Age of the oldest unpaid Chalk SFU retirement debt"),
		metric.WithUnit("s"),
	)
)

// observeBacklog reports the backlog as metrics for as long as ctx lives.
func (r Registry) observeBacklog(ctx context.Context) {
	registration, err := backlogMeter.RegisterCallback(func(_ context.Context, observer metric.Observer) error {
		if backlog, observed := r.backlog.get(); observed {
			observer.ObserveInt64(backlogCount, int64(backlog.Count))
			observer.ObserveFloat64(backlogOldest, backlog.Oldest.Seconds())
		}
		return nil
	}, backlogCount, backlogOldest)
	if err != nil {
		slog.WarnContext(ctx, "chalk sfu retirement backlog metrics not registered", "event", "chalk_sfu.retire_backlog_unobserved", "error", err.Error())
		return
	}
	go func() {
		<-ctx.Done()
		_ = registration.Unregister()
	}()
}

// readBacklog refreshes the backlog from the database.
func (r Registry) readBacklog(ctx context.Context) {
	count, oldest, err := r.recovery.RetirementBacklog(ctx)
	if err != nil {
		if ctx.Err() == nil {
			slog.WarnContext(ctx, "chalk sfu retirement backlog not read", "event", "chalk_sfu.retire_backlog_unread", "error", err.Error())
		}
		return
	}
	r.backlog.set(RetirementBacklog{Count: count, Oldest: oldest})
}
