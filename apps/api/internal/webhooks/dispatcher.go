package webhooks

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"io"
	"log/slog"
	"strconv"
	"sync"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

const (
	DefaultDispatchBatch = 20
	DefaultLeaseDuration = 30 * time.Second
	journeySpanAttribute = "chalk.journey.id"
)

type Claim struct {
	TenantID, EndpointID, EndpointRevisionID, DeliveryID, EventID    utilities.ID
	AttemptID                                                        utilities.ID
	AttemptNumber                                                    int
	EventName                                                        string
	APIVersion                                                       int
	OccurredAt                                                       time.Time
	Body                                                             []byte
	URLCiphertext, CurrentSecretCiphertext, PreviousSecretCiphertext []byte
	PreviousSecretExpiresAt                                          *time.Time
	LeaseToken                                                       utilities.ID
	JourneyID, QueuedJourneyEventID, AttemptJourneyEventID           utilities.ID
	AttemptParentJourneyEventID                                      utilities.ID
	ProducingTraceID, ProducingSpanID                                string
}
type AttemptResult struct {
	Success    bool
	Retryable  bool
	HTTPStatus int
	ErrorCode  string
	Latency    time.Duration
	RetryAfter time.Duration
	FinishedAt time.Time
}
type DispatchRepository interface {
	RecoverExpired(context.Context) (int64, error)
	Claim(context.Context, string, int, time.Duration) ([]Claim, error)
	RecordAttemptTrace(context.Context, Claim, string, string) error
	Complete(context.Context, Claim, AttemptResult) error
	Cleanup(context.Context) error
}

type DispatchHealthRepository interface {
	Health(context.Context) (HealthSnapshot, error)
}

type DeliverySender interface {
	Deliver(context.Context, DeliveryRequest) (DeliveryResponse, error)
}

type Dispatcher struct {
	repository         DispatchRepository
	protector          SecretProtector
	client             DeliverySender
	logger             *slog.Logger
	owner              string
	batch              int
	poll               time.Duration
	cleanupEvery       time.Duration
	now                func() time.Time
	startedAt          time.Time
	lastCleanupSuccess time.Time
}

