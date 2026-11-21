package problemreports

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/obs"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const (
	MaxDescriptionCodePoints = 1000
	MaxDiagnosticsCodePoints = 2000
)

var (
	ErrUnavailable        = errors.New("problem reports unavailable")
	ErrInvalid            = errors.New("invalid problem report")
	ErrForbidden          = errors.New("report participant not found")
	ErrDelivery           = errors.New("problem report delivery failed")
	ErrNotStored          = errors.New("problem report not stored")
	ErrJourneyPermission  = errors.New("journey write permission denied")
	ErrJourneyConstraint  = errors.New("journey write constraint violation")
	ErrJourneyUnavailable = errors.New("journey store unavailable")
)

type Report struct {
	Description     string `json:"description"`
	Diagnostics     string `json:"diagnostics,omitempty"`
	ClientSessionID string `json:"client_session_id,omitempty"`
	SDKVersion      string `json:"sdk_version,omitempty"`
	PickedSymptom   string `json:"picked_symptom,omitempty"`
	JourneyID       string `json:"journey_id,omitempty"`
}

// StoredReport is what the durable commit needs beyond the subject's identity.
// Every field is already bounded: a label is dropped or replaced before it
// reaches the row, and the description and diagnostics never reach telemetry.
type StoredReport struct {
	ID              utilities.ID
	JourneyID       utilities.ID
	ChkCode         string
	ClientSessionID utilities.ID
	SDKVersion      string
	PickedSymptom   string
	Description     string
	Diagnostics     string
}

