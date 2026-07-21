package observability

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/apikeys"
	"github.com/q9labs/chalk/apps/api/internal/participantaccess"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	metricnoop "go.opentelemetry.io/otel/metric/noop"
	"go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	"go.opentelemetry.io/otel/trace"
)

type participantIssuerFunc func(context.Context, participantaccess.Subject) (participantaccess.MediaCredential, error)

func (f participantIssuerFunc) Issue(ctx context.Context, subject participantaccess.Subject) (participantaccess.MediaCredential, error) {
	return f(ctx, subject)
}

type participantVerifierFunc func(context.Context, string) (participantaccess.Subject, error)

func (f participantVerifierFunc) Verify(ctx context.Context, credential string) (participantaccess.Subject, error) {
	return f(ctx, credential)
}

func TestLaunchTelemetryEmitsOnlyBoundedAPIKeySignals(t *testing.T) {
	reader, restore := installMetricReader(t)
	defer restore()
	var output bytes.Buffer
	telemetry := newLaunchTelemetry(slog.New(slog.NewJSONHandler(&output, nil)), time.Now)
	ctx := context.Background()

	telemetry.RecordAuthentication(ctx, apikeys.AuthenticationEvent{Outcome: apikeys.AuthenticationAccepted, Latency: 3 * time.Millisecond})
	telemetry.RecordAuthentication(ctx, apikeys.AuthenticationEvent{Outcome: apikeys.AuthenticationRejected, Latency: 4 * time.Millisecond})
	telemetry.RecordUsageTouch(ctx, apikeys.UsageTouchFailed)

	metrics := collectMetrics(t, reader)
	for _, name := range []string{
		"chalk.api.api_key.authentication",
		"chalk.api.api_key.authentication.duration_seconds",
		"chalk.api.api_key.usage_touch",
	} {
		metric, ok := metrics[name]
		if !ok {
			t.Fatalf("metric %q was not recorded", name)
		}
		assertMetricAttributeKeys(t, metric, map[string]bool{"outcome": true})
	}
	assertSignalDoesNotContain(t, output.String())
}

func TestParticipantTelemetryPreservesParentAndClassifiesAudienceRejection(t *testing.T) {
	reader, restoreMetrics := installMetricReader(t)
	defer restoreMetrics()

	var output bytes.Buffer
	ticks := []time.Time{time.Unix(1_800_000_000, 0), time.Unix(1_800_000_000, int64(2*time.Millisecond))}
	now := func() time.Time {
		value := ticks[0]
		if len(ticks) > 1 {
			ticks = ticks[1:]
		}
		return value
	}
	telemetry := newLaunchTelemetry(slog.New(slog.NewJSONHandler(&output, nil)), now)
	traceID, err := trace.TraceIDFromHex("0af7651916cd43dd8448eb211c80319c")
	if err != nil {
		t.Fatal(err)
	}
	spanID, err := trace.SpanIDFromHex("b7ad6b7169203331")
	if err != nil {
		t.Fatal(err)
	}
	parent := trace.NewSpanContext(trace.SpanContextConfig{TraceID: traceID, SpanID: spanID, TraceFlags: trace.FlagsSampled, Remote: true})
	var observedParent trace.SpanContext
	verifier := InstrumentParticipantMediaVerifier(participantVerifierFunc(func(verifyCtx context.Context, _ string) (participantaccess.Subject, error) {
		observedParent = trace.SpanContextFromContext(verifyCtx)
		return participantaccess.Subject{}, participantaccess.ErrInvalidAudience
	}), telemetry)

	ctx := trace.ContextWithRemoteSpanContext(context.Background(), parent)
	_, err = verifier.Verify(ctx, "credential-sentinel-must-not-leak")
	if !errors.Is(err, participantaccess.ErrInvalidAudience) {
		t.Fatalf("verify error = %v", err)
	}
	if observedParent.TraceID() != traceID {
		t.Fatalf("verifier trace id = %s, want propagated %s", observedParent.TraceID(), traceID)
	}

	metrics := collectMetrics(t, reader)
	for _, name := range []string{
		"chalk.api.participant_media.authentication",
		"chalk.api.participant_media.authentication.duration_seconds",
	} {
		metric, ok := metrics[name]
		if !ok {
			t.Fatalf("metric %q was not recorded", name)
		}
		assertMetricAttributeKeys(t, metric, map[string]bool{"outcome": true, "reason": true})
		assertMetricHasAttributes(t, metric, map[string]string{"outcome": "rejected", "reason": "invalid_audience"})
	}

	assertSignalDoesNotContain(t, output.String())
}

