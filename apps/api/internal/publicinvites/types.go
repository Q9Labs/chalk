package publicinvites

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	ErrInvalidTenantID          = errors.New("invalid public invite tenant id")
	ErrInvalidSpaceID           = errors.New("invalid public invite space id")
	ErrInvalidAccountID         = errors.New("invalid public invite account id")
	ErrInvalidInvite            = errors.New("invalid public invite")
	ErrInviteNotFound           = errors.New("public invite not found")
	ErrInviteUnavailable        = errors.New("public invite unavailable")
	ErrInvalidPublicRole        = errors.New("invalid public invite role")
	ErrInvalidAdmissionMode     = errors.New("invalid public invite admission mode")
	ErrInvalidIdentityMode      = errors.New("invalid public arrival identity mode")
	ErrInvalidArrival           = errors.New("invalid public arrival")
	ErrInvalidIdempotencyKey    = errors.New("invalid public arrival idempotency key")
	ErrIdempotencyConflict      = errors.New("public arrival idempotency conflict")
	ErrArrivalNotFound          = errors.New("public arrival not found")
	ErrArrivalUnavailable       = errors.New("public arrival unavailable")
	ErrInvalidCredential        = errors.New("invalid guest credential")
	ErrCredentialMismatch       = errors.New("guest credential mismatch")
	ErrInvalidAdmissionRequest  = errors.New("invalid admission request")
	ErrAdmissionRequestNotFound = errors.New("admission request not found")
	ErrAdmissionRequestTerminal = errors.New("admission request is terminal")
	ErrInvalidAdmissionDecision = errors.New("invalid admission decision")
	ErrAutoLifecycleNotFound    = errors.New("auto space lifecycle not found")
	ErrInvalidLifecycleState    = errors.New("invalid auto space lifecycle state")
	ErrLifecycleUnavailable     = errors.New("auto space lifecycle port unavailable")
	ErrSpaceUnavailable         = errors.New("public Space port unavailable")
	ErrLinksUnavailable         = errors.New("public invite links port unavailable")
	ErrAccessUnavailable        = errors.New("public access port unavailable")
	ErrMediaProofExpired        = errors.New("public media proof expired")
	ErrMediaProofRejected       = errors.New("public media proof rejected")
	ErrAccountsUnavailable      = errors.New("public account port unavailable")
)

var ErrInvalidRequestKey = ErrInvalidIdempotencyKey

const (
	PublicRoleCollaborator = "collaborator"

	DefaultArrivalLifetime   = 15 * time.Minute
	AdmissionRequestLifetime = 5 * time.Minute

	MinIdempotencyKeyBytes       = 16
	MaxIdempotencyKeyBytes       = 128
	MaxCredentialFamilyBytes     = 256
	MaxDisplayNameBytes          = 256
	MaxProviderBytes             = 128
	MaxProviderSubjectBytes      = 256
	MaxClientPayloadFieldBytes   = 4096
	MaxLifecycleErrorFamilySize  = 64
	DefaultAutoLifecycleLifetime = time.Hour
)

const (
	PublicProviderCloudflareRTK = "cloudflare_rtk"
	PublicProviderCloudflareSFU = "cloudflare_sfu"
	ProviderCloudflareRTK       = PublicProviderCloudflareRTK
	ProviderCloudflareSFU       = PublicProviderCloudflareSFU
)

type AdmissionMode string

const (
	AdmissionOpen        AdmissionMode = "open"
	AdmissionKnock       AdmissionMode = "knock"
	AdmissionMembersOnly AdmissionMode = "members_only"
)

func (m AdmissionMode) valid() bool {
	return m == AdmissionOpen || m == AdmissionKnock || m == AdmissionMembersOnly
}

type IdentityMode string

const (
	IdentityAccount IdentityMode = "account"
	IdentityGuest   IdentityMode = "guest"
)

type Invite struct {
	TenantID      utilities.ID
	SpaceID       utilities.ID
	Handle        []byte
	Generation    uint64
	StateEpoch    uint64
	Enabled       bool
	PublicRole    string
	AdmissionMode AdmissionMode
	CreatedAt     time.Time
	UpdatedAt     time.Time
	RotatedAt     time.Time
	DisabledAt    *time.Time
	LastActorID   utilities.ID
}

type ArrivalState string

const (
	ArrivalPending     ArrivalState = "pending"
	ArrivalAdmitted    ArrivalState = "admitted"
	ArrivalRejected    ArrivalState = "rejected"
	ArrivalLeft        ArrivalState = "left"
	ArrivalUnavailable ArrivalState = "unavailable"
)

