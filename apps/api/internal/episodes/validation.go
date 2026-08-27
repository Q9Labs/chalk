package episodes

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"math/big"
	"regexp"
	"sort"
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

	name, err := utilities.RequiredString(input.Name)
	if err != nil || !utf8.ValidString(name) || len(name) > MaximumParticipantNameBytes {
		return ErrInvalidParticipantName
	}
	input.Name = name

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
	input.Request.Fingerprint = lifecycleFingerprint(struct {
		TenantID      string          `json:"tenant_id"`
		SpaceID       string          `json:"space_id"`
		EpisodeID     string          `json:"episode_id"`
		ParticipantID string          `json:"participant_id"`
		IntentName    string          `json:"intent_name"`
		Name          string          `json:"name"`
		Metadata      json.RawMessage `json:"metadata"`
		Role          string          `json:"role"`
		IdentityID    string          `json:"identity_id"`
		Payload       json.RawMessage `json:"payload"`
	}{
		TenantID: input.TenantID.String(), SpaceID: input.SpaceID.String(), EpisodeID: input.EpisodeID.String(),
		ParticipantID: input.ParticipantID.String(), IntentName: IntentParticipantJoined, Name: input.Name,
		Metadata: input.Metadata, Role: input.Role, IdentityID: input.IdentityID.String(), Payload: payload,
	})
	return nil
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

func validateConfigSnapshot(raw json.RawMessage) (json.RawMessage, EpisodeConfigSnapshot, error) {
	if len(raw) == 0 {
		return nil, EpisodeConfigSnapshot{}, nil
	}
	var snapshot EpisodeConfigSnapshot
	if err := json.Unmarshal(raw, &snapshot); err != nil {
		return nil, EpisodeConfigSnapshot{}, ErrInvalidConfigSnapshot
	}
	if _, err := admissionPolicyMode(snapshot.AdmissionPolicy); err != nil {
		return nil, EpisodeConfigSnapshot{}, ErrInvalidAdmissionPolicy
	}
	roles, err := validateRoleCapabilities(snapshot.Roles)
	if err != nil {
		return nil, EpisodeConfigSnapshot{}, err
	}
	snapshot.Roles = roles
	if snapshot.MaximumEpisodeDurationSeconds < MinimumEpisodeDurationSeconds || snapshot.MaximumEpisodeDurationSeconds > MaximumEpisodeDurationSeconds {
		return nil, EpisodeConfigSnapshot{}, ErrInvalidMaximumDuration
	}
	if snapshot.DefaultEpisodeDurationSeconds < MinimumEpisodeDurationSeconds || snapshot.DefaultEpisodeDurationSeconds > snapshot.MaximumEpisodeDurationSeconds {
		return nil, EpisodeConfigSnapshot{}, ErrInvalidMaximumDuration
	}
	if snapshot.LingerWindowSeconds < 0 || snapshot.LingerWindowSeconds > snapshot.MaximumEpisodeDurationSeconds {
		return nil, EpisodeConfigSnapshot{}, ErrInvalidConfigSnapshot
	}
	if snapshot.ArtifactPolicy != nil {
		if err := snapshot.ArtifactPolicy.Validate(); err != nil {
			return nil, EpisodeConfigSnapshot{}, ErrInvalidConfigSnapshot
		}
	}
	encoded, err := json.Marshal(snapshot)
	if err != nil {
		return nil, EpisodeConfigSnapshot{}, ErrInvalidConfigSnapshot
	}
	return canonicalJSON(encoded), snapshot, nil
}

func admissionPolicyMode(raw json.RawMessage) (string, error) {
	var policy struct {
		Mode string `json:"mode"`
	}
	if err := json.Unmarshal(raw, &policy); err != nil {
		return "", ErrInvalidAdmissionPolicy
	}
	if policy.Mode != "open" && policy.Mode != "knock" && policy.Mode != "members_only" {
		return "", ErrInvalidAdmissionPolicy
	}
	return policy.Mode, nil
}

func validateRoleCapabilities(input map[string][]string) (map[string][]string, error) {
	if len(input) == 0 {
		return nil, ErrInvalidRoleCapabilities
	}
	result := make(map[string][]string, len(input))
	for role, values := range input {
		roleName, err := utilities.RequiredString(role)
		if err != nil || !utf8.ValidString(roleName) || len(roleName) > 128 || len(values) > len(validCapabilities) {
			return nil, ErrInvalidRoleCapabilities
		}
		seen := make(map[string]struct{}, len(values))
		for _, capability := range values {
			if _, ok := validCapabilities[capability]; !ok {
				return nil, ErrInvalidRoleCapabilities
			}
			if _, duplicate := seen[capability]; duplicate {
				return nil, ErrInvalidRoleCapabilities
			}
			seen[capability] = struct{}{}
		}
		for _, capability := range capabilityOrder {
			if _, ok := seen[capability]; ok {
				result[roleName] = append(result[roleName], capability)
			}
		}
	}
	return result, nil
}

