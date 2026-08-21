package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestPublicInviteRepositoryCreateArrivalReplaysByFingerprint(t *testing.T) {
	tenantID := mustPublicInviteID(t, "11111111-1111-4111-8111-111111111111")
	spaceID := mustPublicInviteID(t, "22222222-2222-4222-8222-222222222222")
	arrivalID := mustPublicInviteID(t, "33333333-3333-4333-8333-333333333333")
	handle := bytesOf(0x31, publicinvites.HandleBytes)
	var fingerprint [32]byte
	fingerprint[0] = 7
	requested := publicinvites.Arrival{
		ArrivalHandle: arrivalID, TenantID: tenantID, SpaceID: spaceID, InviteHandle: handle,
		InviteGeneration: 1, InviteStateEpoch: 1, IdentityMode: publicinvites.IdentityGuest,
		DisplayName:         "Guest",
		GuestCredentialHash: bytesOf(0x41, 32), IdempotencyKey: "arrival-replay-0001",
		IdempotencyFingerprint: fingerprint, State: publicinvites.ArrivalPending,
		ExpiresAt: time.Date(2026, 8, 19, 13, 0, 0, 0, time.UTC),
	}
	existing := sqlc.SpacePublicArrival{
		ArrivalHandle: uuid(arrivalID), TenantID: uuid(tenantID), SpaceID: uuid(spaceID), InviteHandle: handle,
		InviteGeneration: 1, InviteStateEpoch: 1, IdentityMode: string(publicinvites.IdentityGuest),
		DisplayName:         requested.DisplayName,
		GuestCredentialHash: bytesOf(0x41, 32), IdempotencyKey: requested.IdempotencyKey,
		IdempotencyFingerprint: fingerprint[:], State: string(publicinvites.ArrivalPending),
		ExpiresAt: timestamptz(&requested.ExpiresAt),
	}
	stub := &publicInviteQuerierStub{lockReplay: existing}
	repository := NewPublicInviteRepository(stub)
	result, err := repository.CreateArrival(context.Background(), requested)
	if err != nil {
		t.Fatalf("create replay: %v", err)
	}
	if result.ArrivalHandle != arrivalID || result.IdempotencyFingerprint != fingerprint || result.DisplayName != requested.DisplayName {
		t.Fatalf("replayed arrival = %#v", result)
	}
	if stub.createArrivalCalled {
		t.Fatal("replay inserted a new arrival")
	}
}

func TestPublicInviteRepositoryCreateArrivalRejectsStaleInvite(t *testing.T) {
	tenantID := mustPublicInviteID(t, "11111111-1111-4111-8111-111111111111")
	spaceID := mustPublicInviteID(t, "22222222-2222-4222-8222-222222222222")
	arrivalID := mustPublicInviteID(t, "33333333-3333-4333-8333-333333333333")
	requested := publicinvites.Arrival{
		ArrivalHandle: arrivalID, TenantID: tenantID, SpaceID: spaceID, InviteHandle: bytesOf(0x31, publicinvites.HandleBytes),
		InviteGeneration: 1, InviteStateEpoch: 1, IdentityMode: publicinvites.IdentityAccount,
		AccountID: mustPublicInviteID(t, "44444444-4444-4444-8444-444444444444"), IdempotencyKey: "arrival-stale-0001",
		State: publicinvites.ArrivalPending, ExpiresAt: time.Now().UTC().Add(time.Minute),
	}
	stub := &publicInviteQuerierStub{lockInvite: sqlc.SpacePublicInvite{
		TenantID: uuid(tenantID), SpaceID: uuid(spaceID), Handle: requested.InviteHandle,
		Generation: 2, StateEpoch: 3, Enabled: true,
	}}
	_, err := NewPublicInviteRepository(stub).CreateArrival(context.Background(), requested)
	if !errors.Is(err, publicinvites.ErrInviteUnavailable) {
		t.Fatalf("error = %v, want invite unavailable", err)
	}
}

