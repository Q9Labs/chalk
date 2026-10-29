package sfu

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"

	"go.opentelemetry.io/otel/attribute"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

func TestHTTPFailureRecordsOnlyAllowlistedRawCodes(t *testing.T) {
	for _, code := range []string{
		"unauthorized", "not_found", "decoding_error", "invalid_params", "payload_too_large",
		"session_error", "invalid_session_description", "not_found_track_error", "empty_track_error",
		"repeated_local_track_error", "update_track_error", "close_track_error", "internal_error",
	} {
		t.Run(code, func(t *testing.T) {
			body, err := json.Marshal(map[string]string{
				"errorCode": code, "errorDescription": "Cannot close track in invalid state. private-credential https://private.invalid/token", "sdp": "private-sdp",
			})
			if err != nil {
				t.Fatal(err)
			}
			assertHTTPFailureDiagnostics(t, body, code)
		})
	}
}

func TestHTTPFailureRedactsUnknownAndUnparsedCodes(t *testing.T) {
	for _, test := range []struct {
		name string
		body string
		want string
	}{
		{"unknown code", `{"errorCode":"private-credential","errorDescription":"Cannot close track in invalid state"}`, "unlisted"},
		{"uppercase unknown code", `{"errorCode":"PRIVATE_CREDENTIAL"}`, "unlisted"},
		{"code with trailing data", `{"errorCode":"session_error private-credential"}`, "unlisted"},
		{"padded code", `{"errorCode":" session_error "}`, "unlisted"},
		{"unbounded code", `{"errorCode":"` + strings.Repeat("private-credential", 1000) + `"}`, "unlisted"},
		{"missing code", `{"errorDescription":"Cannot close track in invalid state"}`, "unparsed_body"},
		{"empty code", `{"errorCode":""}`, "unparsed_body"},
		{"blank code", `{"errorCode":"  "}`, "unparsed_body"},
		{"wrong code type", `{"errorCode":42}`, "unparsed_body"},
		{"legacy code array", `{"errors":[{"code":"not_found","message":"private-credential"}]}`, "unparsed_body"},
		{"null body", `null`, "unparsed_body"},
		{"empty body", ``, "unparsed_body"},
		{"invalid json", `private-credential`, "unparsed_body"},
		{"truncated json", `{"errorCode":"session_error"`, "unparsed_body"},
		{"trailing json", `{"errorCode":"session_error"}{}`, "unparsed_body"},
		{"unrelated field type", `{"errorCode":"session_error","errorDescription":42}`, "session_error"},
	} {
		t.Run(test.name, func(t *testing.T) {
			assertHTTPFailureDiagnostics(t, []byte(test.body), test.want)
		})
	}
}

func assertHTTPFailureDiagnostics(t *testing.T, body []byte, want string) {
	t.Helper()
	for _, status := range []int{http.StatusNotFound, http.StatusGone, http.StatusTooEarly, http.StatusServiceUnavailable} {
		failureErr := sfuStatusError("close_tracks", status, body)
		var failure providerFailure
		if !errors.As(failureErr, &failure) || failure.statusCode != status || failure.stage != failureStageHTTPStatus {
			t.Fatalf("HTTP failure lost status or stage: %v", failureErr)
		}
		logs := captureAddTracksLogs(t)
		recorder := tracetest.NewSpanRecorder()
		provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
		ctx, span := provider.Tracer("http-failure-test").Start(context.Background(), "failure")
		recordProviderFailure(ctx, span, failureErr)
		span.End()
		if err := provider.Shutdown(context.Background()); err != nil {
			t.Fatal(err)
		}
		var record struct {
			Code        string `json:"provider_raw_code"`
			Message     string `json:"provider_message"`
			Fingerprint string `json:"provider_message_fingerprint"`
			Snapshot    string `json:"provider_response_snapshot"`
		}
		if err := json.Unmarshal(logs.Bytes(), &record); err != nil {
			t.Fatal(err)
		}
		if record.Code != want || record.Message != "" || record.Fingerprint != "" || record.Snapshot != "" {
			t.Fatalf("HTTP %d recorded unwanted diagnostics: %+v, want code %q only", status, record, want)
		}
		ended := recorder.Ended()
		if len(ended) != 1 || len(ended[0].Events()) != 1 {
			t.Fatalf("missing failure span event: %v", ended)
		}
		attrs := attribute.NewSet(ended[0].Events()[0].Attributes...)
		code, _ := attrs.Value("chalk.provider.raw_error_code")
		message, _ := attrs.Value("chalk.provider.message")
		fingerprint, _ := attrs.Value("chalk.provider.message_fingerprint")
		snapshot, _ := attrs.Value("chalk.provider.response_snapshot")
		if code.AsString() != want || message.AsString() != "" || fingerprint.AsString() != "" || snapshot.AsString() != "" {
			t.Fatalf("HTTP %d span retained unwanted diagnostics: %v", status, ended[0].Events())
		}
		encoded, err := json.Marshal(ended[0].Events())
		if err != nil {
			t.Fatal(err)
		}
		for _, private := range []string{"private-credential", "PRIVATE_CREDENTIAL", "private.invalid", "private-sdp", "Cannot close track"} {
			if strings.Contains(logs.String(), private) || strings.Contains(string(encoded), private) || strings.Contains(failureErr.Error(), private) {
				t.Fatalf("HTTP %d diagnostics leaked %q", status, private)
			}
		}
	}
}
