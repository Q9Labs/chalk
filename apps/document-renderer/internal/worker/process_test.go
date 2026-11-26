package worker

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	controlplane "github.com/q9labs/chalk/apps/document-renderer/internal/control"
)

func TestIsolatedRenderFailureDoesNotClassifySandboxSetupAsDocumentFailure(t *testing.T) {
	err := isolatedRenderFailure(isolatedSandboxError{err: errors.New("namespace unavailable")})
	var failure renderFailure
	if errors.As(err, &failure) {
		t.Fatalf("sandbox setup became document failure %#v", failure)
	}
	var sandbox isolatedSandboxError
	if !errors.As(err, &sandbox) {
		t.Fatalf("sandbox error lost its type: %v", err)
	}
}

func TestFinishFailureRecyclesAfterIsolatedChildCompromise(t *testing.T) {
	control, closeServer := testControlClient(t)
	defer closeServer()
	err := finishFailure(context.Background(), control, controlplane.Assignment{}, "corrupt", isolatedChildCompromiseError{err: errors.New("parser crashed")})
	if err == nil {
		t.Fatal("parser compromise did not request renderer process recycling")
	}
}

func TestFinishFailureDoesNotRecycleOrdinaryDocumentFailure(t *testing.T) {
	control, closeServer := testControlClient(t)
	defer closeServer()
	if err := finishFailure(context.Background(), control, controlplane.Assignment{}, "password_protected", errors.New("encrypted document")); err != nil {
		t.Fatalf("ordinary document failure: %v", err)
	}
}

func testControlClient(t *testing.T) (controlplane.ControlClient, func()) {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/internal/v1/presenting/render/fail" {
			t.Errorf("unexpected control path %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	return controlplane.NewControlClient(server.URL), server.Close
}
