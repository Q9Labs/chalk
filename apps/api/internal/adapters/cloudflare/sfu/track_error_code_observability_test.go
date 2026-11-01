package sfu

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"go.opentelemetry.io/otel/attribute"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

func TestPerTrackErrorCodeIsRecordedOnSpanAndLog(t *testing.T) {
	for _, test := range []struct{ name, raw, want string }{
		{"known code", "not_found_track_error", "not_found_track_error"},
		{"known transport code", "transport_unavailable_error", "transport_unavailable_error"},
		{"unlisted but well formed code", "future_track_error_9", "other"},
		{"credential-like snake case", "invalid_privatecredential_state", "other"},
		{"uppercase", "NOT_FOUND_TRACK_ERROR", "other"},
		{"junk with spaces", "private-credential and more", "other"},
		{"email", "audio@example.invalid", "other"},
		{"over 64 characters", strings.Repeat("a", 65), "other"},
		{"exactly 64 characters", strings.Repeat("a", 64), "other"},
	} {
		t.Run(test.name, func(t *testing.T) {
			adapter := remoteTrackTestAdapter(t, `{"tracks":[{"sessionId":"publisher","trackName":"private-track","errorCode":"`+test.raw+`","errorDescription":"private provider detail"}]}`)
			_, err := adapter.AddTracks(context.Background(), mediaplane.TracksRequest{ConnectionID: "receiver", Tracks: []mediaplane.Track{{Location: "remote", SessionID: "publisher", TrackName: "private-track"}}})
			var failure providerFailure
			if !errors.As(err, &failure) || failure.stage != failureStageTrack {
				t.Fatalf("want per-track provider failure, got %v", err)
			}

			logs := captureAddTracksLogs(t)
			recorder := tracetest.NewSpanRecorder()
			provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
			ctx, span := provider.Tracer("track-error-code-test").Start(context.Background(), "failure")
			recordProviderFailure(ctx, span, err)
			span.End()
			if err := provider.Shutdown(context.Background()); err != nil {
				t.Fatal(err)
			}

			var record struct {
				TrackErrorCode string `json:"provider_track_error_code"`
			}
			if err := json.Unmarshal(logs.Bytes(), &record); err != nil {
				t.Fatal(err)
			}
			if record.TrackErrorCode != test.want {
				t.Fatalf("log provider_track_error_code = %q, want %q", record.TrackErrorCode, test.want)
			}
			ended := recorder.Ended()
			if len(ended) != 1 || len(ended[0].Events()) != 1 {
				t.Fatalf("missing failure span event: %v", ended)
			}
			attrs := attribute.NewSet(ended[0].Events()[0].Attributes...)
			code, _ := attrs.Value("chalk.provider.track_error_code")
			if code.AsString() != test.want {
				t.Fatalf("span chalk.provider.track_error_code = %q, want %q", code.AsString(), test.want)
			}

			encoded, err := json.Marshal(ended[0].Events())
			if err != nil {
				t.Fatal(err)
			}
			for _, private := range []string{"private provider detail", "private-track", "publisher", "private-credential", "example.invalid"} {
				if strings.Contains(logs.String(), private) || strings.Contains(string(encoded), private) {
					t.Fatalf("diagnostics leaked %q", private)
				}
			}
		})
	}
}

func TestTrackErrorCodeIsEmptyOutsidePerTrackFailures(t *testing.T) {
	topLevel := newProviderResponseFailure("add_tracks", failureStageTopLevel, 200, "not_found_track_error", "msg", 1, 0)
	if topLevel.details.trackErrorCode != "" {
		t.Fatalf("top-level failure carried track error code %q", topLevel.details.trackErrorCode)
	}
}

func TestTrackErrorCodeIsEmptyForCloseTracks(t *testing.T) {
	// close_tracks keeps its existing redaction of provider-chosen codes.
	failure := newProviderResponseFailure("close_tracks", failureStageTrack, 200, "invalid_privatecredential_state", "msg", 1, 1)
	if failure.details.trackErrorCode != "" {
		t.Fatalf("close_tracks carried track error code %q", failure.details.trackErrorCode)
	}
}
