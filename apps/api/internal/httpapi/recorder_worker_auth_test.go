package httpapi

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

type recorderWorkerVerifierStub struct {
	identity workeridentity.Identity
	err      error
}

func (v recorderWorkerVerifierStub) Verify(*http.Request) (workeridentity.Identity, error) {
	return v.identity, v.err
}

func TestRequireRecorderWorkerPropagatesVerifiedIdentity(t *testing.T) {
	workerID, err := utilities.ParseID("11111111-1111-4111-8111-111111111111")
	if err != nil {
		t.Fatalf("parse worker id: %v", err)
	}
	verifier := recorderWorkerVerifierStub{identity: workeridentity.Identity{WorkerID: workerID, Role: workeridentity.RoleRender}}
	handler := requireRecorderWorker(verifier, http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		identity, ok := recorderWorkerIdentity(request.Context())
		if !ok || identity.WorkerID != workerID || identity.Role != workeridentity.RoleRender {
			t.Fatalf("identity = %#v, ok = %t", identity, ok)
		}
		w.WriteHeader(http.StatusNoContent)
	}))

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/v1/recorder/jobs/claim", nil))
	if response.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusNoContent)
	}
}

func TestRequireRecorderWorkerFailsClosed(t *testing.T) {
	tests := []struct {
		name     string
		verifier RecorderWorkerVerifier
		status   int
	}{
		{name: "missing verifier", status: http.StatusServiceUnavailable},
		{name: "invalid identity", verifier: recorderWorkerVerifierStub{err: errors.New("invalid")}, status: http.StatusUnauthorized},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			called := false
			handler := requireRecorderWorker(test.verifier, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true }))
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/v1/recorder/jobs/claim", nil))
			if response.Code != test.status {
				t.Fatalf("status = %d, want %d", response.Code, test.status)
			}
			if called {
				t.Fatal("protected handler was called")
			}
		})
	}
}