func (state ArrivalState) valid() bool {
	switch state {
	case ArrivalPending, ArrivalAdmitted, ArrivalRejected, ArrivalLeft, ArrivalUnavailable:
		return true
	default:
		return false
	}
}

type Arrival struct {
	ArrivalHandle          utilities.ID
	TenantID               utilities.ID
	SpaceID                utilities.ID
	InviteHandle           []byte
	InviteGeneration       uint64
	InviteStateEpoch       uint64
	IdentityMode           IdentityMode
	GuestCredentialHash    []byte
	AccountID              utilities.ID
	DisplayName            string
	CredentialFamily       string
	IdempotencyKey         string
	IdempotencyFingerprint [32]byte
	State                  ArrivalState
	EpisodeID              utilities.ID
	ParticipantID          utilities.ID
	ParticipantGeneration  int64
	Provider               string
	ProviderSubject        string
	ExpiresAt              time.Time
	TerminalReason         string
	CreatedAt              time.Time
	UpdatedAt              time.Time
	TerminalAt             *time.Time
}

type AdmissionRequestState string

const (
	AdmissionRequestPending     AdmissionRequestState = "pending"
	AdmissionRequestApproved    AdmissionRequestState = "approved"
	AdmissionRequestDenied      AdmissionRequestState = "denied"
	AdmissionRequestExpired     AdmissionRequestState = "expired"
	AdmissionRequestInvalidated AdmissionRequestState = "invalidated"
)

type AdmissionRequest struct {
	RequestHandle utilities.ID
	ArrivalHandle utilities.ID
	TenantID      utilities.ID
	SpaceID       utilities.ID
	DisplayName   string
	State         AdmissionRequestState
	RequestedAt   time.Time
	ExpiresAt     time.Time
	DecidedAt     *time.Time
	DecidedBy     utilities.ID
}

type AdmissionDecision string

const (
	DecisionApprove AdmissionDecision = "approve"
	DecisionDeny    AdmissionDecision = "deny"
)

func (decision AdmissionDecision) valid() bool {
	return decision == DecisionApprove || decision == DecisionDeny
}

type AutoLifecycleState string

const (
	AutoLifecycleActive    AutoLifecycleState = "active"
	AutoLifecycleArchiving AutoLifecycleState = "archiving"
	AutoLifecycleArchived  AutoLifecycleState = "archived"
)

type AutoLifecycle struct {
	TenantID             utilities.ID
	SpaceID              utilities.ID
	DeadlineAt           time.Time
	CreatorArrivalHandle utilities.ID
	State                AutoLifecycleState
	NextRetryAt          *time.Time
	RetryCount           int32
	LastErrorFamily      string
	ArchiveCompletedAt   *time.Time
	JourneyID            utilities.ID
	CreatedAt            time.Time
	UpdatedAt            time.Time
}

type RetryAutoLifecycleInput struct {
	TenantID    utilities.ID
	SpaceID     utilities.ID
	NextRetryAt time.Time
	ErrorFamily string
}

type CreateArrivalInput struct {
	TenantID         utilities.ID
	SpaceID          utilities.ID
	Invite           Token
	InviteStateEpoch uint64
	IdentityMode     IdentityMode
	AccountID        utilities.ID
	DisplayName      string
	GuestCredential  []byte
	CredentialFamily string
	IdempotencyKey   string
	ExpiresAt        time.Time
}

type CreateArrivalResult struct {
	Arrival    Arrival
	Credential []byte
}

type UpdateArrivalStateInput struct {
	TenantID                utilities.ID
	ArrivalHandle           utilities.ID
	State                   ArrivalState
	Reason                  string
	EpisodeID               utilities.ID
	ParticipantID           utilities.ID
	ParticipantGeneration   int64
	Provider                string
	ProviderSubject         string
	MatchProviderBinding    bool
	ExpectedProvider        string
	ExpectedProviderSubject string
}

type CreateAdmissionRequestInput struct {
	ArrivalHandle utilities.ID
	DisplayName   string
	ExpiresAt     time.Time
}

type DecideAdmissionRequestInput struct {
	TenantID      utilities.ID
	SpaceID       utilities.ID
	RequestHandle utilities.ID
	Decision      AdmissionDecision
	ActorID       utilities.ID
	RequestKey    string
}

// PublicSpace is the minimum Space projection required by the public runtime.
// Space adapters can carry richer fields without leaking them into this
// package.
type PublicSpace struct {
	TenantID      utilities.ID
	SpaceID       utilities.ID
	Name          string
	Slug          string
	AdmissionMode AdmissionMode
	Archived      bool
}