func NewDispatcher(repository DispatchRepository, protector SecretProtector, client DeliverySender, owner string, logger *slog.Logger) *Dispatcher {
	if logger == nil {
		logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	return &Dispatcher{repository: repository, protector: protector, client: client, owner: owner, logger: logger, batch: DefaultDispatchBatch, poll: time.Second, cleanupEvery: time.Hour, now: time.Now}
}

func (d *Dispatcher) Run(ctx context.Context) error {
	if d.repository == nil || d.protector == nil || d.client == nil {
		return errors.New("webhook dispatcher is not configured")
	}
	d.startedAt = d.now()
	ticker := time.NewTicker(d.poll)
	defer ticker.Stop()
	d.runCleanup(ctx)
	cleanup := time.NewTicker(d.cleanupEvery)
	defer cleanup.Stop()
	health := time.NewTicker(30 * time.Second)
	defer health.Stop()
	d.recordHealth(ctx)
	for {
		if err := d.runBatch(ctx); err != nil && !errors.Is(err, context.Canceled) {
			d.logger.ErrorContext(ctx, "webhook dispatcher cycle failed", "error", err)
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		case <-cleanup.C:
			d.runCleanup(ctx)
		case <-health.C:
			d.recordHealth(ctx)
		}
	}
}

func (d *Dispatcher) runCleanup(ctx context.Context) {
	if err := d.repository.Cleanup(ctx); err != nil {
		recordCleanupRun(ctx, "failed")
		d.logger.ErrorContext(ctx, "webhook dispatcher cleanup failed", "error", err)
		return
	}
	recordCleanupRun(ctx, "succeeded")
	d.lastCleanupSuccess = d.now()
}

func (d *Dispatcher) recordHealth(ctx context.Context) {
	repository, ok := d.repository.(DispatchHealthRepository)
	if !ok {
		return
	}
	health, err := repository.Health(ctx)
	if err != nil {
		d.logger.ErrorContext(ctx, "webhook dispatcher health query failed", "error", err)
		return
	}
	lastCleanupReference := d.lastCleanupSuccess
	if lastCleanupReference.IsZero() {
		lastCleanupReference = d.startedAt
	}
	if !lastCleanupReference.IsZero() {
		health.CleanupLastSuccessAge = d.now().Sub(lastCleanupReference)
		if health.CleanupLastSuccessAge < 0 {
			health.CleanupLastSuccessAge = 0
		}
	}
	RecordHealthMetrics(ctx, health)
}

func (d *Dispatcher) runBatch(ctx context.Context) error {
	recovered, err := d.repository.RecoverExpired(ctx)
	if err != nil {
		return err
	}
	recordLeaseRecoveries(ctx, recovered)
	claims, err := d.repository.Claim(ctx, d.owner, d.batch, DefaultLeaseDuration)
	if err != nil {
		return err
	}
	var wait sync.WaitGroup
	errorsByClaim := make(chan error, len(claims))
	for _, claim := range claims {
		claim := claim
		wait.Add(1)
		go func() {
			defer wait.Done()
			if err := d.deliver(ctx, claim); err != nil {
				errorsByClaim <- err
			}
		}()
	}
	wait.Wait()
	close(errorsByClaim)
	var batchErrors []error
	for err := range errorsByClaim {
		batchErrors = append(batchErrors, err)
	}
	return errors.Join(batchErrors...)
}

func (d *Dispatcher) deliver(ctx context.Context, claim Claim) error {
	links := make([]trace.Link, 0, 1)
	if traceID, err := trace.TraceIDFromHex(claim.ProducingTraceID); err == nil {
		if spanID, spanErr := trace.SpanIDFromHex(claim.ProducingSpanID); spanErr == nil {
			links = append(links, trace.Link{SpanContext: trace.NewSpanContext(trace.SpanContextConfig{TraceID: traceID, SpanID: spanID, Remote: true})})
		}
	}
	ctx, span := otel.Tracer("github.com/q9labs/chalk/apps/api/internal/webhooks").Start(ctx, "webhook.delivery.attempt", trace.WithSpanKind(trace.SpanKindClient), trace.WithLinks(links...))
	defer span.End()
	span.SetAttributes(
		attribute.Int("webhook.attempt_number", claim.AttemptNumber),
		attribute.String("webhook.attempt_id", claim.AttemptID.String()),
		attribute.String("webhook.delivery_id", claim.DeliveryID.String()),
		attribute.String("webhook.event_id", claim.EventID.String()),
		attribute.String(journeySpanAttribute, claim.JourneyID.String()),
	)
	spanContext := span.SpanContext()
	if err := d.repository.RecordAttemptTrace(ctx, claim, spanContext.TraceID().String(), spanContext.SpanID().String()); err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, "record attempt trace")
		return err
	}
	recordFirstAttemptLatency(ctx, claim, d.now())
	urlBytes, err := d.protector.Unprotect(URLScope(claim.TenantID, claim.EndpointID, claim.EndpointRevisionID), claim.URLCiphertext)
	if err != nil {
		recordCryptoFailure(ctx, "decrypt_url")
		return d.completeAttempt(ctx, span, claim, AttemptResult{Retryable: true, ErrorCode: "encryption_failed", FinishedAt: d.now()})
	}
	current, err := d.protector.Unprotect(SecretScope(claim.TenantID, claim.EndpointID), claim.CurrentSecretCiphertext)
	if err != nil {
		recordCryptoFailure(ctx, "decrypt_current_secret")
		return d.completeAttempt(ctx, span, claim, AttemptResult{Retryable: true, ErrorCode: "encryption_failed", FinishedAt: d.now()})
	}
	secrets := [][]byte{current}
	if len(claim.PreviousSecretCiphertext) > 0 && claim.PreviousSecretExpiresAt != nil && d.now().Before(*claim.PreviousSecretExpiresAt) {
		previous, decryptErr := d.protector.Unprotect(SecretScope(claim.TenantID, claim.EndpointID), claim.PreviousSecretCiphertext)
		if decryptErr != nil {
			recordCryptoFailure(ctx, "decrypt_previous_secret")
			return d.completeAttempt(ctx, span, claim, AttemptResult{Retryable: true, ErrorCode: "encryption_failed", FinishedAt: d.now()})
		}
		secrets = append(secrets, previous)
	}
	timestamp, signature := SignatureHeader(claim.EventID.String(), d.now(), claim.Body, secrets...)
	response, deliveryErr := d.client.Deliver(ctx, DeliveryRequest{URL: string(urlBytes), EventID: claim.EventID.String(), Timestamp: timestamp, Signature: signature, Body: claim.Body})
	result := AttemptResult{Success: deliveryErr == nil, HTTPStatus: response.Status, Latency: response.Latency, RetryAfter: response.RetryAfter, FinishedAt: d.now()}
	if deliveryErr != nil {
		var classified DeliveryError
		if errors.As(deliveryErr, &classified) {
			result.Retryable = classified.Retryable
			result.ErrorCode = classified.Code
		} else {
			result.Retryable = true
			result.ErrorCode = "network_failed"
		}
	}
	return d.completeAttempt(ctx, span, claim, result)
}

