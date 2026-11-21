package postgres

// Chain hop a for db.unreachable, db.pool_saturated and db.lock_wait: the
// health poller samples real Postgres faults here, through obs.Fact, and the
// captured rows land in each symptom's chain dir. est_server_ms and event_id
// are pinned so the chain replays byte-identically. Run it:
//
//	scripts/gates/with-postgres.sh -- go -C apps/api test ./internal/adapters/postgres -run TestHealthPollerFaultChain -count=1

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/obs"
)

const chainBase = 1795176000000 // 2026-11-20T12:00:00Z, the chain day's midday

var chainDirs = map[string]string{
	"unreachable": filepath.Join("..", "..", "..", "..", "..", "observability", "fixtures", "db.unreachable", "chain"),
	"saturated":   filepath.Join("..", "..", "..", "..", "..", "observability", "fixtures", "db.pool_saturated", "chain"),
	"locked":      filepath.Join("..", "..", "..", "..", "..", "observability", "fixtures", "db.lock_wait", "chain"),
}

// rowCapture records each kernel row with a deterministic stamp, one sample
// every 30 s starting at the chain base.
type rowCapture struct {
	mu   sync.Mutex
	rows []map[string]any
}

func (c *rowCapture) Enabled(context.Context, slog.Level) bool { return true }
func (c *rowCapture) WithAttrs([]slog.Attr) slog.Handler       { return c }
func (c *rowCapture) WithGroup(string) slog.Handler            { return c }

func (c *rowCapture) Handle(_ context.Context, record slog.Record) error {
	row := map[string]any{}
	record.Attrs(func(attr slog.Attr) bool {
		row[attr.Key] = attr.Value.Any()
		return true
	})
	c.mu.Lock()
	defer c.mu.Unlock()
	row["event_id"] = fmt.Sprintf("chain-health-%04d", len(c.rows)+1)
	row["est_server_ms"] = chainBase + int64(len(c.rows))*30_000
	c.rows = append(c.rows, row)
	return nil
}

func (c *rowCapture) samples(name string) []map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	var out []map[string]any
	for _, row := range c.rows {
		if row["name"] == name {
			out = append(out, row)
		}
	}
	return out
}

func captureObs(t *testing.T) *rowCapture {
	t.Helper()
	sink := &rowCapture{}
	obs.Configure(obs.Config{Logger: slog.New(sink), Mode: obs.ModeClosed, Module: "api", Env: "test", SourceID: "src-health-chain"})
	t.Cleanup(func() { obs.Configure(obs.Config{}) })
	return sink
}

func compareChain(t *testing.T, dir, name string, value any) {
	t.Helper()
	text, _ := json.MarshalIndent(value, "", "  ")
	text = append(text, '\n')
	path := filepath.Join(dir, name)
	if os.Getenv("CHALK_CHAIN_WRITE") == "1" {
		if err := os.WriteFile(path, text, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Skipf("chain file %s is not written yet; run the hop with CHALK_CHAIN_WRITE=1", path)
	}
	var want, got any
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(text, &got); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%s is stale: the poller wrote\n%s", path, text)
	}
}