func TestParticipantIssuanceTelemetryClassifiesSuccessWithoutSubjectFields(t *testing.T) {
	reader, restore := installMetricReader(t)
	defer restore()
	var output bytes.Buffer
	now := time.Unix(1_800_000_000, 0)
	telemetry := newLaunchTelemetry(slog.New(slog.NewJSONHandler(&output, nil)), func() time.Time {
		now = now.Add(time.Millisecond)
		return now
	})
	issuer := InstrumentParticipantAccessIssuer(participantIssuerFunc(func(context.Context, participantaccess.Subject) (participantaccess.MediaCredential, error) {
		return participantaccess.MediaCredential{Token: "issued-token-sentinel", ExpiresAt: now.Add(time.Minute)}, nil
	}), telemetry)

	credential, err := issuer.Issue(context.Background(), participantaccess.Subject{Provider: participantaccess.ProviderCloudflareSFU, CloudflareConnectionID: "connection-id-sentinel"})
	if err != nil || credential.Token == "" {
		t.Fatalf("issue result = %#v, %v", credential, err)
	}
	metric := collectMetrics(t, reader)["chalk.api.participant_access.issuance"]
	assertMetricAttributeKeys(t, metric, map[string]bool{"outcome": true, "reason": true})
	assertMetricHasAttributes(t, metric, map[string]string{"outcome": "issued", "reason": "none"})
	assertSignalDoesNotContain(t, output.String())
}

func installMetricReader(t *testing.T) (*metric.ManualReader, func()) {
	t.Helper()
	reader := metric.NewManualReader()
	provider := metric.NewMeterProvider(metric.WithReader(reader))
	otel.SetMeterProvider(provider)
	return reader, func() {
		_ = provider.Shutdown(context.Background())
		otel.SetMeterProvider(metricnoop.NewMeterProvider())
	}
}

func collectMetrics(t *testing.T, reader *metric.ManualReader) map[string]metricdata.Metrics {
	t.Helper()
	var resourceMetrics metricdata.ResourceMetrics
	if err := reader.Collect(context.Background(), &resourceMetrics); err != nil {
		t.Fatalf("collect metrics: %v", err)
	}
	result := make(map[string]metricdata.Metrics)
	for _, scope := range resourceMetrics.ScopeMetrics {
		for _, value := range scope.Metrics {
			result[value.Name] = value
		}
	}
	return result
}

func assertMetricAttributeKeys(t *testing.T, metric metricdata.Metrics, allowed map[string]bool) {
	t.Helper()
	for _, values := range metricAttributeSets(metric) {
		for _, value := range values.ToSlice() {
			if !allowed[string(value.Key)] {
				t.Fatalf("metric %q contains disallowed attribute %q", metric.Name, value.Key)
			}
		}
	}
}

func assertMetricHasAttributes(t *testing.T, metric metricdata.Metrics, expected map[string]string) {
	t.Helper()
	for _, values := range metricAttributeSets(metric) {
		matched := true
		for key, want := range expected {
			value, ok := values.Value(attribute.Key(key))
			if !ok || value.AsString() != want {
				matched = false
			}
		}
		if matched {
			return
		}
	}
	t.Fatalf("metric %q does not contain attributes %#v", metric.Name, expected)
}

func metricAttributeSets(metric metricdata.Metrics) []attribute.Set {
	sets := make([]attribute.Set, 0)
	switch data := metric.Data.(type) {
	case metricdata.Sum[int64]:
		for _, point := range data.DataPoints {
			sets = append(sets, point.Attributes)
		}
	case metricdata.Histogram[float64]:
		for _, point := range data.DataPoints {
			sets = append(sets, point.Attributes)
		}
	}
	return sets
}

func assertSignalDoesNotContain(t *testing.T, signal string) {
	t.Helper()
	for _, forbidden := range []string{
		"credential-sentinel-must-not-leak",
		"issued-token-sentinel",
		"connection-id-sentinel",
		"chalk_sk_",
		"rooms:read",
		"203.0.113.9",
	} {
		if strings.Contains(signal, forbidden) {
			t.Fatalf("telemetry leaked forbidden material %q in %s", forbidden, signal)
		}
	}
}
