package postgres

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/obs"
)

const (
	healthPollInterval  = 30 * time.Second
	healthSampleTimeout = 2 * time.Second
	// healthApplicationName is the poller's own session name, so its reads never
	// count as API work and its wait never hides behind the busy pool.
	healthApplicationName = "chalk-api-dbhealth"
	// PoolApplicationName names the API pool's sessions in pg_stat_activity; the
	// poller counts waiters and blockers under it.
	PoolApplicationName = "chalk-api"
)

// RunHealthPoller samples Postgres health every thirty seconds over one dedicated
// connection and records db.health_sample. The dedicated connection matters: a
// saturated API pool would hide its own witness if the sample waited on it. The
// sample runs under a two-second deadline; any failure reconnects it next tick.
func RunHealthPoller(ctx context.Context, pool *pgxpool.Pool, connString string) {
	poller := &healthPoller{pool: pool, connString: connString, stmts: map[uint64]stmtCumulative{}}
	poller.sample(ctx)
	ticker := time.NewTicker(healthPollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			poller.close()
			return
		case <-ticker.C:
			poller.sample(ctx)
		}
	}
}

type healthPoller struct {
	pool       *pgxpool.Pool
	connString string
	conn       *pgx.Conn
	seq        int64
	lastStat   *poolSnapshot
	stmts      map[uint64]stmtCumulative
	stmtsRead  bool
}

type poolSnapshot struct {
	acquireCount        int64
	emptyAcquireCount   int64
	emptyAcquireWait    time.Duration
	canceledAcquireCount int64
}

type stmtCumulative struct {
	calls    int64
	totalMS  float64
}

type stmtDelta struct {
	queryID uint64
	calls   int64
	totalMS float64
}

func (p *healthPoller) close() {
	if p.conn != nil {
		_ = p.conn.Close(context.Background())
		p.conn = nil
	}
}

// connect opens the dedicated sample connection. Its runtime parameters keep the
// sample read-only and bounded even when the caller's deadline is wide.
func (p *healthPoller) connect(ctx context.Context) error {
	config, err := pgx.ParseConfig(p.connString)
	if err != nil {
		return fmt.Errorf("parse postgres url for health poller: %w", err)
	}
	config.RuntimeParams["application_name"] = healthApplicationName
	config.RuntimeParams["statement_timeout"] = strconv.Itoa(int(healthSampleTimeout / time.Millisecond))
	config.RuntimeParams["default_transaction_read_only"] = "on"
	config.ConnectTimeout = healthSampleTimeout
	conn, err := pgx.ConnectConfig(ctx, config)
	if err != nil {
		return fmt.Errorf("connect health poller: %w", err)
	}
	p.conn = conn
	return nil
}

// sample takes one health reading and records it. A sample whose reachability
// fails still carries the local pool picture; the server-side reads are reported
// through lock_status and stmt_status instead of pretending a zero.
func (p *healthPoller) sample(ctx context.Context) {
	p.seq++
	sampleCtx, cancel := context.WithTimeout(ctx, healthSampleTimeout)
	defer cancel()

	status := "ok"
	if p.conn == nil || p.conn.IsClosed() {
		p.conn = nil
		if err := p.connect(sampleCtx); err != nil {
			status = "unavailable(connect_failed)"
		}
	}
	var pingErr error
	if status == "ok" {
		pingErr = p.conn.Ping(sampleCtx)
		if pingErr != nil {
			if errors.Is(sampleCtx.Err(), context.DeadlineExceeded) {
				status = "unavailable(ping_timeout)"
			} else {
				status = "unavailable(connect_failed)"
			}
		}
	}
	reach := "up"
	if status != "ok" {
		reach = "down"
	}

	stat := p.pool.Stat()
	snap := poolSnapshot{
		acquireCount:         stat.AcquireCount(),
		emptyAcquireCount:    stat.EmptyAcquireCount(),
		emptyAcquireWait:     stat.EmptyAcquireWaitTime(),
		canceledAcquireCount: stat.CanceledAcquireCount(),
	}
	last := p.lastStat
	p.lastStat = &snap
	var deltas poolSnapshot
	if last != nil {
		deltas = poolSnapshot{
			acquireCount:         snap.acquireCount - last.acquireCount,
			emptyAcquireCount:    snap.emptyAcquireCount - last.emptyAcquireCount,
			emptyAcquireWait:     snap.emptyAcquireWait - last.emptyAcquireWait,
			canceledAcquireCount: snap.canceledAcquireCount - last.canceledAcquireCount,
		}
	}

	attrs := []slog.Attr{
		slog.Int64("sample_seq", p.seq),
		slog.String("db_status", status),
		slog.String("db_reach", reach),
		slog.Int64("max_conns", int64(stat.MaxConns())),
		slog.Int64("total_conns", int64(stat.TotalConns())),
		slog.Int64("acquired_conns", int64(stat.AcquiredConns())),
		slog.Int64("idle_conns", int64(stat.IdleConns())),
		slog.Int64("constructing_conns", int64(stat.ConstructingConns())),
		slog.Int64("acquire_count", deltas.acquireCount),
		slog.Int64("empty_acquire_count", deltas.emptyAcquireCount),
		slog.Int64("empty_acquire_wait_ms", deltas.emptyAcquireWait.Milliseconds()),
		slog.Int64("canceled_acquire_count", deltas.canceledAcquireCount),
	}

	if status != "ok" {
		attrs = append(attrs,
			slog.Int64("active_backends", 0),
			slog.Int64("idle_in_tx_backends", 0),
			slog.Int64("lock_waiters", 0),
			slog.Int64("max_lock_wait_ms", 0),
			slog.String("lock_status", "failed"),
			slog.String("stmt_status", "unavailable(unreachable)"),
		)
		obs.Fact(ctx, obs.EventDbHealthSample, attrs...)
		return
	}

	active, idleInTx, waiters, maxWaitMS, lockOK := p.serverSessions(sampleCtx)
	attrs = append(attrs,
		slog.Int64("active_backends", active),
		slog.Int64("idle_in_tx_backends", idleInTx),
		slog.Int64("lock_waiters", waiters),
		slog.Int64("max_lock_wait_ms", maxWaitMS),
	)
	if lockOK {
		attrs = append(attrs, slog.String("lock_status", "ok"))
		if blocker := p.blocker(sampleCtx, waiters); blocker != nil {
			attrs = append(attrs, blocker...)
		}
	} else {
		attrs = append(attrs, slog.String("lock_status", "failed"))
	}
	stmtStatus, stmtTop := p.statements(sampleCtx)
	attrs = append(attrs, slog.String("stmt_status", stmtStatus))
	if stmtTop != "" {
		attrs = append(attrs, slog.String("stmt_top", stmtTop))
	}
	obs.Fact(ctx, obs.EventDbHealthSample, attrs...)
}

