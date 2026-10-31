package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type admissionRequeueFixture struct {
	ctx               context.Context
	pool              *pgxpool.Pool
	tenantID          utilities.ID
	accountID         utilities.ID
	spaceID           utilities.ID
	episodeID         utilities.ID
	requestHandle     utilities.ID
	repository        PublicInviteRepository
	service           publicinvites.Service
	episodeRepository EpisodeLifecycleRepository
}

func newAdmissionRequeueFixture(t *testing.T) admissionRequeueFixture {
	t.Helper()
	pool := accountTenantIntegrationPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)

	tenantID, accountID := accountTenantIntegrationID(t), accountTenantIntegrationID(t)
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`insert into users(id,name,email) values($1,'Admission retry host',$2)`, uuid(accountID), accountID.String()+"@admission.test")
	exec(`insert into tenants(id,name) values($1,'Admission retry fixture')`, uuid(tenantID))
	exec(`insert into tenant_artifact_policies(tenant_id) values($1)`, uuid(tenantID))
	t.Cleanup(func() {
		for _, table := range []string{
			"space_public_admission_requests", "space_public_arrivals", "sync_admission_requests",
			"sync_publication_fences", "sync_external_operations", "sync_lifecycle_intents",
		} {
			if _, err := pool.Exec(context.Background(), "delete from "+table+" where tenant_id=$1", uuid(tenantID)); err != nil {
				t.Errorf("cleanup %s: %v", table, err)
			}
		}
	})

	spaceService := spaces.NewService(NewSpaceRepository(sqlc.New(pool), pool))
	space, err := spaceService.CreateSpace(ctx, spaces.CreateSpaceInput{
		TenantID: tenantID, Name: "Admission retry", Slug: "admission-" + accountTenantIntegrationID(t).String(),
		MediaPlane: "cf_sfu", AdmissionPolicy: json.RawMessage(`{"mode":"open"}`),
		DefaultEpisodeDurationSeconds: 3600, MaximumEpisodeDurationSeconds: 86400, LingerWindowSeconds: 60,
		RequestKey: accountTenantIntegrationID(t).String(),
	})
	if err != nil {
		t.Fatal(err)
	}
	episodeRepository := NewEpisodeLifecycleRepository(pool)
	host, err := episodes.NewService(episodeRepository).JoinPublic(ctx, episodes.PublicJoinInput{
		TenantID: tenantID, SpaceID: space.ID, AccountID: accountID, IdentityMode: "account",
		DisplayName: "Admission retry host", Role: "owner",
		Request: episodes.Request{Key: accountTenantIntegrationID(t).String()},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := spaceService.UpdateSpace(ctx, tenantID, space.ID, spaces.UpdateSpaceInput{
		AdmissionPolicy: utilities.OptionalJSON{Set: true, Value: json.RawMessage(`{"mode":"knock"}`)},
	}); err != nil {
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
		IdentityMode: publicinvites.IdentityGuest, DisplayName: "Guest",
		GuestCredential: []byte("admission-requeue-integration-credential"),
		IdempotencyKey:  accountTenantIntegrationID(t).String(),
	})
	if err != nil {
		t.Fatal(err)
	}
	request, err := service.CreateAdmissionRequest(ctx, publicinvites.CreateAdmissionRequestInput{
		ArrivalHandle: arrival.Arrival.ArrivalHandle, DisplayName: "Guest",
	})
	if err != nil {
		t.Fatal(err)
	}
	return admissionRequeueFixture{
		ctx: ctx, pool: pool, tenantID: tenantID, accountID: accountID, spaceID: space.ID,
		episodeID: host.Episode.ID, requestHandle: request.RequestHandle,
		repository: repository, service: service, episodeRepository: episodeRepository,
	}
}

func (f admissionRequeueFixture) decisionInput() publicinvites.DecideAdmissionRequestInput {
	return publicinvites.DecideAdmissionRequestInput{
		TenantID: f.tenantID, SpaceID: f.spaceID, RequestHandle: f.requestHandle,
		Decision: publicinvites.DecisionApprove, ActorID: f.accountID,
	}
}

