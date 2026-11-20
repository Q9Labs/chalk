package postgres

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/sdktelemetry"
	"github.com/q9labs/chalk/apps/api/internal/telemetrydelivery"
	"github.com/q9labs/chalk/apps/api/internal/telemetrydelivery/ledgertest"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func telemetryLedgerPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	databaseURL := os.Getenv("CHALK_TELEMETRY_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("CHALK_TELEMETRY_TEST_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err := pool.Ping(ctx); err != nil {
		t.Fatal(err)
	}
	return pool
}

// telemetryTenant is a seeded tenant with two Episodes, each live in its own Space, in db.
type telemetryTenant struct {
	db       sqlc.DBTX
	tenant   utilities.ID
	spaces   [2]utilities.ID
	episodes [2]utilities.ID
}

func seedTelemetryTenant(t *testing.T, db sqlc.DBTX) telemetryTenant {
	t.Helper()
	seed := telemetryTenant{db: db, tenant: accountTenantIntegrationID(t), spaces: [2]utilities.ID{accountTenantIntegrationID(t), accountTenantIntegrationID(t)}, episodes: [2]utilities.ID{accountTenantIntegrationID(t), accountTenantIntegrationID(t)}}
	mustExec(t, db, `insert into tenants(id, name) values($1, 'Telemetry ledger')`, uuid(seed.tenant))
	for index, episode := range seed.episodes {
		space := seed.spaces[index]
		mustExec(t, db, `insert into spaces(id, name, tenant_id, slug, media_plane) values($1, 'Telemetry ledger', $2, $3, 'cf_sfu')`, uuid(space), uuid(seed.tenant), "telemetry-ledger-"+space.String())
		mustExec(t, db, `insert into episodes(id, status, space_id, tenant_id, config_snapshot) values($1, 'active', $2, $3, '{"media_plane_binding":{"provider":"cf_sfu"}}'::jsonb)`, uuid(episode), uuid(space), uuid(seed.tenant))
	}
	return seed
}

// join makes a guest participant of the Episode. It has left, which still counts as live: the last
// records are sent as the client goes.
func (s telemetryTenant) join(t *testing.T, episode int) telemetrydelivery.Identity {
	t.Helper()
	id := accountTenantIntegrationID(t)
	mustExec(t, s.db, `insert into participants(id, tenant_id, space_id, episode_id, identity_id, capabilities, generation, status, role) values($1, $2, $3, $4, null, '{subscribe}'::text[], 1, 'left', 'collaborator')`, uuid(id), uuid(s.tenant), uuid(s.spaces[episode]), uuid(s.episodes[episode]))
	return telemetrydelivery.Identity{TenantID: s.tenant, EpisodeID: s.episodes[episode], ParticipantID: id}
}

// purge deletes the tenant the way the tenant purge does: under its advisory lock and its share
// row exclusive table lock, every row with the tenant_id, then the tenant.
func (s telemetryTenant) purge(t *testing.T) {
	t.Helper()
	mustExec(t, s.db, `select pg_advisory_xact_lock(734091287)`)
	mustExec(t, s.db, `lock table telemetry_sources, participants, episodes, spaces, tenants in share row exclusive mode`)
	for _, table := range []string{"telemetry_sources", "participants", "episodes", "spaces"} {
		mustExec(t, s.db, `delete from `+table+` where tenant_id = $1`, uuid(s.tenant))
	}
	mustExec(t, s.db, `delete from tenants where id = $1`, uuid(s.tenant))
}

// telemetryWorld runs the shared ledger contract in one transaction that is rolled back.
type telemetryWorld struct {
	telemetryTenant
	ledger TelemetryLedger
}

func (w telemetryWorld) Ledger() ledgertest.Ledger { return w.ledger }
func (w telemetryWorld) Join(t *testing.T, episode int) telemetrydelivery.Identity {
	return w.join(t, episode)
}
func (w telemetryWorld) Purge(t *testing.T) { w.purge(t) }

func TestTelemetryLedgerKeepsTheLedgerContract(t *testing.T) {
	pool := telemetryLedgerPool(t)
	ledgertest.Run(t, func(t *testing.T) ledgertest.World {
		tx, err := pool.Begin(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = tx.Rollback(context.Background()) })
		return telemetryWorld{telemetryTenant: seedTelemetryTenant(t, tx), ledger: NewTelemetryLedger(tx)}
	})
}

