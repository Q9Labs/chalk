package publicinvites

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// Repository is the persistence boundary for public Spaces. Implementations
// must lock the invite, arrival, or admission request before state changes.
type Repository interface {
	CreateOrGetInvite(context.Context, Invite) (Invite, error)
	GetInvite(context.Context, utilities.ID, utilities.ID) (Invite, error)
	GetInviteByHandle(context.Context, []byte) (Invite, error)
	SetInviteEnabled(context.Context, utilities.ID, utilities.ID, bool, utilities.ID) (Invite, error)
	RotateInvite(context.Context, utilities.ID, utilities.ID, []byte, utilities.ID, string) (Invite, error)

	CreateArrival(context.Context, Arrival) (Arrival, error)
	GetArrival(context.Context, utilities.ID) (Arrival, error)
	GetArrivalForCredential(context.Context, utilities.ID, []byte) (Arrival, error)
	GetArrivalByIdempotency(context.Context, utilities.ID, utilities.ID, string) (Arrival, error)
	UpdateArrivalState(context.Context, UpdateArrivalStateInput) (Arrival, error)

	CreateAdmissionRequest(context.Context, AdmissionRequest) (AdmissionRequest, error)
	GetAdmissionRequest(context.Context, utilities.ID, utilities.ID, utilities.ID) (AdmissionRequest, error)
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
	handle := make([]byte, HandleBytes)
	if _, err := rand.Read(handle); err != nil {
		return Invite{}, fmt.Errorf("generate public invite handle: %w", err)
	}
	created, err := s.repository.CreateOrGetInvite(ctx, Invite{
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
	handle := make([]byte, HandleBytes)
	if _, err := rand.Read(handle); err != nil {
		return Invite{}, fmt.Errorf("generate rotated public invite handle: %w", err)
	}
	invite, err := s.repository.RotateInvite(ctx, tenantID, spaceID, handle, actorID, requestKey)
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

// CreateArrival records an Account or Guest arrival and returns a newly
// generated Guest credential only on the first idempotent request.
func (s Service) CreateArrival(ctx context.Context, input CreateArrivalInput) (CreateArrivalResult, error) {
	if err := validateIDs(input.TenantID, input.SpaceID); err != nil {
		return CreateArrivalResult{}, err
	}
	if len(input.Invite.Handle) != HandleBytes || input.Invite.Generation == 0 || input.InviteStateEpoch == 0 {
		return CreateArrivalResult{}, ErrInvalidToken
	}
	if err := validateIdempotencyKey(input.IdempotencyKey); err != nil {
		return CreateArrivalResult{}, err
	}
	if input.CredentialFamily != "" && (len(input.CredentialFamily) > MaxCredentialFamilyBytes || !isASCII(input.CredentialFamily)) {
		return CreateArrivalResult{}, ErrInvalidArrival
	}
	input.DisplayName = strings.TrimSpace(input.DisplayName)
	if err := validateDisplayName(input.DisplayName); err != nil {
		return CreateArrivalResult{}, err
	}
	credentialHash, credential, err := prepareCredential(input)
	if err != nil {
		return CreateArrivalResult{}, err
	}
	fingerprint, err := arrivalFingerprint(input, credentialHash)
	if err != nil {
		return CreateArrivalResult{}, err
	}
	if existing, err := s.repository.GetArrivalByIdempotency(ctx, input.TenantID, input.SpaceID, input.IdempotencyKey); err == nil {
		if !bytes.Equal(existing.IdempotencyFingerprint[:], fingerprint[:]) {
			return CreateArrivalResult{}, ErrIdempotencyConflict
		}
		return CreateArrivalResult{Arrival: existing}, nil
	} else if !errors.Is(err, ErrArrivalNotFound) {
		return CreateArrivalResult{}, err
	}

	now := s.now()
	expiresAt := input.ExpiresAt
	if expiresAt.IsZero() {
		expiresAt = now.Add(DefaultArrivalLifetime)
	}
	if !expiresAt.After(now) {
		return CreateArrivalResult{}, ErrArrivalUnavailable
	}
	arrivalHandle, err := utilities.NewID()
	if err != nil {
		return CreateArrivalResult{}, fmt.Errorf("generate public arrival handle: %w", err)
	}
	arrival := Arrival{
		ArrivalHandle:          arrivalHandle,
		TenantID:               input.TenantID,
		SpaceID:                input.SpaceID,
		InviteHandle:           append([]byte(nil), input.Invite.Handle...),
		InviteGeneration:       input.Invite.Generation,
		InviteStateEpoch:       input.InviteStateEpoch,
		IdentityMode:           input.IdentityMode,
		GuestCredentialHash:    append([]byte(nil), credentialHash...),
		AccountID:              input.AccountID,
		DisplayName:            input.DisplayName,
		CredentialFamily:       input.CredentialFamily,
		IdempotencyKey:         input.IdempotencyKey,
		IdempotencyFingerprint: fingerprint,
		State:                  ArrivalPending,
		ExpiresAt:              expiresAt,
	}
	created, err := s.repository.CreateArrival(ctx, arrival)
	if errors.Is(err, ErrIdempotencyConflict) {
		existing, lookupErr := s.repository.GetArrivalByIdempotency(ctx, input.TenantID, input.SpaceID, input.IdempotencyKey)
		if lookupErr != nil {
			return CreateArrivalResult{}, lookupErr
		}
		if !bytes.Equal(existing.IdempotencyFingerprint[:], fingerprint[:]) {
			return CreateArrivalResult{}, ErrIdempotencyConflict
		}
		return CreateArrivalResult{Arrival: existing}, nil
	}
	if err != nil {
		return CreateArrivalResult{}, err
	}
	if !bytes.Equal(created.IdempotencyFingerprint[:], fingerprint[:]) {
		return CreateArrivalResult{}, ErrIdempotencyConflict
	}
	return CreateArrivalResult{Arrival: created, Credential: credential}, nil
}

// Arrive preserves the persistence-facing arrival operation for callers that
// do not need the Runtime's token and access orchestration.
func (s Service) Arrive(ctx context.Context, input CreateArrivalInput) (CreateArrivalResult, error) {
	return s.CreateArrival(ctx, input)
}

func prepareCredential(input CreateArrivalInput) ([]byte, []byte, error) {
	switch input.IdentityMode {
	case IdentityAccount:
		if input.AccountID.IsZero() {
			return nil, nil, ErrInvalidAccountID
		}
		if len(input.GuestCredential) != 0 {
			return nil, nil, ErrInvalidIdentityMode
		}
		return nil, nil, nil
	case IdentityGuest:
		if !input.AccountID.IsZero() {
			return nil, nil, ErrInvalidAccountID
		}
		if len(input.GuestCredential) < 16 || len(input.GuestCredential) > 256 {
			return nil, nil, ErrInvalidCredential
		}
		hash := sha256.Sum256(input.GuestCredential)
		return append([]byte(nil), hash[:]...), append([]byte(nil), input.GuestCredential...), nil
	default:
		return nil, nil, ErrInvalidIdentityMode
	}
}

func (s Service) GetArrival(ctx context.Context, arrivalHandle utilities.ID) (Arrival, error) {
	if arrivalHandle.IsZero() {
		return Arrival{}, ErrArrivalNotFound
	}
	return s.repository.GetArrival(ctx, arrivalHandle)
}

func (s Service) GetArrivalByIdempotency(ctx context.Context, tenantID, spaceID utilities.ID, requestKey string) (Arrival, error) {
	if err := validateIDs(tenantID, spaceID); err != nil {
		return Arrival{}, err
	}
	if err := validateIdempotencyKey(requestKey); err != nil {
		return Arrival{}, err
	}
	return s.repository.GetArrivalByIdempotency(ctx, tenantID, spaceID, requestKey)
}

func (s Service) GetArrivalForCredential(ctx context.Context, arrivalHandle utilities.ID, credential []byte) (Arrival, error) {
	if arrivalHandle.IsZero() {
		return Arrival{}, ErrArrivalNotFound
	}
	if len(credential) < 16 || len(credential) > 256 {
		return Arrival{}, ErrInvalidCredential
	}
	hash := sha256.Sum256(credential)
	arrival, err := s.repository.GetArrivalForCredential(ctx, arrivalHandle, hash[:])
	if errors.Is(err, ErrArrivalNotFound) {
		return Arrival{}, ErrCredentialMismatch
	}
	return arrival, err
}

func (s Service) UpdateArrivalState(ctx context.Context, input UpdateArrivalStateInput) (Arrival, error) {
	if input.TenantID.IsZero() || input.ArrivalHandle.IsZero() {
		return Arrival{}, ErrArrivalNotFound
	}
	if !input.State.valid() {
		return Arrival{}, ErrArrivalUnavailable
	}
	if len(input.Reason) > MaxDisplayNameBytes || !isASCII(input.Reason) {
		return Arrival{}, ErrInvalidArrival
	}
	if input.ParticipantGeneration < 0 {
		return Arrival{}, ErrInvalidArrival
	}
	accessState := input.State == ArrivalAdmitted || input.State == ArrivalLeft
	if accessState && (input.EpisodeID.IsZero() || input.ParticipantID.IsZero() || input.ParticipantGeneration == 0) {
		return Arrival{}, ErrInvalidArrival
	}
	if err := validateProviderBinding(input.Provider, input.ProviderSubject, accessState); err != nil {
		return Arrival{}, err
	}
	return s.repository.UpdateArrivalState(ctx, input)
}

func (s Service) CreateAdmissionRequest(ctx context.Context, input CreateAdmissionRequestInput) (AdmissionRequest, error) {
	if input.ArrivalHandle.IsZero() {
		return AdmissionRequest{}, ErrInvalidAdmissionRequest
	}
	name := strings.TrimSpace(input.DisplayName)
	if err := validateDisplayName(name); err != nil {
		return AdmissionRequest{}, err
	}
	now := s.now()
	expiresAt := input.ExpiresAt
	if expiresAt.IsZero() {
		expiresAt = now.Add(AdmissionRequestLifetime)
	}
	if !expiresAt.After(now) || expiresAt.After(now.Add(AdmissionRequestLifetime)) {
		return AdmissionRequest{}, ErrInvalidAdmissionRequest
	}
	handle, err := utilities.NewID()
	if err != nil {
		return AdmissionRequest{}, fmt.Errorf("generate admission request handle: %w", err)
	}
	return s.repository.CreateAdmissionRequest(ctx, AdmissionRequest{
		RequestHandle: handle,
		ArrivalHandle: input.ArrivalHandle,
		DisplayName:   name,
		State:         AdmissionRequestPending,
		RequestedAt:   now,
		ExpiresAt:     expiresAt,
	})
}

func (s Service) GetAdmissionRequest(ctx context.Context, tenantID, spaceID, requestHandle utilities.ID) (AdmissionRequest, error) {
	if err := validateIDs(tenantID, spaceID); err != nil || requestHandle.IsZero() {
		return AdmissionRequest{}, ErrAdmissionRequestNotFound
	}
	return s.repository.GetAdmissionRequest(ctx, tenantID, spaceID, requestHandle)
}

func (s Service) ListAdmissionRequestsForSpace(ctx context.Context, tenantID, spaceID utilities.ID, state AdmissionRequestState, pageSize int32) ([]AdmissionRequest, error) {
	if err := validateIDs(tenantID, spaceID); err != nil {
		return nil, err
	}
	if state != "" && state != AdmissionRequestPending {
		return nil, ErrInvalidAdmissionRequest
	}
	if pageSize <= 0 || pageSize > 100 {
		pageSize = 50
	}
	return s.repository.ListAdmissionRequests(ctx, tenantID, spaceID, state, pageSize)
}

// ListAdmissionRequests preserves the low-level persistence-facing shape for
// callers that do not need the Runtime page wrapper.
func (s Service) ListAdmissionRequests(ctx context.Context, tenantID, spaceID utilities.ID, state AdmissionRequestState, pageSize int32) ([]AdmissionRequest, error) {
	return s.ListAdmissionRequestsForSpace(ctx, tenantID, spaceID, state, pageSize)
}

func (s Service) DecideAdmissionRequest(ctx context.Context, input DecideAdmissionRequestInput) (AdmissionRequest, Arrival, error) {
	if err := validateIDs(input.TenantID, input.SpaceID); err != nil || input.RequestHandle.IsZero() {
		return AdmissionRequest{}, Arrival{}, ErrAdmissionRequestNotFound
	}
	if !input.Decision.valid() {
		return AdmissionRequest{}, Arrival{}, ErrInvalidAdmissionDecision
	}
	if input.RequestKey != "" {
		if err := validateIdempotencyKey(input.RequestKey); err != nil {
			return AdmissionRequest{}, Arrival{}, ErrInvalidRequestKey
		}
	}
	return s.repository.DecideAdmissionRequest(ctx, input)
}

func (s Service) CreateAutoLifecycle(ctx context.Context, lifecycle AutoLifecycle) (AutoLifecycle, error) {
	if err := validateIDs(lifecycle.TenantID, lifecycle.SpaceID); err != nil {
		return AutoLifecycle{}, err
	}
	if lifecycle.DeadlineAt.IsZero() || lifecycle.RetryCount < 0 {
		return AutoLifecycle{}, ErrInvalidLifecycleState
	}
	if lifecycle.State != "" && lifecycle.State != AutoLifecycleActive {
		return AutoLifecycle{}, ErrInvalidLifecycleState
	}
	if lifecycle.NextRetryAt != nil || lifecycle.ArchiveCompletedAt != nil || lifecycle.LastErrorFamily != "" {
		return AutoLifecycle{}, ErrInvalidLifecycleState
	}
	lifecycle.State = AutoLifecycleActive
	return s.lifecycleCreate(ctx, lifecycle)
}

func (s Service) GetAutoLifecycle(ctx context.Context, tenantID, spaceID utilities.ID) (AutoLifecycle, error) {
	if err := validateIDs(tenantID, spaceID); err != nil {
		return AutoLifecycle{}, err
	}
	if s.lifecycle == nil {
		return AutoLifecycle{}, ErrLifecycleUnavailable
	}
	return s.lifecycle.GetAutoLifecycle(ctx, tenantID, spaceID)
}

func (s Service) DueAutoLifecycles(ctx context.Context, now time.Time, pageSize int32) ([]AutoLifecycle, error) {
	if now.IsZero() {
		now = s.now()
	}
	if pageSize <= 0 || pageSize > 100 {
		pageSize = 50
	}
	if s.lifecycle == nil {
		return nil, ErrLifecycleUnavailable
	}
	return s.lifecycle.ListDueAutoLifecycles(ctx, now, pageSize)
}

func (s Service) MarkAutoLifecycleArchiving(ctx context.Context, tenantID, spaceID utilities.ID) (AutoLifecycle, error) {
	if err := validateIDs(tenantID, spaceID); err != nil {
		return AutoLifecycle{}, err
	}
	if s.lifecycle == nil {
		return AutoLifecycle{}, ErrLifecycleUnavailable
	}
	return s.lifecycle.MarkAutoLifecycleArchiving(ctx, tenantID, spaceID)
}

func (s Service) MarkAutoLifecycleArchived(ctx context.Context, tenantID, spaceID utilities.ID) (AutoLifecycle, error) {
	if err := validateIDs(tenantID, spaceID); err != nil {
		return AutoLifecycle{}, err
	}
	if s.lifecycle == nil {
		return AutoLifecycle{}, ErrLifecycleUnavailable
	}
	return s.lifecycle.MarkAutoLifecycleArchived(ctx, tenantID, spaceID)
}

func (s Service) RetryAutoLifecycle(ctx context.Context, input RetryAutoLifecycleInput) (AutoLifecycle, error) {
	if err := validateIDs(input.TenantID, input.SpaceID); err != nil {
		return AutoLifecycle{}, err
	}
	if input.NextRetryAt.IsZero() || !validErrorFamily(input.ErrorFamily) {
		return AutoLifecycle{}, ErrInvalidLifecycleState
	}
	if s.lifecycle == nil {
		return AutoLifecycle{}, ErrLifecycleUnavailable
	}
	return s.lifecycle.RetryAutoLifecycle(ctx, input)
}

func (s Service) lifecycleCreate(ctx context.Context, lifecycle AutoLifecycle) (AutoLifecycle, error) {
	if s.lifecycle == nil {
		return AutoLifecycle{}, ErrLifecycleUnavailable
	}
	return s.lifecycle.CreateAutoLifecycle(ctx, lifecycle)
}

// Runtime composes persistence with Space, lifecycle, and access ports. All
// ports are required at construction so request handlers never discover a
// missing dependency after accepting a request.
type Runtime struct {
	service               Service
	space                 Space
	lifecycle             Lifecycle
	access                Access
	accounts              Accounts
	links                 Links
	autoLifecycleLifetime time.Duration
}

func NewRuntime(service Service, space Space, lifecycle Lifecycle, access Access, accounts Accounts, links Links) (Runtime, error) {
	return NewRuntimeWithConfig(service, space, lifecycle, access, accounts, links, RuntimeConfig{AutoLifecycleLifetime: DefaultAutoLifecycleLifetime})
}

type RuntimeConfig struct {
	AutoLifecycleLifetime time.Duration
}

func NewRuntimeWithConfig(service Service, space Space, lifecycle Lifecycle, access Access, accounts Accounts, links Links, config RuntimeConfig) (Runtime, error) {
	if space == nil {
		return Runtime{}, ErrSpaceUnavailable
	}
	if lifecycle == nil {
		return Runtime{}, ErrLifecycleUnavailable
	}
	if access == nil {
		return Runtime{}, ErrAccessUnavailable
	}
	if accounts == nil {
		return Runtime{}, ErrAccountsUnavailable
	}
	if links == nil {
		return Runtime{}, ErrLinksUnavailable
	}
	if config.AutoLifecycleLifetime <= 0 || config.AutoLifecycleLifetime > DefaultAutoLifecycleLifetime {
		return Runtime{}, ErrInvalidLifecycleState
	}
	service.lifecycle = lifecycle
	return Runtime{service: service, space: space, lifecycle: lifecycle, access: access, accounts: accounts, links: links, autoLifecycleLifetime: config.AutoLifecycleLifetime}, nil
}

const guestCredentialDerivationContext = "chalk/public-invite/guest-credential/v1"

func (r Runtime) deriveGuestCredential(token Token, requestKey string) ([]byte, error) {
	if r.service.signer == nil {
		return nil, ErrInvalidKeyring
	}
	if len(token.Handle) != HandleBytes || token.Generation == 0 {
		return nil, ErrInvalidToken
	}
	if err := validateIdempotencyKey(requestKey); err != nil {
		return nil, err
	}
	if token.KeyID == "" {
		token.KeyID = r.service.signer.keyring.CurrentKeyID
	}
	mac := hmac.New(sha256.New, r.service.signer.keyring.Signer)
	_, _ = mac.Write([]byte(guestCredentialDerivationContext))
	_, _ = mac.Write([]byte{0})
	_, _ = mac.Write([]byte(token.KeyID))
	_, _ = mac.Write([]byte{0})
	_, _ = mac.Write(token.Handle)
	var generation [8]byte
	binary.BigEndian.PutUint64(generation[:], token.Generation)
	_, _ = mac.Write(generation[:])
	_, _ = mac.Write([]byte(requestKey))
	return mac.Sum(nil), nil
}

func (r Runtime) GetInvite(ctx context.Context, tenantID, spaceID utilities.ID) (ManagedInvite, error) {
	invite, err := r.service.GetInvite(ctx, tenantID, spaceID)
	if errors.Is(err, ErrInviteNotFound) {
		invite, err = r.ensureInviteForSpace(ctx, tenantID, spaceID)
	}
	if err != nil {
		return ManagedInvite{}, err
	}
	return r.managedInvite(ctx, invite)
}

func (r Runtime) ensureInviteForSpace(ctx context.Context, tenantID, spaceID utilities.ID) (Invite, error) {
	space, err := r.space.GetPublicSpace(ctx, tenantID, spaceID)
	if err != nil {
		return Invite{}, err
	}
	if err := validatePublicSpace(space); err != nil {
		return Invite{}, err
	}
	if space.TenantID != tenantID || space.SpaceID != spaceID {
		return Invite{}, ErrInviteUnavailable
	}
	return r.service.EnsureInvite(ctx, tenantID, spaceID, utilities.ID{}, space.AdmissionMode)
}

func (r Runtime) UpdateInvite(ctx context.Context, input UpdateSpacePublicInviteInput) (ManagedInvite, error) {
	invite, err := r.service.SetInviteEnabled(ctx, input.TenantID, input.SpaceID, input.Enabled, input.ActorID)
	if errors.Is(err, ErrInviteNotFound) {
		if _, ensureErr := r.ensureInviteForSpace(ctx, input.TenantID, input.SpaceID); ensureErr != nil {
			return ManagedInvite{}, ensureErr
		}
		invite, err = r.service.SetInviteEnabled(ctx, input.TenantID, input.SpaceID, input.Enabled, input.ActorID)
	}
	if err != nil {
		return ManagedInvite{}, err
	}
	return r.managedInvite(ctx, invite)
}

func (r Runtime) RotateInvite(ctx context.Context, input RotateSpacePublicInviteInput) (ManagedInvite, error) {
	if input.RequestKey != "" {
		if err := validateIdempotencyKey(input.RequestKey); err != nil {
			return ManagedInvite{}, ErrInvalidRequestKey
		}
	}
	invite, err := r.service.RotateInvite(ctx, input.TenantID, input.SpaceID, input.ActorID, input.RequestKey)
	if errors.Is(err, ErrInviteNotFound) {
		if _, ensureErr := r.ensureInviteForSpace(ctx, input.TenantID, input.SpaceID); ensureErr != nil {
			return ManagedInvite{}, ensureErr
		}
		invite, err = r.service.RotateInvite(ctx, input.TenantID, input.SpaceID, input.ActorID, input.RequestKey)
	}
	if err != nil {
		return ManagedInvite{}, err
	}
	return r.managedInvite(ctx, invite)
}

func (r Runtime) ListAdmissionRequests(ctx context.Context, input ListPublicAdmissionRequestsInput) (AdmissionRequestPage, error) {
	requests, err := r.service.ListAdmissionRequestsForSpace(ctx, input.TenantID, input.SpaceID, AdmissionRequestState(input.State), input.PageSize)
	if err != nil {
		return AdmissionRequestPage{}, err
	}
	return AdmissionRequestPage{Requests: requests}, nil
}

func (r Runtime) ApproveAdmissionRequest(ctx context.Context, input DecidePublicAdmissionRequestInput) (AdmissionRequest, error) {
	return r.decideAdmissionRequest(ctx, input, DecisionApprove)
}

func (r Runtime) DenyAdmissionRequest(ctx context.Context, input DecidePublicAdmissionRequestInput) (AdmissionRequest, error) {
	return r.decideAdmissionRequest(ctx, input, DecisionDeny)
}

func (r Runtime) decideAdmissionRequest(ctx context.Context, input DecidePublicAdmissionRequestInput, decision AdmissionDecision) (AdmissionRequest, error) {
	if input.RequestKey != "" {
		if err := validateIdempotencyKey(input.RequestKey); err != nil {
			return AdmissionRequest{}, ErrInvalidRequestKey
		}
	}
	requestHandle, err := utilities.ParseID(strings.TrimSpace(input.RequestHandle))
	if err != nil {
		return AdmissionRequest{}, ErrAdmissionRequestNotFound
	}
	request, arrival, err := r.service.DecideAdmissionRequest(ctx, DecideAdmissionRequestInput{
		TenantID:      input.TenantID,
		SpaceID:       input.SpaceID,
		RequestHandle: requestHandle,
		Decision:      decision,
		ActorID:       input.ActorID,
		RequestKey:    input.RequestKey,
	})
	if err != nil {
		return AdmissionRequest{}, err
	}
	if decision == DecisionDeny {
		if arrival.State != ArrivalRejected {
			return AdmissionRequest{}, ErrAdmissionRequestTerminal
		}
		return request, nil
	}
	if arrival.State == ArrivalAdmitted {
		return request, nil
	}
	if arrival.State != ArrivalPending {
		return AdmissionRequest{}, ErrAdmissionRequestTerminal
	}
	space, err := r.space.GetPublicSpace(ctx, arrival.TenantID, arrival.SpaceID)
	if err != nil {
		return AdmissionRequest{}, err
	}
	if space.TenantID != arrival.TenantID || space.SpaceID != arrival.SpaceID {
		return AdmissionRequest{}, ErrInviteUnavailable
	}
	valid, validationErr := r.pendingGuestArrivalValid(ctx, arrival, space)
	if validationErr != nil {
		return AdmissionRequest{}, validationErr
	}
	if !valid {
		if _, updateErr := r.invalidatePendingArrival(ctx, arrival); updateErr != nil {
			return AdmissionRequest{}, updateErr
		}
		return AdmissionRequest{}, ErrInviteUnavailable
	}
	grant, err := r.access.GrantPublicAccess(ctx, PublicAccessInput{Arrival: arrival})
	if err != nil {
		return AdmissionRequest{}, err
	}
	if err := validateAccessGrant(grant, arrival); err != nil {
		return AdmissionRequest{}, err
	}
	if _, err := r.service.UpdateArrivalState(ctx, UpdateArrivalStateInput{
		TenantID:              arrival.TenantID,
		ArrivalHandle:         arrival.ArrivalHandle,
		State:                 ArrivalAdmitted,
		EpisodeID:             grant.EpisodeID,
		ParticipantID:         grant.ParticipantID,
		ParticipantGeneration: grant.ParticipantGeneration,
		Provider:              grant.Provider,
		ProviderSubject:       grant.ProviderSubject,
	}); err != nil {
		return AdmissionRequest{}, err
	}
	return request, nil
}

func (r Runtime) CreatePublicSpace(ctx context.Context, input CreatePublicSpaceInput) (PublicSpaceCreated, error) {
	name := strings.TrimSpace(input.DisplayName)
	if err := validateDisplayName(name); err != nil {
		return PublicSpaceCreated{}, err
	}
	if input.RequestKey == "" {
		return PublicSpaceCreated{}, ErrInvalidRequestKey
	}
	if err := validateIdempotencyKey(input.RequestKey); err != nil {
		return PublicSpaceCreated{}, ErrInvalidRequestKey
	}
	input.DisplayName = name
	space, err := r.space.CreatePublicSpace(ctx, input)
	if err != nil {
		return PublicSpaceCreated{}, err
	}
	if err := validatePublicSpace(space); err != nil {
		return PublicSpaceCreated{}, err
	}
	if space.Archived {
		return PublicSpaceCreated{}, ErrInviteUnavailable
	}
	invite, err := r.service.EnsureInvite(ctx, space.TenantID, space.SpaceID, utilities.ID{}, space.AdmissionMode)
	if err != nil {
		return PublicSpaceCreated{}, err
	}
	token, err := r.service.IssueInviteToken(invite)
	if err != nil {
		return PublicSpaceCreated{}, err
	}
	inviteLink, err := r.links.SpaceInviteURL(space.Slug, token)
	if err != nil {
		return PublicSpaceCreated{}, fmt.Errorf("build public Space invite link: %w", err)
	}
	arrivalKey := input.RequestKey
	guestCredential, err := r.deriveGuestCredential(Token{Handle: invite.Handle, Generation: invite.Generation}, arrivalKey)
	if err != nil {
		return PublicSpaceCreated{}, err
	}
	var arrivalResult CreateArrivalResult
	existing, existingErr := r.service.GetArrivalByIdempotency(ctx, space.TenantID, space.SpaceID, arrivalKey)
	switch {
	case existingErr == nil:
		if existing.IdentityMode != IdentityGuest || existing.DisplayName != name || existing.IdempotencyKey != arrivalKey ||
			!bytes.Equal(existing.InviteHandle, invite.Handle) || existing.InviteGeneration != invite.Generation || existing.InviteStateEpoch != invite.StateEpoch {
			return PublicSpaceCreated{}, ErrIdempotencyConflict
		}
		arrivalResult.Arrival = existing
	case errors.Is(existingErr, ErrArrivalNotFound):
		arrivalResult, err = r.service.CreateArrival(ctx, CreateArrivalInput{
			TenantID:         space.TenantID,
			SpaceID:          space.SpaceID,
			Invite:           Token{Handle: invite.Handle, Generation: invite.Generation},
			InviteStateEpoch: invite.StateEpoch,
			IdentityMode:     IdentityGuest,
			DisplayName:      name,
			GuestCredential:  guestCredential,
			IdempotencyKey:   arrivalKey,
		})
		if err != nil {
			return PublicSpaceCreated{}, err
		}
	default:
		return PublicSpaceCreated{}, existingErr
	}
	if arrivalResult.Arrival.IdentityMode == IdentityGuest && len(arrivalResult.Credential) == 0 {
		arrivalResult.Credential = append([]byte(nil), guestCredential...)
	}
	arrival := arrivalResult.Arrival
	var grant PublicAccessGrant
	switch arrival.State {
	case ArrivalAdmitted:
		grant, err = r.access.RefreshPublicAccess(ctx, PublicAccessInput{Arrival: arrival})
	case ArrivalPending:
		grant, err = r.access.GrantPublicAccess(ctx, PublicAccessInput{Arrival: arrival})
		if err == nil {
			arrival, err = r.service.UpdateArrivalState(ctx, UpdateArrivalStateInput{
				TenantID:              arrival.TenantID,
				ArrivalHandle:         arrival.ArrivalHandle,
				State:                 ArrivalAdmitted,
				EpisodeID:             grant.EpisodeID,
				ParticipantID:         grant.ParticipantID,
				ParticipantGeneration: grant.ParticipantGeneration,
				Provider:              grant.Provider,
				ProviderSubject:       grant.ProviderSubject,
			})
		}
	default:
		return PublicSpaceCreated{}, ErrArrivalUnavailable
	}
	if err != nil {
		return PublicSpaceCreated{}, err
	}
	if err := validateAccessGrant(grant, arrival); err != nil {
		return PublicSpaceCreated{}, err
	}
	deadline := r.service.now().Add(r.autoLifecycleLifetime)
	lifecycle, err := r.service.CreateAutoLifecycle(ctx, AutoLifecycle{
		TenantID:             space.TenantID,
		SpaceID:              space.SpaceID,
		DeadlineAt:           deadline,
		CreatorArrivalHandle: arrivalResult.Arrival.ArrivalHandle,
	})
	if err != nil {
		return PublicSpaceCreated{}, err
	}
	deadline = lifecycle.DeadlineAt
	presentation := publicSpacePresentation(space)
	arrivalResponse := r.arrivalResult(space, arrival)
	arrivalResponse.Access = &grant
	return PublicSpaceCreated{
		Presentation:    presentation,
		InviteLink:      inviteLink,
		LifecycleUntil:  deadline,
		Arrival:         arrivalResponse,
		GuestCredential: base64.RawURLEncoding.EncodeToString(arrivalResult.Credential),
	}, nil
}

func (r Runtime) Arrive(ctx context.Context, input PublicInviteArrivalInput) (PublicSpaceArrival, error) {
	name := strings.TrimSpace(input.DisplayName)
	if strings.TrimSpace(input.ArrivalHandle) == "" && name != "" {
		if err := validateDisplayName(name); err != nil {
			return PublicSpaceArrival{}, err
		}
	}
	if input.RequestKey == "" && strings.TrimSpace(input.ArrivalHandle) == "" {
		return PublicSpaceArrival{}, ErrInvalidIdempotencyKey
	}
	if input.RequestKey != "" {
		if err := validateIdempotencyKey(input.RequestKey); err != nil {
			return PublicSpaceArrival{}, err
		}
	}
	if r.service.signer == nil {
		return PublicSpaceArrival{}, ErrInvalidKeyring
	}
	token, err := r.service.signer.Verify(strings.TrimSpace(input.Token))
	if err != nil {
		return PublicSpaceArrival{}, err
	}
	if strings.TrimSpace(input.ArrivalHandle) != "" {
		arrival, authErr := r.authenticateArrival(ctx, input.ArrivalHandle, input.GuestCredential, input.AccountID)
		if authErr != nil {
			return PublicSpaceArrival{}, authErr
		}
		if arrival.InviteGeneration != token.Generation || !bytes.Equal(arrival.InviteHandle, token.Handle) {
			return PublicSpaceArrival{}, ErrInviteUnavailable
		}
		space, spaceErr := r.space.GetPublicSpace(ctx, arrival.TenantID, arrival.SpaceID)
		if spaceErr != nil {
			return PublicSpaceArrival{}, spaceErr
		}
		if space.TenantID != arrival.TenantID || space.SpaceID != arrival.SpaceID {
			return PublicSpaceArrival{}, ErrInviteUnavailable
		}
		if space.Archived && arrival.State != ArrivalAdmitted {
			return PublicSpaceArrival{}, ErrInviteUnavailable
		}
		if arrival.State == ArrivalPending && arrival.IdentityMode == IdentityGuest {
			valid, validationErr := r.pendingGuestArrivalValid(ctx, arrival, space)
			if validationErr != nil {
				return PublicSpaceArrival{}, validationErr
			}
			if !valid {
				arrival, validationErr = r.invalidatePendingArrival(ctx, arrival)
				if validationErr != nil {
					return PublicSpaceArrival{}, validationErr
				}
			}
		}
		result := r.arrivalResult(space, arrival)
		if arrival.State == ArrivalAdmitted {
			grant, refreshErr := r.access.RefreshPublicAccess(ctx, PublicAccessInput{Arrival: arrival})
			if refreshErr != nil {
				return PublicSpaceArrival{}, refreshErr
			}
			if err := validateAccessGrant(grant, arrival); err != nil {
				return PublicSpaceArrival{}, err
			}
			result.Access = &grant
		} else if (arrival.IdentityMode == IdentityAccount || space.AdmissionMode == AdmissionOpen) && arrival.State == ArrivalPending {
			grant, grantErr := r.access.GrantPublicAccess(ctx, PublicAccessInput{Arrival: arrival})
			if grantErr != nil {
				return PublicSpaceArrival{}, grantErr
			}
			if err := validateAccessGrant(grant, arrival); err != nil {
				return PublicSpaceArrival{}, err
			}
			admitted, updateErr := r.service.UpdateArrivalState(ctx, UpdateArrivalStateInput{
				TenantID:              arrival.TenantID,
				ArrivalHandle:         arrival.ArrivalHandle,
				State:                 ArrivalAdmitted,
				EpisodeID:             grant.EpisodeID,
				ParticipantID:         grant.ParticipantID,
				ParticipantGeneration: grant.ParticipantGeneration,
				Provider:              grant.Provider,
				ProviderSubject:       grant.ProviderSubject,
			})
			if updateErr != nil {
				return PublicSpaceArrival{}, updateErr
			}
			result = r.arrivalResult(space, admitted)
			result.Access = &grant
		}
		return result, nil
	}
	invite, _, resolveErr := r.service.ResolveInviteToken(ctx, strings.TrimSpace(input.Token))
	if resolveErr != nil {
		return PublicSpaceArrival{}, resolveErr
	}
	if input.RequestKey == "" {
		return PublicSpaceArrival{}, ErrInvalidIdempotencyKey
	}
	space, err := r.space.GetPublicSpace(ctx, invite.TenantID, invite.SpaceID)
	if err != nil {
		return PublicSpaceArrival{}, err
	}
	if space.TenantID != invite.TenantID || space.SpaceID != invite.SpaceID {
		return PublicSpaceArrival{}, ErrInviteUnavailable
	}
	if space.Archived {
		return PublicSpaceArrival{}, ErrInviteUnavailable
	}
	accountAuthorized, err := r.authorizeAccount(ctx, input.AccountID, invite.TenantID)
	if err != nil {
		return PublicSpaceArrival{}, err
	}
	if space.AdmissionMode == AdmissionMembersOnly && !accountAuthorized {
		return PublicSpaceArrival{}, ErrInviteUnavailable
	}
	identityMode := IdentityGuest
	if accountAuthorized {
		identityMode = IdentityAccount
	}
	arrivalAccountID := utilities.ID{}
	if accountAuthorized {
		arrivalAccountID = input.AccountID
	}
	guestCredential, credentialErr := decodeGuestCredential(input.GuestCredential)
	if credentialErr != nil {
		return PublicSpaceArrival{}, credentialErr
	}
	if identityMode == IdentityGuest && len(guestCredential) == 0 {
		guestCredential, err = r.deriveGuestCredential(token, input.RequestKey)
		if err != nil {
			return PublicSpaceArrival{}, err
		}
	}
	arrivalResult, err := r.service.CreateArrival(ctx, CreateArrivalInput{
		TenantID:         invite.TenantID,
		SpaceID:          invite.SpaceID,
		Invite:           token,
		InviteStateEpoch: invite.StateEpoch,
		IdentityMode:     identityMode,
		AccountID:        arrivalAccountID,
		DisplayName:      name,
		GuestCredential:  guestCredential,
		IdempotencyKey:   input.RequestKey,
	})
	if err != nil {
		return PublicSpaceArrival{}, err
	}
	if identityMode == IdentityGuest && len(arrivalResult.Credential) == 0 {
		arrivalResult.Credential = append([]byte(nil), guestCredential...)
	}
	if accountAuthorized || space.AdmissionMode == AdmissionOpen {
		if arrivalResult.Arrival.State == ArrivalAdmitted {
			grant, refreshErr := r.access.RefreshPublicAccess(ctx, PublicAccessInput{Arrival: arrivalResult.Arrival})
			if refreshErr != nil {
				return PublicSpaceArrival{}, refreshErr
			}
			if err := validateAccessGrant(grant, arrivalResult.Arrival); err != nil {
				return PublicSpaceArrival{}, err
			}
			result := r.arrivalResult(space, arrivalResult.Arrival)
			result.Access = &grant
			result.GuestCredential = base64.RawURLEncoding.EncodeToString(arrivalResult.Credential)
			return result, nil
		}
		if arrivalResult.Arrival.State != ArrivalPending {
			return PublicSpaceArrival{}, ErrArrivalUnavailable
		}
		grant, grantErr := r.access.GrantPublicAccess(ctx, PublicAccessInput{Arrival: arrivalResult.Arrival})
		if grantErr != nil {
			return PublicSpaceArrival{}, grantErr
		}
		if err := validateAccessGrant(grant, arrivalResult.Arrival); err != nil {
			return PublicSpaceArrival{}, err
		}
		admitted, updateErr := r.service.UpdateArrivalState(ctx, UpdateArrivalStateInput{
			TenantID:              invite.TenantID,
			ArrivalHandle:         arrivalResult.Arrival.ArrivalHandle,
			State:                 ArrivalAdmitted,
			EpisodeID:             grant.EpisodeID,
			ParticipantID:         grant.ParticipantID,
			ParticipantGeneration: grant.ParticipantGeneration,
			Provider:              grant.Provider,
			ProviderSubject:       grant.ProviderSubject,
		})
		if updateErr != nil {
			return PublicSpaceArrival{}, updateErr
		}
		result := r.arrivalResult(space, admitted)
		result.Access = &grant
		result.GuestCredential = base64.RawURLEncoding.EncodeToString(arrivalResult.Credential)
		return result, nil
	}
	if space.AdmissionMode == AdmissionKnock {
		request, requestErr := r.service.CreateAdmissionRequest(ctx, CreateAdmissionRequestInput{ArrivalHandle: arrivalResult.Arrival.ArrivalHandle, DisplayName: name})
		if requestErr != nil {
			return PublicSpaceArrival{}, requestErr
		}
		result := r.arrivalResult(space, arrivalResult.Arrival)
		result.RetryAfter = maxRetryAfter(request.ExpiresAt, r.service.now())
		result.GuestCredential = base64.RawURLEncoding.EncodeToString(arrivalResult.Credential)
		return result, nil
	}
	return PublicSpaceArrival{}, ErrInviteUnavailable
}

func (r Runtime) ArrivalStatus(ctx context.Context, input PublicInviteArrivalStatusInput) (PublicSpaceArrival, error) {
	arrival, err := r.authenticateArrival(ctx, input.ArrivalHandle, input.GuestCredential, input.AccountID)
	if err != nil {
		return PublicSpaceArrival{}, err
	}
	space, err := r.space.GetPublicSpace(ctx, arrival.TenantID, arrival.SpaceID)
	if err != nil {
		return PublicSpaceArrival{}, err
	}
	if space.TenantID != arrival.TenantID || space.SpaceID != arrival.SpaceID {
		return PublicSpaceArrival{}, ErrInviteUnavailable
	}
	if arrival.State == ArrivalPending && arrival.IdentityMode == IdentityGuest {
		valid, validationErr := r.pendingGuestArrivalValid(ctx, arrival, space)
		if validationErr != nil {
			return PublicSpaceArrival{}, validationErr
		}
		if !valid {
			arrival, validationErr = r.invalidatePendingArrival(ctx, arrival)
			if validationErr != nil {
				return PublicSpaceArrival{}, validationErr
			}
		}
	}
	return r.arrivalResult(space, arrival), nil
}

func (r Runtime) pendingGuestArrivalValid(ctx context.Context, arrival Arrival, space PublicSpace) (bool, error) {
	if (!arrival.ExpiresAt.IsZero() && !arrival.ExpiresAt.After(r.service.now())) || space.Archived || space.AdmissionMode != AdmissionKnock {
		return false, nil
	}
	if len(arrival.InviteHandle) == 0 {
		return true, nil
	}
	invite, err := r.service.repository.GetInviteByHandle(ctx, arrival.InviteHandle)
	if errors.Is(err, ErrInviteNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if err := validateInvite(invite); err != nil || !invite.Enabled || invite.TenantID != arrival.TenantID || invite.SpaceID != arrival.SpaceID || invite.Generation != arrival.InviteGeneration || invite.StateEpoch != arrival.InviteStateEpoch || !bytes.Equal(invite.Handle, arrival.InviteHandle) {
		return false, nil
	}
	return true, nil
}

func (r Runtime) invalidatePendingArrival(ctx context.Context, arrival Arrival) (Arrival, error) {
	updated, err := r.service.UpdateArrivalState(ctx, UpdateArrivalStateInput{
		TenantID: arrival.TenantID, ArrivalHandle: arrival.ArrivalHandle,
		State: ArrivalUnavailable, Reason: "public_arrival_invalidated",
	})
	if err != nil {
		return Arrival{}, err
	}
	return updated, nil
}

func (r Runtime) Status(ctx context.Context, input PublicInviteArrivalStatusInput) (PublicSpaceArrival, error) {
	return r.ArrivalStatus(ctx, input)
}

func (r Runtime) RefreshAccess(ctx context.Context, input PublicInviteRefreshInput) (PublicAccessGrant, error) {
	arrival, err := r.authenticateArrival(ctx, input.ArrivalHandle, input.GuestCredential, input.AccountID)
	if err != nil {
		return PublicAccessGrant{}, err
	}
	if arrival.State != ArrivalAdmitted {
		return PublicAccessGrant{}, ErrArrivalUnavailable
	}
	grant, err := r.access.RefreshPublicAccess(ctx, PublicAccessInput{Arrival: arrival, MediaProof: input.MediaProof, ReplaceMediaConnection: input.ReplaceMediaConnection})
	if err != nil {
		return PublicAccessGrant{}, err
	}
	if err := validateAccessGrant(grant, arrival); err != nil {
		return PublicAccessGrant{}, err
	}
	if input.ReplaceMediaConnection {
		if _, err := r.service.UpdateArrivalState(ctx, UpdateArrivalStateInput{
			TenantID:                arrival.TenantID,
			ArrivalHandle:           arrival.ArrivalHandle,
			State:                   ArrivalAdmitted,
			EpisodeID:               grant.EpisodeID,
			ParticipantID:           grant.ParticipantID,
			ParticipantGeneration:   grant.ParticipantGeneration,
			Provider:                grant.Provider,
			ProviderSubject:         grant.ProviderSubject,
			MatchProviderBinding:    true,
			ExpectedProvider:        arrival.Provider,
			ExpectedProviderSubject: arrival.ProviderSubject,
		}); err != nil {
			_ = r.access.DiscardPublicAccess(ctx, grant)
			return PublicAccessGrant{}, err
		}
		r.discardSupersededPublicAccess(ctx, arrival, grant)
	}
	return grant, nil
}

func (r Runtime) discardSupersededPublicAccess(ctx context.Context, arrival Arrival, grant PublicAccessGrant) {
	if arrival.Provider == grant.Provider && arrival.ProviderSubject == grant.ProviderSubject {
		return
	}
	previous := grant
	previous.Provider = arrival.Provider
	previous.ProviderSubject = arrival.ProviderSubject
	_ = r.access.DiscardPublicAccess(ctx, previous)
}

func (r Runtime) Refresh(ctx context.Context, input PublicInviteRefreshInput) (PublicAccessGrant, error) {
	return r.RefreshAccess(ctx, input)
}

func (r Runtime) Leave(ctx context.Context, input PublicInviteLeaveInput) error {
	arrival, err := r.authenticateArrival(ctx, input.ArrivalHandle, input.GuestCredential, input.AccountID)
	if err != nil {
		return err
	}
	if arrival.State != ArrivalAdmitted {
		return ErrArrivalUnavailable
	}
	if err := r.access.RevokePublicAccess(ctx, PublicAccessInput{Arrival: arrival}); err != nil {
		return err
	}
	_, err = r.service.UpdateArrivalState(ctx, UpdateArrivalStateInput{
		TenantID:              arrival.TenantID,
		ArrivalHandle:         arrival.ArrivalHandle,
		State:                 ArrivalLeft,
		Reason:                "left",
		EpisodeID:             arrival.EpisodeID,
		ParticipantID:         arrival.ParticipantID,
		ParticipantGeneration: arrival.ParticipantGeneration,
		Provider:              arrival.Provider,
		ProviderSubject:       arrival.ProviderSubject,
	})
	return err
}

func (r Runtime) authenticateArrival(ctx context.Context, rawHandle, credential string, accountID utilities.ID) (Arrival, error) {
	handle, err := utilities.ParseID(strings.TrimSpace(rawHandle))
	if err != nil {
		return Arrival{}, ErrArrivalNotFound
	}
	arrival, getErr := r.service.GetArrival(ctx, handle)
	if getErr != nil {
		return Arrival{}, getErr
	}
	if !accountID.IsZero() {
		authorized, authErr := r.authorizeAccount(ctx, accountID, arrival.TenantID)
		if authErr != nil {
			return Arrival{}, authErr
		}
		if authorized {
			if arrival.IdentityMode != IdentityAccount || arrival.AccountID != accountID {
				return Arrival{}, ErrCredentialMismatch
			}
			return arrival, nil
		}
	}
	credentialBytes, credentialErr := decodeGuestCredential(credential)
	if credentialErr != nil {
		return Arrival{}, credentialErr
	}
	return r.service.GetArrivalForCredential(ctx, handle, credentialBytes)
}

func (r Runtime) authorizeAccount(ctx context.Context, accountID, tenantID utilities.ID) (bool, error) {
	if accountID.IsZero() {
		return false, nil
	}
	return r.accounts.AuthorizePublicAccount(ctx, accountID, tenantID)
}

func (r Runtime) managedInvite(ctx context.Context, invite Invite) (ManagedInvite, error) {
	if err := validateInvite(invite); err != nil {
		return ManagedInvite{}, err
	}
	token, err := r.service.IssueInviteToken(invite)
	if err != nil {
		return ManagedInvite{}, err
	}
	space, err := r.space.GetPublicSpace(ctx, invite.TenantID, invite.SpaceID)
	if err != nil {
		return ManagedInvite{}, err
	}
	if err := validatePublicSpace(space); err != nil {
		return ManagedInvite{}, err
	}
	if space.TenantID != invite.TenantID || space.SpaceID != invite.SpaceID {
		return ManagedInvite{}, ErrInviteUnavailable
	}
	canonicalURL, err := r.links.SpaceInviteURL(space.Slug, token)
	if err != nil {
		return ManagedInvite{}, err
	}
	return ManagedInvite{Invite: invite, CanonicalURL: canonicalURL}, nil
}

func (r Runtime) arrivalResult(space PublicSpace, arrival Arrival) PublicSpaceArrival {
	result := PublicSpaceArrival{
		State:         arrival.State,
		Identity:      arrival.IdentityMode,
		ArrivalHandle: arrival.ArrivalHandle.String(),
	}
	presentation := publicSpacePresentation(space)
	result.Presentation = &presentation
	return result
}

func publicSpacePresentation(space PublicSpace) PublicSpacePresentation {
	return PublicSpacePresentation{Name: space.Name, Slug: space.Slug, AdmissionMode: space.AdmissionMode}
}

func validateAccessGrant(grant PublicAccessGrant, arrival Arrival) error {
	if grant.TenantID != arrival.TenantID || grant.SpaceID != arrival.SpaceID || grant.EpisodeID.IsZero() || grant.ParticipantID.IsZero() || grant.ParticipantGeneration <= 0 {
		return ErrArrivalUnavailable
	}
	if err := validateProviderBinding(grant.Provider, grant.ProviderSubject, true); err != nil {
		return err
	}
	if err := validateClientPayload(grant); err != nil {
		return err
	}
	return nil
}

func validateClientPayload(grant PublicAccessGrant) error {
	payload := grant.ClientPayload
	switch grant.Provider {
	case PublicProviderCloudflareSFU:
		if !validClientPayloadField(payload.ConnectionID) || !validClientPayloadField(payload.StunServer) || payload.ProviderSubject != "" || payload.Token != "" {
			return ErrInvalidArrival
		}
	case PublicProviderCloudflareRTK:
		if !validClientPayloadField(payload.ProviderSubject) || payload.ProviderSubject != grant.ProviderSubject || !validClientPayloadField(payload.Token) || payload.ConnectionID != "" || payload.StunServer != "" {
			return ErrInvalidArrival
		}
	default:
		return ErrInvalidArrival
	}
	return nil
}

func validClientPayloadField(value string) bool {
	return value != "" && len(value) <= MaxClientPayloadFieldBytes && isASCII(value)
}

func validatePublicSpace(space PublicSpace) error {
	if space.TenantID.IsZero() || space.SpaceID.IsZero() || !space.AdmissionMode.valid() {
		return ErrInvalidInvite
	}
	if strings.TrimSpace(space.Name) == "" || strings.TrimSpace(space.Slug) == "" || !isASCII(space.Name) || !isASCII(space.Slug) {
		return ErrInvalidInvite
	}
	return nil
}

func validErrorFamily(value string) bool {
	if len(value) == 0 || len(value) > MaxLifecycleErrorFamilySize || !isASCII(value) {
		return false
	}
	for _, character := range value {
		if (character < 'A' || character > 'Z') &&
			(character < 'a' || character > 'z') &&
			(character < '0' || character > '9') && character != '_' && character != '-' && character != '.' {
			return false
		}
	}
	return true
}

func maxRetryAfter(deadline, now time.Time) int {
	remaining := deadline.Sub(now)
	if remaining <= 0 {
		return 0
	}
	return int((remaining + time.Second - 1) / time.Second)
}

func decodeGuestCredential(value string) ([]byte, error) {
	if value == "" {
		return nil, nil
	}
	if decoded, err := base64.RawURLEncoding.DecodeString(value); err == nil && len(decoded) >= 16 && len(decoded) <= 256 {
		return decoded, nil
	}
	return []byte(value), nil
}