func TestPublicInviteRepositoryCreateArrivalPersistsDisplayName(t *testing.T) {
	tenantID := mustPublicInviteID(t, "11111111-1111-4111-8111-111111111111")
	spaceID := mustPublicInviteID(t, "22222222-2222-4222-8222-222222222222")
	arrivalID := mustPublicInviteID(t, "33333333-3333-4333-8333-333333333333")
	handle := bytesOf(0x31, publicinvites.HandleBytes)
	expiresAt := time.Now().UTC().Add(time.Hour)
	fingerprint := [32]byte{7}
	requested := publicinvites.Arrival{
		ArrivalHandle: arrivalID, TenantID: tenantID, SpaceID: spaceID, InviteHandle: handle,
		InviteGeneration: 1, InviteStateEpoch: 1, IdentityMode: publicinvites.IdentityGuest, DisplayName: "Guest Display",
		GuestCredentialHash: bytesOf(0x41, 32), IdempotencyKey: "arrival-display-name-01", IdempotencyFingerprint: fingerprint,
		State: publicinvites.ArrivalPending, ExpiresAt: expiresAt,
	}
	created := sqlc.SpacePublicArrival{
		ArrivalHandle: uuid(arrivalID), TenantID: uuid(tenantID), SpaceID: uuid(spaceID), InviteHandle: handle,
		InviteGeneration: 1, InviteStateEpoch: 1, IdentityMode: string(publicinvites.IdentityGuest), DisplayName: requested.DisplayName,
		GuestCredentialHash: bytesOf(0x41, 32), IdempotencyKey: requested.IdempotencyKey, IdempotencyFingerprint: fingerprint[:],
		State: string(publicinvites.ArrivalPending), ExpiresAt: timestamptz(&expiresAt),
	}
	stub := &publicInviteQuerierStub{
		lockInvite:     sqlc.SpacePublicInvite{TenantID: uuid(tenantID), SpaceID: uuid(spaceID), Handle: handle, Generation: 1, StateEpoch: 1, Enabled: true},
		createdArrival: created,
	}
	result, err := NewPublicInviteRepository(stub).CreateArrival(context.Background(), requested)
	if err != nil {
		t.Fatalf("create arrival: %v", err)
	}
	if result.DisplayName != requested.DisplayName || stub.createdArrivalParams.DisplayName != requested.DisplayName {
		t.Fatalf("display name was not persisted: result=%q params=%q", result.DisplayName, stub.createdArrivalParams.DisplayName)
	}
}

func TestPublicInviteRepositoryApproveAdmissionLeavesArrivalPending(t *testing.T) {
	tenantID := mustPublicInviteID(t, "11111111-1111-4111-8111-111111111111")
	spaceID := mustPublicInviteID(t, "22222222-2222-4222-8222-222222222222")
	requestID := mustPublicInviteID(t, "33333333-3333-4333-8333-333333333333")
	arrivalID := mustPublicInviteID(t, "44444444-4444-4444-8444-444444444444")
	actorID := mustPublicInviteID(t, "55555555-5555-4555-8555-555555555555")
	now := time.Now().UTC()
	future := now.Add(time.Hour)
	request := sqlc.SpacePublicAdmissionRequest{
		RequestHandle: uuid(requestID), ArrivalHandle: uuid(arrivalID), TenantID: uuid(tenantID), SpaceID: uuid(spaceID),
		DisplayName: "Guest", State: string(publicinvites.AdmissionRequestPending), RequestedAt: timestamptz(&now),
		ExpiresAt: timestamptz(&future),
	}
	updatedRequest := request
	updatedRequest.State = string(publicinvites.AdmissionRequestApproved)
	updatedRequest.DecidedAt = timestamptz(&now)
	updatedRequest.DecidedBy = uuid(actorID)
	arrival := sqlc.SpacePublicArrival{
		ArrivalHandle: uuid(arrivalID), TenantID: uuid(tenantID), SpaceID: uuid(spaceID), State: string(publicinvites.ArrivalPending),
		InviteHandle: bytesOf(0x31, publicinvites.HandleBytes), InviteGeneration: 1, InviteStateEpoch: 1,
		IdentityMode: string(publicinvites.IdentityGuest), IdempotencyKey: "admission-approval-0001",
		IdempotencyFingerprint: bytesOf(0x41, 32), ExpiresAt: timestamptz(&future),
	}
	stub := &publicInviteQuerierStub{lockRequest: request, lockAdmissionArrival: arrival, updatedRequest: updatedRequest}
	requestResult, arrivalResult, err := NewPublicInviteRepository(stub).DecideAdmissionRequest(context.Background(), publicinvites.DecideAdmissionRequestInput{
		TenantID: tenantID, SpaceID: spaceID, RequestHandle: requestID, Decision: publicinvites.DecisionApprove, ActorID: actorID,
	})
	if err != nil {
		t.Fatalf("approve admission request: %v", err)
	}
	if requestResult.State != publicinvites.AdmissionRequestApproved {
		t.Fatalf("request state = %q, want approved", requestResult.State)
	}
	if arrivalResult.State != publicinvites.ArrivalPending {
		t.Fatalf("arrival state = %q, want pending", arrivalResult.State)
	}
	if stub.arrivalUpdateCalled {
		t.Fatal("approval updated arrival before runtime grant")
	}
}

