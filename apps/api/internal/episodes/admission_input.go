package episodes

import (
	"encoding/json"
	"strings"
	"unicode/utf8"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func prepareAdmissionInput(input *AdmitParticipantInput) error {
	if err := validateTenantSpaceEpisodeIDs(input.TenantID, input.SpaceID, input.EpisodeID); err != nil {
		return err
	}
	if input.ParticipantID.IsZero() {
		return ErrInvalidParticipantID
	}

	if input.Admission == "" {
		input.Admission = AdmissionPolicy
	}
	if input.Admission != AdmissionPolicy && input.Admission != AdmissionDirect {
		return ErrInvalidAdmissionPolicy
	}

	name, err := utilities.RequiredString(input.Name)
	if err != nil || !utf8.ValidString(name) || len(name) > MaximumParticipantNameBytes {
		return ErrInvalidParticipantName
	}
	input.Name = name

	if err := prepareAdmissionIdentity(input); err != nil {
		return err
	}

	role, err := utilities.RequiredString(input.Role)
	if err != nil || !utf8.ValidString(role) || len(role) > 128 {
		return ErrInvalidRole
	}
	input.Role = role

	metadata, err := utilities.JSON(input.Metadata)
	if err != nil {
		return ErrInvalidIntentPayload
	}
	input.Metadata = metadata

	payload := participantJoinedPayload(input.ParticipantID, input.Name, input.Role)
	if err := prepareRequest(&input.Request, payload); err != nil {
		return err
	}
	input.Request.Fingerprint = admissionFingerprint(input, payload)
	return nil
}

func prepareAdmissionIdentity(input *AdmitParticipantInput) error {
	if input.IdentityExternalID != "" && (!input.IdentityID.IsZero() || !utf8.ValidString(input.IdentityExternalID) || len(input.IdentityExternalID) > 256 || strings.TrimSpace(input.IdentityExternalID) != input.IdentityExternalID) {
		return ErrInvalidIdentityMode
	}
	if input.IdentityKind == "" {
		input.IdentityKind = IdentityKindUser
	}
	if input.IdentityKind != IdentityKindUser && input.IdentityKind != IdentityKindAgent {
		return ErrInvalidIdentityMode
	}
	if input.IdentityKind == IdentityKindAgent && input.IdentityExternalID == "" {
		return ErrInvalidIdentityMode
	}
	return nil
}

func admissionFingerprint(input *AdmitParticipantInput, payload json.RawMessage) [32]byte {
	// Keep policy retries compatible with fingerprints written before this option.
	fingerprintAdmission := input.Admission
	if fingerprintAdmission == AdmissionPolicy {
		fingerprintAdmission = ""
	}
	// Keep user admissions compatible with fingerprints written before the kind existed.
	fingerprintIdentityKind := input.IdentityKind
	if fingerprintIdentityKind == IdentityKindUser {
		fingerprintIdentityKind = ""
	}
	return lifecycleFingerprint(struct {
		Admission          AdmissionMode   `json:"admission,omitempty"`
		TenantID           string          `json:"tenant_id"`
		SpaceID            string          `json:"space_id"`
		EpisodeID          string          `json:"episode_id"`
		ParticipantID      string          `json:"participant_id"`
		IntentName         string          `json:"intent_name"`
		Name               string          `json:"name"`
		Metadata           json.RawMessage `json:"metadata"`
		Role               string          `json:"role"`
		IdentityID         string          `json:"identity_id"`
		IdentityExternalID string          `json:"identity_external_id,omitempty"`
		IdentityKind       IdentityKind    `json:"identity_kind,omitempty"`
		Payload            json.RawMessage `json:"payload"`
	}{
		Admission: fingerprintAdmission,
		TenantID:  input.TenantID.String(), SpaceID: input.SpaceID.String(), EpisodeID: input.EpisodeID.String(),
		ParticipantID: input.ParticipantID.String(), IntentName: IntentParticipantJoined, Name: input.Name,
		Metadata: input.Metadata, Role: input.Role, IdentityID: input.IdentityID.String(), IdentityExternalID: input.IdentityExternalID, IdentityKind: fingerprintIdentityKind, Payload: payload,
	})
}