type ManagedInvite struct {
	Invite
	CanonicalURL string
}

// Space is the application boundary for creating and reading Spaces. The
// public-invites domain does not depend on a concrete Space implementation.
type Space interface {
	CreatePublicSpace(context.Context, CreatePublicSpaceInput) (PublicSpace, error)
	GetPublicSpace(context.Context, utilities.ID, utilities.ID) (PublicSpace, error)
}

type Links interface {
	SpaceInviteURL(string, string) (string, error)
}

// Access is the application boundary for issuing and revoking grants after an
// arrival has been admitted. Access tokens and provider details stay at this
// port rather than in the public-invites domain.
type Access interface {
	GrantPublicAccess(context.Context, PublicAccessInput) (PublicAccessGrant, error)
	RefreshPublicAccess(context.Context, PublicAccessInput) (PublicAccessGrant, error)
	RevokePublicAccess(context.Context, PublicAccessInput) error
	DiscardPublicAccess(context.Context, PublicAccessGrant) error
}

// Accounts authorizes a presented account capability for a tenant after the
// invite capability has resolved that tenant. A false result means the
// account is missing or forbidden and must be treated as a guest arrival;
// non-nil errors are operational failures and must propagate.
type Accounts interface {
	AuthorizePublicAccount(context.Context, utilities.ID, utilities.ID) (bool, error)
}

// Port aliases make the dependency direction explicit at composition seams
// while keeping the short domain names convenient inside this package.
type SpacePort = Space
type LifecyclePort = Lifecycle
type AccessPort = Access
type AccountsPort = Accounts

type PublicAccessInput struct {
	Arrival                Arrival
	MediaProof             string
	ReplaceMediaConnection bool
}

// PublicSpaceCreated is the result of creating an auto-lifecycle public Space.
type PublicSpaceCreated struct {
	Presentation   PublicSpacePresentation
	InviteLink     string
	LifecycleUntil time.Time
	Arrival        PublicSpaceArrival
	// GuestCredential is recoverable on an idempotent replay when the first
	// response was lost.
	GuestCredential string
}

type PublicSpacePresentation struct {
	Name          string
	Slug          string
	AdmissionMode AdmissionMode
}

type PublicSpaceArrival struct {
	State           ArrivalState
	Presentation    *PublicSpacePresentation
	Identity        IdentityMode
	ArrivalHandle   string
	RetryAfter      int
	Access          *PublicAccessGrant
	GuestCredential string
}

type PublicAccessGrant struct {
	SyncToken             string
	MediaToken            string
	ExpiresAt             time.Time
	TenantID              utilities.ID
	SpaceID               utilities.ID
	EpisodeID             utilities.ID
	ParticipantID         utilities.ID
	ParticipantGeneration int64
	Provider              string
	ProviderSubject       string
	ClientPayload         PublicAccessClientPayload
	Diagnostics           *PublicAccessDiagnostics
}

type PublicAccessDiagnostics struct {
	Token      string
	ExpiresAt  time.Time
	Generation int64
	IntakePath string
}

// PublicAccessClientPayload is returned to the client but is never part of an
// Arrival or UpdateArrivalStateInput. Its fields are provider-specific: SFU
// uses ConnectionID and StunServer, while RTK uses ProviderSubject and Token.
type PublicAccessClientPayload struct {
	ConnectionID    string
	StunServer      string
	ProviderSubject string
	Token           string
}

// Compatibility aliases keep the public application seam readable at HTTP
// composition points while the domain uses its shorter core names internally.
type SpacePublicInvite = ManagedInvite
type PublicAdmissionRequestPage = AdmissionRequestPage
type CreatePublicSpaceResult = PublicSpaceCreated
type PublicInviteArrivalResult = PublicSpaceArrival

type UpdateSpacePublicInviteInput struct {
	TenantID utilities.ID
	SpaceID  utilities.ID
	Enabled  bool
	ActorID  utilities.ID
}

type RotateSpacePublicInviteInput struct {
	TenantID   utilities.ID
	SpaceID    utilities.ID
	ActorID    utilities.ID
	RequestKey string
}

type ListPublicAdmissionRequestsInput struct {
	TenantID utilities.ID
	SpaceID  utilities.ID
	State    string
	PageSize int32
}

type AdmissionRequestPage struct {
	Requests []AdmissionRequest
}

