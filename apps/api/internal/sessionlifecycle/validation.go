package sessionlifecycle

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

const sessionCreateFingerprintVersion = "session-create/v3"

var validRoles = map[string]struct{}{
	"host": {}, "cohost": {}, "participant": {},
}

var capabilityOrder = []string{
	"publishAudio", "publishVideo", "publishScreen", "subscribe", "raiseHand", "renameSelf",
	"manageAdmission", "promoteDemote", "transferHost", "muteOthers", "stopVideoOthers",
	"stopScreenOthers", "requestMediaOthers", "removeParticipant", "manageRecording", "endMeeting",
}

var roleOrder = []string{"host", "cohost", "participant"}

var validCapabilities = func() map[string]struct{} {
	result := make(map[string]struct{}, len(capabilityOrder))
	for _, capability := range capabilityOrder {
		result[capability] = struct{}{}
	}
	return result
}()

type sessionCreateFingerprintInput struct {
	Version                string              `json:"fingerprint_version"`
	TenantID               string              `json:"tenant_id"`
	RoomID                 string              `json:"room_id"`
	Metadata               json.RawMessage     `json:"metadata"`
	ActorID                string              `json:"actor_id"`
	StartedAt              *string             `json:"started_at"`
	AdmissionPolicy        string              `json:"admission_policy"`
	HostExitPolicy         string              `json:"host_exit_policy"`
	RoleCapabilities       map[string][]string `json:"role_capabilities"`
	MaximumDurationSeconds int32               `json:"maximum_duration_seconds"`
}

func prepareCreateSessionInput(input *CreateSessionInput) error {
	if err := validateTenantRoomSessionIDs(input.TenantID, input.RoomID, input.ID); err != nil {
		return err
	}

	metadata, err := utilities.JSON(input.Metadata)
	if err != nil {
		return ErrInvalidInitialControlState
	}
	input.Metadata = metadata

	policy, err := validateInitialControlPolicy(InitialControlPolicy{
		AdmissionPolicy: input.AdmissionPolicy, HostExitPolicy: input.HostExitPolicy,
		RoleCapabilities: input.RoleCapabilities, MaximumDurationSeconds: input.MaximumDurationSeconds,
		MaximumDurationCeilingSeconds: input.MaximumDurationCeilingSeconds, DeadlineAt: input.DeadlineAt,
	})
	if err != nil {
		return err
	}
	input.AdmissionPolicy = policy.AdmissionPolicy
	input.HostExitPolicy = policy.HostExitPolicy
	input.RoleCapabilities = policy.RoleCapabilities
	input.DeadlineAt = policy.DeadlineAt
	input.InitialControl, err = NewInitialControlState(policy)
	if err != nil {
		return err
	}
	if err := prepareRequest(&input.Request, nil); err != nil {
		return err
	}
	input.Request.Fingerprint = lifecycleFingerprint(sessionCreateFingerprintInput{
		Version:         sessionCreateFingerprintVersion,
		TenantID:        input.TenantID.String(),
		RoomID:          input.RoomID.String(),
		Metadata:        canonicalJSON(input.Metadata),
		ActorID:         input.CreatedByUserID.String(),
		StartedAt:       canonicalTime(input.StartedAt),
		AdmissionPolicy: input.AdmissionPolicy, HostExitPolicy: input.HostExitPolicy,
		RoleCapabilities: input.RoleCapabilities, MaximumDurationSeconds: input.MaximumDurationSeconds,
	})

	return nil
}

func prepareAdmissionInput(input *AdmitParticipantInput) error {
	if err := validateTenantRoomSessionIDs(input.TenantID, input.RoomID, input.SessionID); err != nil {
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

	metadata, err := utilities.JSON(input.Metadata)
	if err != nil {
		return ErrInvalidIntentPayload
	}
	input.Metadata = metadata
	eligibleRoles, err := validateEligibleRoles(input.InitialRole, input.EligibleRoles)
	if err != nil {
		return err
	}
	input.EligibleRoles = eligibleRoles

	payload := participantJoinedPayload(input.ParticipantID, input.Name, input.InitialRole, input.EligibleRoles)
	if err := prepareRequest(&input.Request, payload); err != nil {
		return err
	}
	input.Request.Fingerprint = lifecycleFingerprint(struct {
		TenantID      string          `json:"tenant_id"`
		RoomID        string          `json:"room_id"`
		SessionID     string          `json:"session_id"`
		ParticipantID string          `json:"participant_session_id"`
		IntentName    string          `json:"intent_name"`
		Name          string          `json:"name"`
		Metadata      json.RawMessage `json:"metadata"`
		InitialRole   string          `json:"initial_role"`
		EligibleRoles []string        `json:"eligible_roles"`
		UserID        string          `json:"user_id"`
		Payload       json.RawMessage `json:"payload"`
	}{
		TenantID: input.TenantID.String(), RoomID: input.RoomID.String(), SessionID: input.SessionID.String(),
		ParticipantID: input.ParticipantID.String(), IntentName: IntentParticipantJoined, Name: input.Name,
		Metadata: input.Metadata, InitialRole: input.InitialRole, EligibleRoles: input.EligibleRoles, UserID: input.UserID.String(), Payload: payload,
	})
	return nil
}

func prepareParticipantRemovalInput(input *RequestParticipantRemovalInput) error {
	if err := validateTenantRoomSessionIDs(input.TenantID, input.RoomID, input.SessionID); err != nil {
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
		RoomID        string          `json:"room_id"`
		SessionID     string          `json:"session_id"`
		ParticipantID string          `json:"participant_session_id"`
		Generation    int64           `json:"participant_session_generation"`
		OperationName string          `json:"operation_name"`
		Payload       json.RawMessage `json:"payload"`
	}{
		TenantID: input.TenantID.String(), RoomID: input.RoomID.String(), SessionID: input.SessionID.String(),
		ParticipantID: input.ParticipantID.String(), Generation: input.ParticipantGeneration,
		OperationName: OperationRemoveParticipant, Payload: payload,
	})
	return nil
}

