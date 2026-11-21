package publicinvites

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
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

func (s Service) EnsureInvite(ctx context.Context, tenantID, spaceID, actorID utilities.ID, mode AdmissionMode) (Invite, error) {
	if err := validateIDs(tenantID, spaceID); err != nil {
		return Invite{}, err
	}
	if !mode.valid() {
		return Invite{}, ErrInvalidAdmissionMode
	}
	created, err := withFreshInviteHandle("generate public invite handle", func(handle []byte) (Invite, error) {
		return s.repository.CreateOrGetInvite(ctx, Invite{
			TenantID:      tenantID,
			SpaceID:       spaceID,
			Handle:        handle,
			Generation:    1,
			StateEpoch:    1,
			Enabled:       true,
			PublicRole:    PublicRoleCollaborator,
			AdmissionMode: mode,
			LastActorID:   actorID,
		})
	})
	if err != nil {
		return Invite{}, err
	}
	if err := validateInvite(created); err != nil {
		return Invite{}, err
	}
	return created, nil
}

func (s Service) GetInvite(ctx context.Context, tenantID, spaceID utilities.ID) (Invite, error) {
	if err := validateIDs(tenantID, spaceID); err != nil {
		return Invite{}, err
	}
	invite, err := s.repository.GetInvite(ctx, tenantID, spaceID)
	if err != nil {
		return Invite{}, err
	}
	if err := validateInvite(invite); err != nil {
		return Invite{}, err
	}
	return invite, nil
}

func (s Service) SetInviteEnabled(ctx context.Context, tenantID, spaceID utilities.ID, enabled bool, actorID utilities.ID) (Invite, error) {
	if err := validateIDs(tenantID, spaceID); err != nil {
		return Invite{}, err
	}
	invite, err := s.repository.SetInviteEnabled(ctx, tenantID, spaceID, enabled, actorID)
	if err != nil {
		return Invite{}, err
	}
	if err := validateInvite(invite); err != nil {
		return Invite{}, err
	}
	return invite, nil
}

func (s Service) RotateInvite(ctx context.Context, tenantID, spaceID, actorID utilities.ID, requestKey string) (Invite, error) {
	if err := validateIDs(tenantID, spaceID); err != nil {
		return Invite{}, err
	}
	if requestKey != "" {
		if err := validateIdempotencyKey(requestKey); err != nil {
			return Invite{}, ErrInvalidRequestKey
		}
	}
	invite, err := withFreshInviteHandle("generate rotated public invite handle", func(handle []byte) (Invite, error) {
		return s.repository.RotateInvite(ctx, tenantID, spaceID, handle, actorID, requestKey)
	})
	if err != nil {
		return Invite{}, err
	}
	if err := validateInvite(invite); err != nil {
		return Invite{}, err
	}
	return invite, nil
}

func (s Service) IssueInviteToken(invite Invite) (string, error) {
	if err := validateInvite(invite); err != nil {
		return "", err
	}
	if s.signer == nil {
		return "", ErrInvalidKeyring
	}
	token, err := s.signer.Issue(invite.Handle, invite.Generation)
	if err != nil {
		return "", err
	}
	return s.signer.Encode(token)
}

func (s Service) ResolveInviteToken(ctx context.Context, raw string) (Invite, Token, error) {
	if code, ok := ParseInviteCode(raw); ok {
		trace.SpanFromContext(ctx).SetAttributes(attribute.String("chalk.public_invite.credential", "code"))
		invite, err := s.repository.GetInviteByCode(ctx, code)
		if errors.Is(err, ErrInviteNotFound) {
			return Invite{}, Token{}, ErrInviteUnavailable
		}
		if err != nil {
			return Invite{}, Token{}, err
		}
		if err := validateInvite(invite); err != nil || !invite.Enabled {
			return Invite{}, Token{}, ErrInviteUnavailable
		}
		return invite, Token{Handle: invite.Handle, Generation: invite.Generation}, nil
	}
	trace.SpanFromContext(ctx).SetAttributes(attribute.String("chalk.public_invite.credential", "token"))
	if s.signer == nil {
		return Invite{}, Token{}, ErrInvalidKeyring
	}
	token, err := s.signer.Verify(raw)
	if err != nil {
		return Invite{}, Token{}, err
	}
	invite, err := s.repository.GetInviteByHandle(ctx, token.Handle)
	if errors.Is(err, ErrInviteNotFound) {
		return Invite{}, Token{}, ErrInviteUnavailable
	}
	if err != nil {
		return Invite{}, Token{}, err
	}
	if err := validateInvite(invite); err != nil {
		return Invite{}, Token{}, ErrInviteUnavailable
	}
	if !invite.Enabled || invite.Generation != token.Generation || !bytes.Equal(invite.Handle, token.Handle) {
		return Invite{}, Token{}, ErrInviteUnavailable
	}
	return invite, token, nil
}

func withFreshInviteHandle(generationError string, attempt func([]byte) (Invite, error)) (Invite, error) {
	err := ErrInviteCodeTaken
	for range 3 {
		handle := make([]byte, HandleBytes)
		if _, readErr := rand.Read(handle); readErr != nil {
			return Invite{}, fmt.Errorf("%s: %w", generationError, readErr)
		}
		var invite Invite
		invite, err = attempt(handle)
		if !errors.Is(err, ErrInviteCodeTaken) {
			return invite, err
		}
	}
	return Invite{}, err
}

type inviteCredential struct {
	code  string
	token Token
}

func (s Service) parseInviteCredential(raw string) (inviteCredential, error) {
	if code, ok := ParseInviteCode(raw); ok {
		return inviteCredential{code: code}, nil
	}
	if s.signer == nil {
		return inviteCredential{}, ErrInvalidKeyring
	}
	token, err := s.signer.Verify(raw)
	if err != nil {
		return inviteCredential{}, err
	}
	return inviteCredential{token: token}, nil
}

func (credential inviteCredential) matches(handle []byte, generation uint64) bool {
	if credential.code != "" {
		return InviteCode(handle) == credential.code || InviteWordCode(handle) == credential.code
	}
	return credential.token.Generation == generation && bytes.Equal(credential.token.Handle, handle)
}
