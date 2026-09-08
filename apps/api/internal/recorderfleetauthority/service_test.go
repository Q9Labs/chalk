package recorderfleetauthority

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

func TestServicePersistsBootstrapBeforeAndAfterIdempotentIssuance(t *testing.T) {
	t.Parallel()
	request := testBootstrapRequest()
	identity := testNodeIdentity()
	repository := &authorityRepositoryStub{}
	issuer := &bootstrapAuthorityStub{identity: identity}
	service, err := NewService("staging", repository, issuer)
	if err != nil {
		t.Fatalf("new service: %v", err)
	}

	got, err := service.EnsureBootstrap(t.Context(), request)
	if err != nil || got != identity {
		t.Fatalf("bootstrap identity/error = %+v/%v", got, err)
	}
	if repository.reserved != request || repository.activated != identity || issuer.ensureCalls != 1 {
		t.Fatalf("bootstrap sequence repository=%+v issuer=%+v", repository, issuer)
	}

	repository.record = BootstrapRecord{Request: request, Identity: &identity}
	if got, err := service.EnsureBootstrap(t.Context(), request); err != nil || got != identity || issuer.ensureCalls != 1 {
		t.Fatalf("idempotent bootstrap identity/error/calls = %+v/%v/%d", got, err, issuer.ensureCalls)
	}
}

func TestServiceDoesNotPersistRevocationUntilIssuerSucceeds(t *testing.T) {
	t.Parallel()
	repository := &authorityRepositoryStub{}
	issuer := &bootstrapAuthorityStub{revokeErr: recorderfleet.ErrProviderUnavailable}
	service, _ := NewService("staging", repository, issuer)
	if err := service.RevokeIdentity(t.Context(), testNodeIdentity()); !errors.Is(err, recorderfleet.ErrProviderUnavailable) {
		t.Fatalf("revoke error = %v", err)
	}
	if repository.revokeCalls != 0 {
		t.Fatalf("durable revocations = %d", repository.revokeCalls)
	}
	issuer.revokeErr = nil
	if err := service.RevokeIdentity(t.Context(), testNodeIdentity()); err != nil || repository.revokeCalls != 1 {
		t.Fatalf("successful revoke error/calls = %v/%d", err, repository.revokeCalls)
	}
}

func TestBoundWorkerVerifierAllowsDrainCompletionButRejectsClaimsAndRevocation(t *testing.T) {
	t.Parallel()
	workerID, _ := utilities.ParseID("55555555-5555-4555-8555-555555555555")
	base := workerVerifierStub{identity: workeridentity.Identity{WorkerID: workerID, Role: workeridentity.RoleCapture}}
	authorizer := &workerAuthorizerStub{claimErr: recorderfleet.ErrAdmissionClosed}
	verifier, err := NewBoundWorkerVerifier(base, authorizer)
	if err != nil {
		t.Fatalf("new verifier: %v", err)
	}
	request, _ := http.NewRequest(http.MethodPost, "https://control.example/internal/v1/recorder/jobs/heartbeat", nil)
	if _, err := verifier.Verify(request); err != nil || authorizer.workerCalls != 1 {
		t.Fatalf("draining heartbeat error/calls = %v/%d", err, authorizer.workerCalls)
	}
	request, _ = http.NewRequest(http.MethodPost, "https://control.example/internal/v1/recorder/jobs/claim", nil)
	if _, err := verifier.Verify(request); !errors.Is(err, recorderfleet.ErrAdmissionClosed) || authorizer.claimCalls != 1 {
		t.Fatalf("closed claim error/calls = %v/%d", err, authorizer.claimCalls)
	}
	authorizer.workerErr = recorderfleet.ErrRoleFence
	request, _ = http.NewRequest(http.MethodPost, "https://control.example/internal/v1/recorder/recording-keys/access", nil)
	if _, err := verifier.Verify(request); !errors.Is(err, workeridentity.ErrUnverifiedPeer) || !errors.Is(err, recorderfleet.ErrRoleFence) {
		t.Fatalf("revoked worker error = %v", err)
	}
}

