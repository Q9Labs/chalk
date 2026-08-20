package episodes

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"strings"
	"unicode/utf8"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// PublicJoinRepository owns the capability-invite boundary. A public join
// resolves the exact Tenant and Space, then creates or reuses the live
// Episode and its Participant in one transaction.
type PublicJoinRepository interface {
	JoinPublic(context.Context, PublicJoinInput) (PublicJoinResult, error)
	FindPublic(context.Context, PublicAccessInput) (PublicJoinResult, error)
	LeavePublic(context.Context, PublicLeaveInput) (PublicLeaveResult, error)
	WaitPublicParticipantReady(context.Context, PublicParticipantKey) (PublicJoinResult, error)
}

type PublicJoinInput struct {
	TenantID     utilities.ID
	SpaceID      utilities.ID
	AccountID    utilities.ID
	IdentityMode string
	DisplayName  string
	Role         string
	Request      Request
}

type PublicAccessInput struct {
	TenantID              utilities.ID
	SpaceID               utilities.ID
	EpisodeID             utilities.ID
	ParticipantID         utilities.ID
	ParticipantGeneration int64
	AccountID             utilities.ID
	IdentityMode          string
}

type PublicParticipantKey struct {
	TenantID              utilities.ID
	SpaceID               utilities.ID
	EpisodeID             utilities.ID
	ParticipantID         utilities.ID
	ParticipantGeneration int64
}

type PublicLeaveInput struct {
	TenantID              utilities.ID
	SpaceID               utilities.ID
	EpisodeID             utilities.ID
	ParticipantID         utilities.ID
	ParticipantGeneration int64
	Request               Request
}

type PublicJoinResult struct {
	Episode        Episode
	Participant    Participant
	Intent         Intent
	EpisodeCreated bool
}

type PublicLeaveResult struct {
	Episode     Episode
	Participant Participant
	Intent      Intent
	Removed     bool
}

func preparePublicJoinInput(input *PublicJoinInput) error {
	if input.TenantID.IsZero() {
		return ErrInvalidTenantID
	}
	if input.SpaceID.IsZero() {
		return ErrInvalidSpaceID
	}
	if input.IdentityMode != "account" && input.IdentityMode != "guest" {
		return ErrInvalidIdentityMode
	}
	if input.IdentityMode == "account" && input.AccountID.IsZero() {
		return ErrInvalidAccountID
	}
	if input.IdentityMode == "guest" && !input.AccountID.IsZero() {
		return ErrInvalidAccountID
	}
	input.DisplayName = strings.TrimSpace(input.DisplayName)
	if input.DisplayName == "" || !utf8.ValidString(input.DisplayName) || len(input.DisplayName) > MaximumParticipantNameBytes {
		return ErrInvalidParticipantName
	}
	input.Role = strings.TrimSpace(input.Role)
	if input.Role == "" || !utf8.ValidString(input.Role) || len(input.Role) > 128 {
		return ErrInvalidRole
	}
	if err := prepareRequest(&input.Request, nil); err != nil {
		return err
	}
	if input.Request.Fingerprint == ([32]byte{}) {
		input.Request.Fingerprint = publicJoinFingerprint(input)
	}
	return nil
}

func preparePublicAccessInput(input *PublicAccessInput) error {
	if err := validateTenantSpaceEpisodeIDs(input.TenantID, input.SpaceID, input.EpisodeID); err != nil {
		return err
	}
	if input.ParticipantID.IsZero() {
		return ErrInvalidParticipantID
	}
	if input.ParticipantGeneration <= 0 {
		return ErrInvalidParticipantGeneration
	}
	if input.IdentityMode != "account" && input.IdentityMode != "guest" {
		return ErrInvalidIdentityMode
	}
	if input.IdentityMode == "account" && input.AccountID.IsZero() {
		return ErrInvalidAccountID
	}
	if input.IdentityMode == "guest" && !input.AccountID.IsZero() {
		return ErrInvalidAccountID
	}
	return nil
}

func preparePublicLeaveInput(input *PublicLeaveInput) error {
	if err := validateTenantSpaceEpisodeIDs(input.TenantID, input.SpaceID, input.EpisodeID); err != nil {
		return err
	}
	if input.ParticipantID.IsZero() {
		return ErrInvalidParticipantID
	}
	if input.ParticipantGeneration <= 0 {
		return ErrInvalidParticipantGeneration
	}
	if err := prepareRequest(&input.Request, json.RawMessage(`{}`)); err != nil {
		return err
	}
	if input.Request.Fingerprint == ([32]byte{}) {
		input.Request.Fingerprint = publicLeaveFingerprint(input)
	}
	return nil
}

func validatePublicParticipantKey(input PublicParticipantKey) error {
	if err := validateTenantSpaceEpisodeIDs(input.TenantID, input.SpaceID, input.EpisodeID); err != nil {
		return err
	}
	if input.ParticipantID.IsZero() {
		return ErrInvalidParticipantID
	}
	if input.ParticipantGeneration <= 0 {
		return ErrInvalidParticipantGeneration
	}
	return nil
}

func publicJoinFingerprint(input *PublicJoinInput) [32]byte {
	value := struct {
		TenantID     string `json:"tenant_id"`
		SpaceID      string `json:"space_id"`
		AccountID    string `json:"account_id,omitempty"`
		IdentityMode string `json:"identity_mode"`
		DisplayName  string `json:"display_name"`
		Role         string `json:"role"`
	}{
		TenantID: input.TenantID.String(), SpaceID: input.SpaceID.String(), AccountID: input.AccountID.String(),
		IdentityMode: input.IdentityMode, DisplayName: input.DisplayName, Role: input.Role,
	}
	payload, _ := json.Marshal(value)
	return sha256.Sum256(payload)
}

func publicLeaveFingerprint(input *PublicLeaveInput) [32]byte {
	value := struct {
		TenantID              string `json:"tenant_id"`
		SpaceID               string `json:"space_id"`
		EpisodeID             string `json:"episode_id"`
		ParticipantID         string `json:"participant_id"`
		ParticipantGeneration int64  `json:"participant_generation"`
	}{
		TenantID: input.TenantID.String(), SpaceID: input.SpaceID.String(), EpisodeID: input.EpisodeID.String(),
		ParticipantID: input.ParticipantID.String(), ParticipantGeneration: input.ParticipantGeneration,
	}
	payload, _ := json.Marshal(value)
	return sha256.Sum256(payload)
}
