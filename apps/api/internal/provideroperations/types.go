package provideroperations

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type Effect string

const (
	EffectGrantPublication  Effect = "media.grant_publication"
	EffectRevokePublication Effect = "media.revoke_publication"
	EffectRemoveParticipant Effect = "media.remove_participant"
	EffectEndSession        Effect = "media.end_session"
	EffectStartRecording    Effect = "recording.start"
	EffectStopRecording     Effect = "recording.stop"
)

type Outcome string

const (
	OutcomeConfirmed        Outcome = "confirmed"
	OutcomeSatisfied        Outcome = "satisfied"
	OutcomeRetryableFailure Outcome = "retryable_failure"
	OutcomeTerminalFailure  Outcome = "terminal_failure"
	OutcomeAmbiguous        Outcome = "ambiguous"
)

type ReceiptState string

const (
	ReceiptPrepared    ReceiptState = "prepared"
	ReceiptDispatching ReceiptState = "dispatching"
	ReceiptCompleted   ReceiptState = "completed"
)

var (
	ErrInvalidOperationID           = errors.New("invalid provider operation id")
	ErrInvalidEffect                = errors.New("invalid provider operation effect")
	ErrInvalidTenantID              = errors.New("invalid provider operation tenant id")
	ErrInvalidSessionID             = errors.New("invalid provider operation session id")
	ErrInvalidParticipantID         = errors.New("invalid provider operation participant id")
	ErrInvalidParticipantGeneration = errors.New("invalid provider operation participant generation")
	ErrInvalidPublicationSource     = errors.New("invalid provider publication source")
	ErrInvalidRecordingID           = errors.New("invalid provider operation recording id")
	ErrInvalidOutcome               = errors.New("invalid provider operation outcome")
	ErrNonTerminalOutcome           = errors.New("provider operation outcome is not terminal")
	ErrInvalidReason                = errors.New("invalid provider operation reason")
	ErrInvalidReceiptState          = errors.New("invalid provider operation receipt state")
	ErrReceiptNotFound              = errors.New("provider operation receipt not found")
	ErrFingerprintConflict          = errors.New("provider operation fingerprint conflict")
	ErrReceiptConflict              = errors.New("provider operation receipt conflict")
	ErrObservationStale             = errors.New("stale provider operation observation")
	ErrObservationConflict          = errors.New("provider operation observation conflict")
	ErrObservationNotFound          = errors.New("provider operation observation not found")
	ErrInvalidObservationCursor     = errors.New("invalid provider operation observation cursor")
)

const (
	MaxOperationIDBytes = 128
	MinOperationIDBytes = 16
	MaxPayloadBytes     = 16 * 1024
	MaxReasonBytes      = 256
	MaxPublications     = 128
)

type OperationInput struct {
	OperationID                  string
	Effect                       Effect
	TenantID                     utilities.ID
	SessionID                    utilities.ID
	ParticipantSessionID         utilities.ID
	ParticipantSessionGeneration int64
	PublicationSource            string
	RecordingID                  utilities.ID
}

type CanonicalOperation struct {
	Input       OperationInput
	Payload     json.RawMessage
	Fingerprint [32]byte
}

type Completion struct {
	Outcome Outcome
	Reason  *string
}

type Receipt struct {
	OperationID                  string
	Effect                       Effect
	TenantID                     utilities.ID
	SessionID                    utilities.ID
	ParticipantSessionID         utilities.ID
	ParticipantSessionGeneration int64
	PublicationSource            string
	RecordingID                  utilities.ID
	Fingerprint                  [32]byte
	Payload                      json.RawMessage
	State                        ReceiptState
	Outcome                      *Outcome
	Reason                       *string
	CreatedAt                    time.Time
	DispatchingAt                *time.Time
	CompletedAt                  *time.Time
}

type PrepareResult struct {
	Receipt Receipt
	Replay  bool
}

type Publication struct {
	ParticipantSessionID utilities.ID
	Source               string
	Enabled              bool
}

type ObservationInput struct {
	TenantID     utilities.ID
	SessionID    utilities.ID
	Incarnation  int64
	Sequence     int64
	Publications []Publication
}

type Cursor struct {
	Incarnation int64
	Sequence    int64
}

type Observation struct {
	TenantID     utilities.ID
	SessionID    utilities.ID
	Incarnation  int64
	Sequence     int64
	Publications []Publication
	Fingerprint  [32]byte
	CreatedAt    time.Time
}

type ObservationPage struct {
	Observations []Observation
	Next         *Cursor
}