func prepareSessionEndInput(input *RequestSessionEndInput) error {
	if err := validateTenantRoomSessionIDs(input.TenantID, input.RoomID, input.SessionID); err != nil {
		return err
	}

	payload := json.RawMessage(`{}`)
	if err := prepareRequest(&input.Request, payload); err != nil {
		return err
	}
	input.Request.Fingerprint = lifecycleFingerprint(struct {
		TenantID      string          `json:"tenant_id"`
		RoomID        string          `json:"room_id"`
		SessionID     string          `json:"session_id"`
		OperationName string          `json:"operation_name"`
		Payload       json.RawMessage `json:"payload"`
	}{
		TenantID: input.TenantID.String(), RoomID: input.RoomID.String(), SessionID: input.SessionID.String(),
		OperationName: OperationTenantEndSession, Payload: payload,
	})
	return nil
}

func prepareTransferHostInput(input *TransferHostInput) error {
	if err := validateTenantRoomSessionIDs(input.TenantID, input.RoomID, input.SessionID); err != nil {
		return err
	}
	if input.ParticipantID.IsZero() {
		return ErrInvalidParticipantID
	}
	if input.ParticipantGeneration <= 0 {
		return ErrInvalidParticipantGeneration
	}
	payload, err := json.Marshal(struct {
		ParticipantSessionID string `json:"participantSessionId"`
	}{ParticipantSessionID: input.ParticipantID.String()})
	if err != nil {
		return ErrInvalidIntentPayload
	}
	if err := prepareRequest(&input.Request, payload); err != nil {
		return err
	}
	input.Request.Fingerprint = lifecycleFingerprint(struct {
		TenantID              string          `json:"tenant_id"`
		RoomID                string          `json:"room_id"`
		SessionID             string          `json:"session_id"`
		OperationName         string          `json:"operation_name"`
		ParticipantSessionID  string          `json:"participant_session_id"`
		ParticipantGeneration int64           `json:"participant_generation"`
		Payload               json.RawMessage `json:"payload"`
	}{
		TenantID: input.TenantID.String(), RoomID: input.RoomID.String(), SessionID: input.SessionID.String(),
		OperationName: OperationTenantTransferHost, ParticipantSessionID: input.ParticipantID.String(),
		ParticipantGeneration: input.ParticipantGeneration, Payload: payload,
	})
	return nil
}

func prepareSetDeadlineInput(input *SetDeadlineInput) error {
	if err := validateTenantRoomSessionIDs(input.TenantID, input.RoomID, input.SessionID); err != nil {
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
		RoomID        string `json:"room_id"`
		SessionID     string `json:"session_id"`
		OperationName string `json:"operation_name"`
		DeadlineAtMS  int64  `json:"deadline_at_ms"`
	}{
		TenantID: input.TenantID.String(), RoomID: input.RoomID.String(), SessionID: input.SessionID.String(),
		OperationName: OperationTenantSetDeadline, DeadlineAtMS: input.Deadline.UnixMilli(),
	})
	return nil
}

