package recorderworker

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"go.opentelemetry.io/otel/trace"
)

var errInvalidTestAttempt = errors.New("invalid test attempt")

func testClaim(t *testing.T) ClaimResult {
	t.Helper()
	claimRequestID, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte("envelope"))
	return ClaimResult{
		ClaimRequestID: claimRequestID, EnvelopeDigest: digest[:],
		Envelope: recordingpipeline.RecorderJobEnvelope{
			TenantID: "tenant-1", EpisodeID: "episode-1", RecordingID: "recording-1", JobID: "job-1", AttemptCount: 2, CaptureEpoch: 3,
		},
	}
}

func TestClaimAttemptContextJoinsTheEpisodeJourneyAndTrace(t *testing.T) {
	claim := testClaim(t)
	journeyID, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	claim.JourneyID = journeyID
	claim.TraceID = "0af7651916cd43dd8448eb211c80319c"

	ctx, err := claimAttemptContext(context.Background(), claim, "capture", errInvalidTestAttempt)
	if err != nil {
		t.Fatal(err)
	}
	if got, ok := observability.JourneyIDFromContext(ctx); !ok || got != journeyID {
		t.Fatalf("attempt must run on the Episode journey %s, got %s", journeyID, got)
	}
	if got := trace.SpanContextFromContext(ctx).TraceID().String(); got != claim.TraceID {
		t.Fatalf("attempt must run on the Episode trace %s, got %s", claim.TraceID, got)
	}
}

func TestClaimAttemptContextFallsBackForAnAPIWithoutJourneyCarry(t *testing.T) {
	claim := testClaim(t)
	ctx, err := claimAttemptContext(context.Background(), claim, "render", errInvalidTestAttempt)
	if err != nil {
		t.Fatal(err)
	}
	if got, ok := observability.JourneyIDFromContext(ctx); !ok || got != claim.ClaimRequestID {
		t.Fatalf("without a carried journey the claim request id names it, got %s", got)
	}
	again, err := claimAttemptContext(context.Background(), claim, "render", errInvalidTestAttempt)
	if err != nil {
		t.Fatal(err)
	}
	if first, second := trace.SpanContextFromContext(ctx), trace.SpanContextFromContext(again); first.TraceID() != second.TraceID() || first.SpanID() != second.SpanID() {
		t.Fatal("a replayed claim must land on the same trace and span")
	}
	other, err := claimAttemptContext(context.Background(), claim, "capture", errInvalidTestAttempt)
	if err != nil {
		t.Fatal(err)
	}
	if trace.SpanContextFromContext(ctx).SpanID() == trace.SpanContextFromContext(other).SpanID() {
		t.Fatal("capture and render attempts of one claim must not share a span")
	}
}

func TestClaimAttemptContextRejectsAnIncompleteClaim(t *testing.T) {
	claim := testClaim(t)
	claim.EnvelopeDigest = nil
	if _, err := claimAttemptContext(context.Background(), claim, "capture", errInvalidTestAttempt); !errors.Is(err, errInvalidTestAttempt) {
		t.Fatalf("a claim without an envelope digest is invalid, got %v", err)
	}
}

func TestClaimAttemptContextPutsRecordingFieldsOnEveryLogRow(t *testing.T) {
	ctx, err := claimAttemptContext(context.Background(), testClaim(t), "capture", errInvalidTestAttempt)
	if err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	observability.New(observability.Config{Service: "chalk-recorder-capture", LogFormat: observability.LogFormatText}, &output).
		Logger().InfoContext(ctx, "capture row")
	for _, want := range []string{"recording_id=recording-1", "job_id=job-1", "episode_id=episode-1", "tenant_id=tenant-1", "attempt=2", "capture_epoch=3"} {
		if !strings.Contains(output.String(), want) {
			t.Errorf("log row lacks %s: %s", want, output.String())
		}
	}
}

func TestRenderFailureCodeNamesTheStage(t *testing.T) {
	cause := renderStageError{stage: RenderAttemptStageDownloadCapture, err: errors.New("download recording capture: boom")}
	if got := renderFailureCode(fmt.Errorf("render: %w", cause)); got != "render_download_capture_failed" {
		t.Fatalf("stage failure code = %q", got)
	}
	if got := renderFailureCode(errors.New("no stage")); got != recordingpipeline.DefaultRenderFailureCode {
		t.Fatalf("unstaged failure code = %q", got)
	}
}

func TestEveryRenderStageYieldsAnAcceptedFailureCode(t *testing.T) {
	stages := []RenderAttemptStage{
		RenderAttemptStageResolveInput, RenderAttemptStageDownloadPresentation, RenderAttemptStageDownloadAssetManifest,
		RenderAttemptStageStageAssets, RenderAttemptStageDownloadCapture, RenderAttemptStageAccessCaptureKeys,
		RenderAttemptStageSourcePreparation, RenderAttemptStageCompositionEncoding, RenderAttemptStageProbe,
		RenderAttemptStagePersistVideo, RenderAttemptStagePersistTranscription, RenderAttemptStageCommit,
	}
	for _, stage := range stages {
		want := "render_" + string(stage) + "_failed"
		if got := renderFailureCode(renderStageError{stage: stage, err: errors.New("x")}); got != want {
			t.Errorf("stage %s sanitized to %q, want %q", stage, got, want)
		}
	}
}
