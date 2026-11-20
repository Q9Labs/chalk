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
	var bounded bool
	if err := pool.QueryRow(t.Context(), `select to_regclass('telemetry_outbox_capacity') is not null`).Scan(&bounded); err != nil {
		t.Fatal(err)
	}
	if bounded {
		mustExec(t, pool, `update telemetry_outbox_capacity set max_bytes = queued_bytes`)
		t.Cleanup(func() { mustExec(t, pool, `update telemetry_outbox_capacity set max_bytes = 67108864`) })
	}
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
	mustExec(t, pool, `update telemetry_outbox_capacity set max_bytes = 67108864`)
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
