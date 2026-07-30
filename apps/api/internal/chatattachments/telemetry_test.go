package chatattachments

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	metricnoop "go.opentelemetry.io/otel/metric/noop"
	"go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	tracenoop "go.opentelemetry.io/otel/trace/noop"
)

func TestRequestTelemetryIsBoundedAndDoesNotExposeAttachmentMaterial(t *testing.T) {
	spanRecorder := tracetest.NewSpanRecorder()
	traceProvider := sdktrace.NewTracerProvider(
		sdktrace.WithSpanProcessor(spanRecorder),
	)
	metricReader := metric.NewManualReader()
	metricProvider := metric.NewMeterProvider(metric.WithReader(metricReader))
	otel.SetTracerProvider(traceProvider)
	otel.SetMeterProvider(metricProvider)
	t.Cleanup(func() {
		_ = traceProvider.Shutdown(context.Background())
		_ = metricProvider.Shutdown(context.Background())
		otel.SetTracerProvider(tracenoop.NewTracerProvider())
		otel.SetMeterProvider(metricnoop.NewMeterProvider())
	})

	var logs bytes.Buffer
	now := time.Date(2026, time.July, 30, 12, 0, 0, 0, time.UTC)
	clock := func() time.Time {
		now = now.Add(time.Millisecond)
		return now
	}
	telemetry := newRequestTelemetry(
		slog.New(slog.NewJSONHandler(&logs, nil)),
		clock,
	)
	subject := chatAttachmentTestSubject(t)

	content := []byte("private-content-sentinel")
	digest := sha256Sum(content)
	initRepository := &chatAttachmentRepositoryStub{}
	initObjects := &chatAttachmentObjectStoreStub{
		uploadURL: objectstorage.SignedURL{
			Method: http.MethodPut,
			URL:    "https://signed-url-sentinel.test/object",
			ExpiresAt: time.Date(
				2026,
				time.July,
				30,
				12,
				10,
				0,
				0,
				time.UTC,
			),
			SignedHeader: map[string][]string{"Content-Type": {"image/png"}},
		},
	}
	initService := NewService(initRepository, initObjects)
	initService.now = func() time.Time {
		return time.Date(2026, time.July, 30, 12, 0, 0, 0, time.UTC)
	}
	initService.telemetry = telemetry
	if _, err := initService.Initiate(context.Background(), InitiateInput{
		Subject:            subject,
		ClientAttachmentID: "private-client-id-sentinel",
		FileName:           "private-file-sentinel.png",
		MIMEType:           "image/png",
		ByteLength:         int64(len(content)),
		SHA256:             hex.EncodeToString(digest[:]),
	}); err != nil {
		t.Fatal(err)
	}

	finalizeService := NewService(
		&chatAttachmentRepositoryStub{err: ErrUploadNotReady},
		&chatAttachmentObjectStoreStub{},
	)
	finalizeService.telemetry = telemetry
	if _, err := finalizeService.Finalize(
		context.Background(),
		subject,
		chatAttachmentTestID(t, "66666666-6666-4666-8666-666666666666"),
	); !errors.Is(err, ErrUploadNotReady) {
		t.Fatalf("finalize error = %v", err)
	}

	downloadService := NewService(
		&chatAttachmentRepositoryStub{
			err: fmt.Errorf(
				"%w: https://signed-url-sentinel.test/private-object",
				objectstorage.ErrProviderFailed,
			),
		},
		&chatAttachmentObjectStoreStub{},
	)
	downloadService.telemetry = telemetry
	if _, err := downloadService.Download(
		context.Background(),
		subject,
		chatAttachmentTestID(t, "55555555-5555-4555-8555-555555555555"),
	); !errors.Is(err, objectstorage.ErrProviderFailed) {
		t.Fatalf("download error = %v", err)
	}

	metrics := collectChatAttachmentMetrics(t, metricReader)
	for _, name := range []string{
		"chalk.api.chat_attachments.requests",
		"chalk.api.chat_attachments.request.duration_seconds",
	} {
		value, ok := metrics[name]
		if !ok {
			t.Fatalf("metric %q was not recorded", name)
		}
		assertChatAttachmentMetricKeys(t, value)
	}
	counter := metrics["chalk.api.chat_attachments.requests"]
	for _, expected := range []map[string]string{
		{"operation": "initiate", "outcome": "succeeded", "reason": "none"},
		{"operation": "finalize", "outcome": "rejected", "reason": "upload_in_progress"},
		{"operation": "download", "outcome": "failed", "reason": "storage_failed"},
	} {
		assertChatAttachmentMetricAttributes(t, counter, expected)
	}

	signals := logs.String() + fmt.Sprint(spanRecorder.Ended())
	for _, forbidden := range []string{
		"private-client-id-sentinel",
		"private-file-sentinel.png",
		"private-content-sentinel",
		"signed-url-sentinel",
		subject.TenantID.String(),
		subject.SessionID.String(),
	} {
		if strings.Contains(signals, forbidden) {
			t.Fatalf("telemetry exposed %q: %s", forbidden, signals)
		}
	}
}

func sha256Sum(value []byte) [32]byte {
	return sha256.Sum256(value)
}

func collectChatAttachmentMetrics(
	t *testing.T,
	reader *metric.ManualReader,
) map[string]metricdata.Metrics {
	t.Helper()
	var resources metricdata.ResourceMetrics
	if err := reader.Collect(context.Background(), &resources); err != nil {
		t.Fatal(err)
	}
	result := make(map[string]metricdata.Metrics)
	for _, scope := range resources.ScopeMetrics {
		for _, value := range scope.Metrics {
			result[value.Name] = value
		}
	}
	return result
}

func assertChatAttachmentMetricKeys(t *testing.T, value metricdata.Metrics) {
	t.Helper()
	for _, set := range chatAttachmentMetricAttributeSets(value) {
		for _, entry := range set.ToSlice() {
			switch string(entry.Key) {
			case "operation", "outcome", "reason":
			default:
				t.Fatalf("metric %q contains unbounded key %q", value.Name, entry.Key)
			}
		}
	}
}

func assertChatAttachmentMetricAttributes(
	t *testing.T,
	value metricdata.Metrics,
	expected map[string]string,
) {
	t.Helper()
	for _, set := range chatAttachmentMetricAttributeSets(value) {
		matches := true
		for key, want := range expected {
			got, ok := set.Value(attribute.Key(key))
			if !ok || got.AsString() != want {
				matches = false
				break
			}
		}
		if matches {
			return
		}
	}
	t.Fatalf("metric %q does not contain attributes %#v", value.Name, expected)
}

func chatAttachmentMetricAttributeSets(value metricdata.Metrics) []attribute.Set {
	var result []attribute.Set
	switch data := value.Data.(type) {
	case metricdata.Sum[int64]:
		for _, point := range data.DataPoints {
			result = append(result, point.Attributes)
		}
	case metricdata.Histogram[float64]:
		for _, point := range data.DataPoints {
			result = append(result, point.Attributes)
		}
	}
	return result
}
