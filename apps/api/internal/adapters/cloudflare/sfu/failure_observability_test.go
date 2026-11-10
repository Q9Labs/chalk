package sfu

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"github.com/q9labs/chalk/apps/api/internal/config"
)

// descriptions are provider free text that echoes a failed dial. The provider's description is
// never reflected, so none of them may reach an error, a log or a span.
var descriptions = []string{
	"connection to ::bad failed",
	"connection to bad:: failed",
	"connection to media-internal failed",
	"connection to media. failed",
	`Post "https://media.internal/x": dial tcp media.internal:8080: connection refused`,
	"dial tcp 203.0.113.17:8080: connection refused",
	"dial tcp [2001:db8::1]:8080: connection refused",
	"peer [media.internal] closed",
	"dial tcp localhost:8080: connection refused",
	"https://media.internal/x",
	"lookup media.internal on resolver: no such host",
}

// assertNoReflection fails when an output carries a chunk of the input that holds punctuation (a
// host, address, port, URL or label) or when any output token parses as an IP or host:port.
// Text the output carries for an empty description, such as "failed:" or JSON syntax, is its own.
func assertNoReflection(t *testing.T, input string, baseline string, outputs ...string) {
	t.Helper()
	for _, chunk := range strings.Fields(input) {
		chunk = strings.Trim(chunk, `"',`)
		if len(chunk) < 3 || !strings.ContainsAny(chunk, ".:-/[]@") || strings.Contains(baseline, chunk) {
			continue
		}
		for _, output := range outputs {
			if strings.Contains(output, chunk) {
				t.Fatalf("output reflects %q from %q: %s", chunk, input, output)
			}
		}
	}
	for _, output := range outputs {
		for _, token := range strings.FieldsFunc(output, func(r rune) bool { return strings.ContainsRune(" \t\n\"'=,{}", r) }) {
			token = strings.Trim(token, "[]:")
			if _, err := netip.ParseAddr(token); err == nil {
				t.Fatalf("output token %q parses as an IP: %s", token, output)
			}
			if host, port, err := net.SplitHostPort(token); err == nil && port != "" && host != "" {
				t.Fatalf("output token %q parses as host:port: %s", token, output)
			}
		}
	}
}

func baselineError() string {
	failure := newProviderResponseFailure("close_tracks", failureStageTopLevel, 200, "internal_error", "", 0, 0)
	snapshot := captureResponseSnapshot([]byte(`{"errorCode":"internal_error","errorDescription":"","tracks":[{"errorCode":"internal_error","errorDescription":""}]}`))
	return failure.Error() + snapshot
}

func TestAProviderDescriptionIsNeverReflected(t *testing.T) {
	baseline := baselineError()
	for _, description := range descriptions {
		t.Run(description, func(t *testing.T) {
			failure := newProviderResponseFailure("close_tracks", failureStageTopLevel, 200, "internal_error", description, 0, 0)
			snapshot := captureResponseSnapshot(mustJSON(t, map[string]any{
				"errorCode": "internal_error", "errorDescription": description,
				"tracks": []map[string]string{{"errorCode": "internal_error", "errorDescription": description}},
			}))
			assertNoReflection(t, description, baseline, failure.Error(), fmt.Sprintf("%v", failure), snapshot)
			if failure.details.messageFingerprint == "" {
				t.Fatal("the description left no fingerprint to match incidents by")
			}
		})
	}
}

func FuzzAProviderDescriptionIsNeverReflected(f *testing.F) {
	for _, description := range descriptions {
		f.Add(description)
	}
	baseline := baselineError()
	f.Fuzz(func(t *testing.T, description string) {
		failure := newProviderResponseFailure("close_tracks", failureStageTopLevel, 200, "internal_error", description, 0, 0)
		outputs := []string{failure.Error()}
		if utf8.ValidString(description) {
			outputs = append(outputs, captureResponseSnapshot(mustJSON(t, map[string]string{"errorCode": "internal_error", "errorDescription": description})))
		}
		assertNoReflection(t, description, baseline, outputs...)
	})
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

type replyClient struct{ body string }

func (c replyClient) Do(*http.Request) (*http.Response, error) {
	return &http.Response{StatusCode: http.StatusOK, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(c.body))}, nil
}

// An HTTP 200 body whose description echoes a failed dial reaches the error, the log and the
// span event only as a code and a fingerprint.
func TestAProviderDescriptionStaysOutOfTheErrorTheLogAndTheSpan(t *testing.T) {
	spans := tracetest.NewSpanRecorder()
	otel.SetTracerProvider(sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(spans)))
	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })

	for _, description := range descriptions {
		adapter, err := NewAdapterWithClient(config.CloudflareRealtimeConfig{RealtimeAppID: "app", RealtimeAppSecret: "secret", RequestTimeout: time.Second},
			replyClient{body: string(mustJSON(t, map[string]string{"errorCode": "internal_error", "errorDescription": description}))}, "https://cloudflare.test/v1")
		if err != nil {
			t.Fatal(err)
		}
		logs.Reset()
		err = adapter.request(context.Background(), http.MethodPost, "/close", nil, &closeTracksResponse{}, "close_tracks")
		if err == nil {
			t.Fatalf("%q: the rejection was not an error", description)
		}
		var events strings.Builder
		for _, span := range spans.Ended() {
			for _, event := range span.Events() {
				fmt.Fprint(&events, event.Name, event.Attributes)
			}
		}
		assertNoReflection(t, description, baselineError(), err.Error(), logs.String(), events.String())
		if !strings.Contains(logs.String(), "provider_message_fingerprint") {
			t.Fatalf("%q: log lacks the fingerprint: %s", description, logs.String())
		}
	}
}
