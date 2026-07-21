package observability

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/apikeys"
	"github.com/q9labs/chalk/apps/api/internal/participantaccess"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	otelmetric "go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"
)

const noRejectionReason = "none"

var launchTracer = otel.Tracer("github.com/q9labs/chalk/apps/api/internal/observability/launch")

type participantAccessIssuer interface {
	Issue(context.Context, participantaccess.Subject) (participantaccess.MediaCredential, error)
}

type participantMediaVerifier interface {
	Verify(context.Context, string) (participantaccess.Subject, error)
}

// LaunchTelemetry owns bounded signals for API-key and participant-media authentication.
// It deliberately has no methods that accept credentials, identity fields, scopes, or IP addresses.
type LaunchTelemetry struct {
	logger                         *slog.Logger
	now                            func() time.Time
	apiKeyAuthentication           otelmetric.Int64Counter
	apiKeyAuthenticationDuration   otelmetric.Float64Histogram
	apiKeyUsageTouch               otelmetric.Int64Counter
	participantIssuance            otelmetric.Int64Counter
	participantIssuanceDuration    otelmetric.Float64Histogram
	participantAuthentication      otelmetric.Int64Counter
	participantAuthenticationDelay otelmetric.Float64Histogram
}

func NewLaunchTelemetry(logger *slog.Logger) *LaunchTelemetry {
	return newLaunchTelemetry(logger, time.Now)
}

func newLaunchTelemetry(logger *slog.Logger, now func() time.Time) *LaunchTelemetry {
	if logger == nil {
		logger = slog.Default()
	}
	if now == nil {
		now = time.Now
	}
	meter := otel.Meter("github.com/q9labs/chalk/apps/api/internal/observability")
	apiKeyAuthentication, _ := meter.Int64Counter("chalk.api.api_key.authentication", otelmetric.WithDescription("Bounded API-key authentication outcomes"))
	apiKeyAuthenticationDuration, _ := meter.Float64Histogram("chalk.api.api_key.authentication.duration_seconds", otelmetric.WithDescription("API-key authentication latency by bounded outcome"), otelmetric.WithUnit("s"))
	apiKeyUsageTouch, _ := meter.Int64Counter("chalk.api.api_key.usage_touch", otelmetric.WithDescription("Best-effort API-key usage telemetry updates by bounded outcome"))
	participantIssuance, _ := meter.Int64Counter("chalk.api.participant_access.issuance", otelmetric.WithDescription("Participant media credential issuance outcomes"))
	participantIssuanceDuration, _ := meter.Float64Histogram("chalk.api.participant_access.issuance.duration_seconds", otelmetric.WithDescription("Participant media credential issuance latency by bounded outcome"), otelmetric.WithUnit("s"))
	participantAuthentication, _ := meter.Int64Counter("chalk.api.participant_media.authentication", otelmetric.WithDescription("Participant media credential authentication outcomes"))
	participantAuthenticationDelay, _ := meter.Float64Histogram("chalk.api.participant_media.authentication.duration_seconds", otelmetric.WithDescription("Participant media credential authentication latency by bounded outcome"), otelmetric.WithUnit("s"))
	return &LaunchTelemetry{
		logger:                         logger,
		now:                            now,
		apiKeyAuthentication:           apiKeyAuthentication,
		apiKeyAuthenticationDuration:   apiKeyAuthenticationDuration,
		apiKeyUsageTouch:               apiKeyUsageTouch,
		participantIssuance:            participantIssuance,
		participantIssuanceDuration:    participantIssuanceDuration,
		participantAuthentication:      participantAuthentication,
		participantAuthenticationDelay: participantAuthenticationDelay,
	}
}

func (t *LaunchTelemetry) RecordAuthentication(ctx context.Context, event apikeys.AuthenticationEvent) {
	if t == nil {
		return
	}
	outcome := boundedAPIKeyAuthenticationOutcome(event.Outcome)
	attributes := otelmetric.WithAttributes(attribute.String("outcome", outcome))
	t.apiKeyAuthentication.Add(ctx, 1, attributes)
	t.apiKeyAuthenticationDuration.Record(ctx, nonNegative(event.Latency).Seconds(), attributes)
	t.logger.Log(ctx, launchLogLevel(outcome, "accepted"), "api key authentication", "event", "api_key.authentication", "outcome", outcome, "duration_ms", milliseconds(nonNegative(event.Latency)))
}

func (t *LaunchTelemetry) RecordUsageTouch(ctx context.Context, outcome apikeys.UsageTouchOutcome) {
	if t == nil {
		return
	}
	bounded := boundedUsageTouchOutcome(outcome)
	t.apiKeyUsageTouch.Add(ctx, 1, otelmetric.WithAttributes(attribute.String("outcome", bounded)))
	t.logger.Log(ctx, launchLogLevel(bounded, "succeeded"), "api key usage touch", "event", "api_key.usage_touch", "outcome", bounded)
}

type ParticipantAccessIssuer struct {
	next      participantAccessIssuer
	telemetry *LaunchTelemetry
}

func InstrumentParticipantAccessIssuer(next participantAccessIssuer, telemetry *LaunchTelemetry) ParticipantAccessIssuer {
	return ParticipantAccessIssuer{next: next, telemetry: telemetry}
}

func (i ParticipantAccessIssuer) Issue(ctx context.Context, subject participantaccess.Subject) (participantaccess.MediaCredential, error) {
	if i.next == nil {
		return participantaccess.MediaCredential{}, participantaccess.ErrInvalidConfig
	}
	if i.telemetry == nil {
		return i.next.Issue(ctx, subject)
	}
	startedAt := i.telemetry.now()
	ctx, span := launchTracer.Start(ctx, "participant_access.issue")
	credential, err := i.next.Issue(ctx, subject)
	outcome, reason := participantIssuanceResult(err)
	i.telemetry.recordParticipantIssuance(ctx, outcome, reason, i.telemetry.now().Sub(startedAt))
	finishLaunchSpan(span, outcome, reason, err)
	return credential, err
}

