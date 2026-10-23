package problemreports

import (
	"context"
	"errors"
	"fmt"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const (
	MaxDescriptionCodePoints = 1000
	MaxDiagnosticsCodePoints = 2000
)

var (
	ErrUnavailable        = errors.New("problem reports unavailable")
	ErrCredentials        = errors.New("remove links and codes before sending a report")
	ErrInvalid            = errors.New("invalid problem report")
	ErrForbidden          = errors.New("report participant not found")
	ErrDelivery           = errors.New("problem report delivery failed")
	ErrJourneyPermission  = errors.New("journey write permission denied")
	ErrJourneyConstraint  = errors.New("journey write constraint violation")
	ErrJourneyUnavailable = errors.New("journey store unavailable")
)

type Report struct {
	Description string `json:"description"`
	Diagnostics string `json:"diagnostics,omitempty"`
}

type Attribution struct{ SpaceName, ReporterName, Role string }
type Repository interface {
	Attribution(context.Context, accessgrants.Subject) (Attribution, error)
	RecordDelivery(context.Context, accessgrants.Subject, utilities.ID) error
}

// Delivery contains only the fields approved for problem-report forwarding.
type Delivery struct {
	Report
	Attribution
	CallID utilities.ID
}

type Sender interface {
	Send(context.Context, Delivery) error
}

// CredentialSource supplies live call credentials for rejection, never delivery.
type CredentialSource interface {
	Credentials(context.Context, accessgrants.Subject) ([]string, error)
}

type Service struct {
	repository       Repository
	credentials      CredentialSource
	knownCredentials []string
	sender           Sender
	tracer           trace.Tracer
}

func NewService(repository Repository, sender Sender) Service {
	scope := "github.com/q9labs/chalk/apps/api/internal/problemreports"
	return Service{repository: repository, sender: sender, tracer: otel.Tracer(scope)}
}

func (s Service) Available() bool { return s.sender != nil }

func (s Service) WithCredentials(source CredentialSource, known ...string) Service {
	s.credentials = source
	s.knownCredentials = append([]string(nil), known...)
	return s
}

func (s Service) Send(ctx context.Context, subject accessgrants.Subject, report Report) (Result, error) {
	if !s.Available() {
		return Result{Outcome: OutcomeDisabled}, ErrUnavailable
	}
	if strings.TrimSpace(report.Description) == "" {
		return Result{Outcome: OutcomeDescriptionBlank}, ErrInvalid
	}
	if utf8.RuneCountInString(report.Description) > MaxDescriptionCodePoints {
		return Result{Outcome: OutcomeDescriptionTooLong}, ErrInvalid
	}
	if utf8.RuneCountInString(report.Diagnostics) > MaxDiagnosticsCodePoints {
		return Result{Outcome: OutcomeDiagnosticsTooLong}, ErrInvalid
	}
	attribution, err := s.repository.Attribution(ctx, subject)
	if err != nil {
		if errors.Is(err, ErrForbidden) {
			return Result{Outcome: OutcomeParticipantBindingMismatch}, ErrForbidden
		}
		return Result{Outcome: OutcomeAttributionFailed}, errors.New("problem report attribution unavailable")
	}
	credentials := append([]string(nil), s.knownCredentials...)
	if s.credentials != nil {
		live, err := s.credentials.Credentials(ctx, subject)
		if err != nil {
			return Result{Outcome: OutcomeCredentialSourceFailed}, fmt.Errorf("%w: credentials_unavailable", ErrDelivery)
		}
		credentials = append(credentials, live...)
	}
	if requestCredentials, ok := ctx.Value(credentialContextKey{}).([]string); ok {
		credentials = append(credentials, requestCredentials...)
	}
	// Catch accidental pastes in each field and splits across the two form inputs.
	// Deliberate reconstruction across unrelated attribution fields is out of scope.
	for _, text := range []string{attribution.SpaceName, attribution.ReporterName, attribution.Role, subject.EpisodeID.String(), report.Description, report.Diagnostics, report.Description + "\n" + report.Diagnostics} {
		if containsKnownCredential(text, credentials) || containsCredential(text) {
			return Result{Outcome: OutcomeCredentialsDetected}, ErrCredentials
		}
	}
	reportID, err := utilities.NewID()
	if err != nil {
		return Result{Outcome: OutcomeIDGenerationFailed}, fmt.Errorf("%w: id_generation", ErrDelivery)
	}
	ctx, span := s.tracer.Start(ctx, "problem_report.delivery", trace.WithAttributes(attribute.String("chalk.episode_id", subject.EpisodeID.String()), attribute.String("chalk.report_id", reportID.String())))
	defer span.End()
	if err := s.sender.Send(ctx, Delivery{Report: report, Attribution: attribution, CallID: subject.EpisodeID}); err != nil {
		result := Result{Outcome: OutcomeDiscordFailed, ReportID: reportID}
		var failure DeliveryError
		if errors.As(err, &failure) {
			return result, failure
		}
		return result, ErrDelivery
	}

	// Once Discord accepted the report, telemetry failure must not invite a duplicate.
	evidenceCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
	defer cancel()
	if err := s.repository.RecordDelivery(evidenceCtx, subject, reportID); err != nil {
		return Result{Outcome: journeyFailureOutcome(err), ReportID: reportID}, nil
	}
	return Result{Outcome: OutcomeAccepted, ReportID: reportID}, nil
}

func journeyFailureOutcome(err error) Outcome {
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return OutcomeJourneyTimeout
	case errors.Is(err, context.Canceled):
		return OutcomeJourneyCanceled
	case errors.Is(err, ErrJourneyPermission):
		return OutcomeJourneyPermission
	case errors.Is(err, ErrJourneyConstraint):
		return OutcomeJourneyConstraint
	case errors.Is(err, ErrJourneyUnavailable):
		return OutcomeJourneyUnavailable
	default:
		return OutcomeJourneyInternal
	}
}