func TestPublicInviteRepositoryCreateAdmissionRequestReplaysByArrival(t *testing.T) {
	tenantID := mustPublicInviteID(t, "11111111-1111-4111-8111-111111111111")
	spaceID := mustPublicInviteID(t, "22222222-2222-4222-8222-222222222222")
	arrivalID := mustPublicInviteID(t, "33333333-3333-4333-8333-333333333333")
	existingRequestID := mustPublicInviteID(t, "44444444-4444-4444-8444-444444444444")
	newRequestID := mustPublicInviteID(t, "55555555-5555-4555-8555-555555555555")
	now := time.Now().UTC()
	future := now.Add(time.Hour)
	arrival := sqlc.SpacePublicArrival{
		ArrivalHandle: uuid(arrivalID), TenantID: uuid(tenantID), SpaceID: uuid(spaceID), State: string(publicinvites.ArrivalPending),
	}
	existing := sqlc.SpacePublicAdmissionRequest{
		RequestHandle: uuid(existingRequestID), ArrivalHandle: uuid(arrivalID), TenantID: uuid(tenantID), SpaceID: uuid(spaceID),
		DisplayName: "Guest", State: string(publicinvites.AdmissionRequestPending), RequestedAt: timestamptz(&now), ExpiresAt: timestamptz(&future),
	}
	stub := &publicInviteQuerierStub{lockAdmissionArrival: arrival, createdAdmissionRequest: existing}
	result, err := NewPublicInviteRepository(stub).CreateAdmissionRequest(context.Background(), publicinvites.AdmissionRequest{
		RequestHandle: newRequestID, ArrivalHandle: arrivalID,
		DisplayName: "Guest", State: publicinvites.AdmissionRequestPending, RequestedAt: now, ExpiresAt: future,
	})
	if err != nil {
		t.Fatalf("replay admission request: %v", err)
	}
	if result.RequestHandle != existingRequestID || stub.createdAdmissionRequestParams.RequestHandle != uuid(newRequestID) {
		t.Fatalf("replay result = %#v, params = %#v", result, stub.createdAdmissionRequestParams)
	}
	if stub.createdAdmissionRequestParams.TenantID != uuid(tenantID) || stub.createdAdmissionRequestParams.SpaceID != uuid(spaceID) {
		t.Fatalf("admission request scope = %v/%v, want locked arrival scope", stub.createdAdmissionRequestParams.TenantID, stub.createdAdmissionRequestParams.SpaceID)
	}
}

func TestPublicInviteRepositorySetInviteEnabledSameStateIsNoOp(t *testing.T) {
	tenantID := mustPublicInviteID(t, "11111111-1111-4111-8111-111111111111")
	spaceID := mustPublicInviteID(t, "22222222-2222-4222-8222-222222222222")
	row := sqlc.SpacePublicInvite{
		TenantID: uuid(tenantID), SpaceID: uuid(spaceID), Handle: bytesOf(0x31, publicinvites.HandleBytes),
		Generation: 2, StateEpoch: 4, Enabled: true, PublicRole: publicinvites.PublicRoleCollaborator,
		AdmissionMode: string(publicinvites.AdmissionOpen),
	}
	stub := &publicInviteQuerierStub{lockedInvite: row}
	result, err := NewPublicInviteRepository(stub).SetInviteEnabled(context.Background(), tenantID, spaceID, true, mustPublicInviteID(t, "33333333-3333-4333-8333-333333333333"))
	if err != nil {
		t.Fatalf("set invite enabled: %v", err)
	}
	if result.Generation != 2 || result.StateEpoch != 4 || !result.Enabled {
		t.Fatalf("same-state invite update changed row: %+v", result)
	}
	if stub.updateInviteCalled {
		t.Fatal("same-state invite update executed SQL mutation")
	}
}