type Attribution struct{ SpaceName, ReporterName, Role string }
type Repository interface {
	Attribution(context.Context, accessgrants.Subject) (Attribution, error)
	StoreReport(context.Context, accessgrants.Subject, StoredReport) error
	SetForwardOutcome(context.Context, utilities.ID, utilities.ID, string) error
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

type Service struct {
	repository Repository
	sender     Sender
	tracer     trace.Tracer
}

func NewService(repository Repository, sender Sender) Service {
	scope := "github.com/q9labs/chalk/apps/api/internal/problemreports"
	return Service{repository: repository, sender: sender, tracer: otel.Tracer(scope)}
}

// Available is on whenever the store is configured; the Discord forward is optional.
func (s Service) Available() bool { return s.repository != nil }

// boundedLabel keeps a client-supplied label registry-safe: short and without
// spaces, so no free text reaches a row. It mirrors the client wire label.
var boundedLabel = regexp.MustCompile(`^[0-9A-Za-z][0-9A-Za-z._:+-]{0,63}$`)

// symptomLabel is the closed shape of a registry symptom code or its
// not_applicable placeholder.
var symptomLabel = regexp.MustCompile(`^[a-z][a-z0-9_.]{0,63}$`)

func normalizePickedSymptom(value string) string {
	value = strings.TrimSpace(value)
	if !symptomLabel.MatchString(value) {
		return "unavailable(not_picked)"
	}
	return value
}

func normalizeSDKVersion(value string) string {
	value = strings.TrimSpace(value)
	if !boundedLabel.MatchString(value) {
		return ""
	}
	return value
}

// clientSession normalizes the cs_ handle or bare uuid and derives the CHK
// code through the registry's one implementation.
func clientSession(value string) (utilities.ID, string) {
	value = strings.TrimPrefix(strings.TrimSpace(value), "cs_")
	id, err := utilities.ParseID(value)
	if err != nil {
		return utilities.ID{}, ""
	}
	code, err := obs.DiagnosticCode(id.String())
	if err != nil {
		return id, ""
	}
	return id, code
}

// reportJourney is the send's journey: the client's jr_ when the body names
// it, else the report's own id, matching the ledger event's journey.
func reportJourney(value string, reportID utilities.ID) utilities.ID {
	if id, err := utilities.ParseID(strings.TrimPrefix(strings.TrimSpace(value), "jr_")); err == nil {
		return id
	}
	return reportID
}

func (s Service) Send(ctx context.Context, subject accessgrants.Subject, report Report) (Result, error) {
	reportID, err := utilities.NewID()
	journeyID := reportJourney(report.JourneyID, reportID)
	picked := normalizePickedSymptom(report.PickedSymptom)
	sessionID, chkCode := clientSession(report.ClientSessionID)
	refused := func(outcome Outcome) Result {
		attrs := []slog.Attr{obs.F("journey_id", journeyID.String())}
		if !reportID.IsZero() {
			attrs = append(attrs, obs.F("report_id", reportID.String()))
		}
		attrs = append(attrs, obs.F("picked_symptom", picked))
		if chkCode != "" {
			attrs = append(attrs, obs.F("chk_code", chkCode))
		}
		result := Result{Outcome: outcome, ReportID: reportID, JourneyID: journeyID, Code: chkCode}
		if !journeyID.IsZero() {
			result.DecisionID = obs.Decision(ctx, "problem_report.submit", "refused", "report."+outcome.Cause(), attrs...)
		}
		return result
	}
	if !s.Available() {
		return refused(OutcomeDisabled), ErrUnavailable
	}
	if err != nil {
		return refused(OutcomeIDGenerationFailed), fmt.Errorf("%w: id_generation", ErrDelivery)
	}
	if strings.TrimSpace(report.Description) == "" {
		return refused(OutcomeDescriptionBlank), ErrInvalid
	}
	if utf8.RuneCountInString(report.Description) > MaxDescriptionCodePoints {
		return refused(OutcomeDescriptionTooLong), ErrInvalid
	}
	if utf8.RuneCountInString(report.Diagnostics) > MaxDiagnosticsCodePoints {
		return refused(OutcomeDiagnosticsTooLong), ErrInvalid
	}
	attribution, err := s.repository.Attribution(ctx, subject)
	if err != nil {
		if errors.Is(err, ErrForbidden) {
			return refused(OutcomeParticipantBindingMismatch), ErrForbidden
		}
		return refused(OutcomeAttributionFailed), errors.New("problem report attribution unavailable")
	}
	ctx, span := s.tracer.Start(ctx, "problem_report.commit", trace.WithAttributes(attribute.String("chalk.episode_id", subject.EpisodeID.String()), attribute.String("chalk.report_id", reportID.String())))
	defer span.End()

	// The row and the ledger event commit together before any forward, so Sent
	// means stored. A commit failure keeps the existing journey_* causes.
	stored := StoredReport{
		ID: reportID, JourneyID: journeyID, ChkCode: chkCode, ClientSessionID: sessionID,
		SDKVersion: normalizeSDKVersion(report.SDKVersion), PickedSymptom: picked,
		Description: report.Description, Diagnostics: report.Diagnostics,
	}
	if err := s.repository.StoreReport(ctx, subject, stored); err != nil {
		return refused(journeyFailureOutcome(err)), ErrNotStored
	}
	submitAttrs := []slog.Attr{
		obs.F("journey_id", journeyID.String()), obs.F("report_id", reportID.String()),
		obs.F("picked_symptom", picked),
	}
	if chkCode != "" {
		submitAttrs = append(submitAttrs, obs.F("chk_code", chkCode))
	}
	decisionID := obs.Decision(ctx, "problem_report.submit", "stored", "", submitAttrs...)

	// The forward runs in the same request and its bounded class lands on the
	// row; the answer is Sent whatever it returns. No retry.
	forwardOutcome := s.forward(ctx, subject, report, reportID, journeyID, attribution)
	evidenceCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
	defer cancel()
	_ = s.repository.SetForwardOutcome(evidenceCtx, subject.TenantID, reportID, forwardOutcome)
	return Result{Outcome: OutcomeAccepted, ReportID: reportID, JourneyID: journeyID, Code: chkCode, DecisionID: decisionID}, nil
}

// forward is the Discord call as one op record: ok, expected(not_configured) or
// a bounded error class. The webhook URL never appears in a field.
func (s Service) forward(ctx context.Context, subject accessgrants.Subject, report Report, reportID, journeyID utilities.ID, attribution Attribution) string {
	forwardOutcome := "pending"
	_ = obs.Op(ctx, "problem_report.forward", func(ctx context.Context, scope *obs.Scope) error {
		if s.sender == nil {
			forwardOutcome = "not_configured"
			scope.Set(obs.F("forward_outcome", forwardOutcome))
			scope.Expected(obs.ReasonReportForwardNotConfigured)
			return nil
		}
		err := s.sender.Send(ctx, Delivery{Report: report, Attribution: attribution, CallID: subject.EpisodeID})
		var failure DeliveryError
		switch {
		case err == nil:
			forwardOutcome = "ok"
		case errors.As(err, &failure) && failure.HTTPStatus != 0:
			forwardOutcome = fmt.Sprintf("http_%d", failure.HTTPStatus)
			scope.Set(obs.F("forward_outcome", forwardOutcome))
			return obs.Failure(obs.ReasonReportForwardHTTP, err)
		case errors.As(err, &failure):
			forwardOutcome = "transport_" + failure.TransportCategory()
			scope.Set(obs.F("forward_outcome", forwardOutcome))
			return obs.Failure(obs.ReasonReportForwardTransport, err)
		default:
			forwardOutcome = "transport_failed"
			scope.Set(obs.F("forward_outcome", forwardOutcome))
			return obs.Failure(obs.ReasonReportForwardTransport, err)
		}
		scope.Set(obs.F("forward_outcome", forwardOutcome))
		return nil
	}, obs.F("journey_id", journeyID.String()), obs.F("report_id", reportID.String()))
	return forwardOutcome
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
