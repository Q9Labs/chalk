package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/providerbridge"
	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestProviderBridgePOSTRequiresVerifiedSyncPeer(t *testing.T) {
	handler := NewProviderBridgeHandler(&providerBridgeService{}, syncPeerVerifier{err: errors.New("unverified")})
	request := httptest.NewRequest(http.MethodPost, "/internal/v1/sync/provider-operations/operation-000001", bytes.NewBufferString(validProviderOperationBody()))
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusUnauthorized)
	}
}

func TestProviderBridgePOSTExecutesExactContract(t *testing.T) {
	service := &providerBridgeService{}
	handler := NewProviderBridgeHandler(service, syncPeerVerifier{})
	request := httptest.NewRequest(http.MethodPost, "/internal/v1/sync/provider-operations/operation-000001", bytes.NewBufferString(validProviderOperationBody()))
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s, want 200", response.Code, response.Body.String())
	}
	if service.executed.OperationID != "operation-000001" || service.executed.Effect != provideroperations.EffectRevokePublication || service.executed.PublicationSource != "camera" {
		t.Fatalf("executed input = %#v", service.executed)
	}
	var payload providerOperationResponse
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload.Outcome != provideroperations.OutcomeConfirmed || payload.Effect != provideroperations.EffectRevokePublication {
		t.Fatalf("response = %#v", payload)
	}
}

func TestProviderBridgePOSTRejectsUnknownAndOversizeBodies(t *testing.T) {
	handler := NewProviderBridgeHandler(&providerBridgeService{}, syncPeerVerifier{})

	unknown := httptest.NewRequest(http.MethodPost, "/internal/v1/sync/provider-operations/operation-000001", bytes.NewBufferString(`{"effect":"media.end_session","tenant_id":"11111111-1111-4111-8111-111111111111","session_id":"22222222-2222-4222-8222-222222222222","provider_id":"private"}`))
	unknownResponse := httptest.NewRecorder()
	handler.ServeHTTP(unknownResponse, unknown)
	if unknownResponse.Code != http.StatusBadRequest {
		t.Fatalf("unknown field status = %d, want %d", unknownResponse.Code, http.StatusBadRequest)
	}

	oversizeBody := `{"effect":"` + strings.Repeat("x", providerOperationBodyLimit) + `"}`
	oversize := httptest.NewRequest(http.MethodPost, "/internal/v1/sync/provider-operations/operation-000001", strings.NewReader(oversizeBody))
	oversizeResponse := httptest.NewRecorder()
	handler.ServeHTTP(oversizeResponse, oversize)
	if oversizeResponse.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversize status = %d, want %d", oversizeResponse.Code, http.StatusRequestEntityTooLarge)
	}
}

func TestProviderBridgeGETReturnsProviderNeutralObservationPage(t *testing.T) {
	participantID := mustProviderBridgeID(t, "33333333-3333-4333-8333-333333333333")
	service := &providerBridgeService{page: provideroperations.ObservationPage{
		Observations: []provideroperations.Observation{{
			Incarnation: 2,
			Sequence:    7,
			Publications: []provideroperations.Publication{{
				ParticipantSessionID: participantID,
				Source:               "screen",
				Enabled:              true,
			}},
		}},
		Next: &provideroperations.Cursor{Incarnation: 2, Sequence: 7},
	}}
	handler := NewProviderBridgeHandler(service, syncPeerVerifier{})
	request := httptest.NewRequest(http.MethodGet, "/internal/v1/sync/media-observations?tenant_id=11111111-1111-4111-8111-111111111111&session_id=22222222-2222-4222-8222-222222222222&limit=10", nil)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s, want 200", response.Code, response.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload["has_more"] != true || payload["next_cursor"] == nil {
		t.Fatalf("response = %#v", payload)
	}
	if bytes.Contains(response.Body.Bytes(), []byte("publication_id")) || bytes.Contains(response.Body.Bytes(), []byte("provider_id")) {
		t.Fatalf("response leaked provider identifiers: %s", response.Body.String())
	}
}

func validProviderOperationBody() string {
	return `{"effect":"media.revoke_publication","tenant_id":"11111111-1111-4111-8111-111111111111","session_id":"22222222-2222-4222-8222-222222222222","participant_session_id":"33333333-3333-4333-8333-333333333333","publication_source":"camera"}`
}

type syncPeerVerifier struct{ err error }

func (v syncPeerVerifier) Verify(*http.Request) error { return v.err }

type providerBridgeService struct {
	executed provideroperations.OperationInput
	page     provideroperations.ObservationPage
}

func (s *providerBridgeService) Execute(_ context.Context, input provideroperations.OperationInput) (providerbridge.Result, error) {
	s.executed = input
	return providerbridge.Result{
		OperationID: input.OperationID,
		Effect:      input.Effect,
		Outcome:     provideroperations.OutcomeConfirmed,
	}, nil
}

func (s *providerBridgeService) ListObservations(_ context.Context, _, _ utilities.ID, _ *provideroperations.Cursor, _ int) (provideroperations.ObservationPage, error) {
	return s.page, nil
}

func mustProviderBridgeID(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatalf("parse id: %v", err)
	}
	return id
}