type Repository interface {
	Prepare(context.Context, OperationInput) (PrepareResult, error)
	MarkDispatching(context.Context, string, Effect) (Receipt, error)
	ResetForRetry(context.Context, string, Effect) (Receipt, error)
	Complete(context.Context, string, Effect, Completion) (Receipt, error)
	Get(context.Context, string, Effect) (Receipt, error)
	AppendObservation(context.Context, ObservationInput) (Observation, error)
	ListObservations(context.Context, utilities.ID, utilities.ID, *Cursor, int) (ObservationPage, error)
}

type canonicalPayload struct {
	Effect                       Effect  `json:"effect"`
	TenantID                     string  `json:"tenant_id"`
	SessionID                    string  `json:"session_id"`
	ParticipantSessionID         *string `json:"participant_session_id,omitempty"`
	ParticipantSessionGeneration *int64  `json:"participant_session_generation,omitempty"`
	PublicationSource            *string `json:"publication_source,omitempty"`
	RecordingID                  *string `json:"recording_id,omitempty"`
}

type canonicalPublication struct {
	ParticipantSessionID string `json:"participant_session_id"`
	Source               string `json:"source"`
	Enabled              bool   `json:"enabled"`
}

func Canonicalize(input OperationInput) (CanonicalOperation, error) {
	input.OperationID = strings.TrimSpace(input.OperationID)
	if err := ValidateIdentity(input.OperationID, input.Effect); err != nil {
		return CanonicalOperation{}, err
	}
	if input.TenantID.IsZero() {
		return CanonicalOperation{}, ErrInvalidTenantID
	}
	if input.SessionID.IsZero() {
		return CanonicalOperation{}, ErrInvalidSessionID
	}

	participantPresent := !input.ParticipantSessionID.IsZero()
	if !participantPresent && input.ParticipantSessionGeneration != 0 {
		return CanonicalOperation{}, ErrInvalidParticipantGeneration
	}
	if participantPresent && input.ParticipantSessionGeneration < 0 {
		return CanonicalOperation{}, ErrInvalidParticipantGeneration
	}

	input.PublicationSource = strings.ToLower(strings.TrimSpace(input.PublicationSource))
	if input.PublicationSource != "" && !validPublicationSource(input.PublicationSource) {
		return CanonicalOperation{}, ErrInvalidPublicationSource
	}

	if err := validateEffectFields(input); err != nil {
		return CanonicalOperation{}, err
	}

	payload := canonicalPayload{Effect: input.Effect, TenantID: input.TenantID.String(), SessionID: input.SessionID.String()}
	if participantPresent {
		id := input.ParticipantSessionID.String()
		payload.ParticipantSessionID = &id
		if input.ParticipantSessionGeneration > 0 {
			generation := input.ParticipantSessionGeneration
			payload.ParticipantSessionGeneration = &generation
		}
	}
	if input.PublicationSource != "" {
		payload.PublicationSource = &input.PublicationSource
	}
	if !input.RecordingID.IsZero() {
		id := input.RecordingID.String()
		payload.RecordingID = &id
	}
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		return CanonicalOperation{}, fmt.Errorf("marshal provider operation payload: %w", err)
	}
	if len(payloadBytes) > MaxPayloadBytes {
		return CanonicalOperation{}, fmt.Errorf("provider operation payload exceeds %d bytes", MaxPayloadBytes)
	}
	return CanonicalOperation{Input: input, Payload: payloadBytes, Fingerprint: sha256.Sum256(payloadBytes)}, nil
}

func ValidateIdentity(operationID string, effect Effect) error {
	if len(operationID) < MinOperationIDBytes || len(operationID) > MaxOperationIDBytes || !validOperationID(operationID) {
		return ErrInvalidOperationID
	}
	if !validEffect(effect) {
		return ErrInvalidEffect
	}
	return nil
}

func (input OperationInput) Canonicalize() (CanonicalOperation, error) {
	return Canonicalize(input)
}

func Fingerprint(input OperationInput) ([32]byte, error) {
	canonical, err := Canonicalize(input)
	if err != nil {
		return [32]byte{}, err
	}
	return canonical.Fingerprint, nil
}

func (completion Completion) Validate() error {
	if !validOutcome(completion.Outcome) {
		return ErrInvalidOutcome
	}
	if completion.Outcome == OutcomeRetryableFailure || completion.Outcome == OutcomeAmbiguous {
		return ErrNonTerminalOutcome
	}
	if completion.Reason == nil {
		return nil
	}
	reason := strings.TrimSpace(*completion.Reason)
	if reason == "" || len(reason) > MaxReasonBytes {
		return ErrInvalidReason
	}
	return nil
}