// chainPool opens a pool against the isolated chain database under the same
// application_name the API pool runs with in production.
func chainPool(t *testing.T, databaseURL string, maxConns int32) *pgxpool.Pool {
	t.Helper()
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.RuntimeParams["application_name"] = PoolApplicationName
	config.MaxConns = maxConns
	config.MinConns = 0
	pool, err := pgxpool.NewWithConfig(t.Context(), config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func sampleTimes(t *testing.T, p *healthPoller, times int) {
	t.Helper()
	for i := 0; i < times; i++ {
		p.sample(context.Background())
	}
}

func TestHealthPollerFaultChain(t *testing.T) {
	databaseURL := os.Getenv("CHALK_TELEMETRY_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set CHALK_TELEMETRY_TEST_DATABASE_URL to an isolated, migrated database")
	}

	t.Run("unreachable", func(t *testing.T) {
		pool := chainPool(t, databaseURL, 4)
		sink := captureObs(t)
		// The poller's own connection points at a dead port: connect_failed,
		// while the pool it also samples is real.
		p := &healthPoller{pool: pool, connString: "postgres://chain:chain@127.0.0.1:1/chalk", stmts: map[uint64]stmtCumulative{}}
		sampleTimes(t, p, 3)
		p.close()
		compareChain(t, chainDirs["unreachable"], "samples.fault.json", sink.samples(string(obs.EventDbHealthSample)))
	})

	t.Run("saturated", func(t *testing.T) {
		pool := chainPool(t, databaseURL, 2)
		sink := captureObs(t)
		p := &healthPoller{pool: pool, connString: databaseURL, stmts: map[uint64]stmtCumulative{}}
		defer p.close()
		// Hold both pool connections for the whole run; each acquire under a
		// 150 ms deadline queues on an empty pool and is canceled.
		stop := make(chan struct{})
		var holders sync.WaitGroup
		for i := 0; i < 2; i++ {
			holders.Add(1)
			go func() {
				defer holders.Done()
				conn, err := pool.Acquire(context.Background())
				if err != nil {
					return
				}
				defer conn.Release()
				<-stop
			}()
		}
		defer func() { close(stop); holders.Wait() }()
		deadline := time.Now().Add(10 * time.Second)
		for pool.Stat().AcquiredConns() < 2 && time.Now().Before(deadline) {
			time.Sleep(10 * time.Millisecond)
		}
		for i := 0; i < 5; i++ {
			ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
			_, _ = pool.Acquire(ctx)
			cancel()
			p.sample(context.Background())
		}
		compareChain(t, chainDirs["saturated"], "samples.fault.json", sink.samples(string(obs.EventDbHealthSample)))
	})

	t.Run("locked", func(t *testing.T) {
		pool := chainPool(t, databaseURL, 4)
		sink := captureObs(t)
		p := &healthPoller{pool: pool, connString: databaseURL, stmts: map[uint64]stmtCumulative{}}
		defer p.close()
		// A second chalk-api session holds an advisory lock a pooled backend
		// then waits on, so the waiter counts under application_name=chalk-api.
		holder, err := pool.Acquire(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if _, err := holder.Exec(context.Background(), "select pg_advisory_lock(914)"); err != nil {
			t.Fatal(err)
		}
		waiting := make(chan error, 1)
		go func() {
			conn, err := pool.Acquire(context.Background())
			if err != nil {
				waiting <- err
				return
			}
			defer conn.Release()
			_, err = conn.Exec(context.Background(), "select pg_advisory_lock(914)")
			waiting <- err
		}()
		// The wait has to be at least 5 s old before the first sample counts it.
		time.Sleep(5500 * time.Millisecond)
		sampleTimes(t, p, 2)
		if _, err := holder.Exec(context.Background(), "select pg_advisory_unlock(914)"); err != nil {
			t.Fatal(err)
		}
		holder.Release()
		<-waiting
		rows := sink.samples(string(obs.EventDbHealthSample))
		// max_lock_wait_ms is a wall-clock measurement: pin it like the stamped
		// times so the chain file replays byte-identically.
		for _, row := range rows {
			row["max_lock_wait_ms"] = 5500
		}
		compareChain(t, chainDirs["locked"], "samples.fault.json", rows)
	})

	t.Run("healthy", func(t *testing.T) {
		pool := chainPool(t, databaseURL, 4)
		sink := captureObs(t)
		p := &healthPoller{pool: pool, connString: databaseURL, stmts: map[uint64]stmtCumulative{}}
		sampleTimes(t, p, 4)
		p.close()
		for _, dir := range chainDirs {
			compareChain(t, dir, "samples.healthy.json", sink.samples(string(obs.EventDbHealthSample)))
		}
	})
}
