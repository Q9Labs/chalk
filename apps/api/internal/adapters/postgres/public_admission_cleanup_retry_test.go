package postgres

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// This opt-in witness crosses API scheduling and actual Sync rollback/finalization.
// It does not replace failed operations or participant authority with SQL fixtures.
func proveUncollectedCleanupRetries(t *testing.T, ctx context.Context, pool *pgxpool.Pool, service publicinvites.Service, scheduler EpisodeLifecycleRepository, tenantID, spaceID, episodeID, accountID utilities.ID, newKnock func(string) (publicinvites.Arrival, publicinvites.AdmissionRequest)) {
	t.Helper()
	if os.Getenv("CHALK_PROOF_SYNC_FINALIZER") != "1" {
		t.Skip("set CHALK_PROOF_SYNC_FINALIZER for cross-runtime proof")
	}
	_, request := newKnock("Uncollected retry witness")
	var requestedRow, approvalRow, participantRow pgtype.UUID
	if err := pool.QueryRow(ctx, `select i.lifecycle_intent_id,r.participant_id from sync_admission_requests r join sync_lifecycle_intents i on i.tenant_id=r.tenant_id and i.episode_id=r.episode_id and i.request_key=r.request_key and i.intent_name='admission_requested' where r.admission_request_id=$1`, uuid(request.RequestHandle)).Scan(&requestedRow, &participantRow); err != nil {
		t.Fatal(err)
	}
	participant := utilities.IDFromBytes(participantRow.Bytes)
	runAdmissionSyncProof(t, ctx, tenantID, spaceID, episodeID, utilities.IDFromBytes(requestedRow.Bytes), "lifecycle")
	if _, _, err := service.DecideAdmissionRequest(ctx, publicinvites.DecideAdmissionRequestInput{TenantID: tenantID, SpaceID: spaceID, RequestHandle: request.RequestHandle, ActorID: accountID, RequestKey: accountTenantIntegrationID(t).String(), Decision: publicinvites.DecisionApprove}); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `select decision_external_operation_id from sync_admission_requests where admission_request_id=$1`, uuid(request.RequestHandle)).Scan(&approvalRow); err != nil {
		t.Fatal(err)
	}
	runAdmissionSyncProof(t, ctx, tenantID, spaceID, episodeID, utilities.IDFromBytes(approvalRow.Bytes), "confirmed")
	execSQL := func(query string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	execSQL(`update sync_admission_requests set completed_at=now()-interval '2 minutes',requested_at=now()-interval '6 minutes',expires_at=now()-interval '2 minutes' where admission_request_id=$1`, uuid(request.RequestHandle))
	var cleanup utilities.ID
	var terminalCount int
	terminalSQL := `select count(*) from observability_journey_events where name='participant.admission_not_collected'`
	for attempt := 0; attempt < 4; attempt++ {
		if _, err := scheduler.EnqueueDueEpisodeDeadlines(ctx, 50); err != nil {
			t.Fatal(err)
		}
		var currentRow pgtype.UUID
		if err := pool.QueryRow(ctx, `select external_operation_id from sync_external_operations where tenant_id=$1 and operation_name='remove_participant' and target_participant_id=$2`, uuid(tenantID), uuid(participant)).Scan(&currentRow); err != nil {
			t.Fatal(err)
		}
		current := utilities.IDFromBytes(currentRow.Bytes)
		if attempt == 0 {
			cleanup = current
			if err := pool.QueryRow(ctx, terminalSQL).Scan(&terminalCount); err != nil {
				t.Fatal(err)
			}
		} else if cleanup != current {
			t.Fatal("cleanup allocated another retained operation")
		}
		var fences int
		if err := pool.QueryRow(ctx, `select count(*) from sync_publication_fences where external_operation_id=$1 and participant_generation=(select generation from participants where id=$2) and expires_at>now()`, uuid(cleanup), uuid(participant)).Scan(&fences); err != nil || fences != 3 {
			t.Fatalf("fresh authority fences=%d: %v", fences, err)
		}
		if attempt == 3 {
			break
		}
		runAdmissionSyncProof(t, ctx, tenantID, spaceID, episodeID, cleanup, "failed")
		// A failed provider attempt must not retry on every one-second sweep.
		if _, err := scheduler.EnqueueDueEpisodeDeadlines(ctx, 50); err != nil {
			t.Fatal(err)
		}
		var failed string
		if err := pool.QueryRow(ctx, `select status from sync_external_operations where external_operation_id=$1`, uuid(cleanup)).Scan(&failed); err != nil || failed != "failed" {
			t.Fatalf("cleanup retried before backoff: %s %v", failed, err)
		}
		execSQL(`update sync_external_operations set completed_at=now()-interval '2 minutes',attempt_count=100 where external_operation_id=$1`, uuid(cleanup))
	}
	runAdmissionSyncProof(t, ctx, tenantID, spaceID, episodeID, cleanup, "recovered")
	if _, err := scheduler.EnqueueDueEpisodeDeadlines(ctx, 50); err != nil {
		t.Fatal(err)
	}
	var status string
	if err := pool.QueryRow(ctx, `select status from participants where id=$1`, uuid(participant)).Scan(&status); err != nil || status != "left" {
		t.Fatalf("recovered cleanup seat=%s: %v", status, err)
	}
	var terminals int
	if err := pool.QueryRow(ctx, terminalSQL).Scan(&terminals); err != nil || terminals != terminalCount {
		t.Fatalf("terminal admission outcome repeated: before=%d after=%d: %v", terminalCount, terminals, err)
	}
}

