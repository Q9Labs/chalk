package sfu

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

func TestTransportFailureCausesAtAdapterBoundary(t *testing.T) {
	const privateMarker = "private-transport-detail"
	for _, test := range []struct {
		name   string
		err    error
		cancel bool
		cause  transportCause
	}{
		{"timeout", context.DeadlineExceeded, false, transportCauseTimeout},
		{"caller canceled", context.Canceled, true, transportCauseCallerCanceled},
		{"caller canceled with timeout error", context.DeadlineExceeded, true, transportCauseCallerCanceled},
		{"canceled error with live caller", context.Canceled, false, transportCauseOther},
		{"connection reset", &net.OpError{Op: "read", Net: "tcp", Err: os.NewSyscallError("read", syscall.ECONNRESET)}, false, transportCauseConnectionReset},
		{"connection refused", &net.OpError{Op: "dial", Net: "tcp", Err: os.NewSyscallError("connect", syscall.ECONNREFUSED)}, false, transportCauseConnectionRefused},
		{"dns", &net.DNSError{Err: privateMarker, Name: privateMarker, IsNotFound: true}, false, transportCauseDNS},
		{"dns timeout", &net.DNSError{Err: privateMarker, IsTimeout: true}, false, transportCauseTimeout},
		{"tls record", tls.RecordHeaderError{Msg: privateMarker}, false, transportCauseTLS},
		{"tls certificate", &tls.CertificateVerificationError{Err: x509.UnknownAuthorityError{}}, false, transportCauseTLS},
		{"tls alert", tls.AlertError(40), false, transportCauseTLS},
		{"other", errors.New(privateMarker), false, transportCauseOther},
	} {
		for _, bodyFailure := range []bool{false, true} {
			for _, operation := range []string{"add_tracks", "close_tracks", "verify_connection"} {
				phase := "headers"
				if bodyFailure {
					phase = "body"
				}
				t.Run(test.name+"/"+phase+"/"+operation, func(t *testing.T) {
					logs := captureAddTracksLogs(t)
					recorder := tracetest.NewSpanRecorder()
					tracerProvider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
					reader := sdkmetric.NewManualReader()
					meterProvider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
					oldTracer, oldCounter := sfuTracer, sfuFailureCounter
					sfuTracer = tracerProvider.Tracer("transport-test")
					var err error
					sfuFailureCounter, err = meterProvider.Meter("transport-test").Int64Counter("chalk.api.cloudflare_sfu.failures")
					if err != nil {
						t.Fatal(err)
					}
					t.Cleanup(func() {
						sfuTracer, sfuFailureCounter = oldTracer, oldCounter
						_ = tracerProvider.Shutdown(context.Background())
						_ = meterProvider.Shutdown(context.Background())
					})
					ctx, cancel := context.WithCancel(context.Background())
					defer cancel()
					fail := func() error {
						if test.cancel {
							cancel()
						}
						return test.err
					}
					client := &http.Client{Transport: faultTransport(func(*http.Request) (*http.Response, error) {
						if bodyFailure {
							return &http.Response{StatusCode: http.StatusOK, Body: faultBody{fail: fail}}, nil
						}
						return nil, fail()
					})}
					adapter, err := NewAdapterWithClient(config.CloudflareRealtimeConfig{
						RealtimeAppID: "test-app", RealtimeAppSecret: "test-secret", RequestTimeout: 6 * time.Second,
					}, client, "https://example.invalid")
					if err != nil {
						t.Fatal(err)
					}
					switch operation {
					case "add_tracks":
						_, err = adapter.AddTracks(ctx, mediaplane.TracksRequest{ConnectionID: "connection"})
					case "close_tracks":
						_, err = adapter.CloseTracks(ctx, mediaplane.CloseTracksRequest{Provider: mediaplane.ProviderCloudflareSFU, ConnectionID: "connection"})
					case "verify_connection":
						_, err = adapter.VerifyConnectionMetadata(ctx, "connection")
					}
					var failure providerFailure
					if !errors.As(err, &failure) || failure.transportCause != test.cause {
						t.Fatalf("transport cause = %q, want %q", failure.transportCause, test.cause)
					}
					if errors.Is(err, context.Canceled) != test.cancel || errors.Is(err, mediaplane.ErrProviderFailed) == test.cancel {
						t.Fatal("caller cancellation and provider failure must remain distinct")
					}
					ended := recorder.Ended()
					if len(ended) != 1 {
						t.Fatalf("spans = %d, want 1", len(ended))
					}
					attrs := attribute.NewSet(ended[0].Attributes()...)
					cause, _ := attrs.Value("chalk.provider.transport_cause")
					if cause.AsString() != string(test.cause) {
						t.Fatal("span lost bounded transport cause")
					}
					if (ended[0].Status().Code == codes.Error) == test.cancel {
						t.Fatal("only provider failures should mark the span as an error")
					}
					var resource metricdata.ResourceMetrics
					if err := reader.Collect(context.Background(), &resource); err != nil {
						t.Fatal(err)
					}
					var failures int64
					for _, scope := range resource.ScopeMetrics {
						for _, metric := range scope.Metrics {
							for _, point := range metric.Data.(metricdata.Sum[int64]).DataPoints {
								failures += point.Value
							}
						}
					}
					wantFailures := int64(1)
					if test.cancel {
						wantFailures = 0
					}
					if failures != wantFailures {
						t.Fatalf("provider failure count = %d, want %d", failures, wantFailures)
					}
					encoded, err := json.Marshal(struct {
						Attributes []attribute.KeyValue
						Events     []sdktrace.Event
					}{ended[0].Attributes(), ended[0].Events()})
					if err != nil {
						t.Fatal(err)
					}
					if strings.Contains(logs.String(), privateMarker) || strings.Contains(string(encoded), privateMarker) || strings.Contains(failure.Error(), privateMarker) {
						t.Fatal("transport error details leaked into diagnostics")
					}
					if !strings.Contains(logs.String(), `"transport_cause":"`+string(test.cause)+`"`) {
						t.Fatal("log lost bounded transport cause")
					}
				})
			}
		}
	}
}

type faultTransport func(*http.Request) (*http.Response, error)

func (f faultTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	return f(request)
}

type faultBody struct{ fail func() error }

func (b faultBody) Read([]byte) (int, error) { return 0, b.fail() }
func (faultBody) Close() error               { return nil }

var _ io.ReadCloser = faultBody{}
