package provideroperations

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/artifactpolicy"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type Effect string

const (
	EffectGrantPublication  Effect = "media.grant_publication"
	EffectRevokePublication Effect = "media.revoke_publication"
	EffectRemoveParticipant Effect = "media.remove_participant"
	EffectEndEpisode        Effect = "media.end_episode"
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
	ErrInvalidEpisodeID             = errors.New("invalid provider operation episode id")
	ErrInvalidParticipantID         = errors.New("invalid provider operation participant id")
	ErrInvalidParticipantGeneration = errors.New("invalid provider operation participant generation")
	ErrInvalidPublicationSource     = errors.New("invalid provider publication source")
	ErrInvalidPublicationID         = errors.New("invalid provider publication id")
	ErrInvalidRecordingID           = errors.New("invalid provider operation recording id")
	ErrInvalidRecordingReservation  = errors.New("invalid provider recording reservation")
	ErrReceiptPayloadCorrupt        = errors.New("provider operation receipt payload is corrupt")
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
	OperationID           string
	Effect                Effect
	TenantID              utilities.ID
	EpisodeID             utilities.ID
	ParticipantID         utilities.ID
	ParticipantGeneration int64
	PublicationSource     string
	RecordingID           utilities.ID
	RecordingReservation  *RecordingReservation
}

// RecordingReservation is the immutable, server-derived admission envelope
// for a recording.start provider operation.
type RecordingReservation struct {
	SpaceID               utilities.ID
	ParticipantCount      int
	MaxDurationSeconds    int
	InputBitrateBPS       int64
	PolicySnapshotVersion string
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
	OperationID           string
	Effect                Effect
	TenantID              utilities.ID
	EpisodeID             utilities.ID
	ParticipantID         utilities.ID
	ParticipantGeneration int64
	PublicationSource     string
	RecordingID           utilities.ID
	Fingerprint           [32]byte
	Payload               json.RawMessage
	State                 ReceiptState
	Outcome               *Outcome
	Reason                *string
	CreatedAt             time.Time
	DispatchingAt         *time.Time
	CompletedAt           *time.Time
}

type PrepareResult struct {
	Receipt Receipt
	Replay  bool
}

type Publication struct {
	ParticipantID utilities.ID
	Source        string
	Enabled       bool
	PublicationID string
}

type ObservationInput struct {
	TenantID     utilities.ID
	EpisodeID    utilities.ID
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
	EpisodeID    utilities.ID
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
	Effect                Effect                         `json:"effect"`
	TenantID              string                         `json:"tenant_id"`
	EpisodeID             string                         `json:"episode_id"`
	ParticipantID         *string                        `json:"participant_id,omitempty"`
	ParticipantGeneration *int64                         `json:"participant_generation,omitempty"`
	PublicationSource     *string                        `json:"publication_source,omitempty"`
	RecordingID           *string                        `json:"recording_id,omitempty"`
	RecordingReservation  *canonicalRecordingReservation `json:"recording_reservation,omitempty"`
}

type canonicalRecordingReservation struct {
	SpaceID               string `json:"space_id"`
	ParticipantCount      int    `json:"participant_count"`
	MaxDurationSeconds    int    `json:"max_duration_seconds"`
	InputBitrateBPS       int64  `json:"input_bitrate_bps"`
	PolicySnapshotVersion string `json:"policy_snapshot_version"`
}

type canonicalPublication struct {
	ParticipantID string  `json:"participant_id"`
	Source        string  `json:"source"`
	Enabled       bool    `json:"enabled"`
	PublicationID *string `json:"publication_id"`
}

