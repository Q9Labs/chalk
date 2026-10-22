package postgres

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// Use the production columns and indexes in connection-local tables, preserving
// 100,000 collected admissions as well as current due and future candidates.
func proveAdmissionCleanupPlan(t *testing.T, ctx context.Context, pool *pgxpool.Pool, handle utilities.ID) {
	t.Helper()
	connection, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Release()
	tx, err := connection.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := tx.Exec(ctx, query, args...); err != nil {
			t.Fatalf("cleanup seed %.80s: %v", query, err)
		}
	}
	exec(`create temp table proof_seed on commit drop as
      select to_jsonb(r) as request, to_jsonb(p) as participant,
        to_jsonb(public) as public_request, to_jsonb(a) as arrival
      from public.sync_admission_requests r
      join public.participants p on p.id=r.participant_id
      join public.space_public_admission_requests public on public.request_handle=r.admission_request_id
      join public.space_public_arrivals a on a.arrival_handle=public.arrival_handle
      where r.admission_request_id=$1`, uuid(handle))
	for _, table := range []string{"sync_admission_requests", "participants", "space_public_admission_requests", "space_public_arrivals", "episodes", "sync_lifecycle_intents", "sync_admission_invalidations"} {
		exec(`create temp table ` + table + ` (like public.` + table + ` including defaults including indexes) on commit drop`)
	}
	exec(`insert into episodes select * from public.episodes`)
	exec(`insert into participants select (jsonb_populate_record(null::participants, participant || jsonb_build_object(
      'id',md5('seat-'||n)::uuid,'account_id',null,'media_connection_id',null,
      'status',case when n<=100000 then 'left' else 'active' end,
      'joined_at',now()-interval '2 hours','left_at',case when n<=100000 then now()-interval '1 hour' else null end))).*
      from proof_seed cross join generate_series(1,100003) n`)
	exec(`insert into sync_admission_requests select (jsonb_populate_record(null::sync_admission_requests, request || jsonb_build_object(
      'admission_request_id',md5('request-'||n)::uuid,'participant_id',md5('seat-'||n)::uuid,
      'request_key','history_'||lpad(n::text,16,'0'),'status','admitted',
      'decision_external_operation_id',md5('operation-'||n)::uuid,
      'requested_at',now()-interval '2 hours','completed_at',now()-interval '10 minutes',
      'expires_at',case when n in (100002,100003) then now()+interval '5 minutes' else now()-interval '1 hour' end))).*
      from proof_seed cross join generate_series(1,100003) n`)
	exec(`insert into space_public_admission_requests select (jsonb_populate_record(null::space_public_admission_requests, public_request || jsonb_build_object(
      'request_handle',md5('request-'||n)::uuid,'arrival_handle',md5('arrival-'||n)::uuid,'state','approved'))).*
      from proof_seed cross join generate_series(1,100003) n`)
	exec(`insert into space_public_arrivals select (jsonb_populate_record(null::space_public_arrivals, arrival || jsonb_build_object(
      'arrival_handle',md5('arrival-'||n)::uuid,'idempotency_key','history_'||lpad(n::text,16,'0'),
      'participant_id',md5('seat-'||n)::uuid,'provider_subject',md5('subject-'||n),
      'state',case when n<=100000 then 'left' when n=100003 then 'unavailable' else 'pending' end))).*
      from proof_seed cross join generate_series(1,100003) n`)
	exec(`insert into participants select (jsonb_populate_record(null::participants, participant || jsonb_build_object(
      'id',md5('seat-'||n)::uuid,'account_id',null,'media_connection_id',null,'status','joining'))).*
      from proof_seed cross join generate_series(100004,200006) n`)
	exec(`insert into sync_admission_requests select (jsonb_populate_record(null::sync_admission_requests, request || jsonb_build_object(
      'admission_request_id',md5('request-'||n)::uuid,'participant_id',md5('seat-'||n)::uuid,
      'request_key','pending_'||lpad(n::text,16,'0'),'status','pending',
      'decision_external_operation_id',null,'completed_at',null,'requested_at',now()-interval '2 hours',
      'expires_at',case when n in (200004,200006) then now()-interval '1 minute' else now()+interval '5 minutes' end))).*
      from proof_seed cross join generate_series(100004,200006) n`)
	exec(`insert into space_public_admission_requests select (jsonb_populate_record(null::space_public_admission_requests, public_request || jsonb_build_object(
      'request_handle',md5('request-'||n)::uuid,'arrival_handle',md5('arrival-'||n)::uuid,'state','pending'))).*
      from proof_seed cross join generate_series(100004,200006) n`)
	exec(`insert into space_public_arrivals select (jsonb_populate_record(null::space_public_arrivals, arrival || jsonb_build_object(
      'arrival_handle',md5('arrival-'||n)::uuid,'idempotency_key','pending_'||lpad(n::text,16,'0'),
      'participant_id',null,'participant_generation',null,'episode_id',null,'provider',null,'provider_subject',null,
      'state',case when n in (200005,200006) then 'unavailable' else 'pending' end))).*
      from proof_seed cross join generate_series(100004,200006) n`)
	exec(`insert into sync_admission_invalidations(admission_request_id) select md5('request-'||n)::uuid from generate_series(200005,200006) n`)
	for _, table := range []string{"sync_admission_requests", "participants", "space_public_admission_requests", "space_public_arrivals", "episodes", "sync_lifecycle_intents", "sync_admission_invalidations"} {
		exec(`analyze ` + table)
	}
	source, err := os.ReadFile(filepath.Join("..", "..", "..", "db", "queries", "sync_lifecycle.sql"))
	if err != nil {
		t.Fatal(err)
	}
	query := strings.Split(strings.Split(string(source), "-- name: ListDueAdmissionRequests :many\n")[1], "-- name: LockEpisodeAdmissionRequest")[0]
	query = strings.ReplaceAll(query, "sqlc.arg(page_size)", "$1")
	var plan []byte
	if err := tx.QueryRow(ctx, "explain (analyze, buffers, format json) "+query, 50).Scan(&plan); err != nil {
		t.Fatal(err)
	}
	if path := os.Getenv("CHALK_PROOF_PLAN_PATH"); path != "" {
		if err := os.WriteFile(path, plan, 0600); err != nil {
			t.Fatal(err)
		}
	}
	var roots []struct {
		Plan admissionCleanupPlanNode `json:"Plan"`
	}
	if err := json.Unmarshal(plan, &roots); err != nil {
		t.Fatal(err)
	}
	if len(roots) != 1 {
		t.Fatalf("EXPLAIN roots=%d, want 1", len(roots))
	}
	activeIndex, admittedIndex, invalidatedIndex := false, false, false
	var inspect func(admissionCleanupPlanNode)
	inspect = func(node admissionCleanupPlanNode) {
		if node.Relation == "sync_admission_requests" && node.Removed > 50 {
			t.Errorf("pending selection filtered %.0f future requests instead of using a due index", node.Removed)
		}
		if node.Kind == "Seq Scan" && (node.Relation == "sync_admission_requests" || node.Relation == "participants" || node.Relation == "space_public_admission_requests" || node.Relation == "space_public_arrivals") {
			t.Errorf("retained-history relation uses sequential scan: %s", node.Relation)
		}
		// LIKE INCLUDING INDEXES assigns fresh names in pg_temp; match indexed
		// relations and actual work instead of copied index names.
		if node.Relation == "participants" && strings.Contains(node.Kind, "Index") && node.Rows == 3 {
			activeIndex = true
		}
		if node.Relation == "sync_admission_requests" && strings.Contains(node.Kind, "Index") && node.Loops == 3 {
			admittedIndex = true
		}
		if node.Relation == "sync_admission_requests" && strings.Contains(node.Kind, "Index") && node.Loops == 2 && strings.Contains(node.IndexCondition, "admission_request_id =") && !strings.Contains(node.IndexCondition, "expires_at") {
			invalidatedIndex = true
		}
		for _, child := range node.Children {
			inspect(child)
		}
	}
	inspect(roots[0].Plan)
	if !activeIndex || !admittedIndex || !invalidatedIndex {
		t.Fatalf("cleanup must start at 3 active seats and use 3 indexed admitted lookups: active=%v admitted=%v invalidated=%v; plan=%s", activeIndex, admittedIndex, invalidatedIndex, plan)
	}
	due, err := sqlc.New(tx).ListDueAdmissionRequests(ctx, 50)
	if err != nil || len(due) != 5 {
		t.Fatalf("seeded cleanup due rows=%d want 5, err=%v", len(due), err)
	}
	t.Log("EXPLAIN: 100000 retained collected admissions; 100000 future pending admissions; 3 current active seats; 5 unique due rows; indexed deadline, invalidation, and active-seat selection")
}

type admissionCleanupPlanNode struct {
	IndexCondition string                     `json:"Index Cond"`
	Kind           string                     `json:"Node Type"`
	Relation       string                     `json:"Relation Name"`
	Rows           float64                    `json:"Actual Rows"`
	Removed        float64                    `json:"Rows Removed by Filter"`
	Loops          float64                    `json:"Actual Loops"`
	Children       []admissionCleanupPlanNode `json:"Plans"`
}