func participantJoinedPayload(participantID utilities.ID, displayName, role string) json.RawMessage {
	payload, _ := json.Marshal(struct {
		DisplayName   string `json:"display_name"`
		ParticipantID string `json:"participant_id"`
		Role          string `json:"role"`
	}{DisplayName: displayName, ParticipantID: participantID.String(), Role: role})
	return payload
}

func participantLeftPayload(participantID utilities.ID) json.RawMessage {
	payload, _ := json.Marshal(struct {
		ParticipantID string `json:"participant_id"`
	}{ParticipantID: participantID.String()})
	return payload
}

func validateTenantSpaceEpisodeIDs(tenantID, spaceID, episodeID utilities.ID) error {
	if tenantID.IsZero() {
		return ErrInvalidTenantID
	}
	if spaceID.IsZero() {
		return ErrInvalidSpaceID
	}
	if episodeID.IsZero() {
		return ErrInvalidEpisodeID
	}
	return nil
}

func lifecycleFingerprint(value any) [32]byte {
	normalized, _ := json.Marshal(value)
	return sha256.Sum256(normalized)
}

func canonicalJSON(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return nil
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil
	}
	return appendCanonicalJSON(nil, value)
}

func appendCanonicalJSON(target []byte, value any) []byte {
	switch value := value.(type) {
	case nil:
		return append(target, "null"...)
	case bool:
		return append(target, strconv.FormatBool(value)...)
	case string:
		encoded, _ := json.Marshal(value)
		return append(target, encoded...)
	case json.Number:
		return append(target, canonicalJSONNumber(string(value))...)
	case []any:
		target = append(target, '[')
		for index, item := range value {
			if index > 0 {
				target = append(target, ',')
			}
			target = appendCanonicalJSON(target, item)
		}
		return append(target, ']')
	case map[string]any:
		keys := make([]string, 0, len(value))
		for key := range value {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		target = append(target, '{')
		for index, key := range keys {
			if index > 0 {
				target = append(target, ',')
			}
			encoded, _ := json.Marshal(key)
			target = append(target, encoded...)
			target = append(target, ':')
			target = appendCanonicalJSON(target, value[key])
		}
		return append(target, '}')
	default:
		return target
	}
}

func canonicalJSONNumber(number string) string {
	negative := strings.HasPrefix(number, "-")
	if negative {
		number = number[1:]
	}
	exponent := new(big.Int)
	if exponentIndex := strings.IndexAny(number, "eE"); exponentIndex >= 0 {
		exponent.SetString(number[exponentIndex+1:], 10)
		number = number[:exponentIndex]
	}
	fractionDigits := 0
	if decimalIndex := strings.IndexByte(number, '.'); decimalIndex >= 0 {
		fractionDigits = len(number) - decimalIndex - 1
		number = number[:decimalIndex] + number[decimalIndex+1:]
	}
	number = strings.TrimLeft(number, "0")
	if number == "" {
		return "0"
	}
	trailingZeros := len(number) - len(strings.TrimRight(number, "0"))
	number = number[:len(number)-trailingZeros]
	exponent.Sub(exponent, big.NewInt(int64(fractionDigits)))
	exponent.Add(exponent, big.NewInt(int64(trailingZeros)))
	sign := ""
	if negative {
		sign = "-"
	}
	scientificExponent := new(big.Int).Add(exponent, big.NewInt(int64(len(number)-1)))
	if scientificExponent.IsInt64() {
		value := scientificExponent.Int64()
		decimalPosition := int64(len(number)) + exponent.Int64()
		if value >= -6 && value < 21 {
			switch {
			case decimalPosition <= 0:
				return sign + "0." + strings.Repeat("0", int(-decimalPosition)) + number
			case decimalPosition >= int64(len(number)):
				return sign + number + strings.Repeat("0", int(decimalPosition-int64(len(number))))
			default:
				return sign + number[:decimalPosition] + "." + number[decimalPosition:]
			}
		}
	}
	mantissa := number[:1]
	if len(number) > 1 {
		mantissa += "." + number[1:]
	}
	exponentSign := ""
	if scientificExponent.Sign() >= 0 {
		exponentSign = "+"
	}
	return sign + mantissa + "e" + exponentSign + scientificExponent.String()
}

func canonicalTime(value *time.Time) *string {
	if value == nil {
		return nil
	}
	normalized := value.UTC().Format(time.RFC3339Nano)
	return &normalized
}