func (d *Dispatcher) completeAttempt(ctx context.Context, span trace.Span, claim Claim, result AttemptResult) error {
	if err := d.repository.Complete(ctx, claim, result); err != nil {
		d.logger.WarnContext(ctx, "webhook delivery completion failed", "journey_id", claim.JourneyID.String(), "event_id", claim.EventID.String(), "delivery_id", claim.DeliveryID.String(), "attempt_id", claim.AttemptID.String(), "attempt_number", claim.AttemptNumber, "error_code", boundedErrorCode(result.ErrorCode), "error", err)
		span.RecordError(err)
		span.SetStatus(codes.Error, "complete delivery")
		return err
	}
	recordAttemptMetrics(ctx, claim, result)
	d.logger.InfoContext(ctx, "webhook delivery attempt completed", "journey_id", claim.JourneyID.String(), "event_id", claim.EventID.String(), "delivery_id", claim.DeliveryID.String(), "attempt_id", claim.AttemptID.String(), "attempt_number", claim.AttemptNumber, "event_name", boundedMetricEventName(claim.EventName), "api_version", boundedMetricAPIVersion(claim.APIVersion), "outcome", attemptMetricOutcome(result), "error_code", boundedErrorCode(result.ErrorCode), "http_status_class", statusClassMetric(result.HTTPStatus))
	span.SetAttributes(attribute.String("webhook.outcome", attemptMetricOutcome(result)), attribute.String("webhook.error_code", boundedErrorCode(result.ErrorCode)), attribute.String("http.response.status_class", statusClassMetric(result.HTTPStatus)))
	if !result.Success {
		span.SetStatus(codes.Error, boundedErrorCode(result.ErrorCode))
	}
	return nil
}

var retryOffsets = []time.Duration{0, 30 * time.Second, 2 * time.Minute, 10 * time.Minute, 30 * time.Minute, 2 * time.Hour, 6 * time.Hour, 12 * time.Hour, 24 * time.Hour, 48 * time.Hour, 72 * time.Hour}

func NextAttemptAt(deliveryID utilities.ID, occurredAt, finishedAt time.Time, nextAttemptNumber int, retryAfter time.Duration) *time.Time {
	if nextAttemptNumber < 2 || nextAttemptNumber > len(retryOffsets) {
		return nil
	}
	deadline := occurredAt.Add(retryOffsets[nextAttemptNumber-1])
	jitterWindow := retryOffsets[nextAttemptNumber-1] / 10
	if jitterWindow > 0 {
		digest := sha256.Sum256([]byte(deliveryID.String() + ":" + strconv.Itoa(nextAttemptNumber)))
		jitter := time.Duration(binary.BigEndian.Uint64(digest[:8]) % (uint64(jitterWindow) + 1))
		deadline = deadline.Add(-jitter)
	}
	minimum := finishedAt.Add(15 * time.Second)
	if deadline.Before(minimum) {
		deadline = minimum
	}
	if retryAfter > 0 {
		retryDeadline := finishedAt.Add(retryAfter)
		if retryDeadline.After(deadline) {
			deadline = retryDeadline
		}
	}
	horizon := occurredAt.Add(72 * time.Hour)
	if deadline.After(horizon) {
		return nil
	}
	return &deadline
}
