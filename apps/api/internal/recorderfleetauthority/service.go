package recorderfleetauthority

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

type BootstrapRecord struct {
	Request  recorderfleet.BootstrapRequest
	Identity *recorderfleet.NodeIdentity
}

type WorkerObservation struct {
	Identity      workeridentity.Identity
	Ready         bool
	AdmissionOpen bool
	ReadyCapacity int
	ObservedAt    time.Time
}

type Repository interface {
	GetDemand(context.Context, recorderfleet.PoolKey, time.Time) (recorderfleet.Demand, error)
	ObserveNodes(context.Context, recorderfleet.PoolKey, time.Time) ([]recorderfleet.NodeObservation, error)
	ReserveBootstrap(context.Context, recorderfleet.BootstrapRequest) (BootstrapRecord, error)
	ActivateBootstrap(context.Context, recorderfleet.BootstrapRequest, recorderfleet.NodeIdentity) (recorderfleet.NodeIdentity, error)
	AbandonBootstrap(context.Context, recorderfleet.BootstrapRequest, time.Time) error
	CloseAdmission(context.Context, string, recorderfleet.NodeIdentity) error
	MarkRevoked(context.Context, string, recorderfleet.NodeIdentity, time.Time) error
	PublishPool(context.Context, recorderfleet.PoolProjection) error
	RecordWorkerObservation(context.Context, string, WorkerObservation) (recorderfleet.NodeObservation, error)
	AuthorizeWorker(context.Context, string, workeridentity.Identity) error
	AuthorizeWorkerClaim(context.Context, string, workeridentity.Identity) error
}

type Service struct {
	environment string
	issuer      recorderfleet.BootstrapAuthority
	now         func() time.Time
	repository  Repository
}

func NewService(environment string, repository Repository, issuer recorderfleet.BootstrapAuthority) (Service, error) {
	environment = strings.TrimSpace(environment)
	if environment == "" || strings.ContainsAny(environment, "/\\") || repository == nil || issuer == nil {
		return Service{}, recorderfleet.ErrInvalidConfig
	}
	return Service{environment: environment, repository: repository, issuer: issuer, now: time.Now}, nil
}

func (s Service) GetDemand(ctx context.Context, key recorderfleet.PoolKey) (recorderfleet.Demand, error) {
	if err := s.validateKey(key); err != nil {
		return recorderfleet.Demand{}, err
	}
	return s.repository.GetDemand(ctx, key, s.now().UTC())
}

func (s Service) ObserveNodes(ctx context.Context, key recorderfleet.PoolKey) ([]recorderfleet.NodeObservation, error) {
	if err := s.validateKey(key); err != nil {
		return nil, err
	}
	return s.repository.ObserveNodes(ctx, key, s.now().UTC())
}

func (s Service) EnsureBootstrap(ctx context.Context, request recorderfleet.BootstrapRequest) (recorderfleet.NodeIdentity, error) {
	if err := request.Validate(); err != nil || request.Key.Environment != s.environment {
		return recorderfleet.NodeIdentity{}, recorderfleet.ErrRoleFence
	}
	record, err := s.repository.ReserveBootstrap(ctx, request)
	if err != nil {
		return recorderfleet.NodeIdentity{}, fmt.Errorf("reserve recorder fleet bootstrap: %w", err)
	}
	if record.Request != request {
		return recorderfleet.NodeIdentity{}, recorderfleet.ErrInventoryDrift
	}
	if record.Identity != nil {
		if err := validateIdentity(request, *record.Identity); err != nil {
			return recorderfleet.NodeIdentity{}, err
		}
		return *record.Identity, nil
	}
	identity, err := s.issuer.EnsureBootstrap(ctx, request)
	if err != nil {
		return recorderfleet.NodeIdentity{}, fmt.Errorf("issue recorder fleet bootstrap: %w", err)
	}
	if err := validateIdentity(request, identity); err != nil {
		return recorderfleet.NodeIdentity{}, err
	}
	activated, err := s.repository.ActivateBootstrap(ctx, request, identity)
	if err != nil {
		return recorderfleet.NodeIdentity{}, fmt.Errorf("activate recorder fleet bootstrap: %w", err)
	}
	if activated != identity {
		return recorderfleet.NodeIdentity{}, recorderfleet.ErrRoleFence
	}
	return activated, nil
}

func (s Service) AbandonBootstrap(ctx context.Context, request recorderfleet.BootstrapRequest) error {
	if err := request.Validate(); err != nil || request.Key.Environment != s.environment {
		return recorderfleet.ErrRoleFence
	}
	if err := s.repository.AbandonBootstrap(ctx, request, s.now().UTC()); err != nil {
		return fmt.Errorf("record recorder fleet bootstrap abandonment: %w", err)
	}
	if err := s.issuer.AbandonBootstrap(ctx, request); err != nil {
		return fmt.Errorf("abandon recorder fleet certificate authority: %w", err)
	}
	return nil
}

func (s Service) CloseAdmission(ctx context.Context, identity recorderfleet.NodeIdentity) error {
	if err := validateNodeIdentity(identity); err != nil {
		return err
	}
	return s.repository.CloseAdmission(ctx, s.environment, identity)
}

