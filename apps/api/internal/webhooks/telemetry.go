package webhooks

import (
	"context"
	"strconv"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

// These instrument and label names are part of the operator-facing webhook
// contract. Labels are deliberately bounded and never include tenant, endpoint,
// destination, payload, or other customer-controlled values.
var (
	webhookMeter = otel.Meter("github.com/q9labs/chalk/apps/api/internal/webhooks")

	webhookEventsCommitted, _ = webhookMeter.Int64Counter(
		"chalk.webhook.events.committed",
		metric.WithUnit("{event}"),
	)
	webhookEventFanout, _ = webhookMeter.Int64Histogram(
		"chalk.webhook.event.fanout",
		metric.WithUnit("{delivery}"),
	)
	webhookActiveDeliveries, _ = webhookMeter.Int64Gauge(
		"chalk.webhook.deliveries.active",
		metric.WithUnit("{delivery}"),
	)
	webhookOldestEligibleAge, _ = webhookMeter.Float64Gauge(
		"chalk.webhook.delivery.oldest_eligible_age",
		metric.WithUnit("s"),
	)
	webhookFirstAttemptLatency, _ = webhookMeter.Float64Histogram(
		"chalk.webhook.delivery.first_attempt_latency",
		metric.WithUnit("s"),
	)
	webhookAttempts, _ = webhookMeter.Int64Counter(
		"chalk.webhook.delivery.attempts",
		metric.WithUnit("{attempt}"),
	)
	webhookRequestLatency, _ = webhookMeter.Float64Histogram(
		"chalk.webhook.delivery.request_latency",
		metric.WithUnit("ms"),
	)
	webhookRetries, _ = webhookMeter.Int64Counter(
		"chalk.webhook.delivery.retries",
		metric.WithUnit("{retry}"),
	)
	webhookTerminalDeliveries, _ = webhookMeter.Int64Counter(
		"chalk.webhook.deliveries.terminal",
		metric.WithUnit("{delivery}"),
	)
	webhookLeaseExpiries, _ = webhookMeter.Int64Counter(
		"chalk.webhook.delivery.lease_expiries",
		metric.WithUnit("{lease}"),
	)
	webhookFairnessThrottles, _ = webhookMeter.Int64Gauge(
		"chalk.webhook.dispatch.fairness_throttles",
		metric.WithUnit("{scope}"),
	)
	webhookSSRFRejections, _ = webhookMeter.Int64Counter(
		"chalk.webhook.security.ssrf_rejections",
		metric.WithUnit("{rejection}"),
	)
	webhookCryptoFailures, _ = webhookMeter.Int64Counter(
		"chalk.webhook.crypto.failures",
		metric.WithUnit("{failure}"),
	)
	webhookCleanupLag, _ = webhookMeter.Float64Gauge(
		"chalk.webhook.cleanup.lag",
		metric.WithUnit("s"),
	)
	webhookCleanupLastSuccessAge, _ = webhookMeter.Float64Gauge(
		"chalk.webhook.cleanup.last_success_age",
		metric.WithUnit("s"),
	)
	webhookCleanupRuns, _ = webhookMeter.Int64Counter(
		"chalk.webhook.cleanup.runs",
		metric.WithUnit("{run}"),
	)
	webhookJourneyBranchAge, _ = webhookMeter.Float64Gauge(
		"chalk.webhook.journey.oldest_unterminated_branch_age",
		metric.WithUnit("s"),
	)
	webhookRedeliveryResults, _ = webhookMeter.Int64Counter(
		"chalk.webhook.redelivery.results",
		metric.WithUnit("{request}"),
	)
)

type HealthSnapshot struct {
	PendingDeliveries         int64
	RetryWaitDeliveries       int64
	LeasedDeliveries          int64
	OldestEligibleAge         time.Duration
	EndpointFairnessThrottles int64
	TenantFairnessThrottles   int64
	CleanupLag                time.Duration
	CleanupLastSuccessAge     time.Duration
	OldestUnterminatedAge     time.Duration
}

func RecordEventMetrics(ctx context.Context, eventName string, apiVersion, fanout int) {
	labels := metric.WithAttributes(eventAttributes(eventName, apiVersion)...)
	webhookEventsCommitted.Add(ctx, 1, labels)
	webhookEventFanout.Record(ctx, int64(fanout), labels)
}

func RecordHealthMetrics(ctx context.Context, health HealthSnapshot) {
	for state, count := range map[string]int64{
		"pending":    health.PendingDeliveries,
		"retry_wait": health.RetryWaitDeliveries,
		"delivering": health.LeasedDeliveries,
	} {
		webhookActiveDeliveries.Record(ctx, count, metric.WithAttributes(attribute.String("state", state)))
	}
	webhookOldestEligibleAge.Record(ctx, health.OldestEligibleAge.Seconds())
	webhookFairnessThrottles.Record(ctx, health.EndpointFairnessThrottles, metric.WithAttributes(attribute.String("scope", "endpoint")))
	webhookFairnessThrottles.Record(ctx, health.TenantFairnessThrottles, metric.WithAttributes(attribute.String("scope", "tenant")))
	webhookCleanupLag.Record(ctx, health.CleanupLag.Seconds())
	webhookCleanupLastSuccessAge.Record(ctx, health.CleanupLastSuccessAge.Seconds())
	webhookJourneyBranchAge.Record(ctx, health.OldestUnterminatedAge.Seconds())
}

func recordCleanupRun(ctx context.Context, outcome string) {
	if outcome == "succeeded" || outcome == "failed" {
		webhookCleanupRuns.Add(ctx, 1, metric.WithAttributes(attribute.String("outcome", outcome)))
	}
}

func recordFirstAttemptLatency(ctx context.Context, claim Claim, startedAt time.Time) {
	if claim.AttemptNumber != 1 || claim.OccurredAt.IsZero() {
		return
	}
	latency := startedAt.Sub(claim.OccurredAt)
	if latency < 0 {
		latency = 0
	}
	webhookFirstAttemptLatency.Record(ctx, latency.Seconds(), metric.WithAttributes(eventAttributes(claim.EventName, claim.APIVersion)...))
}

func recordAttemptMetrics(ctx context.Context, claim Claim, result AttemptResult) {
	labels := metric.WithAttributes(
		attribute.String("event_name", boundedMetricEventName(claim.EventName)),
		attribute.Int("api_version", boundedMetricAPIVersion(claim.APIVersion)),
		attribute.String("outcome", attemptMetricOutcome(result)),
		attribute.String("error_code", boundedErrorCode(result.ErrorCode)),
		attribute.String("http_status_class", statusClassMetric(result.HTTPStatus)),
	)
	webhookAttempts.Add(ctx, 1, labels)
	webhookRequestLatency.Record(ctx, float64(result.Latency.Microseconds())/1000, labels)
	if !result.Success && result.Retryable {
		webhookRetries.Add(ctx, 1, labels)
	}
	if result.Success {
		RecordTerminalDeliveries(ctx, "succeeded", 1)
	} else if !result.Retryable || NextAttemptAt(claim.DeliveryID, claim.OccurredAt, result.FinishedAt, claim.AttemptNumber+1, result.RetryAfter) == nil {
		RecordTerminalDeliveries(ctx, "exhausted", 1)
	}
}

func RecordTerminalDeliveries(ctx context.Context, outcome string, count int64) {
	if count <= 0 {
		return
	}
	switch outcome {
	case "succeeded", "exhausted", "canceled", "erased":
		webhookTerminalDeliveries.Add(ctx, count, metric.WithAttributes(attribute.String("outcome", outcome)))
	}
}

func recordLeaseRecoveries(ctx context.Context, count int64) {
	if count > 0 {
		webhookLeaseExpiries.Add(ctx, count)
	}
}

func RecordSSRFRejection(ctx context.Context, class string) {
	switch class {
	case "url_policy", "blocked_address", "mixed_dns_answer":
		webhookSSRFRejections.Add(ctx, 1, metric.WithAttributes(attribute.String("class", class)))
	}
}

func recordCryptoFailure(ctx context.Context, operation string) {
	switch operation {
	case "decrypt_url", "decrypt_current_secret", "decrypt_previous_secret", "sign_request":
		webhookCryptoFailures.Add(ctx, 1, metric.WithAttributes(attribute.String("operation", operation)))
	}
}

func RecordRedeliveryResult(ctx context.Context, outcome string) {
	switch outcome {
	case "accepted", "not_found", "not_redeliverable", "erased", "conflict", "failed":
		webhookRedeliveryResults.Add(ctx, 1, metric.WithAttributes(attribute.String("outcome", outcome)))
	}
}

func attemptMetricOutcome(result AttemptResult) string {
	if result.Success {
		return "succeeded"
	}
	if result.Retryable {
		return "retryable_failure"
	}
	return "terminal_failure"
}

func boundedErrorCode(code string) string {
	switch code {
	case "", "dns_failed", "connect_failed", "tls_failed", "timeout", "network_failed", "response_too_large", "response_headers_too_large", "http_3xx", "http_4xx", "http_5xx", "encryption_failed", "unsafe_url", "ssrf_blocked", "request_invalid", "invalid_http_status", "lease_expired":
		return code
	default:
		return "other"
	}
}

func statusClassMetric(status int) string {
	if status < 100 || status > 599 {
		return "none"
	}
	return strconv.Itoa(status/100) + "xx"
}

func eventAttributes(eventName string, apiVersion int) []attribute.KeyValue {
	return []attribute.KeyValue{attribute.String("event_name", boundedMetricEventName(eventName)), attribute.Int("api_version", boundedMetricAPIVersion(apiVersion))}
}

func boundedMetricEventName(eventName string) string {
	if !knownMetricEventName(eventName) {
		return "other"
	}
	return eventName
}

func boundedMetricAPIVersion(apiVersion int) int {
	if apiVersion != APIVersion {
		return 0
	}
	return apiVersion
}

func knownMetricEventName(name string) bool {
	if name == "endpoint.test" {
		return true
	}
	for _, candidate := range CoreEventTypes {
		if name == candidate {
			return true
		}
	}
	_, ok := reservedEventTypes[name]
	return ok
}
