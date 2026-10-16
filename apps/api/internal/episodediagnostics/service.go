package episodediagnostics

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"

	"errors"

	"time"

	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	ErrDisabled         = errors.New("episode diagnostics are disabled")
	ErrUnauthenticated  = errors.New("diagnostic principal is unauthenticated")
	ErrForbidden        = errors.New("diagnostic principal is forbidden")
	ErrNotFound         = errors.New("episode diagnostic not found")
	ErrConflict         = errors.New("diagnostic event fingerprint conflict")
	ErrCapacity         = errors.New("diagnostic capacity exceeded")
	ErrInvalidScope     = errors.New("invalid diagnostic scope")
	ErrInvalidReference = errors.New("invalid diagnostic reference")
)

const (
	MaxAppendEvents      = 200
	DefaultPageSize      = 100
	RetentionPeriod      = 7 * 24 * time.Hour
	MaximumEpilogueLease = 24 * time.Hour
)

type ProducerKind string

const (
	ProducerParticipant ProducerKind = "participant"
	ProducerService     ProducerKind = "service"
)

type ProducerPrincipal struct {
	Kind                  ProducerKind
	ID                    string
	ServiceID             string
	InstanceID            string
	Generation            int64
	Environment           Environment
	TenantID              utilities.ID
	SpaceID               utilities.ID
	EpisodeID             utilities.ID
	ParticipantID         utilities.ID
	ParticipantGeneration int64
	AllowedSources        map[EventSource]struct{}
}

type AuthoritativeEpisode struct {
	Episode     episodes.Episode
	StartedLate bool
}

type Repository interface {
	Ensure(context.Context, AuthoritativeEpisode, Environment) (EpisodeDiagnostic, error)
	Reconcile(context.Context, Environment, time.Time, int) ([]EpisodeDiagnostic, error)
	ResolveScope(context.Context, AppendScope, int64) (EpisodeDiagnostic, error)
	Append(context.Context, EpisodeDiagnostic, *utilities.ID, []ValidatedEvent) (AppendDiagnosticEventsResult, error)
	Retain(context.Context, time.Time, int) (int, error)
}

type Telemetry interface {
	RecordDiagnostic(context.Context, string, string, string, time.Duration)
}

type Service struct {
	repository  Repository
	telemetry   Telemetry
	environment Environment
	hmacKey     []byte
	now         func() time.Time
}

func NewService(repository Repository, environment Environment, hmacKey []byte, telemetry Telemetry) Service {
	return Service{repository: repository, environment: environment, hmacKey: append([]byte(nil), hmacKey...), telemetry: telemetry, now: time.Now}
}

func (s Service) Ensure(ctx context.Context, episode episodes.Episode, startedLate bool) (EpisodeDiagnostic, error) {
	if s.repository == nil {
		return EpisodeDiagnostic{}, ErrDisabled
	}
	diagnostic, err := s.repository.Ensure(ctx, AuthoritativeEpisode{Episode: episode, StartedLate: startedLate}, s.environment)
	if err != nil {
		return EpisodeDiagnostic{}, err
	}
	if err := validateEnvironment(s.environment, diagnostic.Environment); err != nil {
		return EpisodeDiagnostic{}, err
	}
	return sanitizeDiagnosticConfig(diagnostic), nil
}

func (s Service) Append(ctx context.Context, principal ProducerPrincipal, request AppendDiagnosticEventsRequest) (AppendDiagnosticEventsResult, error) {
	started := s.now()
	if s.repository == nil {
		return AppendDiagnosticEventsResult{}, ErrDisabled
	}
	if len(request.Events) > MaxAppendEvents {
		s.record(ctx, "append", "rejected", "capacity", started)
		return AppendDiagnosticEventsResult{}, ErrCapacity
	}
	if err := ValidateAppendRequest(request); err != nil {
		s.record(ctx, "append", "rejected", "invalid", started)
		return AppendDiagnosticEventsResult{}, err
	}
	if err := authorizeProducer(principal, request); err != nil {
		s.record(ctx, "append", "rejected", "forbidden", started)
		return AppendDiagnosticEventsResult{}, err
	}
	if err := validateEnvironment(principal.Environment, s.environment); err != nil {
		s.record(ctx, "append", "rejected", "environment", started)
		return AppendDiagnosticEventsResult{}, err
	}
	scope, participantID, err := boundScope(principal, request.Scope)
	if err != nil {
		return AppendDiagnosticEventsResult{}, err
	}
	validated := make([]ValidatedEvent, 0, len(request.Events))
	for _, event := range request.Events {
		if _, ok := principal.AllowedSources[event.Source]; !ok {
			return AppendDiagnosticEventsResult{}, ErrForbidden
		}
		event, err = s.eventForStorage(event)
		if err != nil {
			return AppendDiagnosticEventsResult{}, err
		}
		item, validateErr := ValidateDraft(event)
		if validateErr != nil {
			return AppendDiagnosticEventsResult{}, validateErr
		}
		validated = append(validated, item)
	}
	diagnostic, err := s.repository.ResolveScope(ctx, scope, principal.ParticipantGeneration)
	if err != nil {
		return AppendDiagnosticEventsResult{}, err
	}
	if err := ValidateProducerEnvironment(principal, diagnostic); err != nil {
		s.record(ctx, "append", "rejected", "environment", started)
		return AppendDiagnosticEventsResult{}, err
	}
	if err := ValidateDiagnosticIntake(diagnostic, request.Events, started); err != nil {
		s.record(ctx, "append", "rejected", "lifecycle", started)
		return AppendDiagnosticEventsResult{}, err
	}
	diagnostic = sanitizeDiagnosticConfig(diagnostic)
	result, err := s.repository.Append(ctx, diagnostic, participantID, validated)
	if result.DiagnosticReference == "" {
		result.DiagnosticReference = referenceFor(diagnostic)
	}
	s.record(ctx, "append", outcome(err), errorClass(err), started)
	return result, err
}