func (s Service) RevokeIdentity(ctx context.Context, identity recorderfleet.NodeIdentity) error {
	if err := validateNodeIdentity(identity); err != nil {
		return err
	}
	if err := s.issuer.RevokeIdentity(ctx, identity); err != nil {
		return fmt.Errorf("revoke recorder fleet certificate: %w", err)
	}
	if err := s.repository.MarkRevoked(ctx, s.environment, identity, s.now().UTC()); err != nil {
		return fmt.Errorf("record recorder fleet revocation: %w", err)
	}
	return nil
}

func (s Service) PublishPool(ctx context.Context, projection recorderfleet.PoolProjection) error {
	if err := s.validateKey(projection.Key); err != nil || strings.TrimSpace(projection.DemandRevision) == "" && projection.Reason != "controller_unavailable" || projection.ReadyCapacity < 0 || projection.ObservedAt.IsZero() || strings.TrimSpace(projection.Reason) == "" || len(projection.Reason) > 256 {
		return recorderfleet.ErrRoleFence
	}
	return s.repository.PublishPool(ctx, projection)
}

func (s Service) RecordWorkerObservation(ctx context.Context, observation WorkerObservation) (recorderfleet.NodeObservation, error) {
	if observation.Identity.WorkerID.IsZero() || !validRole(observation.Identity.Role) || observation.ReadyCapacity < 0 || observation.ObservedAt.IsZero() || !observation.Ready && observation.AdmissionOpen {
		return recorderfleet.NodeObservation{}, recorderfleet.ErrRoleFence
	}
	return s.repository.RecordWorkerObservation(ctx, s.environment, observation)
}

func (s Service) AuthorizeWorker(ctx context.Context, identity workeridentity.Identity) error {
	if identity.WorkerID.IsZero() || !validRole(identity.Role) {
		return recorderfleet.ErrRoleFence
	}
	return s.repository.AuthorizeWorker(ctx, s.environment, identity)
}

func (s Service) AuthorizeWorkerClaim(ctx context.Context, identity workeridentity.Identity) error {
	if identity.WorkerID.IsZero() || !validRole(identity.Role) {
		return recorderfleet.ErrRoleFence
	}
	return s.repository.AuthorizeWorkerClaim(ctx, s.environment, identity)
}

func (s Service) validateKey(key recorderfleet.PoolKey) error {
	if key.Environment != s.environment {
		return recorderfleet.ErrRoleFence
	}
	return key.Validate()
}

func validateIdentity(request recorderfleet.BootstrapRequest, identity recorderfleet.NodeIdentity) error {
	if identity.ProviderID != request.ProviderID || identity.Role != request.Key.Role || identity.BootGeneration != request.BootGeneration {
		return recorderfleet.ErrRoleFence
	}
	return validateNodeIdentity(identity)
}

func validateNodeIdentity(identity recorderfleet.NodeIdentity) error {
	if strings.TrimSpace(identity.ProviderID) == "" || identity.BootGeneration == 0 || !validRole(identity.Role) {
		return recorderfleet.ErrRoleFence
	}
	parsed, err := utilities.ParseID(identity.WorkerID)
	if err != nil || parsed.IsZero() {
		return recorderfleet.ErrRoleFence
	}
	return nil
}

func validRole(role workeridentity.Role) bool {
	return role == workeridentity.RoleCapture || role == workeridentity.RoleRender
}

// BoundWorkerVerifier rejects a still-valid worker certificate when its
// durable node binding is revoked, missing, or role-mismatched. Draining nodes
// may finish existing work, but the claim path additionally requires admission.
type BoundWorkerVerifier struct {
	authorizer interface {
		AuthorizeWorker(context.Context, workeridentity.Identity) error
		AuthorizeWorkerClaim(context.Context, workeridentity.Identity) error
	}
	base interface {
		Verify(*http.Request) (workeridentity.Identity, error)
	}
}

func NewBoundWorkerVerifier(base interface {
	Verify(*http.Request) (workeridentity.Identity, error)
}, authorizer interface {
	AuthorizeWorker(context.Context, workeridentity.Identity) error
	AuthorizeWorkerClaim(context.Context, workeridentity.Identity) error
}) (*BoundWorkerVerifier, error) {
	if base == nil || authorizer == nil {
		return nil, recorderfleet.ErrInvalidConfig
	}
	return &BoundWorkerVerifier{base: base, authorizer: authorizer}, nil
}

func (v *BoundWorkerVerifier) Verify(request *http.Request) (workeridentity.Identity, error) {
	if v == nil || request == nil {
		return workeridentity.Identity{}, workeridentity.ErrUnverifiedPeer
	}
	identity, err := v.base.Verify(request)
	if err != nil {
		return workeridentity.Identity{}, err
	}
	authorize := v.authorizer.AuthorizeWorker
	if request.URL != nil && strings.HasSuffix(request.URL.Path, "/jobs/claim") {
		authorize = v.authorizer.AuthorizeWorkerClaim
	}
	if err := authorize(request.Context(), identity); err != nil {
		return workeridentity.Identity{}, errors.Join(workeridentity.ErrUnverifiedPeer, err)
	}
	return identity, nil
}

var (
	_ recorderfleet.DemandSource       = Service{}
	_ recorderfleet.BootstrapAuthority = Service{}
	_ recorderfleet.RuntimeControl     = Service{}
)