func Canonicalize(input OperationInput) (CanonicalOperation, error) {
	input.OperationID = strings.TrimSpace(input.OperationID)
	if err := ValidateIdentity(input.OperationID, input.Effect); err != nil {
		return CanonicalOperation{}, err
	}
	if input.TenantID.IsZero() {
		return CanonicalOperation{}, ErrInvalidTenantID
	}
	if input.EpisodeID.IsZero() {
		return CanonicalOperation{}, ErrInvalidEpisodeID
	}

	participantPresent := !input.ParticipantID.IsZero()
	if !participantPresent && input.ParticipantGeneration != 0 {
		return CanonicalOperation{}, ErrInvalidParticipantGeneration
	}
	if participantPresent && input.ParticipantGeneration < 0 {
		return CanonicalOperation{}, ErrInvalidParticipantGeneration
	}

	input.PublicationSource = strings.ToLower(strings.TrimSpace(input.PublicationSource))
	if input.PublicationSource != "" && !validPublicationSource(input.PublicationSource) {
		return CanonicalOperation{}, ErrInvalidPublicationSource
	}

	if err := validateEffectFields(input); err != nil {
		return CanonicalOperation{}, err
	}
	if input.RecordingReservation != nil {
		if err := input.RecordingReservation.Validate(); err != nil {
			return CanonicalOperation{}, err
		}
	}

	payload := canonicalPayload{Effect: input.Effect, TenantID: input.TenantID.String(), EpisodeID: input.EpisodeID.String()}
	if participantPresent {
		id := input.ParticipantID.String()
		payload.ParticipantID = &id
		if input.ParticipantGeneration > 0 {
			generation := input.ParticipantGeneration
			payload.ParticipantGeneration = &generation
		}
	}
	if input.PublicationSource != "" {
		payload.PublicationSource = &input.PublicationSource
	}
	if !input.RecordingID.IsZero() {
		id := input.RecordingID.String()
		payload.RecordingID = &id
	}
	if input.RecordingReservation != nil {
		reservation := input.RecordingReservation
		payload.RecordingReservation = &canonicalRecordingReservation{
			SpaceID:               reservation.SpaceID.String(),
			ParticipantCount:      reservation.ParticipantCount,
			MaxDurationSeconds:    reservation.MaxDurationSeconds,
			InputBitrateBPS:       reservation.InputBitrateBPS,
			PolicySnapshotVersion: reservation.PolicySnapshotVersion,
		}
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

func (reservation RecordingReservation) Validate() error {
	if reservation.SpaceID.IsZero() || reservation.ParticipantCount < 1 || reservation.ParticipantCount > 10 ||
		reservation.MaxDurationSeconds < 1 || reservation.MaxDurationSeconds > 7200 ||
		reservation.InputBitrateBPS < 1 || reservation.InputBitrateBPS > 4_000_000 ||
		reservation.PolicySnapshotVersion != artifactpolicy.SnapshotSchemaVersion {
		return ErrInvalidRecordingReservation
	}
	return nil
}

// OperationFromReceipt reconstructs the dispatch input from the canonical
// payload persisted with a provider receipt. Scalar receipt columns are
// checked as a second integrity boundary so a corrupt row cannot dispatch.
func OperationFromReceipt(receipt Receipt) (OperationInput, error) {
	var payload canonicalPayload
	decoder := json.NewDecoder(bytes.NewReader(receipt.Payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil {
		return OperationInput{}, errors.Join(ErrReceiptPayloadCorrupt, err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return OperationInput{}, ErrReceiptPayloadCorrupt
	}

	input := OperationInput{OperationID: receipt.OperationID, Effect: payload.Effect, TenantID: utilities.ID{}, EpisodeID: utilities.ID{}}
	var err error
	if input.TenantID, err = utilities.ParseID(payload.TenantID); err != nil {
		return OperationInput{}, errors.Join(ErrReceiptPayloadCorrupt, ErrInvalidTenantID)
	}
	if input.EpisodeID, err = utilities.ParseID(payload.EpisodeID); err != nil {
		return OperationInput{}, errors.Join(ErrReceiptPayloadCorrupt, ErrInvalidEpisodeID)
	}
	if payload.ParticipantID != nil {
		if input.ParticipantID, err = utilities.ParseID(*payload.ParticipantID); err != nil {
			return OperationInput{}, errors.Join(ErrReceiptPayloadCorrupt, ErrInvalidParticipantID)
		}
	}
	if payload.ParticipantGeneration != nil {
		input.ParticipantGeneration = *payload.ParticipantGeneration
	}
	if payload.PublicationSource != nil {
		input.PublicationSource = *payload.PublicationSource
	}
	if payload.RecordingID != nil {
		if input.RecordingID, err = utilities.ParseID(*payload.RecordingID); err != nil {
			return OperationInput{}, errors.Join(ErrReceiptPayloadCorrupt, ErrInvalidRecordingID)
		}
	}
	if payload.RecordingReservation != nil {
		spaceID, parseErr := utilities.ParseID(payload.RecordingReservation.SpaceID)
		if parseErr != nil {
			return OperationInput{}, errors.Join(ErrReceiptPayloadCorrupt, ErrInvalidRecordingReservation)
		}
		input.RecordingReservation = &RecordingReservation{
			SpaceID:               spaceID,
			ParticipantCount:      payload.RecordingReservation.ParticipantCount,
			MaxDurationSeconds:    payload.RecordingReservation.MaxDurationSeconds,
			InputBitrateBPS:       payload.RecordingReservation.InputBitrateBPS,
			PolicySnapshotVersion: payload.RecordingReservation.PolicySnapshotVersion,
		}
	}

	canonical, err := Canonicalize(input)
	if err != nil || canonical.Fingerprint != receipt.Fingerprint ||
		receipt.Effect != input.Effect || receipt.TenantID != input.TenantID || receipt.EpisodeID != input.EpisodeID ||
		receipt.ParticipantID != input.ParticipantID || receipt.ParticipantGeneration != input.ParticipantGeneration ||
		receipt.PublicationSource != input.PublicationSource || receipt.RecordingID != input.RecordingID {
		if err != nil {
			return OperationInput{}, errors.Join(ErrReceiptPayloadCorrupt, err)
		}
		return OperationInput{}, ErrReceiptPayloadCorrupt
	}
	return canonical.Input, nil
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
	if input.EpisodeID.IsZero() {
		return ObservationInput{}, [32]byte{}, nil, ErrInvalidEpisodeID
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
		if publication.ParticipantID.IsZero() {
			return ObservationInput{}, [32]byte{}, nil, ErrInvalidParticipantID
		}
		publication.Source = strings.ToLower(strings.TrimSpace(publication.Source))
		if !validPublicationSource(publication.Source) {
			return ObservationInput{}, [32]byte{}, nil, ErrInvalidPublicationSource
		}
		publication.PublicationID = strings.TrimSpace(publication.PublicationID)
		if len(publication.PublicationID) > 256 || publication.Enabled != (publication.PublicationID != "") {
			return ObservationInput{}, [32]byte{}, nil, ErrInvalidPublicationID
		}
		key := publication.ParticipantID.String() + "\x00" + publication.Source
		if _, exists := seen[key]; exists {
			return ObservationInput{}, [32]byte{}, nil, ErrObservationConflict
		}
		seen[key] = struct{}{}
	}
	sort.Slice(input.Publications, func(left, right int) bool {
		if input.Publications[left].ParticipantID.String() == input.Publications[right].ParticipantID.String() {
			return input.Publications[left].Source < input.Publications[right].Source
		}
		return input.Publications[left].ParticipantID.String() < input.Publications[right].ParticipantID.String()
	})
	publications := make([]canonicalPublication, len(input.Publications))
	for index, publication := range input.Publications {
		canonical := canonicalPublication{ParticipantID: publication.ParticipantID.String(), Source: publication.Source, Enabled: publication.Enabled}
		if publication.PublicationID != "" {
			canonical.PublicationID = &publication.PublicationID
		}
		publications[index] = canonical
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
	if participantRequired && input.ParticipantID.IsZero() {
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
	if !participantRequired && !input.ParticipantID.IsZero() {
		return ErrInvalidParticipantID
	}
	if input.Effect == EffectStartRecording && input.RecordingReservation == nil {
		return ErrInvalidRecordingReservation
	}
	if input.Effect != EffectStartRecording && input.RecordingReservation != nil {
		return ErrInvalidRecordingReservation
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
	case EffectGrantPublication, EffectRevokePublication, EffectRemoveParticipant, EffectEndEpisode, EffectStartRecording, EffectStopRecording:
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