func CanonicalizeObservation(input ObservationInput) (ObservationInput, [32]byte, json.RawMessage, error) {
	if input.TenantID.IsZero() {
		return ObservationInput{}, [32]byte{}, nil, ErrInvalidTenantID
	}
	if input.SessionID.IsZero() {
		return ObservationInput{}, [32]byte{}, nil, ErrInvalidSessionID
	}
	if input.Incarnation < 0 || input.Sequence < 0 {
		return ObservationInput{}, [32]byte{}, nil, ErrInvalidObservationCursor
	}
	if len(input.Publications) > MaxPublications {
		return ObservationInput{}, [32]byte{}, nil, fmt.Errorf("provider observation exceeds %d publications", MaxPublications)
	}
	input.Publications = append([]Publication(nil), input.Publications...)
	seen := make(map[string]struct{}, len(input.Publications))
	for index := range input.Publications {
		publication := &input.Publications[index]
		if publication.ParticipantSessionID.IsZero() {
			return ObservationInput{}, [32]byte{}, nil, ErrInvalidParticipantID
		}
		publication.Source = strings.ToLower(strings.TrimSpace(publication.Source))
		if !validPublicationSource(publication.Source) {
			return ObservationInput{}, [32]byte{}, nil, ErrInvalidPublicationSource
		}
		key := publication.ParticipantSessionID.String() + "\x00" + publication.Source
		if _, exists := seen[key]; exists {
			return ObservationInput{}, [32]byte{}, nil, ErrObservationConflict
		}
		seen[key] = struct{}{}
	}
	sort.Slice(input.Publications, func(left, right int) bool {
		if input.Publications[left].ParticipantSessionID.String() == input.Publications[right].ParticipantSessionID.String() {
			return input.Publications[left].Source < input.Publications[right].Source
		}
		return input.Publications[left].ParticipantSessionID.String() < input.Publications[right].ParticipantSessionID.String()
	})
	publications := make([]canonicalPublication, len(input.Publications))
	for index, publication := range input.Publications {
		publications[index] = canonicalPublication{ParticipantSessionID: publication.ParticipantSessionID.String(), Source: publication.Source, Enabled: publication.Enabled}
	}
	payload, err := json.Marshal(publications)
	if err != nil {
		return ObservationInput{}, [32]byte{}, nil, fmt.Errorf("marshal provider observation: %w", err)
	}
	if len(payload) > MaxPayloadBytes {
		return ObservationInput{}, [32]byte{}, nil, fmt.Errorf("provider observation exceeds %d bytes", MaxPayloadBytes)
	}
	return input, sha256.Sum256(payload), payload, nil
}

func (input ObservationInput) Canonicalize() (ObservationInput, [32]byte, json.RawMessage, error) {
	return CanonicalizeObservation(input)
}

func (input ObservationInput) Cursor() Cursor {
	return Cursor{Incarnation: input.Incarnation, Sequence: input.Sequence}
}

func FingerprintHex(value [32]byte) string {
	return hex.EncodeToString(value[:])
}

func validateEffectFields(input OperationInput) error {
	participantRequired := input.Effect == EffectGrantPublication || input.Effect == EffectRevokePublication || input.Effect == EffectRemoveParticipant
	if participantRequired && input.ParticipantSessionID.IsZero() {
		return ErrInvalidParticipantID
	}
	publicationRequired := input.Effect == EffectGrantPublication || input.Effect == EffectRevokePublication
	if publicationRequired && input.PublicationSource == "" {
		return ErrInvalidPublicationSource
	}
	if !publicationRequired && input.PublicationSource != "" {
		return ErrInvalidPublicationSource
	}
	recordingRequired := input.Effect == EffectStartRecording || input.Effect == EffectStopRecording
	if recordingRequired && input.RecordingID.IsZero() {
		return ErrInvalidRecordingID
	}
	if !recordingRequired && !input.RecordingID.IsZero() {
		return ErrInvalidRecordingID
	}
	if !participantRequired && !input.ParticipantSessionID.IsZero() {
		return ErrInvalidParticipantID
	}
	return nil
}

func validOperationID(value string) bool {
	for _, character := range value {
		if (character < 'a' || character > 'z') && (character < 'A' || character > 'Z') && (character < '0' || character > '9') && character != '_' && character != '-' {
			return false
		}
	}
	return true
}

func validEffect(value Effect) bool {
	switch value {
	case EffectGrantPublication, EffectRevokePublication, EffectRemoveParticipant, EffectEndSession, EffectStartRecording, EffectStopRecording:
		return true
	default:
		return false
	}
}

func validOutcome(value Outcome) bool {
	switch value {
	case OutcomeConfirmed, OutcomeSatisfied, OutcomeRetryableFailure, OutcomeTerminalFailure, OutcomeAmbiguous:
		return true
	default:
		return false
	}
}

func validPublicationSource(value string) bool {
	switch value {
	case "microphone", "camera", "screen":
		return true
	default:
		return false
	}
}