// committedTelemetryTenant seeds a tenant outside any transaction, for the proofs that need two
// connections, and removes it afterwards.
func committedTelemetryTenant(t *testing.T) (*pgxpool.Pool, telemetryTenant) {
	pool := telemetryLedgerPool(t)
	seed := seedTelemetryTenant(t, pool)
	t.Cleanup(func() {
		for _, table := range []string{"telemetry_sources", "participants", "episodes", "spaces"} {
			mustExec(t, pool, `delete from `+table+` where tenant_id = $1`, uuid(seed.tenant))
		}
		mustExec(t, pool, `delete from tenants where id = $1`, uuid(seed.tenant))
	})
	return pool, seed
}

// holdOpen admits a batch in a transaction it leaves open, so its locks stay held until commit.
func holdOpen(t *testing.T, pool *pgxpool.Pool, identity telemetrydelivery.Identity, request sdktelemetry.Request) pgx.Tx {
	t.Helper()
	tx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = tx.Rollback(context.Background()) })
	if _, err := NewTelemetryLedger(tx).Admit(t.Context(), identity, request, time.Now(), sdktelemetry.Stamp{}); err != nil {
		t.Fatal(err)
	}
	return tx
}

type admitted struct {
	admission telemetrydelivery.Admission
	err       error
}

// admitBehind admits on the pool and checks that it waits while the open transaction holds its
// locks, then commits that transaction and returns what the waiting admission saw.
func admitBehind(t *testing.T, pool *pgxpool.Pool, open pgx.Tx, identity telemetrydelivery.Identity, request sdktelemetry.Request) admitted {
	t.Helper()
	done := make(chan admitted, 1)
	go func() {
		admission, err := NewTelemetryLedger(pool).Admit(context.Background(), identity, request, time.Now(), sdktelemetry.Stamp{})
		done <- admitted{admission, err}
	}()
	select {
	case result := <-done:
		t.Fatalf("the admission finished (%+v) while the open transaction held its locks", result)
	case <-time.After(500 * time.Millisecond):
	}
	if err := open.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	return <-done
}

var proofSource = ledgertest.SourceID(10)

// Two copies of one batch: the second waits for the first's commit and then finds every record a
// duplicate.
func TestTelemetryLedgerConcurrentRetriesAreDuplicates(t *testing.T) {
	pool, seed := committedTelemetryTenant(t)
	owner := seed.join(t, 0)
	request := ledgertest.Batch(t, proofSource, 2, "", ledgertest.Record(0), ledgertest.Record(1))
	open := holdOpen(t, pool, owner, request)
	second := admitBehind(t, pool, open, owner, request)
	if second.err != nil || second.admission.Duplicates != 2 || len(second.admission.New) != 0 {
		t.Fatalf("second batch: duplicates = %d, new = %d, err = %v, want 2 duplicates and nothing new", second.admission.Duplicates, len(second.admission.New), second.err)
	}
}

// Two first batches of one new source from different participants: the second waits on the
// first's uncommitted row, then is refused as owned, so the source has one row of the first owner.
func TestTelemetryLedgerConcurrentFirstBatchesMakeOneOwner(t *testing.T) {
	pool, seed := committedTelemetryTenant(t)
	owner, other := seed.join(t, 0), seed.join(t, 0)
	request := ledgertest.Batch(t, proofSource, 1, "", ledgertest.Record(0))
	open := holdOpen(t, pool, owner, request)
	if second := admitBehind(t, pool, open, other, request); !errors.Is(second.err, telemetrydelivery.ErrSourceOwned) {
		t.Fatalf("second batch: err = %v, want ErrSourceOwned", second.err)
	}
	row, found, err := NewTelemetryLedger(pool).Source(t.Context(), seed.tenant, proofSource)
	if err != nil || !found || row.Owner() != owner {
		t.Fatalf("row = %+v, found = %v, err = %v, want one row owned by the first participant", row, found, err)
	}
}

