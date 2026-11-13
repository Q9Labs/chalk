package capturesignaling

import (
	"bytes"
	"context"
	"errors"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplane"
)

func TestSignalingHandleIsCanonicalEnvelopeUUID(t *testing.T) {
	canonical := signalingHandle()
	if _, err := NewSignalingHandle(string(canonical)); err != nil {
		t.Fatalf("canonical handle: %v", err)
	}
	if _, err := NewSignalingHandle("signal-1"); !errors.Is(err, ErrInvalidSignalingHandle) {
		t.Fatalf("opaque handle error = %v", err)
	}
	if _, err := NewSignalingHandle(" 11111111-1111-1111-1111-111111111111"); !errors.Is(err, ErrInvalidSignalingHandle) {
		t.Fatalf("spaced handle error = %v", err)
	}
	if _, err := NewSignalingHandle("11111111-1111-1111-1111-111111111111"); err != nil {
		t.Fatalf("fixed UUID: %v", err)
	}
}

func TestCommandIdentityHasOneOperationField(t *testing.T) {
	command := commandFor(captureplane.OperationCreateCaptureConnection, time.Now().Add(time.Minute))
	request, _, err := CanonicalRequest(command)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(request, []byte("operation_kind")) || bytes.Contains(request, []byte(`"kind"`)) {
		t.Fatalf("canonical identity contains removed aliases: %s", request)
	}
}

func TestServiceRejectsMalformedOrStaleConnectionProjection(t *testing.T) {
	for name, projectionError := range map[string]error{
		"malformed": ErrCorruptStoredResult,
		"handle":    ErrStaleConnection,
		"epoch":     ErrStaleCaptureEpoch,
	} {
		t.Run(name, func(t *testing.T) {
			command := commandFor(captureplane.OperationInspectCaptureConnection, time.Now().Add(time.Minute))
			store := newMemoryPort()
			projection := projectionFor(command, "neg-1")
			switch name {
			case "malformed":
				projection = &ConnectionProjection{SignalingHandle: command.SignalingHandle}
			case "handle":
				projection.SignalingHandle = differentSignalingHandle()
			case "epoch":
				projection.CaptureEpoch = 2
				projection.Connection.CaptureEpoch = 2
			}
			store.projection = projection
			service, err := NewService(store, &fakePlane{}, Options{MaxWait: time.Second})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := service.Execute(context.Background(), ExecuteRequest{Command: command}); !errors.Is(err, projectionError) {
				t.Fatalf("projection error = %v, want %v", err, projectionError)
			}
		})
	}
}

func TestServiceRequiresPriorConnectionForNonCreate(t *testing.T) {
	command := commandFor(captureplane.OperationInspectCaptureConnection, time.Now().Add(time.Minute))
	service, err := NewService(newMemoryPort(), &fakePlane{}, Options{MaxWait: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Execute(context.Background(), ExecuteRequest{Command: command}); !errors.Is(err, ErrStaleConnection) {
		t.Fatalf("missing connection error = %v", err)
	}
}

func TestValidatePreparedCommandFencesCurrentProjection(t *testing.T) {
	base := commandFor(captureplane.OperationInspectCaptureConnection, time.Now().Add(time.Minute))
	projection := projectionFor(base, "neg-1")
	wrongConnection := base
	wrongInput := *wrongConnection.Input.InspectCaptureConnection
	wrongInput.Connection = "another-connection"
	wrongConnection.Input.InspectCaptureConnection = &wrongInput
	if err := ValidatePreparedCommand(preparedFor(wrongConnection), projection); !errors.Is(err, ErrStaleConnection) {
		t.Fatalf("wrong connection error = %v", err)
	}
	oldPlan := base
	oldPlan.Identity.PlanRevision = 1
	oldProjection := projectionFor(oldPlan, "neg-1")
	oldProjection.PlanRevision = 2
	oldProjection.Connection.PlanRevision = 2
	if err := ValidatePreparedCommand(preparedFor(oldPlan), oldProjection); !errors.Is(err, ErrStalePlanRevision) {
		t.Fatalf("old plan error = %v", err)
	}
	secondCreate := commandFor(captureplane.OperationCreateCaptureConnection, time.Now().Add(time.Minute))
	if err := ValidatePreparedCommand(preparedFor(secondCreate), projection); !errors.Is(err, ErrStaleConnection) {
		t.Fatalf("second create error = %v", err)
	}
	closed := *projection
	closed.Closed = true
	closed.State = captureplane.CaptureConnectionClosed
	closedCommand := commandFor(captureplane.OperationPullCaptureTracks, time.Now().Add(time.Minute))
	if err := ValidatePreparedCommand(preparedFor(closedCommand), &closed); !errors.Is(err, ErrStaleConnection) {
		t.Fatalf("command after close error = %v", err)
	}
	closeCommand := commandFor(captureplane.OperationCloseCaptureConnection, time.Now().Add(time.Minute))
	if err := ValidatePreparedCommand(preparedFor(closeCommand), &closed); err != nil {
		t.Fatalf("close after close: %v", err)
	}
}

func TestServiceProjectsConnectionLifecycleAndPreservesState(t *testing.T) {
	provider := &fakePlane{}
	store := newMemoryPort()
	service, err := NewService(store, provider, Options{MaxWait: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	create := commandFor(captureplane.OperationCreateCaptureConnection, time.Now().Add(time.Minute))
	if _, err := service.Execute(context.Background(), ExecuteRequest{Command: create}); err != nil {
		t.Fatalf("create: %v", err)
	}
	if store.projection.State != captureplane.CaptureConnectionConnecting || store.projection.Closed {
		t.Fatalf("create projection = %#v", store.projection)
	}
	pull := commandFor(captureplane.OperationPullCaptureTracks, time.Now().Add(time.Minute))
	if _, err := service.Execute(context.Background(), ExecuteRequest{Command: pull}); err != nil {
		t.Fatalf("pull: %v", err)
	}
	if store.projection.State != captureplane.CaptureConnectionConnecting {
		t.Fatalf("pull did not preserve state: %#v", store.projection)
	}
	inspect := commandFor(captureplane.OperationInspectCaptureConnection, time.Now().Add(time.Minute))
	if _, err := service.Execute(context.Background(), ExecuteRequest{Command: inspect}); err != nil {
		t.Fatalf("inspect: %v", err)
	}
	if store.projection.State != captureplane.CaptureConnectionConnected {
		t.Fatalf("inspect state = %s", store.projection.State)
	}
	closeConnection := commandFor(captureplane.OperationCloseCaptureConnection, time.Now().Add(time.Minute))
	if _, err := service.Execute(context.Background(), ExecuteRequest{Command: closeConnection}); err != nil {
		t.Fatalf("close connection: %v", err)
	}
	if store.projection.State != captureplane.CaptureConnectionClosed || !store.projection.Closed {
		t.Fatalf("close projection = %#v", store.projection)
	}
}

func sameAuthority(left, right CommandAuthority) bool {
	return left.TenantID == right.TenantID && left.SpaceID == right.SpaceID && left.EpisodeID == right.EpisodeID && left.RecordingID == right.RecordingID && left.JobID == right.JobID && left.AttemptCount == right.AttemptCount && left.FencingGeneration == right.FencingGeneration && left.CaptureEpoch == right.CaptureEpoch && bytes.Equal(left.EnvelopeDigest, right.EnvelopeDigest)
}

func sameLease(left, right WorkerLease) bool {
	return left.Owner == right.Owner && left.Token == right.Token && left.ExpiresAt.Equal(right.ExpiresAt)
}
