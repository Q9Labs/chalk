package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/recordinglifecycle"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

const workerTestSpace = "77777777-7777-4777-8777-777777777777"

type recorderRecordingLifecycleServiceStub struct {
	ready   func(context.Context, recordinglifecycle.ReadyInput) (recordinglifecycle.Publication, error)
	stopped func(context.Context, recordinglifecycle.StoppedInput) (recordinglifecycle.Publication, error)
}

func (s recorderRecordingLifecycleServiceStub) PublishReady(ctx context.Context, input recordinglifecycle.ReadyInput) (recordinglifecycle.Publication, error) {
	return s.ready(ctx, input)
}

func (s recorderRecordingLifecycleServiceStub) PublishStopped(ctx context.Context, input recordinglifecycle.StoppedInput) (recordinglifecycle.Publication, error) {
	return s.stopped(ctx, input)
}

func TestRecorderRecordingLifecyclePublishesFencedReadyAndStopped(t *testing.T) {
	readyCalls, stoppedCalls := 0, 0
	service := recorderRecordingLifecycleServiceStub{
		ready: func(_ context.Context, input recordinglifecycle.ReadyInput) (recordinglifecycle.Publication, error) {
			readyCalls++
			assertRecorderLifecycleAuthority(t, input.Authority)
			if input.RequestKey != "capture_ready_44444444-4444-4444-8444-444444444444_3" || !input.NoPublisher || input.ReadyAt.IsZero() {
				t.Fatalf("ready input = %+v", input)
			}
			return recordinglifecycle.Publication{}, nil
		},
		stopped: func(_ context.Context, input recordinglifecycle.StoppedInput) (recordinglifecycle.Publication, error) {
			stoppedCalls++
			assertRecorderLifecycleAuthority(t, input.Authority)
			if input.RequestKey != "capture_stopped_44444444-4444-4444-8444-444444444444_3" || input.StoppedAt.IsZero() {
				t.Fatalf("stopped input = %+v", input)
			}
			return recordinglifecycle.Publication{}, nil
		},
	}
	router := recorderRecordingLifecycleRouter(t, workeridentity.RoleCapture, service)

	response := httptest.NewRecorder()
	router.ServeHTTP(response, recorderWorkerRequest(http.MethodPost, "/internal/v1/recorder/capture/ready", recordingLifecycleAuthorityJSON()+`,"request_key":"capture_ready_44444444-4444-4444-8444-444444444444_3","observed_at":"2026-08-25T12:00:00Z","no_publisher":true}`))
	if response.Code != http.StatusNoContent || readyCalls != 1 || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("ready status=%d calls=%d headers=%v body=%s", response.Code, readyCalls, response.Header(), response.Body.String())
	}

	response = httptest.NewRecorder()
	router.ServeHTTP(response, recorderWorkerRequest(http.MethodPost, "/internal/v1/recorder/capture/stopped", recordingLifecycleAuthorityJSON()+`,"request_key":"capture_stopped_44444444-4444-4444-8444-444444444444_3","observed_at":"2026-08-25T12:01:00Z"}`))
	if response.Code != http.StatusNoContent || stoppedCalls != 1 {
		t.Fatalf("stopped status=%d calls=%d body=%s", response.Code, stoppedCalls, response.Body.String())
	}
}

func TestRecorderRecordingLifecycleRejectsWrongRoleAndMapsConflict(t *testing.T) {
	called := false
	service := recorderRecordingLifecycleServiceStub{
		ready: func(context.Context, recordinglifecycle.ReadyInput) (recordinglifecycle.Publication, error) {
			called = true
			return recordinglifecycle.Publication{}, recordinglifecycle.ErrOperationConflict
		},
		stopped: func(context.Context, recordinglifecycle.StoppedInput) (recordinglifecycle.Publication, error) {
			return recordinglifecycle.Publication{}, errors.New("unexpected stopped callback")
		},
	}
	body := recordingLifecycleAuthorityJSON() + `,"request_key":"capture_ready_44444444-4444-4444-8444-444444444444_3","observed_at":"2026-08-25T12:00:00Z","no_publisher":false}`

	renderRouter := recorderRecordingLifecycleRouter(t, workeridentity.RoleRender, service)
	response := httptest.NewRecorder()
	renderRouter.ServeHTTP(response, recorderWorkerRequest(http.MethodPost, "/internal/v1/recorder/capture/ready", body))
	if response.Code != http.StatusForbidden || called {
		t.Fatalf("render status=%d called=%v body=%s", response.Code, called, response.Body.String())
	}

	captureRouter := recorderRecordingLifecycleRouter(t, workeridentity.RoleCapture, service)
	response = httptest.NewRecorder()
	captureRouter.ServeHTTP(response, recorderWorkerRequest(http.MethodPost, "/internal/v1/recorder/capture/ready", body))
	if response.Code != http.StatusConflict || !called {
		t.Fatalf("conflict status=%d called=%v body=%s", response.Code, called, response.Body.String())
	}
}

func assertRecorderLifecycleAuthority(t *testing.T, authority recordinglifecycle.Authority) {
	t.Helper()
	if authority.TenantID != workerTestTenant || authority.SpaceID != workerTestSpace || authority.EpisodeID != workerTestEpisode || authority.RecordingID != workerTestRecord || authority.JobID != workerTestJob || authority.AttemptCount != 1 || authority.FencingGeneration != 2 || authority.CaptureEpoch != 3 || authority.LeaseOwner != workerTestID || authority.LeaseToken != "lease-token" || len(authority.EnvelopeDigest) != 32 {
		t.Fatalf("lifecycle authority = %+v", authority)
	}
}

func recorderRecordingLifecycleRouter(t *testing.T, role workeridentity.Role, service RecorderRecordingLifecycleService) http.Handler {
	t.Helper()
	workerID := mustRecorderWorkerID(t, workerTestID)
	return NewRecorderWorkerRouterWithControls(recorderWorkerServiceStub{}, recorderWorkerRouteVerifierStub{identity: workeridentity.Identity{WorkerID: workerID, Role: role}}, RecorderWorkerControlServices{RecordingLifecycle: service})
}

func recordingLifecycleAuthorityJSON() string {
	return recordingAuthorityJSON() + `,"space_id":"` + workerTestSpace + `"`
}