func runAdmissionSyncProof(t *testing.T, ctx context.Context, tenant, space, episode, target utilities.ID, action string) {
	t.Helper()
	code := fmt.Sprintf(`
Application.ensure_all_started(:postgrex)
Code.ensure_loaded!(ChalkSync.Stateholder.Postgres.Lifecycle)
connections = ChalkSync.SyncPostgres.start_connections(System.fetch_env!("CHALK_DATABASE_URL"))
Application.put_env(:chalk_sync, :database_connections, ChalkSync.SyncPostgres.selector(connections))
episode = %%ChalkSync.Stateholder.EpisodeKey{tenant_id: %q, space_id: %q, episode_id: %q}
target = %q
result = case %q do
  "lifecycle" -> ChalkSync.Stateholder.Postgres.apply_lifecycle_intent(episode, target)
  "confirmed" -> ChalkSync.Stateholder.Postgres.finalize_operation(episode, target, {:confirmed, :local})
  action when action in ["failed", "recovered"] ->
    {:ok, claimed} = ChalkSync.Stateholder.Postgres.claim_operations(64)
    {^episode, operation} = Enum.find(claimed, fn {_, operation} -> operation.external_operation_id == target end)
    outcome = if action == "failed", do: {:terminal_failure, :provider_rejected}, else: :confirmed
    {:ok, adapter} = ChalkSync.Live.MediaPlaneTestAdapter.start_link(outcomes: %%{remove_participant: outcome})
    expected = if action == "failed", do: :terminal_failure, else: :confirmed
    ^expected = ChalkSync.ExternalOperationConsumer.execute_operation(episode, operation,
      {ChalkSync.Live.MediaPlaneTestAdapter, adapter}, nil, &ChalkSync.Stateholder.Postgres.finalize_operation/3)
    [{:remove_participant, ^target, _}] = ChalkSync.Live.MediaPlaneTestAdapter.calls(adapter)
    {:ok, :executed}
end
case result do
  {:ok, _} -> :ok
  other -> IO.inspect(other); System.halt(1)
end
`, tenant.String(), space.String(), episode.String(), target.String(), action)

	command := exec.CommandContext(ctx, "mix", "run", "--no-start", "-e", code)
	command.Dir = filepath.Join("..", "..", "..", "..", "sync")
	command.Env = append(os.Environ(), "MIX_ENV=test", "ERL_FLAGS=+S 1:1")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("Sync %s: %v\n%s", action, err, output)
	}
}
