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

const sessionCreateFingerprintVersion = "session-create/v1"

type sessionCreateFingerprintInput struct {
	Version   string          `json:"fingerprint_version"`
	TenantID  string          `json:"tenant_id"`
	RoomID    string          `json:"room_id"`
	Metadata  json.RawMessage `json:"metadata"`
	ActorID   string          `json:"actor_id"`
	StartedAt *string         `json:"started_at"`
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

	if len(input.InitialControl.FoldedState) == 0 {
		return ErrInvalidInitialControlState
	}
	foldedState, err := utilities.JSON(input.InitialControl.FoldedState)
	if err != nil {
		return ErrInvalidInitialControlState
	}
	input.InitialControl.FoldedState = foldedState
	if input.InitialControl.SchemaVersion <= 0 {
		return ErrInvalidInitialControlSchemaVersion
	}
	if input.InitialControl.SnapshotBytes < 0 || input.InitialControl.SnapshotBytes > MaximumSnapshotBytes {
		return ErrInvalidInitialControlSnapshotBytes
	}
	if err := prepareRequest(&input.Request, nil); err != nil {
		return err
	}
	input.Request.Fingerprint = lifecycleFingerprint(sessionCreateFingerprintInput{
		Version:   sessionCreateFingerprintVersion,
		TenantID:  input.TenantID.String(),
		RoomID:    input.RoomID.String(),
		Metadata:  canonicalJSON(input.Metadata),
		ActorID:   input.CreatedByUserID.String(),
		StartedAt: canonicalTime(input.StartedAt),
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

	payload := participantJoinedPayload(input.ParticipantID, input.Name)
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
		Capabilities  []string        `json:"capabilities"`
		UserID        string          `json:"user_id"`
		Payload       json.RawMessage `json:"payload"`
	}{
		TenantID: input.TenantID.String(), RoomID: input.RoomID.String(), SessionID: input.SessionID.String(),
		ParticipantID: input.ParticipantID.String(), IntentName: IntentParticipantJoined, Name: input.Name,
		Metadata: input.Metadata, Capabilities: input.Capabilities, UserID: input.UserID.String(), Payload: payload,
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
		IntentName    string          `json:"intent_name"`
		Payload       json.RawMessage `json:"payload"`
	}{
		TenantID: input.TenantID.String(), RoomID: input.RoomID.String(), SessionID: input.SessionID.String(),
		ParticipantID: input.ParticipantID.String(), Generation: input.ParticipantGeneration,
		IntentName: IntentParticipantLeft, Payload: payload,
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
		TenantID   string          `json:"tenant_id"`
		RoomID     string          `json:"room_id"`
		SessionID  string          `json:"session_id"`
		IntentName string          `json:"intent_name"`
		Payload    json.RawMessage `json:"payload"`
	}{
		TenantID: input.TenantID.String(), RoomID: input.RoomID.String(), SessionID: input.SessionID.String(),
		IntentName: IntentSessionEnded, Payload: payload,
	})
	return nil
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

	if exponent.Sign() == 0 {
		if negative {
			return "-" + number
		}
		return number
	}
	if negative {
		return "-" + number + "e" + exponent.String()
	}
	return number + "e" + exponent.String()
}

func canonicalTime(value *time.Time) *string {
	if value == nil {
		return nil
	}
	normalized := value.UTC().Format(time.RFC3339Nano)
	return &normalized
}

func participantJoinedPayload(participantID utilities.ID, displayName string) json.RawMessage {
	payload, _ := json.Marshal(struct {
		DisplayName          string `json:"display_name"`
		ParticipantSessionID string `json:"participant_session_id"`
	}{
		DisplayName:          displayName,
		ParticipantSessionID: participantID.String(),
	})
	return payload
}

func participantLeftPayload(participantID utilities.ID) json.RawMessage {
	payload, _ := json.Marshal(struct {
		ParticipantSessionID string `json:"participant_session_id"`
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
