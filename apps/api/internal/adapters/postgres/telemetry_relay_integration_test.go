package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/sdktelemetry"
	"github.com/q9labs/chalk/apps/api/internal/telemetrydelivery/ledgertest"
)

func TestTelemetryBacklogBackpressuresWithoutAcknowledging(t *testing.T) {
	pool, seed := committedTelemetryTenant(t)
	mustExec(t, pool, `insert into telemetry_outbox_usage (tenant_id, max_bytes) values ($1, 0)`, uuid(seed.tenant))
	owner := seed.join(t, 0)
	source := ledgertest.SourceID(1)
	request := ledgertest.Batch(t, source, 1, "", ledgertest.Record(0))
	ledger := NewTelemetryLedger(pool)
	if _, err := ledger.Admit(t.Context(), owner, request, time.Now(), sdktelemetry.Stamp{}); err == nil {
		t.Fatal("the exhausted outbox admitted a batch")
	}
	if _, found, err := ledger.Source(t.Context(), seed.tenant, source); found || err != nil {
		t.Fatalf("source found = %v, err = %v; want the ledger write rolled back", found, err)
	}
	mustExec(t, pool, `update telemetry_outbox_usage set max_bytes = default where tenant_id = $1`, uuid(seed.tenant))
	if retry, err := ledger.Admit(t.Context(), owner, request, time.Now(), sdktelemetry.Stamp{}); err != nil || len(retry.New) != 1 {
		t.Fatalf("retry = %+v, err = %v; want evidence admitted as new", retry, err)
	}
}

func TestTelemetryRelayDoesNotExportDuringPurgeFence(t *testing.T) {
	pool, seed := committedTelemetryTenant(t)
	mustExec(t, pool, `insert into telemetry_outbox (tenant_id, payload) values ($1, '[{}]')`, uuid(seed.tenant))
	purge, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer purge.Rollback(t.Context())
	mustExec(t, purge, `lock table telemetry_outbox in share row exclusive mode`)
	ctx, cancel := context.WithTimeout(t.Context(), 100*time.Millisecond)
	defer cancel()
	exported := false
	_, err = NewTelemetryLedger(pool).RelayEvidence(ctx, func(context.Context, []json.RawMessage) error {
		exported = true
		return nil
	})
	if exported || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("exported = %v, err = %v; want the relay to wait before exporting", exported, err)
	}
}

func TestTelemetryRelayRetriesRefusedPayloadsSeparately(t *testing.T) {
	pool, seed := committedTelemetryTenant(t)
	mustExec(t, pool, `insert into telemetry_outbox (tenant_id, payload) values ($1, '[{"claim":"refused"}]'), ($1, '[{"claim":"healthy"}]')`, uuid(seed.tenant))
	ledger := NewTelemetryLedger(pool)
	refused := errors.New("incomplete receipt")
	export := func(_ context.Context, rows []json.RawMessage) error {
		for _, row := range rows {
			var payload struct{ Claim string }
			if err := json.Unmarshal(row, &payload); err != nil {
				t.Fatal(err)
			}
			if payload.Claim == "refused" {
				return refused
			}
		}
		return nil
	}
	_, _ = ledger.RelayEvidence(t.Context(), export)
	mustExec(t, pool, `update telemetry_outbox set available_at = now() where tenant_id = $1`, uuid(seed.tenant))
	_, _ = ledger.RelayEvidence(t.Context(), export)
	if shipped, err := ledger.RelayEvidence(t.Context(), export); shipped != 1 || err != nil {
		t.Fatalf("shipped = %d, err = %v; a refused payload must not hold back its neighbour", shipped, err)
	}
}

// The outbox counts its bytes per Tenant, in a table the Tenant purge selects by tenant_id. A counter
// outside the Tenant would be a retained row that every erase of a Tenant with pending evidence changes,
// and the purge rolls back when a retained row changes.
func TestTelemetryOutboxCountsBytesPerTenantInATableThePurgeErases(t *testing.T) {
	pool, seed := committedTelemetryTenant(t)
	queued := func() int64 {
		var bytes int64
		if err := pool.QueryRow(t.Context(), `select coalesce(sum(queued_bytes), 0) from telemetry_outbox_usage where tenant_id = $1`, uuid(seed.tenant)).Scan(&bytes); err != nil {
			t.Fatal(err)
		}
		return bytes
	}
	mustExec(t, pool, `insert into telemetry_outbox (tenant_id, payload) values ($1, '[{"a":1}]'), ($1, '[{"a":2}]')`, uuid(seed.tenant))
	both := queued()
	mustExec(t, pool, `delete from telemetry_outbox where tenant_id = $1 and payload = '[{"a":1}]'`, uuid(seed.tenant))
	if one := queued(); one <= 0 || one*2 != both {
		t.Fatalf("queued bytes = %d after one of two equal rows left, want half of %d", one, both)
	}
	mustExec(t, pool, `delete from telemetry_outbox where tenant_id = $1`, uuid(seed.tenant))
	if left := queued(); left != 0 {
		t.Fatalf("queued bytes = %d with the outbox empty, want 0", left)
	}
	catalog, err := loadPurgeCatalog(t.Context(), pool)
	if err != nil {
		t.Fatal(err)
	}
	for _, table := range catalog.Tables {
		if table.Name == "telemetry_outbox_usage" && !table.has("tenant_id") {
			t.Fatal("telemetry_outbox_usage has no tenant_id, so the purge would retain a row the outbox changes")
		}
	}
}
