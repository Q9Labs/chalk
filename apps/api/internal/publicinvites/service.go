package publicinvites

import (
	"context"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// Repository is the persistence boundary for public Spaces. Implementations
// must lock the invite, arrival, or admission request before state changes.
type Repository interface {
	CreateOrGetInvite(context.Context, Invite) (Invite, error)
	GetInvite(context.Context, utilities.ID, utilities.ID) (Invite, error)
	GetInviteByHandle(context.Context, []byte) (Invite, error)
	GetInviteByCode(context.Context, string) (Invite, error)
	SetInviteEnabled(context.Context, utilities.ID, utilities.ID, bool, utilities.ID) (Invite, error)
	RotateInvite(context.Context, utilities.ID, utilities.ID, []byte, utilities.ID, string) (Invite, error)

	CreateArrival(context.Context, Arrival) (Arrival, error)
	GetArrival(context.Context, utilities.ID) (Arrival, error)
	GetArrivalForCredential(context.Context, utilities.ID, []byte) (Arrival, error)
	GetArrivalByIdempotency(context.Context, utilities.ID, utilities.ID, string) (Arrival, error)
	UpdateArrivalState(context.Context, UpdateArrivalStateInput) (Arrival, error)

	CreateAdmissionRequest(context.Context, AdmissionRequest, mediaplane.ClientProviders) (AdmissionRequest, error)
	GetAdmissionRequest(context.Context, utilities.ID, utilities.ID, utilities.ID) (AdmissionRequest, error)
	GetAdmissionRequestForArrival(context.Context, Arrival) (AdmissionRequest, error)
	ListAdmissionRequests(context.Context, utilities.ID, utilities.ID, AdmissionRequestState, int32) ([]AdmissionRequest, error)
	DecideAdmissionRequest(context.Context, DecideAdmissionRequestInput) (AdmissionRequest, Arrival, error)
}

// Lifecycle owns durable auto-archive state. It is separate from Repository
// so ordinary invite callers do not need to implement scheduler operations.
type Lifecycle interface {
	CreateAutoLifecycle(context.Context, AutoLifecycle) (AutoLifecycle, error)
	GetAutoLifecycle(context.Context, utilities.ID, utilities.ID) (AutoLifecycle, error)
	ListDueAutoLifecycles(context.Context, time.Time, int32) ([]AutoLifecycle, error)
	MarkAutoLifecycleArchiving(context.Context, utilities.ID, utilities.ID) (AutoLifecycle, error)
	MarkAutoLifecycleArchived(context.Context, utilities.ID, utilities.ID) (AutoLifecycle, error)
	RetryAutoLifecycle(context.Context, RetryAutoLifecycleInput) (AutoLifecycle, error)
}

type Service struct {
	repository Repository
	lifecycle  Lifecycle
	signer     *Signer
	now        func() time.Time
}

// NewService constructs the persistence-facing invite service. Lifecycle
// operations can be enabled with NewServiceWithLifecycle or through Runtime.
func NewService(repository Repository, signers ...Signer) Service {
	service := Service{
		repository: repository,
		now:        func() time.Time { return time.Now().UTC() },
	}
	if len(signers) > 0 {
		service.signer = &signers[0]
	}
	return service
}

func NewServiceWithLifecycle(repository Repository, lifecycle Lifecycle, signers ...Signer) (Service, error) {
	if repository == nil {
		return Service{}, ErrInvalidInvite
	}
	if lifecycle == nil {
		return Service{}, ErrLifecycleUnavailable
	}
	service := NewService(repository, signers...)
	service.lifecycle = lifecycle
	return service, nil
}

func (s Service) WithClock(now func() time.Time) Service {
	if now != nil {
		s.now = now
	}
	return s
}