type ParticipantMediaVerifier struct {
	next      participantMediaVerifier
	telemetry *LaunchTelemetry
}

func InstrumentParticipantMediaVerifier(next participantMediaVerifier, telemetry *LaunchTelemetry) ParticipantMediaVerifier {
	return ParticipantMediaVerifier{next: next, telemetry: telemetry}
}

func (v ParticipantMediaVerifier) Verify(ctx context.Context, credential string) (participantaccess.Subject, error) {
	if v.next == nil {
		return participantaccess.Subject{}, participantaccess.ErrInvalidConfig
	}
	if v.telemetry == nil {
		return v.next.Verify(ctx, credential)
	}
	startedAt := v.telemetry.now()
	ctx, span := launchTracer.Start(ctx, "participant_media.authenticate")
	subject, err := v.next.Verify(ctx, credential)
	outcome, reason := participantAuthenticationResult(err)
	v.telemetry.recordParticipantAuthentication(ctx, outcome, reason, v.telemetry.now().Sub(startedAt))
	finishLaunchSpan(span, outcome, reason, err)
	return subject, err
}

func (t *LaunchTelemetry) recordParticipantIssuance(ctx context.Context, outcome, reason string, duration time.Duration) {
	attributes := otelmetric.WithAttributes(attribute.String("outcome", outcome), attribute.String("reason", reason))
	t.participantIssuance.Add(ctx, 1, attributes)
	t.participantIssuanceDuration.Record(ctx, nonNegative(duration).Seconds(), attributes)
	t.logger.Log(ctx, launchLogLevel(outcome, "issued"), "participant access issuance", "event", "participant_access.issuance", "outcome", outcome, "reason", reason, "duration_ms", milliseconds(nonNegative(duration)))
}

func (t *LaunchTelemetry) recordParticipantAuthentication(ctx context.Context, outcome, reason string, duration time.Duration) {
	attributes := otelmetric.WithAttributes(attribute.String("outcome", outcome), attribute.String("reason", reason))
	t.participantAuthentication.Add(ctx, 1, attributes)
	t.participantAuthenticationDelay.Record(ctx, nonNegative(duration).Seconds(), attributes)
	t.logger.Log(ctx, launchLogLevel(outcome, "accepted"), "participant media authentication", "event", "participant_media.authentication", "outcome", outcome, "reason", reason, "duration_ms", milliseconds(nonNegative(duration)))
}

func finishLaunchSpan(span trace.Span, outcome, reason string, err error) {
	span.SetAttributes(attribute.String("chalk.outcome", outcome), attribute.String("chalk.rejection.reason", reason))
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, reason)
	}
	span.End()
}

func boundedAPIKeyAuthenticationOutcome(outcome apikeys.AuthenticationOutcome) string {
	switch outcome {
	case apikeys.AuthenticationAccepted, apikeys.AuthenticationRejected, apikeys.AuthenticationFailed:
		return string(outcome)
	default:
		return "failed"
	}
}

func boundedUsageTouchOutcome(outcome apikeys.UsageTouchOutcome) string {
	switch outcome {
	case apikeys.UsageTouchSucceeded, apikeys.UsageTouchFailed:
		return string(outcome)
	default:
		return "failed"
	}
}

func participantIssuanceResult(err error) (string, string) {
	switch {
	case err == nil:
		return "issued", noRejectionReason
	case errors.Is(err, participantaccess.ErrInvalidSubject):
		return "rejected", "invalid_subject"
	case errors.Is(err, participantaccess.ErrInvalidConfig):
		return "failed", "invalid_configuration"
	default:
		return "failed", "signing_failed"
	}
}

func participantAuthenticationResult(err error) (string, string) {
	switch {
	case err == nil:
		return "accepted", noRejectionReason
	case errors.Is(err, participantaccess.ErrMalformedCredential):
		return "rejected", "malformed"
	case errors.Is(err, participantaccess.ErrInvalidHeader):
		return "rejected", "invalid_header"
	case errors.Is(err, participantaccess.ErrUnknownKey):
		return "rejected", "unknown_key"
	case errors.Is(err, participantaccess.ErrInvalidSignature):
		return "rejected", "invalid_signature"
	case errors.Is(err, participantaccess.ErrInvalidIssuer):
		return "rejected", "invalid_issuer"
	case errors.Is(err, participantaccess.ErrInvalidAudience):
		return "rejected", "invalid_audience"
	case errors.Is(err, participantaccess.ErrInvalidTimeClaims):
		return "rejected", "invalid_time_claims"
	case errors.Is(err, participantaccess.ErrNotYetValid):
		return "rejected", "not_yet_valid"
	case errors.Is(err, participantaccess.ErrExpired):
		return "rejected", "expired"
	case errors.Is(err, participantaccess.ErrLifetimeExceeded):
		return "rejected", "lifetime_exceeded"
	case errors.Is(err, participantaccess.ErrInvalidSubject), errors.Is(err, participantaccess.ErrSubjectMismatch):
		return "rejected", "invalid_subject"
	default:
		return "failed", "verification_failed"
	}
}

func nonNegative(duration time.Duration) time.Duration {
	if duration < 0 {
		return 0
	}
	return duration
}

func launchLogLevel(outcome, success string) slog.Level {
	if outcome == success {
		return slog.LevelDebug
	}
	if outcome == "failed" {
		return slog.LevelError
	}
	return slog.LevelWarn
}
