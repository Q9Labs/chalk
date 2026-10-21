package publicinvites

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"testing"

	"go.opentelemetry.io/contrib/bridges/otelslog"
	"go.opentelemetry.io/otel/attribute"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	"go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type admissionLogExporter struct {
	records []sdklog.Record
}

func (e *admissionLogExporter) Export(_ context.Context, records []sdklog.Record) error {
	for _, record := range records {
		e.records = append(e.records, record.Clone())
	}
	return nil
}

func (*admissionLogExporter) Shutdown(context.Context) error   { return nil }
func (*admissionLogExporter) ForceFlush(context.Context) error { return nil }

func TestAdmissionOutcomeOTLPLabels(t *testing.T) {
	ctx := context.Background()
	exporter := &admissionLogExporter{}
	provider := sdklog.NewLoggerProvider(sdklog.WithProcessor(sdklog.NewSimpleProcessor(exporter)))
	defer provider.Shutdown(ctx)
	previousLogger := slog.Default()
	slog.SetDefault(slog.New(otelslog.NewHandler("test", otelslog.WithLoggerProvider(provider))))
	defer slog.SetDefault(previousLogger)
	for _, state := range []ArrivalState{ArrivalAdmitted, ArrivalRejected, ArrivalUnavailable} {
		RecordAdmissionOutcome(ctx, Arrival{State: state}, "admission_denied")
		if len(exporter.records) == 0 {
			t.Fatal("missing admission OTLP log")
		}
		var got string
		exporter.records[len(exporter.records)-1].WalkAttributes(func(attr attribute.KeyValue) bool {
			if attr.Key == "state" {
				got = attr.Value.AsString()
			}
			return true
		})
		if got != string(state) {
			t.Fatalf("OTLP admission state = %q, want %q", got, state)
		}
	}
}

func TestAdmissionOutcomesAreObservableWithoutIdentityMetricLabels(t *testing.T) {
	ctx := context.Background()
	reader := metric.NewManualReader()
	provider := metric.NewMeterProvider(metric.WithReader(reader))
	defer provider.Shutdown(ctx)
	counter, err := provider.Meter("test").Int64Counter("chalk.public_invite.admission.outcomes")
	if err != nil {
		t.Fatal(err)
	}
	previousCounter := admissionOutcomes
	admissionOutcomes = counter
	defer func() { admissionOutcomes = previousCounter }()
	var logs bytes.Buffer
	previousLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&logs, nil)))
	defer slog.SetDefault(previousLogger)
	exporter := tracetest.NewInMemoryExporter()
	traces := sdktrace.NewTracerProvider(sdktrace.WithSyncer(exporter))
	defer traces.Shutdown(ctx)
	id, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	for _, outcome := range []struct {
		state  ArrivalState
		reason string
	}{{ArrivalAdmitted, "approved"}, {ArrivalRejected, "admission_denied"}, {ArrivalUnavailable, "admission_request_expired"}, {ArrivalUnavailable, "admission_not_collected"}} {
		spanCtx, span := traces.Tracer("test").Start(ctx, "collect")
		RecordAdmissionOutcome(spanCtx, Arrival{ArrivalHandle: id, State: outcome.state}, outcome.reason)
		span.End()
		if !strings.Contains(logs.String(), `"reason":"`+outcome.reason+`"`) {
			t.Fatalf("missing structured outcome %s", outcome.reason)
		}
	}
	var data metricdata.ResourceMetrics
	if err := reader.Collect(ctx, &data); err != nil {
		t.Fatal(err)
	}
	sum, ok := data.ScopeMetrics[0].Metrics[0].Data.(metricdata.Sum[int64])
	if !ok {
		t.Fatal("missing admission outcome counter")
	}
	if len(sum.DataPoints) != 4 {
		t.Fatalf("outcome series = %d, want 4", len(sum.DataPoints))
	}
	for _, point := range sum.DataPoints {
		if point.Value != 1 || point.Attributes.Len() != 2 {
			t.Fatalf("unexpected metric point: %+v", point)
		}
		for _, key := range []attribute.Key{"state", "reason"} {
			if _, ok := point.Attributes.Value(key); !ok {
				t.Fatalf("missing metric label %s", key)
			}
		}
	}
	spans := exporter.GetSpans()
	if len(spans) != 4 {
		t.Fatalf("outcome spans = %d, want 4", len(spans))
	}
	for _, span := range spans {
		if len(span.Attributes) != 2 {
			t.Fatalf("missing terminal outcome span labels: %+v", span.Attributes)
		}
	}
}
