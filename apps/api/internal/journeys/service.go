package journeys

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	ErrEmptyEventBatch          = errors.New("journey event batch is empty")
	ErrEventBatchTooLarge       = errors.New("journey event batch exceeds limit")
	ErrInvalidEvent             = errors.New("invalid journey event")
	ErrInvalidJourneyID         = errors.New("invalid journey id")
	ErrJourneyNotFound          = errors.New("journey not found")
	ErrJourneyLedgerUnavailable = errors.New("journey ledger unavailable")
)

const (
	MaxEventsPerBatch = 100
	MaxAttributes     = 32
	MaxAttributeKey   = 96
	MaxAttributeText  = 1024
	MaxFieldLength    = 128
)

type Event struct {
	EventID            utilities.ID
	JourneyID          utilities.ID
	Sequence           int64
	OccurredAt         time.Time
	Name               string
	Phase              string
	State              string
	OriginKind         string
	FirstObservedLayer string
	UpstreamVisibility string
	ParentEventID      utilities.ID
	TraceID            *string
	SpanID             *string
	Attributes         json.RawMessage
	ReceivedAt         time.Time
}

type IntakeInput struct {
	Events []Event
}

type IntakeResult struct {
	AcceptedCount  int
	DuplicateCount int
	JourneyIDs     []utilities.ID
}

type Ledger struct {
	JourneyID     utilities.ID
	Events        []Event
	TerminalState *string
}

type Repository interface {
	Append(ctx context.Context, events []Event) (accepted int, duplicate int, err error)
	Get(ctx context.Context, journeyID utilities.ID) (Ledger, error)
}

type Service struct {
	repository Repository
}

func NewService(repository Repository) Service {
	return Service{repository: repository}
}

func (s Service) Intake(ctx context.Context, input IntakeInput) (IntakeResult, error) {
	if s.repository == nil {
		return IntakeResult{}, ErrJourneyLedgerUnavailable
	}
	if len(input.Events) == 0 {
		return IntakeResult{}, ErrEmptyEventBatch
	}
	if len(input.Events) > MaxEventsPerBatch {
		return IntakeResult{}, ErrEventBatchTooLarge
	}

	journeyIDs := make([]utilities.ID, 0, len(input.Events))
	seenJourneys := make(map[string]struct{}, len(input.Events))
	for index := range input.Events {
		if err := prepareEvent(&input.Events[index]); err != nil {
			return IntakeResult{}, fmt.Errorf("event %d: %w", index, err)
		}
		journeyID := input.Events[index].JourneyID
		if _, seen := seenJourneys[journeyID.String()]; !seen {
			seenJourneys[journeyID.String()] = struct{}{}
			journeyIDs = append(journeyIDs, journeyID)
		}
	}

	accepted, duplicate, err := s.repository.Append(ctx, input.Events)
	if err != nil {
		return IntakeResult{}, err
	}

	return IntakeResult{
		AcceptedCount:  accepted,
		DuplicateCount: duplicate,
		JourneyIDs:     journeyIDs,
	}, nil
}

func (s Service) Get(ctx context.Context, journeyID utilities.ID) (Ledger, error) {
	if s.repository == nil {
		return Ledger{}, ErrJourneyLedgerUnavailable
	}
	if journeyID.IsZero() {
		return Ledger{}, ErrInvalidJourneyID
	}
	return s.repository.Get(ctx, journeyID)
}

func prepareEvent(event *Event) error {
	if event.EventID.IsZero() || event.JourneyID.IsZero() || event.Sequence < 0 || event.OccurredAt.IsZero() {
		return ErrInvalidEvent
	}
	for _, value := range []*string{&event.Name, &event.Phase, &event.State, &event.OriginKind, &event.FirstObservedLayer, &event.UpstreamVisibility} {
		prepared, err := requiredField(*value)
		if err != nil {
			return ErrInvalidEvent
		}
		*value = prepared
	}
	event.Phase = strings.ToLower(event.Phase)
	event.State = strings.ToLower(event.State)

	traceID, err := optionalTraceField(event.TraceID, 16)
	if err != nil {
		return ErrInvalidEvent
	}
	event.TraceID = traceID
	spanID, err := optionalTraceField(event.SpanID, 8)
	if err != nil {
		return ErrInvalidEvent
	}
	event.SpanID = spanID

	attributes, err := boundedAttributes(event.Attributes)
	if err != nil {
		return ErrInvalidEvent
	}
	event.Attributes = attributes
	return nil
}

func requiredField(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > MaxFieldLength {
		return "", ErrInvalidEvent
	}
	return value, nil
}

func optionalTraceField(value *string, byteLength int) (*string, error) {
	if value == nil {
		return nil, nil
	}
	prepared := strings.ToLower(strings.TrimSpace(*value))
	decoded, err := hex.DecodeString(prepared)
	if err != nil || len(decoded) != byteLength {
		return nil, ErrInvalidEvent
	}
	allZero := true
	for _, part := range decoded {
		if part != 0 {
			allZero = false
			break
		}
	}
	if allZero {
		return nil, ErrInvalidEvent
	}
	return &prepared, nil
}

func boundedAttributes(raw json.RawMessage) (json.RawMessage, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return json.RawMessage(`{}`), nil
	}

	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.UseNumber()
	attributes := map[string]any{}
	if err := decoder.Decode(&attributes); err != nil {
		return nil, err
	}
	if len(attributes) > MaxAttributes {
		return nil, ErrInvalidEvent
	}
	for key, value := range attributes {
		if strings.TrimSpace(key) == "" || len(key) > MaxAttributeKey || !primitiveAttribute(value) {
			return nil, ErrInvalidEvent
		}
	}

	prepared, err := json.Marshal(attributes)
	if err != nil {
		return nil, err
	}
	return json.RawMessage(prepared), nil
}

func primitiveAttribute(value any) bool {
	switch value := value.(type) {
	case string:
		return len(value) <= MaxAttributeText
	case bool:
		return true
	case json.Number:
		parsed, err := value.Float64()
		return err == nil && !math.IsInf(parsed, 0) && !math.IsNaN(parsed)
	default:
		return false
	}
}

func IsTerminalState(state string) bool {
	switch strings.ToLower(strings.TrimSpace(state)) {
	case "completed", "succeeded", "failed", "cancelled", "canceled":
		return true
	default:
		return false
	}
}

func IsTerminalEvent(event Event) bool {
	return strings.EqualFold(strings.TrimSpace(event.Phase), "terminal") && IsTerminalState(event.State)
}
