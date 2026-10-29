package sfu

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"go.opentelemetry.io/otel/attribute"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

func TestCaptureCloseRecordsRedactedTrackRejection(t *testing.T) {
	for _, test := range []struct {
		operation string
		code      string
		wantCode  string
	}{
		{"tracks", "invalid_track_state", "invalid_track_state"},
		{"connection", "invalid_track_state", "invalid_track_state"},
		{"tracks", "invalid_privatecredential_state", "invalid_[redacted]_state"},
		{"connection", "invalid_privatecredential_state", "invalid_[redacted]_state"},
	} {
		t.Run(test.operation+"/"+test.code, func(t *testing.T) {
			message := "Cannot close track in invalid state. Bearer private-token https://example.test/secret?token=private-token a=ice-pwd:private-password " + strings.Repeat("request rejected ", 100)
			payload, err := json.Marshal(map[string]any{"tracks": []map[string]string{{"mid": "7", "errorCode": test.code, "errorDescription": message}}, "sdp": "private-sdp"})
			if err != nil {
				t.Fatal(err)
			}
			client := &captureSequenceClient{responses: []captureHTTPResponse{{status: http.StatusOK, body: string(payload)}}}
			if test.operation == "connection" {
				client.responses = append([]captureHTTPResponse{{status: http.StatusOK, body: `{"tracks":[{"mid":"7","location":"remote"}]}`}}, client.responses...)
			}
			adapter := newCaptureTestAdapter(t, client)
			logs := captureAddTracksLogs(t)
			recorder := tracetest.NewSpanRecorder()
			provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
			defer provider.Shutdown(context.Background())
			ctx, span := provider.Tracer("close-test").Start(context.Background(), "capture-close")
			metadata := captureMetadata("close-rejection")
			tracks := []captureplane.PulledCaptureTrack{{CaptureTrack: captureTrack("private-publisher", "private-camera", 6, captureplane.TrackSourceCamera, captureplane.TrackKindVideo, captureplane.TrackLayerMedium), MID: "7"}}
			if test.operation == "tracks" {
				_, err = adapter.CloseCaptureTracks(ctx, captureplane.CloseCaptureTracksInput{Metadata: metadata, Connection: "private-connection", Tracks: tracks})
			} else {
				_, err = adapter.CloseCaptureConnection(ctx, captureplane.CloseCaptureConnectionInput{Metadata: metadata, Connection: "private-connection", Tracks: tracks, Force: true})
			}
			span.End()
			var failure captureplane.ProviderError
			if !errors.As(err, &failure) || failure.Class != captureplane.ProviderFailureProtocol || failure.Code != "provider_track_200" || failure.Retryable {
				t.Fatalf("track rejection behavior changed: %v", err)
			}
			type failureRecord struct {
				Event   string `json:"event"`
				Code    string `json:"provider_raw_code"`
				Message string `json:"provider_message"`
			}
			var records []failureRecord
			for line := range strings.Lines(logs.String()) {
				var record failureRecord
				if err := json.Unmarshal([]byte(line), &record); err != nil {
					t.Fatal(err)
				}
				if record.Event == "cloudflare_sfu.request_failed" {
					records = append(records, record)
				}
			}
			if len(records) != 1 || records[0].Code != test.wantCode || !strings.Contains(records[0].Message, "Cannot close track in invalid state.") || utf8.RuneCountInString(records[0].Message) > maxProviderMessageRunes+1 {
				t.Fatalf("missing bounded rejection diagnostics: %+v", records)
			}
			var events int
			for _, ended := range recorder.Ended() {
				for _, event := range ended.Events() {
					if event.Name != "cloudflare_sfu.provider_failure" {
						continue
					}
					events++
					attrs := attribute.NewSet(event.Attributes...)
					code, _ := attrs.Value("chalk.provider.raw_error_code")
					message, _ := attrs.Value("chalk.provider.message")
					if code.AsString() != records[0].Code || message.AsString() != records[0].Message {
						t.Fatalf("trace lost rejection diagnostics: %v", event.Attributes)
					}
				}
			}
			if events != 1 {
				t.Fatalf("got %d provider failure events; want 1", events)
			}
			traceJSON, err := json.Marshal(recorder.Ended()[0].Events())
			if err != nil {
				t.Fatal(err)
			}
			for _, private := range []string{"private-token", "example.test", "private-password", "private-sdp", "private-publisher", "private-camera", "private-connection", "sfu-app-secret", "privatecredential"} {
				if strings.Contains(logs.String(), private) || strings.Contains(string(traceJSON), private) {
					t.Fatalf("diagnostics leaked %q", private)
				}
			}
		})
	}
}