// serverSessions counts the pool's backends and its Lock waiters in
// pg_stat_activity. The wait is measured from query_start, the instant the
// blocked statement began, so it includes the client's own queueing.
func (p *healthPoller) serverSessions(ctx context.Context) (active, idleInTx, waiters, maxWaitMS int64, ok bool) {
	const query = `select
		count(*) filter (where state = 'active'),
		count(*) filter (where state in ('idle in transaction', 'idle in transaction (aborted)')),
		count(*) filter (where wait_event_type = 'Lock'),
		coalesce(round(max(extract(epoch from (now() - query_start)) * 1000) filter (where wait_event_type = 'Lock')), 0)
	from pg_stat_activity
	where application_name = $1`
	if err := p.conn.QueryRow(ctx, query, PoolApplicationName).Scan(&active, &idleInTx, &waiters, &maxWaitMS); err != nil {
		return 0, 0, 0, 0, false
	}
	return active, idleInTx, waiters, maxWaitMS, true
}

// blocker names the session the pool's oldest Lock waiter is stuck behind. A
// non-superuser may see another session's identity hidden as nulls; the fields
// stay empty then rather than guess.
func (p *healthPoller) blocker(ctx context.Context, waiters int64) []slog.Attr {
	if waiters == 0 {
		return nil
	}
	const query = `select blocker.application_name, blocker.usename,
		coalesce(round(extract(epoch from (now() - blocker.xact_start)) * 1000), 0)
	from pg_stat_activity waiter
	cross join lateral unnest(pg_blocking_pids(waiter.pid)) blocked_by(pid)
	join pg_stat_activity blocker on blocker.pid = blocked_by.pid
	where waiter.application_name = $1 and waiter.wait_event_type = 'Lock'
	order by waiter.query_start asc
	limit 1`
	var appName, user *string
	var xactAgeMS int64
	if err := p.conn.QueryRow(ctx, query, PoolApplicationName).Scan(&appName, &user, &xactAgeMS); err != nil {
		return nil
	}
	attrs := []slog.Attr{slog.Int64("blocker_xact_age_ms", xactAgeMS)}
	if appName != nil {
		attrs = append(attrs, slog.String("blocker_application_name", *appName))
	}
	if user != nil {
		attrs = append(attrs, slog.String("blocker_usename", *user))
	}
	return attrs
}

// statements reads pg_stat_statements and reports the five largest deltas since
// the previous successful read. Only queryid, calls and total_exec_time are read;
// query text never leaves the database.
func (p *healthPoller) statements(ctx context.Context) (status, top string) {
	const query = `select queryid, calls, total_exec_time from pg_stat_statements`
	rows, err := p.conn.Query(ctx, query)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "42501" {
			return "unavailable(permission_denied)", ""
		}
		return "unavailable(extension_missing)", ""
	}
	defer rows.Close()

	current := map[uint64]stmtCumulative{}
	for rows.Next() {
		var queryID uint64
		var calls int64
		var totalMS float64
		if err := rows.Scan(&queryID, &calls, &totalMS); err != nil {
			return "unavailable(extension_missing)", ""
		}
		current[queryID] = stmtCumulative{calls: calls, totalMS: totalMS}
	}
	if err := rows.Err(); err != nil {
		return "unavailable(extension_missing)", ""
	}

	var deltas []stmtDelta
	if p.stmtsRead {
		for queryID, now := range current {
			before, seen := p.stmts[queryID]
			d := stmtDelta{queryID: queryID, calls: now.calls - before.calls, totalMS: now.totalMS - before.totalMS}
			if !seen || d.calls > 0 {
				deltas = append(deltas, d)
			}
		}
	}
	p.stmts = current
	p.stmtsRead = true
	if len(deltas) == 0 {
		return "ok", ""
	}
	sort.Slice(deltas, func(i, j int) bool { return deltas[i].totalMS > deltas[j].totalMS })
	if len(deltas) > 5 {
		deltas = deltas[:5]
	}
	parts := make([]string, len(deltas))
	for i, d := range deltas {
		parts[i] = fmt.Sprintf("%d:%d:%.0f", d.queryID, d.calls, d.totalMS)
	}
	return "ok", strings.Join(parts, ";")
}