func authorizeProducer(principal ProducerPrincipal, request AppendDiagnosticEventsRequest) error {
	if principal.ID == "" || principal.Environment == "" || len(principal.AllowedSources) == 0 {
		return ErrUnauthenticated
	}
	if request.Producer.ID != principal.ID || request.Producer.InstanceID != principal.InstanceID || request.Producer.Generation != principal.Generation {
		return ErrForbidden
	}
	return nil
}

func boundScope(principal ProducerPrincipal, supplied *AppendScope) (AppendScope, *utilities.ID, error) {
	bound := AppendScope{TenantID: principal.TenantID.String(), SpaceID: principal.SpaceID.String(), EpisodeID: principal.EpisodeID.String(), ParticipantID: principal.ParticipantID.String()}
	if principal.Kind == ProducerService {
		if supplied == nil {
			return AppendScope{}, nil, ErrInvalidScope
		}
		bound = *supplied
	} else if supplied != nil {
		if supplied.TenantID != bound.TenantID || supplied.SpaceID != bound.SpaceID || supplied.EpisodeID != bound.EpisodeID || supplied.ParticipantID != "" && supplied.ParticipantID != bound.ParticipantID {
			return AppendScope{}, nil, ErrForbidden
		}
	}
	var participant *utilities.ID
	if bound.ParticipantID != "" {
		id, err := utilities.ParseID(bound.ParticipantID)
		if err != nil {
			return AppendScope{}, nil, ErrInvalidScope
		}
		participant = &id
	}
	for _, value := range []string{bound.TenantID, bound.SpaceID, bound.EpisodeID} {
		if _, err := utilities.ParseID(value); err != nil {
			return AppendScope{}, nil, ErrInvalidScope
		}
	}
	return bound, participant, nil
}

func outcome(err error) string {
	if err != nil {
		return "failure"
	}
	return "success"
}

func errorClass(err error) string {
	switch {
	case err == nil:
		return "none"
	case errors.Is(err, ErrForbidden), errors.Is(err, ErrUnauthenticated):
		return "authorization"
	case errors.Is(err, ErrDiagnosticEnvironmentMismatch):
		return "environment"
	case errors.Is(err, ErrDiagnosticIntakeClosed):
		return "lifecycle_closed"
	case errors.Is(err, ErrDiagnosticExpired):
		return "expired"
	case errors.Is(err, ErrDiagnosticLifecycleInvalid):
		return "lifecycle"
	case errors.Is(err, ErrCapacity):
		return "capacity"
	case errors.Is(err, ErrConflict):
		return "conflict"
	default:
		var validationErr *ValidationError
		if errors.As(err, &validationErr) {
			return "validation"
		}
		return "internal"
	}
}

func (s Service) record(ctx context.Context, operation, result, reason string, started time.Time) {
	if s.telemetry != nil {
		s.telemetry.RecordDiagnostic(ctx, operation, result, reason, s.now().Sub(started))
	}
}

func (s Service) eventForStorage(event DiagnosticEventDraft) (DiagnosticEventDraft, error) {
	if event.Correlation == nil || event.Correlation.ProviderID == "" {
		return event, nil
	}
	if len(s.hmacKey) == 0 {
		return DiagnosticEventDraft{}, errors.New("provider identifier HMAC key is unavailable")
	}
	correlation := *event.Correlation
	correlation.ProviderID = s.safeIdentifierToken("provider", correlation.ProviderID)
	event.Correlation = &correlation
	return event, nil
}

func (s Service) safeIdentifierToken(idClass, value string) string {
	mac := hmac.New(sha256.New, s.hmacKey)
	_, _ = mac.Write([]byte(string(s.environment) + "\x00" + idClass + "\x00" + value))
	return "hmac:v1:" + hex.EncodeToString(mac.Sum(nil))
}

func referenceFor(diagnostic EpisodeDiagnostic) string {
	reference, _ := FormatReference(DiagnosticReference{Version: 1, Environment: diagnostic.Environment, DiagnosticID: diagnostic.ID})
	return reference
}
