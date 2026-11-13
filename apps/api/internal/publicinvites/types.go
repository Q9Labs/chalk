package publicinvites

import (
	"errors"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	ErrInvalidTenantID          = errors.New("invalid public invite tenant id")
	ErrInvalidSpaceID           = errors.New("invalid public invite space id")
	ErrInvalidAccountID         = errors.New("invalid public invite account id")
	ErrInvalidInvite            = errors.New("invalid public invite")
	ErrInviteNotFound           = errors.New("public invite not found")
	ErrInviteCodeTaken          = errors.New("public invite code taken")
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
	PublicProviderCloudflareSFU = "cloudflare_sfu"
	PublicProviderChalkSFU      = "chalk_sfu"

	ProviderCloudflareSFU = PublicProviderCloudflareSFU
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