type DecidePublicAdmissionRequestInput struct {
	TenantID      utilities.ID
	SpaceID       utilities.ID
	RequestHandle string
	RequestKey    string
	ActorID       utilities.ID
}

type CreatePublicSpaceInput struct {
	DisplayName string
	RequestKey  string
	Native      bool
}

type PublicInviteArrivalInput struct {
	Token         string
	DisplayName   string
	RequestKey    string
	ArrivalHandle string
	// GuestCredential is optional for a new guest arrival. Runtime derives a
	// server-bound credential from the invite and request key when it is absent.
	GuestCredential   string
	AccountID         utilities.ID
	AccountAuthorized bool
	Native            bool
}

type PublicInviteArrivalStatusInput struct {
	ArrivalHandle   string
	GuestCredential string
	AccountID       utilities.ID
	Native          bool
}

type PublicInviteRefreshInput struct {
	ArrivalHandle          string
	GuestCredential        string
	AccountID              utilities.ID
	Native                 bool
	MediaProof             string
	ReplaceMediaConnection bool
}

type PublicInviteLeaveInput struct {
	ArrivalHandle   string
	GuestCredential string
	AccountID       utilities.ID
	Native          bool
}

func validateIDs(tenantID, spaceID utilities.ID) error {
	if tenantID.IsZero() {
		return ErrInvalidTenantID
	}
	if spaceID.IsZero() {
		return ErrInvalidSpaceID
	}
	return nil
}

func validateInvite(invite Invite) error {
	if err := validateIDs(invite.TenantID, invite.SpaceID); err != nil {
		return err
	}
	if len(invite.Handle) != HandleBytes {
		return ErrInvalidHandle
	}
	if invite.Generation == 0 || invite.StateEpoch == 0 {
		return ErrInvalidGeneration
	}
	if invite.PublicRole != PublicRoleCollaborator {
		return ErrInvalidPublicRole
	}
	if !invite.AdmissionMode.valid() {
		return ErrInvalidAdmissionMode
	}
	return nil
}

func validateIdempotencyKey(key string) error {
	if len(key) < MinIdempotencyKeyBytes || len(key) > MaxIdempotencyKeyBytes || !isASCII(key) {
		return ErrInvalidIdempotencyKey
	}
	for _, character := range key {
		if (character < 'A' || character > 'Z') &&
			(character < 'a' || character > 'z') &&
			(character < '0' || character > '9') && character != '_' && character != '-' {
			return ErrInvalidIdempotencyKey
		}
	}
	return nil
}

func validateDisplayName(name string) error {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > MaxDisplayNameBytes || !isASCII(name) {
		return ErrInvalidAdmissionRequest
	}
	return nil
}

func validateProviderBinding(provider, subject string, required bool) error {
	if provider == "" || subject == "" {
		if required || provider != "" || subject != "" {
			return ErrInvalidArrival
		}
		return nil
	}
	if len(provider) > MaxProviderBytes || len(subject) > MaxProviderSubjectBytes || !isASCII(provider) || !isASCII(subject) {
		return ErrInvalidArrival
	}
	return nil
}

func arrivalFingerprint(input CreateArrivalInput, credentialHash []byte) ([32]byte, error) {
	canonical := struct {
		TenantID         string       `json:"tenant_id"`
		SpaceID          string       `json:"space_id"`
		InviteHandle     string       `json:"invite_handle"`
		InviteGeneration uint64       `json:"invite_generation"`
		InviteStateEpoch uint64       `json:"invite_state_epoch"`
		IdentityMode     IdentityMode `json:"identity_mode"`
		AccountID        string       `json:"account_id,omitempty"`
		DisplayName      string       `json:"display_name"`
		CredentialHash   []byte       `json:"credential_hash,omitempty"`
		CredentialFamily string       `json:"credential_family,omitempty"`
	}{
		TenantID:         input.TenantID.String(),
		SpaceID:          input.SpaceID.String(),
		InviteHandle:     fmt.Sprintf("%x", input.Invite.Handle),
		InviteGeneration: input.Invite.Generation,
		InviteStateEpoch: input.InviteStateEpoch,
		IdentityMode:     input.IdentityMode,
		AccountID:        input.AccountID.String(),
		DisplayName:      input.DisplayName,
		CredentialHash:   credentialHash,
		CredentialFamily: input.CredentialFamily,
	}
	encoded, err := json.Marshal(canonical)
	if err != nil {
		return [32]byte{}, fmt.Errorf("marshal public arrival fingerprint: %w", err)
	}
	return sha256.Sum256(encoded), nil
}
