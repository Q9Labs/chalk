package episodes

import (
	"crypto/sha256"
	"encoding/json"
	"strings"
	"unicode/utf8"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const selfJoinFingerprintVersion = "dashboard-space-self/v1"

type selfJoinFingerprintInput struct {
	Version     string `json:"version"`
	TenantID    string `json:"tenant_id"`
	AccountID   string `json:"account_id"`
	SpaceSlug   string `json:"space_slug"`
	DisplayName string `json:"display_name"`
}

func prepareSelfJoinInput(input *SelfJoinInput) error {
	if input.TenantID.IsZero() {
		return ErrInvalidTenantID
	}
	if input.AccountID.IsZero() {
		return ErrInvalidAccountID
	}
	slug, err := requiredSelfValue(input.SpaceSlug, 128)
	if err != nil {
		return ErrInvalidSpaceSlug
	}
	input.SpaceSlug = slug
	name, err := requiredSelfValue(input.DisplayName, MaximumParticipantNameBytes)
	if err != nil {
		return ErrInvalidParticipantName
	}
	input.DisplayName = name
	if err := prepareRequest(&input.Request, json.RawMessage(`{}`)); err != nil {
		return err
	}
	input.Request.Fingerprint = selfJoinFingerprint(selfJoinFingerprintInput{
		Version: selfJoinFingerprintVersion, TenantID: input.TenantID.String(), AccountID: input.AccountID.String(),
		SpaceSlug: input.SpaceSlug, DisplayName: input.DisplayName,
	})
	return nil
}

func prepareSelfAccessInput(input *SelfAccessInput) error {
	if input.TenantID.IsZero() {
		return ErrInvalidTenantID
	}
	if input.AccountID.IsZero() {
		return ErrInvalidAccountID
	}
	slug, err := requiredSelfValue(input.SpaceSlug, 128)
	if err != nil {
		return ErrInvalidSpaceSlug
	}
	input.SpaceSlug = slug
	return nil
}

func prepareSelfLeaveInput(input *SelfLeaveInput) error {
	if input.TenantID.IsZero() {
		return ErrInvalidTenantID
	}
	if input.AccountID.IsZero() {
		return ErrInvalidAccountID
	}
	slug, err := requiredSelfValue(input.SpaceSlug, 128)
	if err != nil {
		return ErrInvalidSpaceSlug
	}
	input.SpaceSlug = slug
	if input.ParticipantGeneration < 0 {
		return ErrInvalidParticipantGeneration
	}
	if err := prepareRequest(&input.Request, json.RawMessage(`{}`)); err != nil {
		return err
	}
	// Leave retries are participant-scoped and intentionally independent of the
	// generation echoed by a stale browser grant. The repository still checks a
	// supplied positive generation against the current participant.
	input.Request.Fingerprint = selfJoinFingerprint(struct {
		Version   string `json:"version"`
		TenantID  string `json:"tenant_id"`
		AccountID string `json:"account_id"`
		SpaceSlug string `json:"space_slug"`
	}{
		Version: selfJoinFingerprintVersion, TenantID: input.TenantID.String(), AccountID: input.AccountID.String(),
		SpaceSlug: input.SpaceSlug,
	})
	return nil
}

func requiredSelfValue(value string, maxBytes int) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" || !utf8.ValidString(value) || len(value) > maxBytes {
		return "", ErrInvalidSpaceSlug
	}
	return value, nil
}

func selfJoinFingerprint(value any) [32]byte {
	payload, _ := json.Marshal(value)
	return sha256.Sum256(payload)
}

// ParticipantJoinedPayload is shared by the account join adapter and the
// existing lifecycle adapter. The Sync consumer adds its admission revision
// when it applies the intent.
func ParticipantJoinedPayload(participantID utilities.ID, displayName, role string) json.RawMessage {
	payload, _ := json.Marshal(struct {
		ParticipantID string `json:"participant_id"`
		DisplayName   string `json:"display_name"`
		Role          string `json:"role"`
	}{ParticipantID: participantID.String(), DisplayName: displayName, Role: role})
	return payload
}
