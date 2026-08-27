package httpapi

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/capturesignaling"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

type recorderCaptureSignalingServiceStub struct {
	execute func(context.Context, capturesignaling.ExecuteRequest) (capturesignaling.Execution, error)
}

func (s recorderCaptureSignalingServiceStub) Execute(ctx context.Context, request capturesignaling.ExecuteRequest) (capturesignaling.Execution, error) {
	return s.execute(ctx, request)
}

func TestRecorderCaptureSignalingRoutesUseVerifiedCaptureAuthority(t *testing.T) {
	operations := make([]captureplane.OperationKind, 0, 6)
	var owner string
	service := recorderCaptureSignalingServiceStub{execute: func(_ context.Context, request capturesignaling.ExecuteRequest) (capturesignaling.Execution, error) {
		command := request.Command
		operations = append(operations, command.Identity.Operation)
		owner = command.Lease.Owner
		return capturesignaling.Execution{Result: recorderCaptureSignalingResult(command.Identity.Operation)}, nil
	}}
	workerID := mustRecorderWorkerID(t, workerTestID)
	router := NewRecorderWorkerRouterWithControls(
		recorderWorkerServiceStub{},
		recorderWorkerRouteVerifierStub{identity: workeridentity.Identity{WorkerID: workerID, Role: workeridentity.RoleCapture}},
		RecorderWorkerControlServices{CaptureSignaling: service},
	)

	common := recorderCaptureSignalingTestAuthority()
	pulledTrack := `{"owner_reference":"owner-1","track_reference":"track-1","participant_id":"` + workerTestClaim + `","participant_generation":1,"source":"camera","kind":"video","requested_layer":"auto","mid":"0"}`
	tests := []struct {
		path string
		body string
		op   captureplane.OperationKind
	}{
		{path: "/internal/v1/recorder/capture/create", body: "{" + common + "}", op: captureplane.OperationCreateCaptureConnection},
		{path: "/internal/v1/recorder/capture/pull", body: "{" + common + `,"connection":"connection-1","tracks":[{"owner_reference":"owner-1","track_reference":"track-1","participant_id":"` + workerTestClaim + `","participant_generation":1,"source":"camera","kind":"video","requested_layer":"auto"}]}`, op: captureplane.OperationPullCaptureTracks},
		{path: "/internal/v1/recorder/capture/renegotiate", body: "{" + common + `,"connection":"connection-1","negotiation_id":"negotiation-1","description":{"type":"answer","sdp":"v=0\r\n"}}`, op: captureplane.OperationRenegotiateCaptureConnection},
		{path: "/internal/v1/recorder/capture/inspect", body: "{" + common + `,"connection":"connection-1","tracks":[` + pulledTrack + `]}`, op: captureplane.OperationInspectCaptureConnection},
		{path: "/internal/v1/recorder/capture/close-tracks", body: "{" + common + `,"connection":"connection-1","tracks":[` + pulledTrack + `]}`, op: captureplane.OperationCloseCaptureTracks},
		{path: "/internal/v1/recorder/capture/close-connection", body: "{" + common + `,"connection":"connection-1","tracks":[` + pulledTrack + `],"force":true}`, op: captureplane.OperationCloseCaptureConnection},
	}
	for _, test := range tests {
		response := httptest.NewRecorder()
		router.ServeHTTP(response, recorderWorkerRequest(http.MethodPost, test.path, test.body))
		if response.Code != http.StatusOK {
			t.Fatalf("%s status=%d body=%s", test.op, response.Code, response.Body.String())
		}
	}
	if owner != workerTestID {
		t.Fatalf("capture signaling lease owner = %q, want verified worker %q", owner, workerTestID)
	}
	if len(operations) != len(tests) {
		t.Fatalf("capture signaling operations = %v", operations)
	}
	for index, test := range tests {
		if operations[index] != test.op {
			t.Fatalf("capture signaling operation %d = %s, want %s", index, operations[index], test.op)
		}
	}
}