func NewMaximumDurationRequest(tenantID, roomID, sessionID utilities.ID, generation int64) (Request, error) {
	payload, err := json.Marshal(struct {
		DeadlineGeneration int64 `json:"deadlineGeneration"`
	}{DeadlineGeneration: generation})
	if err != nil {
		return Request{}, ErrInvalidIntentPayload
	}
	request := Request{Key: "maximum-duration-" + strconv.FormatInt(generation, 10), payload: payload}
	request.Fingerprint = lifecycleFingerprint(struct {
		TenantID           string          `json:"tenant_id"`
		RoomID             string          `json:"room_id"`
		SessionID          string          `json:"session_id"`
		OperationName      string          `json:"operation_name"`
		DeadlineGeneration int64           `json:"deadline_generation"`
		Payload            json.RawMessage `json:"payload"`
	}{
		TenantID: tenantID.String(), RoomID: roomID.String(), SessionID: sessionID.String(),
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

func participantJoinedPayload(participantID utilities.ID, displayName string, initialRole string, eligibleRoles []string) json.RawMessage {
	payload, _ := json.Marshal(struct {
		DisplayName          string   `json:"display_name"`
		ParticipantSessionID string   `json:"participant_session_id"`
		InitialRole          string   `json:"initial_role"`
		EligibleRoles        []string `json:"eligible_roles"`
	}{
		DisplayName:          displayName,
		ParticipantSessionID: participantID.String(),
		InitialRole:          initialRole,
		EligibleRoles:        eligibleRoles,
	})
	return payload
}

func validateInitialControlPolicy(policy InitialControlPolicy) (InitialControlPolicy, error) {
	if policy.AdmissionPolicy != "open" && policy.AdmissionPolicy != "approval" && policy.AdmissionPolicy != "closed" {
		return InitialControlPolicy{}, ErrInvalidAdmissionPolicy
	}
	if policy.HostExitPolicy != "require_transfer" && policy.HostExitPolicy != "promote_cohost" {
		return InitialControlPolicy{}, ErrInvalidHostExitPolicy
	}
	roleCapabilities, err := validateRoleCapabilities(policy.RoleCapabilities)
	if err != nil {
		return InitialControlPolicy{}, err
	}
	policy.RoleCapabilities = roleCapabilities
	if policy.MaximumDurationSeconds < MinimumSessionDurationSeconds || policy.MaximumDurationSeconds > MaximumSessionDurationSeconds {
		return InitialControlPolicy{}, ErrInvalidMaximumDuration
	}
	if policy.MaximumDurationCeilingSeconds < MinimumSessionDurationSeconds || policy.MaximumDurationCeilingSeconds > MaximumSessionDurationSeconds || policy.MaximumDurationSeconds > policy.MaximumDurationCeilingSeconds {
		return InitialControlPolicy{}, ErrInvalidMaximumDurationCeiling
	}
	if policy.DeadlineAt.IsZero() || policy.DeadlineAt.UnixMilli() < 1 {
		return InitialControlPolicy{}, ErrInvalidDeadline
	}
	policy.DeadlineAt = policy.DeadlineAt.UTC().Truncate(time.Millisecond)
	return policy, nil
}

func validateRoleCapabilities(input map[string][]string) (map[string][]string, error) {
	if len(input) != len(validRoles) {
		return nil, ErrInvalidRoleCapabilities
	}
	result := make(map[string][]string, len(validRoles))
	for _, role := range roleOrder {
		values, ok := input[role]
		if !ok || len(values) > len(validCapabilities) {
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
				result[role] = append(result[role], capability)
			}
		}
	}
	return result, nil
}

func validateEligibleRoles(initialRole string, input []string) ([]string, error) {
	if _, ok := validRoles[initialRole]; !ok {
		return nil, ErrInvalidInitialRole
	}
	if len(input) == 0 || len(input) > len(validRoles) {
		return nil, ErrInvalidEligibleRoles
	}
	seen := make(map[string]struct{}, len(input))
	for _, role := range input {
		if _, ok := validRoles[role]; !ok {
			return nil, ErrInvalidEligibleRoles
		}
		if _, duplicate := seen[role]; duplicate {
			return nil, ErrInvalidEligibleRoles
		}
		seen[role] = struct{}{}
	}
	if _, ok := seen[initialRole]; !ok {
		return nil, ErrInvalidEligibleRoles
	}
	if initialRole == "host" {
		if _, ok := seen["cohost"]; !ok {
			return nil, ErrInvalidEligibleRoles
		}
	}
	result := make([]string, 0, len(input))
	for _, role := range roleOrder {
		if _, ok := seen[role]; ok {
			result = append(result, role)
		}
	}
	return result, nil
}

func participantLeftPayload(participantID utilities.ID) json.RawMessage {
	payload, _ := json.Marshal(struct {
		ParticipantSessionID string `json:"participantSessionId"`
	}{
		ParticipantSessionID: participantID.String(),
	})
	return payload
}

func validateTenantRoomSessionIDs(tenantID utilities.ID, roomID utilities.ID, sessionID utilities.ID) error {
	if tenantID.IsZero() {
		return ErrInvalidTenantID
	}
	if roomID.IsZero() {
		return ErrInvalidRoomID
	}
	if sessionID.IsZero() {
		return ErrInvalidSessionID
	}

	return nil
}

func lifecycleFingerprint(value any) [32]byte {
	normalized, _ := json.Marshal(value)
	return sha256.Sum256(normalized)
}