// An admission that arrives while a purge of its tenant is open waits for the purge, then finds
// the participant gone and creates nothing.
func TestTelemetryLedgerAdmissionWaitsForAnOpenPurge(t *testing.T) {
	pool, seed := committedTelemetryTenant(t)
	owner := seed.join(t, 0)
	if _, err := NewTelemetryLedger(pool).Admit(t.Context(), owner, ledgertest.Batch(t, proofSource, 1, "", ledgertest.Record(0)), time.Now(), sdktelemetry.Stamp{}); err != nil {
		t.Fatal(err)
	}
	tx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = tx.Rollback(context.Background()) })
	purging := seed
	purging.db = tx
	purging.purge(t)
	after := admitBehind(t, pool, tx, owner, ledgertest.Batch(t, ledgertest.SourceID(11), 1, "", ledgertest.Record(0)))
	if !errors.Is(after.err, telemetrydelivery.ErrParticipantGone) {
		t.Fatalf("after the purge: err = %v, want ErrParticipantGone", after.err)
	}
	var count int
	if err := pool.QueryRow(t.Context(), `select count(*) from telemetry_sources where tenant_id = $1`, uuid(seed.tenant)).Scan(&count); err != nil || count != 0 {
		t.Fatalf("telemetry_sources rows = %d, err = %v, want none recreated", count, err)
	}
}

func TestTelemetryAckSurvivesRestartBeforeExport(t *testing.T) {
	pool, seed := committedTelemetryTenant(t)
	identity := seed.join(t, 0)
	request := ledgertest.Batch(t, ledgertest.SourceID(1), 1, "", ledgertest.Record(0))
	received := time.Now()
	if _, err := NewTelemetryLedger(pool).Admit(t.Context(), identity, request, received, sdktelemetry.Stamp{}); err != nil {
		t.Fatal(err)
	}
	// The process may stop here before any exporter runs. A fresh instance sees a duplicate.
	retry, err := NewTelemetryLedger(pool).Admit(t.Context(), identity, request, received, sdktelemetry.Stamp{})
	if err != nil || retry.Duplicates != 1 {
		t.Fatalf("retry = %+v, error = %v; want duplicate ACK", retry, err)
	}
	var rows int
	if err := pool.QueryRow(t.Context(), `select coalesce(sum(jsonb_array_length(payload)), 0) from telemetry_outbox where tenant_id = $1`, uuid(seed.tenant)).Scan(&rows); err != nil || rows != 1 {
		t.Fatalf("durable payloads after restart = %d, error = %v; want exactly one", rows, err)
	}
}

func TestTelemetryRelayRetainsPayloadUntilAxiomAcknowledgesAllFields(t *testing.T) {
	pool, seed := committedTelemetryTenant(t)
	identity := seed.join(t, 0)
	request := ledgertest.Batch(t, ledgertest.SourceID(1), 1, "", ledgertest.Record(0))
	ledger := NewTelemetryLedger(pool)
	if _, err := ledger.Admit(t.Context(), identity, request, time.Now(), sdktelemetry.Stamp{}); err != nil {
		t.Fatal(err)
	}

	deliveries := make(chan []byte, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		payload, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
		}
		partial := len(deliveries) == 0
		deliveries <- payload
		receipt := map[string]any{"ingested": 1, "failed": 0}
		if partial {
			receipt["messages"] = []map[string]string{{"code": "column_limit_drop"}}
		}
		_ = json.NewEncoder(w).Encode(receipt)
	}))
	defer server.Close()
	sink, err := observability.NewAxiomEvidence(server.URL, "Authorization=Bearer%20synthetic,x-axiom-dataset=test-logs")
	if err != nil {
		t.Fatal(err)
	}
	if count, err := ledger.RelayEvidence(t.Context(), sink.Export); count != 0 || err == nil {
		t.Fatalf("partial ingest: count=%d err=%v; want retry", count, err)
	}
	mustExec(t, pool, `update telemetry_outbox set available_at = now() where tenant_id = $1`, uuid(seed.tenant))
	if count, err := NewTelemetryLedger(pool).RelayEvidence(t.Context(), sink.Export); count != 1 || err != nil {
		t.Fatalf("relay after restart: count=%d err=%v; want one delivery", count, err)
	}
	if first, second := <-deliveries, <-deliveries; !bytes.Equal(first, second) {
		t.Fatal("retry changed stored evidence")
	}
	if count, err := ledger.RelayEvidence(t.Context(), sink.Export); count != 0 || err != nil {
		t.Fatalf("relay after full receipt: count=%d err=%v; want empty", count, err)
	}
}
