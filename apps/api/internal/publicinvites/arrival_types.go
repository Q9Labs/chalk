package publicinvites

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

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
	RequirePending          bool
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
