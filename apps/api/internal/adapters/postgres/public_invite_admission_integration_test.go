package postgres

import (
	"context"
	"encoding/json"
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
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// dashboardKnockFixture is a Space with a started Episode and a knock invite, as the signed-in
// dashboard's Start a call action creates them.
type dashboardKnockFixture struct {
	t                 *testing.T
	ctx               context.Context
	knockCtx          context.Context
	pool              *pgxpool.Pool
	tenantID          utilities.ID
	accountID         utilities.ID
	spaceID           utilities.ID
	episodeID         utilities.ID
	service           publicinvites.Service
	repository        PublicInviteRepository
	episodeRepository EpisodeLifecycleRepository
	invite            publicinvites.Invite
	journeyID         utilities.ID
}

func newDashboardKnockFixture(t *testing.T) *dashboardKnockFixture {
	t.Helper()
	databaseURL := os.Getenv(config.DatabaseURL)
	if testing.Short() || databaseURL == "" {
		t.Skip("isolated PostgreSQL integration database is not configured")
	}
	timeout := 30 * time.Second
	if os.Getenv("CHALK_PROOF_CLEANUP_EXPLAIN") == "1" {
		timeout = 5 * time.Minute
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	t.Cleanup(cancel)
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	f := &dashboardKnockFixture{
		t: t, ctx: ctx, pool: pool,
		tenantID: accountTenantIntegrationID(t), accountID: accountTenantIntegrationID(t),
		journeyID: accountTenantIntegrationID(t),
	}
	f.exec(`insert into users(id,name,email) values($1,'Dashboard host',$2)`, uuid(f.accountID), f.accountID.String()+"@admission.test")
	f.exec(`insert into tenants(id,name) values($1,'Dashboard admission fixture')`, uuid(f.tenantID))
	f.exec(`insert into tenant_artifact_policies(tenant_id) values($1)`, uuid(f.tenantID))
	// These pending lifecycle rows must never escape into another Sync test.
	t.Cleanup(f.deleteLifecycleRows)
	f.startEpisodeWithKnockInvite()
	f.knockCtx = observability.ContextWithJourneyID(ctx, f.journeyID)
	return f
}

func (f *dashboardKnockFixture) deleteLifecycleRows() {
	for _, table := range []string{"space_public_admission_requests", "space_public_arrivals", "sync_admission_requests", "sync_publication_fences", "sync_external_operations", "sync_lifecycle_intents"} {
		if _, err := f.pool.Exec(context.Background(), "delete from "+table+" where tenant_id=$1", uuid(f.tenantID)); err != nil {
			f.t.Errorf("cleanup %s: %v", table, err)
		}
	}
}

// startEpisodeWithKnockInvite starts an Episode in an open Space, then switches the Space policy to
// knock: the Episode freezes open mode, but knocks and host decisions must follow the current Space
// policy after that Episode has already started.
func (f *dashboardKnockFixture) startEpisodeWithKnockInvite() {
	t, ctx := f.t, f.ctx
	spaceService := spaces.NewService(NewSpaceRepository(sqlc.New(f.pool), f.pool))
	space, err := spaceService.CreateSpace(ctx, spaces.CreateSpaceInput{
		TenantID: f.tenantID, Name: "New call", Slug: "call-" + accountTenantIntegrationID(t).String(),
		MediaPlane: "cf_sfu", AdmissionPolicy: json.RawMessage(`{"mode":"open"}`),
		DefaultEpisodeDurationSeconds: 3600, MaximumEpisodeDurationSeconds: 86400, LingerWindowSeconds: 60,
		RequestKey: accountTenantIntegrationID(t).String(),
	})
	if err != nil {
		t.Fatal(err)
	}
	f.spaceID = space.ID
	f.episodeRepository = NewEpisodeLifecycleRepository(f.pool)
	host, err := episodes.NewService(f.episodeRepository).JoinPublic(ctx, episodes.PublicJoinInput{
		TenantID: f.tenantID, SpaceID: space.ID, AccountID: f.accountID, IdentityMode: "account", DisplayName: "Dashboard host", Role: "owner",
		Request: episodes.Request{Key: accountTenantIntegrationID(t).String()},
	})
	if err != nil {
		t.Fatal(err)
	}
	f.episodeID = host.Episode.ID
	if _, err := spaceService.UpdateSpace(ctx, f.tenantID, space.ID, spaces.UpdateSpaceInput{
		AdmissionPolicy: utilities.OptionalJSON{Set: true, Value: json.RawMessage(`{"mode":"knock"}`)},
	}); err != nil {
		t.Fatal(err)
	}
	f.repository = NewPublicInviteRepositoryWithPool(f.pool)
	f.service = publicinvites.NewService(f.repository)
	f.invite, err = f.service.EnsureInvite(ctx, f.tenantID, space.ID, f.accountID, publicinvites.AdmissionKnock)
	if err != nil {
		t.Fatal(err)
	}
}

func (f *dashboardKnockFixture) exec(query string, args ...any) {
	f.t.Helper()
	if _, err := f.pool.Exec(f.ctx, query, args...); err != nil {
		f.t.Fatal(err)
	}
}

// count runs a query that returns one number.
func (f *dashboardKnockFixture) count(query string, args ...any) int {
	f.t.Helper()
	var count int
	if err := f.pool.QueryRow(f.ctx, query, args...).Scan(&count); err != nil {
		f.t.Fatal(err)
	}
	return count
}

func (f *dashboardKnockFixture) newArrival(name, credential string) publicinvites.Arrival {
	f.t.Helper()
	created, err := f.service.CreateArrival(f.ctx, publicinvites.CreateArrivalInput{
		TenantID: f.tenantID, SpaceID: f.spaceID,
		Invite: publicinvites.Token{Handle: f.invite.Handle, Generation: f.invite.Generation}, InviteStateEpoch: f.invite.StateEpoch,
		IdentityMode: publicinvites.IdentityGuest, DisplayName: name, GuestCredential: []byte(credential), IdempotencyKey: accountTenantIntegrationID(f.t).String(),
	})
	if err != nil {
		f.t.Fatal(err)
	}
	return created.Arrival
}

func (f *dashboardKnockFixture) newKnock(name string) (publicinvites.Arrival, publicinvites.AdmissionRequest) {
	f.t.Helper()
	arrival := f.newArrival(name, "isolated-test-guest-credential")
	request, err := f.service.CreateAdmissionRequest(f.knockCtx, publicinvites.CreateAdmissionRequestInput{ArrivalHandle: arrival.ArrivalHandle, DisplayName: name})
	if err != nil {
		f.t.Fatal(err)
	}
	return arrival, request
}

func (f *dashboardKnockFixture) decideInput(request publicinvites.AdmissionRequest, decision publicinvites.AdmissionDecision) publicinvites.DecideAdmissionRequestInput {
	return publicinvites.DecideAdmissionRequestInput{TenantID: f.tenantID, SpaceID: f.spaceID, RequestHandle: request.RequestHandle, ActorID: f.accountID, Decision: decision}
}

// The signed-in dashboard's Start a call action creates this knock policy.
// An isolated guest must reach the same live Episode queue as an SDK knock.
func TestDashboardCallPublicKnockReachesEpisodeAdmission(t *testing.T) {
	f := newDashboardKnockFixture(t)
	ctx, pool := f.ctx, f.pool
	arrival := f.newArrival("Isolated guest", "isolated-test-guest-credential")
	t.Run("expired pending arrival retry", func(t *testing.T) {
		proveExpiredPendingArrivalRetry(t, ctx, pool, f.repository, f.invite, f.tenantID, f.spaceID)
	})
	t.Run("mixed version arrival lock", func(t *testing.T) { proveAdmissionRolloutLockOrder(t, ctx, pool, arrival.ArrivalHandle) })
	t.Run("control before Episode", func(t *testing.T) {
		control := f.newArrival("Control guest", "control-lock-test-credential")
		proveAdmissionControlLockOrder(t, ctx, pool, f.tenantID, f.episodeID, control.ArrivalHandle)
	})

	arrival = f.newArrival("Isolated guest", "isolated-test-guest-credential")
	request := f.proveKnockReachesQueue(arrival)
	f.proveKnockExpiryOperation(request)
	f.proveInvalidatedArrivalExpiry()
	f.proveFailedExpiryRequeued(request)

	t.Run("mixed version canonical decision gate", func(t *testing.T) {
		proveCanonicalAdmissionRejectsLegacyDecision(t, ctx, pool, f.service, f.accountID, f.newKnock)
	})
	t.Run("mixed version decision lock", func(t *testing.T) {
		_, request := f.newKnock("Rollout decision guest")
		proveAdmissionDecisionRolloutLockOrder(t, ctx, pool, request, f.accountID)
	})
	f.proveDecisionRetriesReuseOperation()
	t.Run("decision progress permits retry", func(t *testing.T) { f.proveDecisionProgress() })
	t.Run("reserved decision replay", func(t *testing.T) {
		proveReservedAdmissionReplays(t, ctx, pool, f.service, f.tenantID, f.spaceID, f.episodeID, f.accountID, f.newKnock)
	})

	proof := captureAdmissionOutcomeProof(t)
	f.knockCtx = proof.start(ctx, f.journeyID)
	f.proveUncollectedApprovalIsRemoved(proof)

	t.Run("collection rejects a terminal seat", func(t *testing.T) {
		proveTerminalAdmissionCollection(t, ctx, pool, f.service, f.repository, f.episodeRepository, f.tenantID, f.spaceID, f.episodeID, f.accountID, f.newKnock)
	})
	t.Run("cancellation persists its terminal journey and signals", func(t *testing.T) {
		proveAdmissionCancellation(t, ctx, pool, f.repository, proof, f.tenantID, f.spaceID, f.newKnock)
	})
	t.Run("collection validates locked provenance", func(t *testing.T) {
		proveAdmissionProvenanceCollection(t, ctx, pool, f.service, f.episodeRepository, f.tenantID, f.spaceID, f.episodeID, f.accountID, f.newKnock)
	})
	t.Run("cleanup query retained history", func(t *testing.T) {
		if os.Getenv("CHALK_PROOF_CLEANUP_EXPLAIN") != "1" {
			t.Skip("opt-in seeded EXPLAIN proof")
		}
		_, request := f.newKnock("Cleanup EXPLAIN fixture")
		planCtx, cancel := context.WithTimeout(ctx, 4*time.Minute)
		defer cancel()
		proveAdmissionCleanupPlan(t, planCtx, pool, request.RequestHandle)
	})

	f.proveDisabledInviteRejectsApproval()
	f.proveReplayAfterEpisodeEnded(arrival, request)
}
