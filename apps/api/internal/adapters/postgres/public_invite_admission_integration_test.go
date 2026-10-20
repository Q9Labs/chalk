package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
)

// The signed-in dashboard's Start a call action creates this knock policy.
// An isolated guest must reach the same live Episode queue as an SDK knock.
func TestDashboardCallPublicKnockReachesEpisodeAdmission(t *testing.T) {
	databaseURL := os.Getenv(config.DatabaseURL)
	if testing.Short() || databaseURL == "" {
		t.Skip("isolated PostgreSQL integration database is not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	tenantID, accountID := accountTenantIntegrationID(t), accountTenantIntegrationID(t)
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`insert into users(id,name,email) values($1,'Dashboard host',$2)`, uuid(accountID), accountID.String()+"@admission.test")
	exec(`insert into tenants(id,name) values($1,'Dashboard admission fixture')`, uuid(tenantID))
	exec(`insert into tenant_artifact_policies(tenant_id) values($1)`, uuid(tenantID))
	// These pending lifecycle rows must never escape into another Sync test.
	defer func() {
		for _, table := range []string{"space_public_admission_requests", "space_public_arrivals", "sync_admission_requests", "sync_external_operations", "sync_lifecycle_intents"} {
			if _, err := pool.Exec(context.Background(), "delete from "+table+" where tenant_id=$1", uuid(tenantID)); err != nil {
				t.Errorf("cleanup %s: %v", table, err)
			}
		}
	}()
	queries := sqlc.New(pool)
	spaceService := spaces.NewService(NewSpaceRepository(queries, pool))
	space, err := spaceService.CreateSpace(ctx, spaces.CreateSpaceInput{
		TenantID: tenantID, Name: "New call", Slug: "call-" + accountTenantIntegrationID(t).String(),
		MediaPlane: "cf_sfu", AdmissionPolicy: json.RawMessage(`{"mode":"knock"}`),
		DefaultEpisodeDurationSeconds: 3600, MaximumEpisodeDurationSeconds: 86400, LingerWindowSeconds: 60,
		RequestKey: accountTenantIntegrationID(t).String(),
	})
	if err != nil {
		t.Fatal(err)
	}
	episodeRepository := NewEpisodeLifecycleRepository(pool)
	host, err := episodes.NewService(episodeRepository).JoinPublic(ctx, episodes.PublicJoinInput{
		TenantID: tenantID, SpaceID: space.ID, AccountID: accountID, IdentityMode: "account", DisplayName: "Dashboard host", Role: "owner",
		Request: episodes.Request{Key: accountTenantIntegrationID(t).String()},
	})
	if err != nil {
		t.Fatal(err)
	}
	repository := NewPublicInviteRepositoryWithPool(pool)
	service := publicinvites.NewService(repository)
	invite, err := service.EnsureInvite(ctx, tenantID, space.ID, accountID, publicinvites.AdmissionKnock)
	if err != nil {
		t.Fatal(err)
	}
	arrival, err := service.CreateArrival(ctx, publicinvites.CreateArrivalInput{
		TenantID: tenantID, SpaceID: space.ID,
		Invite: publicinvites.Token{Handle: invite.Handle, Generation: invite.Generation}, InviteStateEpoch: invite.StateEpoch,
		IdentityMode: publicinvites.IdentityGuest, DisplayName: "Isolated guest", GuestCredential: []byte("isolated-test-guest-credential"), IdempotencyKey: accountTenantIntegrationID(t).String(),
	})
	if err != nil {
		t.Fatal(err)
	}
	journeyID := accountTenantIntegrationID(t)
	knockCtx := observability.ContextWithJourneyID(ctx, journeyID)
	request, err := service.CreateAdmissionRequest(knockCtx, publicinvites.CreateAdmissionRequestInput{ArrivalHandle: arrival.Arrival.ArrivalHandle, DisplayName: "Isolated guest"})
	if err != nil {
		t.Fatal(err)
	}
	var count int
	if err := pool.QueryRow(ctx, `select count(*) from sync_admission_requests where tenant_id=$1 and space_id=$2 and episode_id=$3 and admission_request_id=$4 and status='pending'`, uuid(tenantID), uuid(space.ID), uuid(host.Episode.ID), uuid(request.RequestHandle)).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatal("public knock is missing from the live Episode admission queue")
	}
	var payload json.RawMessage
	if err := pool.QueryRow(ctx, `select payload from sync_lifecycle_intents where tenant_id=$1 and episode_id=$2 and intent_name='admission_requested'`, uuid(tenantID), uuid(host.Episode.ID)).Scan(&payload); err != nil {
		t.Fatal(err)
	}
	var event struct {
		ID          string `json:"admission_request_id"`
		DisplayName string `json:"display_name"`
	}
	if err := json.Unmarshal(payload, &event); err != nil {
		t.Fatal(err)
	}
	if event.ID != request.RequestHandle.String() || event.DisplayName != "Isolated guest" {
		t.Fatalf("host admission event = %s", payload)
	}
	replay, err := service.CreateAdmissionRequest(ctx, publicinvites.CreateAdmissionRequestInput{ArrivalHandle: arrival.Arrival.ArrivalHandle, DisplayName: "Isolated guest"})
	if err != nil || replay.RequestHandle != request.RequestHandle {
		t.Fatalf("retry created a second knock: %v, %v", replay, err)
	}
	// The deadline worker reserves the canonical expiry operation exactly once.
	// A pending request remains pending until Sync commits its terminal result.
	exec(`update sync_admission_requests set requested_at=now()-interval '6 minutes', expires_at=now()-interval '1 second' where tenant_id=$1 and admission_request_id=$2`, uuid(tenantID), uuid(request.RequestHandle))
	pending, err := repository.GetAdmissionRequest(ctx, tenantID, space.ID, request.RequestHandle)
	if err != nil || pending.State != publicinvites.AdmissionRequestPending {
		t.Fatalf("uncommitted expiry must not race a host decision: %+v, %v", pending, err)
	}
	if _, err := episodeRepository.EnqueueDueEpisodeDeadlines(ctx, 50); err != nil {
		t.Fatal(err)
	}
	if _, err := episodeRepository.EnqueueDueEpisodeDeadlines(ctx, 50); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `select count(*) from sync_external_operations operations join sync_admission_requests requests on requests.tenant_id=operations.tenant_id and requests.episode_id=operations.episode_id and requests.decision_external_operation_id=operations.external_operation_id where requests.tenant_id=$1 and requests.admission_request_id=$2 and operations.operation_name='admission_request_expired' and operations.journey_id=$3`, uuid(tenantID), uuid(request.RequestHandle), uuid(journeyID)).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("canonical expiry operations = %d, want 1", count)
	}

	invalidated, err := service.CreateArrival(ctx, publicinvites.CreateArrivalInput{
		TenantID: tenantID, SpaceID: space.ID,
		Invite: publicinvites.Token{Handle: invite.Handle, Generation: invite.Generation}, InviteStateEpoch: invite.StateEpoch,
		IdentityMode: publicinvites.IdentityGuest, DisplayName: "Invalidated guest", GuestCredential: []byte("invalidated-test-guest-credential"), IdempotencyKey: accountTenantIntegrationID(t).String(),
	})
	if err != nil {
		t.Fatal(err)
	}
	invalidRequest, err := service.CreateAdmissionRequest(ctx, publicinvites.CreateAdmissionRequestInput{ArrivalHandle: invalidated.Arrival.ArrivalHandle, DisplayName: "Invalidated guest"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.UpdateArrivalState(ctx, publicinvites.UpdateArrivalStateInput{TenantID: tenantID, ArrivalHandle: invalidated.Arrival.ArrivalHandle, State: publicinvites.ArrivalUnavailable, Reason: "public_arrival_invalidated"}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := service.DecideAdmissionRequest(ctx, publicinvites.DecideAdmissionRequestInput{TenantID: tenantID, SpaceID: space.ID, RequestHandle: invalidRequest.RequestHandle, ActorID: accountID, Decision: publicinvites.DecisionApprove}); !errors.Is(err, publicinvites.ErrAdmissionRequestTerminal) {
		t.Fatalf("approval of an invalidated arrival = %v", err)
	}
	if _, err := episodeRepository.EnqueueDueEpisodeDeadlines(ctx, 50); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `select count(*) from sync_external_operations operations join sync_admission_requests requests on requests.tenant_id=operations.tenant_id and requests.episode_id=operations.episode_id and requests.decision_external_operation_id=operations.external_operation_id where requests.tenant_id=$1 and requests.admission_request_id=$2 and operations.operation_name='admission_request_expired'`, uuid(tenantID), uuid(invalidRequest.RequestHandle)).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("invalidated arrival expiry operations = %d, want 1", count)
	}

}
