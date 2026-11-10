package recorderworker

import (
	"context"
	"fmt"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// Test-only entry points and fixtures restored with the Capture suite.
// Production code calls the context-taking variants directly.

func (a *PionCaptureAttempt) consumePacket(ctx context.Context, writer *captureBundleWriter, event captureRuntimeEvent) error {
	if (event.packet == nil && event.report == nil) || event.track == nil {
		return fmt.Errorf("%w: empty RTP event", ErrInvalidCaptureAttempt)
	}
	plan, err := a.packetAuthority(ctx)
	if err != nil {
		return err
	}
	return a.consumeAuthorizedPacket(ctx, writer, event, plan)
}

func (a *PionCaptureAttempt) emitReady(ctx context.Context, noPublisher bool) error {
	return a.emitReadyAt(ctx, noPublisher, a.config.Now().UTC())
}

func (w *captureBundleWriter) close(reason recordingbundle.CloseReason, now time.Time) error {
	storageCtx, cancel := context.WithTimeout(context.Background(), w.attempt.config.CloseTimeout)
	defer cancel()
	return w.closeWithContext(storageCtx, reason, now)
}

func testEnvelope(t *testing.T) recordingpipeline.RecorderJobEnvelope {
	t.Helper()
	return recordingpipeline.RecorderJobEnvelope{
		SchemaVersion: recordingpipeline.RecorderJobSchemaVersion, TenantID: "22222222-2222-4222-8222-222222222222", SpaceID: "33333333-3333-4333-8333-333333333333", EpisodeID: "44444444-4444-4444-8444-444444444444", RecordingID: "55555555-5555-4555-8555-555555555555", JobID: "66666666-6666-4666-8666-666666666666", Kind: recordingpipeline.JobKindCapture, AttemptCount: 1, FencingGeneration: 1, CaptureEpoch: 1, PolicySnapshotVersion: recordingpipeline.SupportedPolicySnapshotVersion, HardDeadline: "2026-08-25T12:00:00Z", InitialPlanRevision: recordingpipeline.RecorderInitialPlanRevision, BundleSchemaVersion: recordingpipeline.RecordingBundleSchema, LayoutProfile: recordingpipeline.RecordingLayoutProfile, ParticipantLimit: recordingpipeline.MaximumEpisodeParticipants, InputBitrateBPS: recordingpipeline.MaximumInputBitrateBPS, AudioCodec: "opus", VideoCodecs: []string{"vp8", "h264"}, PlanHandle: "77777777-7777-4777-8777-777777777777", SignalingHandle: "88888888-8888-4888-8888-888888888888", KeyHandle: "99999999-9999-4999-8999-999999999999", ObjectHandle: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	}
}

func testID(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatalf("parse id: %v", err)
	}
	return id
}

func bytesOf(value byte) []byte {
	result := make([]byte, 32)
	result[0] = value
	return result
}

type readinessControlStub struct {
	mu                    sync.Mutex
	calls                 int
	failAt                int
	err                   error
	reports               chan WorkerReadiness
	closedContextCanceled bool
	closeAt               int
}

func (s *readinessControlStub) ReportReadiness(ctx context.Context, readiness WorkerReadiness) (WorkerReadinessReceipt, error) {
	s.mu.Lock()
	s.calls++
	call := s.calls
	if !readiness.AdmissionOpen && ctx.Err() != nil {
		s.closedContextCanceled = true
	}
	s.mu.Unlock()
	s.reports <- readiness
	if call == s.failAt {
		return WorkerReadinessReceipt{}, s.err
	}
	receipt := WorkerReadinessReceipt{Role: "capture", WorkerReadiness: readiness, ObservedAt: time.Now(), UpdatedAt: time.Now()}
	if call == s.closeAt {
		receipt.AdmissionOpen = false
		receipt.ReadyCapacity = 0
	}
	return receipt, nil
}

func assertReadinessReport(t *testing.T, reports <-chan WorkerReadiness, admissionOpen bool, capacity int, reason string) {
	t.Helper()
	select {
	case report := <-reports:
		if report.AdmissionOpen != admissionOpen || report.ReadyCapacity != capacity || report.Reason != reason {
			t.Fatalf("report = %#v", report)
		}
	case <-time.After(time.Second):
		t.Fatal("readiness report timed out")
	}
}

type readinessRoundTripFunc func(*http.Request) (*http.Response, error)

func (function readinessRoundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}