func TestPublicInviteRepositoryRotateInviteReplaysRequestKey(t *testing.T) {
	tenantID := mustPublicInviteID(t, "11111111-1111-4111-8111-111111111111")
	spaceID := mustPublicInviteID(t, "22222222-2222-4222-8222-222222222222")
	requestKey := "rotate-request-0001"
	row := sqlc.SpacePublicInvite{
		TenantID: uuid(tenantID), SpaceID: uuid(spaceID), Handle: bytesOf(0x31, publicinvites.HandleBytes),
		Generation: 2, StateEpoch: 4, Enabled: true, PublicRole: publicinvites.PublicRoleCollaborator,
		AdmissionMode: string(publicinvites.AdmissionOpen), LastRotationRequestKey: textValue(requestKey),
	}
	stub := &publicInviteQuerierStub{lockedInvite: row}
	result, err := NewPublicInviteRepository(stub).RotateInvite(context.Background(), tenantID, spaceID, bytesOf(0x41, publicinvites.HandleBytes), mustPublicInviteID(t, "33333333-3333-4333-8333-333333333333"), requestKey)
	if err != nil {
		t.Fatalf("rotate invite replay: %v", err)
	}
	if string(result.Handle) != string(row.Handle) || result.Generation != uint64(row.Generation) {
		t.Fatalf("replayed rotation changed invite: %+v", result)
	}
	if stub.rotateInviteCalled {
		t.Fatal("same-key rotation executed SQL mutation")
	}
}

func TestPublicInviteRepositoryAdmissionDecisionRequestKeyReplayAndConflict(t *testing.T) {
	tenantID := mustPublicInviteID(t, "11111111-1111-4111-8111-111111111111")
	spaceID := mustPublicInviteID(t, "22222222-2222-4222-8222-222222222222")
	requestID := mustPublicInviteID(t, "33333333-3333-4333-8333-333333333333")
	arrivalID := mustPublicInviteID(t, "44444444-4444-4444-8444-444444444444")
	requestKey := "admission-decision-01"
	now := time.Now().UTC()
	request := sqlc.SpacePublicAdmissionRequest{
		RequestHandle: uuid(requestID), ArrivalHandle: uuid(arrivalID), TenantID: uuid(tenantID), SpaceID: uuid(spaceID),
		DisplayName: "Guest", State: string(publicinvites.AdmissionRequestApproved), RequestedAt: timestamptz(&now),
		ExpiresAt: timestamptz(&now), DecidedAt: timestamptz(&now), DecisionRequestKey: textValue(requestKey),
	}
	arrival := sqlc.SpacePublicArrival{
		ArrivalHandle: uuid(arrivalID), TenantID: uuid(tenantID), SpaceID: uuid(spaceID), State: string(publicinvites.ArrivalPending),
		InviteHandle: bytesOf(0x31, publicinvites.HandleBytes), InviteGeneration: 1, InviteStateEpoch: 1,
		IdentityMode: string(publicinvites.IdentityGuest), DisplayName: "Guest", IdempotencyKey: "admission-decision-arrival",
		IdempotencyFingerprint: bytesOf(0x41, 32), ExpiresAt: timestamptz(&now),
	}
	stub := &publicInviteQuerierStub{lockRequest: request, lockAdmissionArrival: arrival}
	repository := NewPublicInviteRepository(stub)
	result, replayArrival, err := repository.DecideAdmissionRequest(context.Background(), publicinvites.DecideAdmissionRequestInput{
		TenantID: tenantID, SpaceID: spaceID, RequestHandle: requestID, Decision: publicinvites.DecisionApprove, RequestKey: requestKey,
	})
	if err != nil || result.State != publicinvites.AdmissionRequestApproved || replayArrival.State != publicinvites.ArrivalPending {
		t.Fatalf("same-key admission replay = request=%+v arrival=%+v err=%v", result, replayArrival, err)
	}
	if _, _, err := repository.DecideAdmissionRequest(context.Background(), publicinvites.DecideAdmissionRequestInput{
		TenantID: tenantID, SpaceID: spaceID, RequestHandle: requestID, Decision: publicinvites.DecisionDeny, RequestKey: requestKey,
	}); !errors.Is(err, publicinvites.ErrIdempotencyConflict) {
		t.Fatalf("same-key opposite admission decision error = %v, want conflict", err)
	}
}

