package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/recorderfleetcontrol"
	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

func TestRecorderFleetControllerRouterMatchesClientContract(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	key := recorderfleet.PoolKey{Environment: "staging", Role: workeridentity.RoleCapture}
	identity := recorderfleet.NodeIdentity{
		ProviderID: "42", WorkerID: "55555555-5555-4555-8555-555555555555",
		Role: workeridentity.RoleCapture, BootGeneration: 3,
	}
	service := &recorderFleetControllerServiceStub{
		demand:   recorderfleet.Demand{Revision: "demand-7", DesiredNodes: 1, ScheduledPrewarms: 1, ObservedAt: now},
		nodes:    []recorderfleet.NodeObservation{{Identity: identity, Ready: true, AdmissionOpen: true, ReadyCapacity: 4, ObservedAt: now}},
		identity: identity,
	}
	controllerID, _ := utilities.ParseID("66666666-6666-4666-8666-666666666666")
	router := NewRecorderFleetControllerRouter(service, recorderFleetControllerVerifierStub{
		identity: recorderfleet.ControllerIdentity{ControllerID: controllerID},
	}, "staging")
	server := httptest.NewTLSServer(router)
	defer server.Close()
	client, err := recorderfleetcontrol.New(recorderfleetcontrol.Config{BaseURL: server.URL, HTTPClient: server.Client(), Key: key})
	if err != nil {
		t.Fatalf("new control client: %v", err)
	}

	if demand, err := client.GetDemand(t.Context(), key); err != nil || demand != service.demand {
		t.Fatalf("demand/error = %+v/%v", demand, err)
	}
	if nodes, err := client.ObserveNodes(t.Context(), key); err != nil || len(nodes) != 1 || nodes[0].Identity != identity {
		t.Fatalf("nodes/error = %+v/%v", nodes, err)
	}
	bootstrapRequest := recorderfleet.BootstrapRequest{
		Key: key, ProviderID: "42", NodeName: "node-42", Region: "sgp1", ReleaseID: "release-7",
		ImageDigest: "sha256:" + strings.Repeat("a", 64), BootGeneration: 3, InventoryDigest: strings.Repeat("b", 64),
	}
	if got, err := client.EnsureBootstrap(t.Context(), bootstrapRequest); err != nil || got != identity {
		t.Fatalf("bootstrap identity/error = %+v/%v", got, err)
	}
	if err := client.AbandonBootstrap(t.Context(), bootstrapRequest); err != nil {
		t.Fatalf("abandon bootstrap: %v", err)
	}
	if err := client.CloseAdmission(t.Context(), identity); err != nil {
		t.Fatalf("close admission: %v", err)
	}
	if err := client.RevokeIdentity(t.Context(), identity); err != nil {
		t.Fatalf("revoke identity: %v", err)
	}
	projection := recorderfleet.PoolProjection{Key: key, DemandRevision: "demand-7", AdmissionOpen: true, ReadyCapacity: 4, Reason: "ready", ObservedAt: now}
	if err := client.PublishPool(t.Context(), projection); err != nil {
		t.Fatalf("publish pool: %v", err)
	}
	if service.bootstrap != bootstrapRequest || service.abandoned != bootstrapRequest || service.closed != identity || service.revoked != identity || service.projection != projection {
		t.Fatalf("service calls = %+v", service)
	}
}

func TestRecorderFleetControllerRouterRequiresControllerAndStrictSchema(t *testing.T) {
	t.Parallel()
	service := &recorderFleetControllerServiceStub{}
	router := NewRecorderFleetControllerRouter(service, recorderFleetControllerVerifierStub{err: recorderfleet.ErrUnverifiedControllerPeer}, "staging")
	request := httptest.NewRequest(http.MethodGet, "/internal/v1/recorder/fleet/demand?role=capture", nil)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized || service.demandCalls != 0 {
		t.Fatalf("unauthorized status/calls = %d/%d", response.Code, service.demandCalls)
	}

	router = NewRecorderFleetControllerRouter(service, recorderFleetControllerVerifierStub{}, "staging")
	request = httptest.NewRequest(http.MethodPut, "/internal/v1/recorder/fleet/pool", strings.NewReader(`{"schema_version":"recorder_fleet_pool.v1","key":{"environment":"staging","role":"capture"},"demand_revision":"7","admission_open":false,"ready_capacity":0,"reason":"no_demand","observed_at":"2026-09-06T12:00:00Z","unknown":true}`))
	request.Header.Set("Content-Type", "application/json")
	response = httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("unknown-field status = %d body=%s", response.Code, response.Body.String())
	}
}

type recorderFleetControllerVerifierStub struct {
	identity recorderfleet.ControllerIdentity
	err      error
}

func (v recorderFleetControllerVerifierStub) Verify(*http.Request) (recorderfleet.ControllerIdentity, error) {
	return v.identity, v.err
}

type recorderFleetControllerServiceStub struct {
	demand      recorderfleet.Demand
	nodes       []recorderfleet.NodeObservation
	identity    recorderfleet.NodeIdentity
	bootstrap   recorderfleet.BootstrapRequest
	abandoned   recorderfleet.BootstrapRequest
	closed      recorderfleet.NodeIdentity
	revoked     recorderfleet.NodeIdentity
	projection  recorderfleet.PoolProjection
	demandCalls int
}

func (s *recorderFleetControllerServiceStub) AbandonBootstrap(_ context.Context, request recorderfleet.BootstrapRequest) error {
	s.abandoned = request
	return nil
}

func (s *recorderFleetControllerServiceStub) GetDemand(context.Context, recorderfleet.PoolKey) (recorderfleet.Demand, error) {
	s.demandCalls++
	return s.demand, nil
}

func (s *recorderFleetControllerServiceStub) ObserveNodes(context.Context, recorderfleet.PoolKey) ([]recorderfleet.NodeObservation, error) {
	return s.nodes, nil
}

func (s *recorderFleetControllerServiceStub) EnsureBootstrap(_ context.Context, request recorderfleet.BootstrapRequest) (recorderfleet.NodeIdentity, error) {
	s.bootstrap = request
	return s.identity, nil
}

func (s *recorderFleetControllerServiceStub) CloseAdmission(_ context.Context, identity recorderfleet.NodeIdentity) error {
	s.closed = identity
	return nil
}

func (s *recorderFleetControllerServiceStub) RevokeIdentity(_ context.Context, identity recorderfleet.NodeIdentity) error {
	s.revoked = identity
	return nil
}

func (s *recorderFleetControllerServiceStub) PublishPool(_ context.Context, projection recorderfleet.PoolProjection) error {
	s.projection = projection
	return nil
}