func testBootstrapRequest() recorderfleet.BootstrapRequest {
	return recorderfleet.BootstrapRequest{
		Key:        recorderfleet.PoolKey{Environment: "staging", Role: workeridentity.RoleCapture},
		ProviderID: "42", NodeName: "node-42", Region: "sgp1", ReleaseID: "release-7",
		ImageDigest: "sha256:" + strings.Repeat("a", 64), BootGeneration: 3,
		InventoryDigest: strings.Repeat("b", 64),
	}
}

func testNodeIdentity() recorderfleet.NodeIdentity {
	return recorderfleet.NodeIdentity{
		ProviderID: "42", WorkerID: "55555555-5555-4555-8555-555555555555",
		Role: workeridentity.RoleCapture, BootGeneration: 3,
	}
}

type authorityRepositoryStub struct {
	record       BootstrapRecord
	reserved     recorderfleet.BootstrapRequest
	activated    recorderfleet.NodeIdentity
	revokeCalls  int
	authorizeErr error
}

func (r *authorityRepositoryStub) GetDemand(context.Context, recorderfleet.PoolKey, time.Time) (recorderfleet.Demand, error) {
	return recorderfleet.Demand{}, nil
}

func (r *authorityRepositoryStub) ObserveNodes(context.Context, recorderfleet.PoolKey, time.Time) ([]recorderfleet.NodeObservation, error) {
	return nil, nil
}

func (r *authorityRepositoryStub) ReserveBootstrap(_ context.Context, request recorderfleet.BootstrapRequest) (BootstrapRecord, error) {
	r.reserved = request
	if r.record.Request == (recorderfleet.BootstrapRequest{}) {
		return BootstrapRecord{Request: request}, nil
	}
	return r.record, nil
}

func (r *authorityRepositoryStub) ActivateBootstrap(_ context.Context, _ recorderfleet.BootstrapRequest, identity recorderfleet.NodeIdentity) (recorderfleet.NodeIdentity, error) {
	r.activated = identity
	return identity, nil
}

func (r *authorityRepositoryStub) CloseAdmission(context.Context, string, recorderfleet.NodeIdentity) error {
	return nil
}

func (r *authorityRepositoryStub) MarkRevoked(context.Context, string, recorderfleet.NodeIdentity, time.Time) error {
	r.revokeCalls++
	return nil
}

func (r *authorityRepositoryStub) PublishPool(context.Context, recorderfleet.PoolProjection) error {
	return nil
}

func (r *authorityRepositoryStub) RecordWorkerObservation(context.Context, string, WorkerObservation) (recorderfleet.NodeObservation, error) {
	return recorderfleet.NodeObservation{}, nil
}

func (r *authorityRepositoryStub) AuthorizeWorker(context.Context, string, workeridentity.Identity) error {
	return r.authorizeErr
}

func (r *authorityRepositoryStub) AuthorizeWorkerClaim(context.Context, string, workeridentity.Identity) error {
	return r.authorizeErr
}

type bootstrapAuthorityStub struct {
	identity    recorderfleet.NodeIdentity
	ensureCalls int
	revokeErr   error
}

func (a *bootstrapAuthorityStub) EnsureBootstrap(context.Context, recorderfleet.BootstrapRequest) (recorderfleet.NodeIdentity, error) {
	a.ensureCalls++
	return a.identity, nil
}

func (a *bootstrapAuthorityStub) RevokeIdentity(context.Context, recorderfleet.NodeIdentity) error {
	return a.revokeErr
}

type workerVerifierStub struct {
	identity workeridentity.Identity
}

func (v workerVerifierStub) Verify(*http.Request) (workeridentity.Identity, error) {
	return v.identity, nil
}

type workerAuthorizerStub struct {
	workerErr   error
	claimErr    error
	workerCalls int
	claimCalls  int
}

func (a *workerAuthorizerStub) AuthorizeWorker(context.Context, workeridentity.Identity) error {
	a.workerCalls++
	return a.workerErr
}

func (a *workerAuthorizerStub) AuthorizeWorkerClaim(context.Context, workeridentity.Identity) error {
	a.claimCalls++
	return a.claimErr
}