func TestPublicInviteRepositoryRetryAutoLifecycleMapsErrorFamily(t *testing.T) {
	tenantID := mustPublicInviteID(t, "11111111-1111-4111-8111-111111111111")
	spaceID := mustPublicInviteID(t, "22222222-2222-4222-8222-222222222222")
	nextRetry := time.Date(2026, 8, 19, 13, 0, 0, 0, time.UTC)
	stub := &publicInviteQuerierStub{
		lockLifecycle: sqlc.AutoSpaceLifecycle{
			TenantID: uuid(tenantID), SpaceID: uuid(spaceID), State: string(publicinvites.AutoLifecycleArchiving),
			DeadlineAt: timestamptz(&nextRetry), RetryCount: 2,
		},
		retryLifecycle: sqlc.AutoSpaceLifecycle{
			TenantID: uuid(tenantID), SpaceID: uuid(spaceID), State: string(publicinvites.AutoLifecycleActive),
			DeadlineAt: timestamptz(&nextRetry), NextRetryAt: timestamptz(&nextRetry), RetryCount: 3,
			LastErrorFamily: textValue("provider_timeout"),
		},
	}
	result, err := NewPublicInviteRepository(stub).RetryAutoLifecycle(context.Background(), publicinvites.RetryAutoLifecycleInput{
		TenantID: tenantID, SpaceID: spaceID, NextRetryAt: nextRetry, ErrorFamily: "provider_timeout",
	})
	if err != nil {
		t.Fatalf("retry lifecycle: %v", err)
	}
	if result.RetryCount != 3 || result.LastErrorFamily != "provider_timeout" {
		t.Fatalf("retry result = %#v, params = %#v", result, stub.retryParams)
	}
}

type publicInviteQuerierStub struct {
	publicInviteQuerier
	lockReplay                    sqlc.SpacePublicArrival
	lockInvite                    sqlc.SpacePublicInvite
	lockedInvite                  sqlc.SpacePublicInvite
	lockLifecycle                 sqlc.AutoSpaceLifecycle
	retryLifecycle                sqlc.AutoSpaceLifecycle
	retryParams                   sqlc.RetryAutoSpaceLifecycleParams
	lockRequest                   sqlc.SpacePublicAdmissionRequest
	lockAdmissionArrival          sqlc.SpacePublicArrival
	updatedRequest                sqlc.SpacePublicAdmissionRequest
	arrivalUpdateCalled           bool
	createArrivalCalled           bool
	createdArrival                sqlc.SpacePublicArrival
	createdArrivalParams          sqlc.CreateSpacePublicArrivalParams
	createdAdmissionRequest       sqlc.SpacePublicAdmissionRequest
	createdAdmissionRequestParams sqlc.CreateSpacePublicAdmissionRequestParams
	updateInviteCalled            bool
	rotateInviteCalled            bool
}

func (s *publicInviteQuerierStub) LockSpacePublicArrivalByIdempotency(context.Context, sqlc.LockSpacePublicArrivalByIdempotencyParams) (sqlc.SpacePublicArrival, error) {
	if s.lockReplay.ArrivalHandle.Valid {
		return s.lockReplay, nil
	}
	return sqlc.SpacePublicArrival{}, pgx.ErrNoRows
}

func (s *publicInviteQuerierStub) LockSpacePublicInviteByHandle(context.Context, []byte) (sqlc.SpacePublicInvite, error) {
	if s.lockInvite.TenantID.Valid {
		return s.lockInvite, nil
	}
	return sqlc.SpacePublicInvite{}, pgx.ErrNoRows
}