func (f admissionRequeueFixture) seedFailedDecision(t *testing.T) utilities.ID {
	t.Helper()
	if _, _, err := f.service.DecideAdmissionRequest(f.ctx, f.decisionInput()); err != nil {
		t.Fatalf("create admission decision: %v", err)
	}
	var externalOperationID pgtype.UUID
	if err := f.pool.QueryRow(f.ctx, `
		select decision_external_operation_id
		from sync_admission_requests
		where tenant_id=$1 and admission_request_id=$2
	`, uuid(f.tenantID), uuid(f.requestHandle)).Scan(&externalOperationID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(f.ctx, `
		update sync_external_operations
		set status='failed', completed_at=now(), last_error_code='fixture_failure', acceptance_order=null
		where tenant_id=$1 and episode_id=$2 and external_operation_id=$3
	`, uuid(f.tenantID), uuid(f.episodeID), externalOperationID); err != nil {
		t.Fatalf("seed legacy failed operation: %v", err)
	}
	if _, err := f.pool.Exec(f.ctx, `
		update sync_admission_requests
		set decision_external_operation_id=null
		where tenant_id=$1 and admission_request_id=$2
	`, uuid(f.tenantID), uuid(f.requestHandle)); err != nil {
		t.Fatalf("release failed admission decision: %v", err)
	}
	return utilities.IDFromBytes(externalOperationID.Bytes)
}

func (f admissionRequeueFixture) operationOrder(t *testing.T, operationID utilities.ID) pgtype.Int8 {
	t.Helper()
	var order pgtype.Int8
	if err := f.pool.QueryRow(f.ctx, `
		select acceptance_order
		from sync_external_operations
		where tenant_id=$1 and episode_id=$2 and external_operation_id=$3
	`, uuid(f.tenantID), uuid(f.episodeID), uuid(operationID)).Scan(&order); err != nil {
		t.Fatal(err)
	}
	return order
}

func TestFailedAdmissionDecisionRequeueAllocatesLaterOrder(t *testing.T) {
	fixture := newAdmissionRequeueFixture(t)
	externalOperationID := fixture.seedFailedDecision(t)
	if order := fixture.operationOrder(t, externalOperationID); order.Valid {
		t.Fatalf("legacy failed row acceptance_order = %d, want NULL", order.Int64)
	}

	newerRequestKey := accountTenantIntegrationID(t).String()
	newerFingerprint := sha256.Sum256([]byte(newerRequestKey))
	newerOperationID := accountTenantIntegrationID(t)
	var newerOrder pgtype.Int8
	if err := fixture.pool.QueryRow(fixture.ctx, `
		insert into sync_external_operations (
			tenant_id, space_id, episode_id, external_operation_id, request_key,
			request_fingerprint, operation_name, payload, status
		) values ($1,$2,$3,$4,$5,$6,'tenant_end_episode','{}','pending')
		returning acceptance_order
	`, uuid(fixture.tenantID), uuid(fixture.spaceID), uuid(fixture.episodeID),
		uuid(newerOperationID), newerRequestKey, newerFingerprint[:]).Scan(&newerOrder); err != nil {
		t.Fatalf("queue newer ordinary operation: %v", err)
	}

	if _, _, err := fixture.service.DecideAdmissionRequest(fixture.ctx, fixture.decisionInput()); err != nil {
		t.Fatalf("retry admission decision: %v", err)
	}
	order := fixture.operationOrder(t, externalOperationID)
	if !order.Valid || order.Int64 <= newerOrder.Int64 {
		t.Fatalf("requeued order = %v, newer operation order = %d", order, newerOrder.Int64)
	}
	var status string
	if err := fixture.pool.QueryRow(fixture.ctx, `
		select status from sync_external_operations where external_operation_id=$1
	`, uuid(externalOperationID)).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "pending" {
		t.Fatalf("requeued status = %q, want pending", status)
	}
	var reservedID pgtype.UUID
	if err := fixture.pool.QueryRow(fixture.ctx, `
		select decision_external_operation_id from sync_admission_requests
		where tenant_id=$1 and admission_request_id=$2
	`, uuid(fixture.tenantID), uuid(fixture.requestHandle)).Scan(&reservedID); err != nil {
		t.Fatal(err)
	}
	if utilities.IDFromBytes(reservedID.Bytes) != externalOperationID {
		t.Fatalf("requeued external operation ID = %s, want unchanged %s", utilities.IDFromBytes(reservedID.Bytes), externalOperationID)
	}
}

func TestFailedAdmissionExpirySweepRequeuesLegacyOperation(t *testing.T) {
	fixture := newAdmissionRequeueFixture(t)
	if _, err := fixture.pool.Exec(fixture.ctx, `
		update sync_admission_requests
		set requested_at=now()-interval '6 minutes', expires_at=now()-interval '1 second'
		where tenant_id=$1 and admission_request_id=$2
	`, uuid(fixture.tenantID), uuid(fixture.requestHandle)); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.episodeRepository.EnqueueDueEpisodeDeadlines(fixture.ctx, 50); err != nil {
		t.Fatalf("initial admission expiry enqueue: %v", err)
	}
	var externalOperationID pgtype.UUID
	if err := fixture.pool.QueryRow(fixture.ctx, `
		select decision_external_operation_id from sync_admission_requests
		where tenant_id=$1 and admission_request_id=$2
	`, uuid(fixture.tenantID), uuid(fixture.requestHandle)).Scan(&externalOperationID); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.pool.Exec(fixture.ctx, `
		update sync_external_operations
		set status='failed', completed_at=now(), last_error_code='fixture_failure', acceptance_order=null
		where tenant_id=$1 and episode_id=$2 and external_operation_id=$3
	`, uuid(fixture.tenantID), uuid(fixture.episodeID), externalOperationID); err != nil {
		t.Fatalf("seed legacy failed expiry operation: %v", err)
	}
	if _, err := fixture.pool.Exec(fixture.ctx, `
		update sync_admission_requests set decision_external_operation_id=null
		where tenant_id=$1 and admission_request_id=$2
	`, uuid(fixture.tenantID), uuid(fixture.requestHandle)); err != nil {
		t.Fatal(err)
	}
	count, err := fixture.episodeRepository.EnqueueDueEpisodeDeadlines(fixture.ctx, 50)
	if err != nil || count < 1 {
		t.Fatalf("retry expired admission: count=%d err=%v", count, err)
	}
	order := fixture.operationOrder(t, utilities.IDFromBytes(externalOperationID.Bytes))
	if !order.Valid {
		t.Fatal("expiry sweep committed a pending row without an acceptance order")
	}
	var status string
	if err := fixture.pool.QueryRow(fixture.ctx, `
		select status from sync_external_operations where external_operation_id=$1
	`, externalOperationID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "pending" {
		t.Fatalf("expiry status = %q, want pending", status)
	}
}

func TestLegacyAdmissionRequeueSQLAllocatesOrder(t *testing.T) {
	fixture := newAdmissionRequeueFixture(t)
	externalOperationID := fixture.seedFailedDecision(t)
	var order pgtype.Int8
	err := fixture.pool.QueryRow(fixture.ctx, `
		update sync_external_operations
		set status = 'pending', completed_at = null, last_error_code = null,
		    next_attempt_at = now(), attempt_count = 0
		where tenant_id = $1 and episode_id = $2
		  and external_operation_id = $3
		  and operation_name in ('admit_participant', 'deny_admission', 'admission_request_expired')
		  and status = 'failed'
		returning acceptance_order
	`, uuid(fixture.tenantID), uuid(fixture.episodeID), uuid(externalOperationID)).Scan(&order)
	if err != nil {
		t.Fatalf("old-style requeue update: %v", err)
	}
	if !order.Valid {
		t.Fatal("old-style requeue left acceptance_order NULL")
	}
}

func TestConcurrentFailedAdmissionRetriesAreIdempotent(t *testing.T) {
	fixture := newAdmissionRequeueFixture(t)
	externalOperationID := fixture.seedFailedDecision(t)

	var wait sync.WaitGroup
	errors := make(chan error, 2)
	for range 2 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			_, _, err := fixture.service.DecideAdmissionRequest(fixture.ctx, fixture.decisionInput())
			errors <- err
		}()
	}
	wait.Wait()
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatalf("concurrent retry: %v", err)
		}
	}

	var count int
	if err := fixture.pool.QueryRow(fixture.ctx, `
		select count(*) from sync_external_operations
		where tenant_id=$1 and episode_id=$2 and external_operation_id=$3
	`, uuid(fixture.tenantID), uuid(fixture.episodeID), uuid(externalOperationID)).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("decision operation rows = %d, want 1", count)
	}
	order := fixture.operationOrder(t, externalOperationID)
	if !order.Valid {
		t.Fatal("concurrent retry left acceptance_order NULL")
	}
	if _, _, err := fixture.service.DecideAdmissionRequest(fixture.ctx, fixture.decisionInput()); err != nil {
		t.Fatalf("retry pending admission: %v", err)
	}
	if got := fixture.operationOrder(t, externalOperationID); got.Int64 != order.Int64 {
		t.Fatalf("pending retry changed acceptance_order from %d to %d", order.Int64, got.Int64)
	}

	if _, err := fixture.pool.Exec(fixture.ctx, `
		update sync_external_operations
		set status='failed', completed_at=now(), last_error_code='fixture_failure'
		where tenant_id=$1 and episode_id=$2 and external_operation_id=$3
	`, uuid(fixture.tenantID), uuid(fixture.episodeID), uuid(externalOperationID)); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.pool.Exec(fixture.ctx, `
		update sync_admission_requests set decision_external_operation_id=null
		where tenant_id=$1 and admission_request_id=$2
	`, uuid(fixture.tenantID), uuid(fixture.requestHandle)); err != nil {
		t.Fatal(err)
	}
	if _, _, err := fixture.service.DecideAdmissionRequest(fixture.ctx, fixture.decisionInput()); err != nil {
		t.Fatalf("retry failed row with existing order: %v", err)
	}
	if got := fixture.operationOrder(t, externalOperationID); got.Int64 != order.Int64 {
		t.Fatalf("requeue changed existing acceptance_order from %d to %d", order.Int64, got.Int64)
	}
}
