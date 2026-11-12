package episodes

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var requestKeyPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{16,128}$`)

const episodeCreateFingerprintVersion = "episode-create/v1"

type episodeCreateFingerprintInput struct {
	Version         string          `json:"fingerprint_version"`
	TenantID        string          `json:"tenant_id"`
	SpaceID         string          `json:"space_id"`
	Metadata        json.RawMessage `json:"metadata"`
	ActorID         string          `json:"actor_id"`
	StartedAt       *string         `json:"started_at"`
	ConfigSnapshot  json.RawMessage `json:"config_snapshot"`
	MaximumDuration int32           `json:"maximum_duration_seconds"`
}

func prepareCreateEpisodeInput(input *CreateEpisodeInput) error {
	if err := validateTenantSpaceEpisodeIDs(input.TenantID, input.SpaceID, input.ID); err != nil {
		return err
	}

	metadata, err := utilities.JSON(input.Metadata)
	if err != nil {
		return ErrInvalidConfigSnapshot
	}
	input.Metadata = metadata

	snapshot, config, err := validateConfigSnapshot(input.ConfigSnapshot)
	if err != nil {
		return err
	}
	input.ConfigSnapshot = snapshot
	if len(input.ConfigSnapshot) > 0 {
		if input.MaximumDurationSeconds == 0 {
			input.MaximumDurationSeconds = config.MaximumEpisodeDurationSeconds
		}
		if input.MaximumDurationCeilingSeconds == 0 {
			input.MaximumDurationCeilingSeconds = config.MaximumEpisodeDurationSeconds
		}
		if input.MaximumDurationSeconds < MinimumEpisodeDurationSeconds || input.MaximumDurationSeconds > MaximumEpisodeDurationSeconds {
			return ErrInvalidMaximumDuration
		}
		if input.MaximumDurationCeilingSeconds < MinimumEpisodeDurationSeconds || input.MaximumDurationCeilingSeconds > MaximumEpisodeDurationSeconds || input.MaximumDurationSeconds > input.MaximumDurationCeilingSeconds {
			return ErrInvalidMaximumDurationCeiling
		}
	}
	if !input.DeadlineAt.IsZero() {
		input.DeadlineAt = input.DeadlineAt.UTC().Truncate(time.Millisecond)
	}

	if err := prepareRequest(&input.Request, nil); err != nil {
		return err
	}
	input.Request.Fingerprint = lifecycleFingerprint(episodeCreateFingerprintInput{
		Version: episodeCreateFingerprintVersion, TenantID: input.TenantID.String(), SpaceID: input.SpaceID.String(),
		Metadata: canonicalJSON(input.Metadata), ActorID: input.CreatedByUserID.String(), StartedAt: canonicalTime(input.StartedAt),
		ConfigSnapshot: canonicalJSON(input.ConfigSnapshot), MaximumDuration: input.MaximumDurationSeconds,
	})
	return nil
}

func prepareAdmissionInput(input *AdmitParticipantInput) error {
	if err := validateTenantSpaceEpisodeIDs(input.TenantID, input.SpaceID, input.EpisodeID); err != nil {
		return err
	}
	if input.ParticipantID.IsZero() {
		return ErrInvalidParticipantID
	}
	if err := prepareAdmissionFields(input); err != nil {
		return err
	}
	payload := participantJoinedPayload(input.ParticipantID, input.Name, input.Role)
	if err := prepareRequest(&input.Request, payload); err != nil {
		return err
	}
	input.Request.Fingerprint = admissionFingerprint(*input, payload)
	return nil
}

func prepareAdmissionFields(input *AdmitParticipantInput) error {
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

	if input.IdentityExternalID != "" && (!input.IdentityID.IsZero() || !utf8.ValidString(input.IdentityExternalID) || len(input.IdentityExternalID) > 256 || strings.TrimSpace(input.IdentityExternalID) != input.IdentityExternalID) {
		return ErrInvalidIdentityMode
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
	return nil
}

func admissionFingerprint(input AdmitParticipantInput, payload json.RawMessage) [32]byte {
	// Keep policy retries compatible with fingerprints written before this option.
	admission := input.Admission
	if admission == AdmissionPolicy {
		admission = ""
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
		Payload            json.RawMessage `json:"payload"`
	}{
		Admission: admission,
		TenantID:  input.TenantID.String(), SpaceID: input.SpaceID.String(), EpisodeID: input.EpisodeID.String(),
		ParticipantID: input.ParticipantID.String(), IntentName: IntentParticipantJoined, Name: input.Name,
		Metadata: input.Metadata, Role: input.Role, IdentityID: input.IdentityID.String(), IdentityExternalID: input.IdentityExternalID, Payload: payload,
	})
}

func prepareParticipantRemovalInput(input *RequestParticipantRemovalInput) error {
	if err := validateTenantSpaceEpisodeIDs(input.TenantID, input.SpaceID, input.EpisodeID); err != nil {
		return err
	}
	if input.ParticipantID.IsZero() {
		return ErrInvalidParticipantID
	}
	if input.ParticipantGeneration <= 0 {
		return ErrInvalidParticipantGeneration
	}

	payload := participantLeftPayload(input.ParticipantID)
	if err := prepareRequest(&input.Request, payload); err != nil {
		return err
	}
	input.Request.Fingerprint = lifecycleFingerprint(struct {
		TenantID      string          `json:"tenant_id"`
		SpaceID       string          `json:"space_id"`
		EpisodeID     string          `json:"episode_id"`
		ParticipantID string          `json:"participant_id"`
		Generation    int64           `json:"participant_generation"`
		OperationName string          `json:"operation_name"`
		Payload       json.RawMessage `json:"payload"`
	}{
		TenantID: input.TenantID.String(), SpaceID: input.SpaceID.String(), EpisodeID: input.EpisodeID.String(),
		ParticipantID: input.ParticipantID.String(), Generation: input.ParticipantGeneration,
		OperationName: OperationRemoveParticipant, Payload: payload,
	})
	return nil
}

func prepareEpisodeEndInput(input *RequestEpisodeEndInput) error {
	if err := validateTenantSpaceEpisodeIDs(input.TenantID, input.SpaceID, input.EpisodeID); err != nil {
		return err
	}
	payload := json.RawMessage(`{}`)
	if err := prepareRequest(&input.Request, payload); err != nil {
		return err
	}
	input.Request.Fingerprint = lifecycleFingerprint(struct {
		TenantID      string          `json:"tenant_id"`
		SpaceID       string          `json:"space_id"`
		EpisodeID     string          `json:"episode_id"`
		OperationName string          `json:"operation_name"`
		Payload       json.RawMessage `json:"payload"`
	}{
		TenantID: input.TenantID.String(), SpaceID: input.SpaceID.String(), EpisodeID: input.EpisodeID.String(),
		OperationName: OperationTenantEndEpisode, Payload: payload,
	})
	return nil
}

func prepareSetDeadlineInput(input *SetDeadlineInput) error {
	if err := validateTenantSpaceEpisodeIDs(input.TenantID, input.SpaceID, input.EpisodeID); err != nil {
		return err
	}
	if input.Deadline.IsZero() {
		return ErrInvalidDeadline
	}
	input.Deadline = input.Deadline.UTC().Truncate(time.Millisecond)
	if err := prepareRequest(&input.Request, json.RawMessage(`{}`)); err != nil {
		return err
	}
	input.Request.Fingerprint = lifecycleFingerprint(struct {
		TenantID      string `json:"tenant_id"`
		SpaceID       string `json:"space_id"`
		EpisodeID     string `json:"episode_id"`
		OperationName string `json:"operation_name"`
		DeadlineAtMS  int64  `json:"deadline_at_ms"`
	}{
		TenantID: input.TenantID.String(), SpaceID: input.SpaceID.String(), EpisodeID: input.EpisodeID.String(),
		OperationName: OperationTenantSetDeadline, DeadlineAtMS: input.Deadline.UnixMilli(),
	})
	return nil
}

// NewLingerRequest keys the end of one empty window. Each failed earlier end
// of that window adds a retry suffix, so a retry is a new operation.
func NewLingerRequest(tenantID, spaceID, episodeID utilities.ID, lastDepartureAt time.Time, failedAttempts int) (Request, error) {
	key := "empty-episode-linger-" + strconv.FormatInt(lastDepartureAt.UnixMicro(), 10)
	if failedAttempts > 0 {
		key += "-retry-" + strconv.Itoa(failedAttempts)
	}
	input := RequestEpisodeEndInput{TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID, Request: Request{Key: key}}
	if err := prepareEpisodeEndInput(&input); err != nil {
		return Request{}, err
	}
	return input.Request, nil
}

func NewMaximumDurationRequest(tenantID, spaceID, episodeID utilities.ID, generation int64) (Request, error) {
	payload, err := json.Marshal(struct {
		DeadlineGeneration int64 `json:"deadlineGeneration"`
	}{DeadlineGeneration: generation})
	if err != nil {
		return Request{}, ErrInvalidIntentPayload
	}
	request := Request{Key: "maximum-duration-" + strconv.FormatInt(generation, 10), payload: payload}
	request.Fingerprint = lifecycleFingerprint(struct {
		TenantID           string          `json:"tenant_id"`
		SpaceID            string          `json:"space_id"`
		EpisodeID          string          `json:"episode_id"`
		OperationName      string          `json:"operation_name"`
		DeadlineGeneration int64           `json:"deadline_generation"`
		Payload            json.RawMessage `json:"payload"`
	}{
		TenantID: tenantID.String(), SpaceID: spaceID.String(), EpisodeID: episodeID.String(),
		OperationName: OperationMaximumDurationExpired, DeadlineGeneration: generation, Payload: payload,
	})
	return request, nil
}

func prepareRequest(request *Request, payload json.RawMessage) error {
	key, err := utilities.RequiredString(request.Key)
	if err != nil || !requestKeyPattern.MatchString(key) {
		return ErrInvalidRequestKey
	}
	request.Key = key
	if payload == nil {
		return nil
	}
	if len(payload) > MaximumIntentPayloadBytes {
		return ErrInvalidIntentPayload
	}
	payload, err = utilities.JSON(payload)
	if err != nil {
		return ErrInvalidIntentPayload
	}
	request.payload = payload
	return nil
}