func TestRecorderCaptureSignalingRejectsRenderWorkerAndUnconfiguredRoute(t *testing.T) {
	called := false
	service := recorderCaptureSignalingServiceStub{execute: func(context.Context, capturesignaling.ExecuteRequest) (capturesignaling.Execution, error) {
		called = true
		return capturesignaling.Execution{}, nil
	}}
	workerID := mustRecorderWorkerID(t, workerTestID)
	renderRouter := NewRecorderWorkerRouterWithControls(
		recorderWorkerServiceStub{},
		recorderWorkerRouteVerifierStub{identity: workeridentity.Identity{WorkerID: workerID, Role: workeridentity.RoleRender}},
		RecorderWorkerControlServices{CaptureSignaling: service},
	)
	response := httptest.NewRecorder()
	renderRouter.ServeHTTP(response, recorderWorkerRequest(http.MethodPost, "/internal/v1/recorder/capture/create", "{"+recorderCaptureSignalingTestAuthority()+"}"))
	if response.Code != http.StatusForbidden || called {
		t.Fatalf("render signaling status=%d called=%v body=%s", response.Code, called, response.Body.String())
	}

	unconfigured := NewRecorderWorkerRouter(
		recorderWorkerServiceStub{},
		recorderWorkerRouteVerifierStub{identity: workeridentity.Identity{WorkerID: workerID, Role: workeridentity.RoleCapture}},
	)
	response = httptest.NewRecorder()
	unconfigured.ServeHTTP(response, recorderWorkerRequest(http.MethodPost, "/internal/v1/recorder/capture/create", "{"+recorderCaptureSignalingTestAuthority()+"}"))
	if response.Code != http.StatusNotFound {
		t.Fatalf("unconfigured signaling status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestRecorderCaptureSignalingRequiresMIDForPulledTrackLists(t *testing.T) {
	called := false
	service := recorderCaptureSignalingServiceStub{execute: func(context.Context, capturesignaling.ExecuteRequest) (capturesignaling.Execution, error) {
		called = true
		return capturesignaling.Execution{}, nil
	}}
	workerID := mustRecorderWorkerID(t, workerTestID)
	router := NewRecorderWorkerRouterWithControls(
		recorderWorkerServiceStub{},
		recorderWorkerRouteVerifierStub{identity: workeridentity.Identity{WorkerID: workerID, Role: workeridentity.RoleCapture}},
		RecorderWorkerControlServices{CaptureSignaling: service},
	)
	body := "{" + recorderCaptureSignalingTestAuthority() + `,"connection":"connection-1","tracks":[{"owner_reference":"owner-1","track_reference":"track-1","participant_id":"` + workerTestClaim + `","participant_generation":1,"source":"camera","kind":"video","requested_layer":"auto"}]}`
	response := httptest.NewRecorder()
	router.ServeHTTP(response, recorderWorkerRequest(http.MethodPost, "/internal/v1/recorder/capture/inspect", body))
	if response.Code != http.StatusBadRequest || called {
		t.Fatalf("missing MID status=%d called=%v body=%s", response.Code, called, response.Body.String())
	}
}

func recorderCaptureSignalingTestAuthority() string {
	return fmt.Sprintf(
		`"signaling_handle":"88888888-8888-4888-8888-888888888888","tenant_id":"%s","space_id":"%s","episode_id":"%s","recording_id":"%s","job_id":"%s","attempt_count":1,"fencing_generation":2,"capture_epoch":1,"envelope_digest":"%s","lease_token":"lease","lease_expires_at":"%s","plan_revision":1,"idempotency_key":"command-1"`,
		workerTestTenant,
		workerTestTenant,
		workerTestEpisode,
		workerTestRecord,
		workerTestJob,
		strings.Repeat("ab", 32),
		time.Now().UTC().Add(time.Hour).Format(time.RFC3339Nano),
	)
}

func recorderCaptureSignalingResult(operation captureplane.OperationKind) capturesignaling.CommandResult {
	connection := captureplane.CaptureConnection{ConnectionReference: "connection-1", CaptureEpoch: 1, PlanRevision: 1}
	negotiation := captureplane.Negotiation{Requirement: captureplane.NegotiationNotRequired}
	switch operation {
	case captureplane.OperationCreateCaptureConnection:
		return capturesignaling.CommandResult{CreateCaptureConnection: &captureplane.CreateCaptureConnectionResult{Connection: connection, Negotiation: negotiation}}
	case captureplane.OperationPullCaptureTracks:
		return capturesignaling.CommandResult{PullCaptureTracks: &captureplane.PullCaptureTracksResult{Connection: connection, Negotiation: negotiation}}
	case captureplane.OperationRenegotiateCaptureConnection:
		return capturesignaling.CommandResult{RenegotiateCaptureConnection: &captureplane.RenegotiateCaptureConnectionResult{Connection: connection, Negotiation: negotiation}}
	case captureplane.OperationInspectCaptureConnection:
		return capturesignaling.CommandResult{InspectCaptureConnection: &captureplane.InspectCaptureConnectionResult{Connection: connection, State: captureplane.CaptureConnectionConnected, Negotiation: negotiation}}
	case captureplane.OperationCloseCaptureTracks:
		return capturesignaling.CommandResult{CloseCaptureTracks: &captureplane.CloseCaptureTracksResult{Connection: connection, Negotiation: negotiation}}
	case captureplane.OperationCloseCaptureConnection:
		return capturesignaling.CommandResult{CloseCaptureConnection: &captureplane.CloseCaptureConnectionResult{Connection: connection, Closed: true}}
	default:
		return capturesignaling.CommandResult{}
	}
}