func (s *publicInviteQuerierStub) LockSpacePublicInvite(context.Context, sqlc.LockSpacePublicInviteParams) (sqlc.SpacePublicInvite, error) {
	if s.lockedInvite.TenantID.Valid {
		return s.lockedInvite, nil
	}
	return sqlc.SpacePublicInvite{}, pgx.ErrNoRows
}

func (s *publicInviteQuerierStub) UpdateSpacePublicInviteEnabled(context.Context, sqlc.UpdateSpacePublicInviteEnabledParams) (sqlc.SpacePublicInvite, error) {
	s.updateInviteCalled = true
	return sqlc.SpacePublicInvite{}, errors.New("unexpected invite update")
}

func (s *publicInviteQuerierStub) RotateSpacePublicInvite(context.Context, sqlc.RotateSpacePublicInviteParams) (sqlc.SpacePublicInvite, error) {
	s.rotateInviteCalled = true
	return sqlc.SpacePublicInvite{}, errors.New("unexpected invite rotation")
}

func (s *publicInviteQuerierStub) CreateSpacePublicArrival(_ context.Context, arg sqlc.CreateSpacePublicArrivalParams) (sqlc.SpacePublicArrival, error) {
	s.createArrivalCalled = true
	s.createdArrivalParams = arg
	if s.createdArrival.ArrivalHandle.Valid {
		return s.createdArrival, nil
	}
	return sqlc.SpacePublicArrival{}, errors.New("unexpected insert")
}

func (s *publicInviteQuerierStub) CreateSpacePublicAdmissionRequest(_ context.Context, arg sqlc.CreateSpacePublicAdmissionRequestParams) (sqlc.SpacePublicAdmissionRequest, error) {
	s.createdAdmissionRequestParams = arg
	if s.createdAdmissionRequest.RequestHandle.Valid {
		return s.createdAdmissionRequest, nil
	}
	return sqlc.SpacePublicAdmissionRequest{}, errors.New("unexpected admission request insert")
}

func (s *publicInviteQuerierStub) LockAutoSpaceLifecycle(context.Context, sqlc.LockAutoSpaceLifecycleParams) (sqlc.AutoSpaceLifecycle, error) {
	if s.lockLifecycle.TenantID.Valid {
		return s.lockLifecycle, nil
	}
	return sqlc.AutoSpaceLifecycle{}, pgx.ErrNoRows
}

func (s *publicInviteQuerierStub) LockSpacePublicAdmissionRequest(context.Context, sqlc.LockSpacePublicAdmissionRequestParams) (sqlc.SpacePublicAdmissionRequest, error) {
	if s.lockRequest.RequestHandle.Valid {
		return s.lockRequest, nil
	}
	return sqlc.SpacePublicAdmissionRequest{}, pgx.ErrNoRows
}

func (s *publicInviteQuerierStub) LockSpacePublicArrival(context.Context, pgtype.UUID) (sqlc.SpacePublicArrival, error) {
	if s.lockAdmissionArrival.ArrivalHandle.Valid {
		return s.lockAdmissionArrival, nil
	}
	return sqlc.SpacePublicArrival{}, pgx.ErrNoRows
}

func (s *publicInviteQuerierStub) UpdateSpacePublicAdmissionRequest(context.Context, sqlc.UpdateSpacePublicAdmissionRequestParams) (sqlc.SpacePublicAdmissionRequest, error) {
	return s.updatedRequest, nil
}

func (s *publicInviteQuerierStub) UpdateSpacePublicArrivalState(context.Context, sqlc.UpdateSpacePublicArrivalStateParams) (sqlc.SpacePublicArrival, error) {
	s.arrivalUpdateCalled = true
	return sqlc.SpacePublicArrival{}, errors.New("unexpected arrival update")
}

func (s *publicInviteQuerierStub) RetryAutoSpaceLifecycle(_ context.Context, arg sqlc.RetryAutoSpaceLifecycleParams) (sqlc.AutoSpaceLifecycle, error) {
	s.retryParams = arg
	return s.retryLifecycle, nil
}

func mustPublicInviteID(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatalf("parse id %q: %v", value, err)
	}
	return id
}

func bytesOf(value byte, length int) []byte {
	result := make([]byte, length)
	for index := range result {
		result[index] = value
	}
	return result
}
