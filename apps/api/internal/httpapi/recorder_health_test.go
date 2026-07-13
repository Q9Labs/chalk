package httpapi_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

type recorderHealthStub struct {
	failRole workeridentity.Role
}

func (s recorderHealthStub) CheckRecorderPool(_ context.Context, role workeridentity.Role) error {
	if role == s.failRole {
		return errors.New("unavailable")
	}
	return nil
}

func TestRecorderHealthRoutesProjectOnlyPublicSafeState(t *testing.T) {
	router := httpapi.NewRouter(httpapi.Options{RecorderHealth: recorderHealthStub{failRole: workeridentity.RoleRender}})

	for _, test := range []struct {
		path   string
		status int
		body   string
	}{
		{path: "/healthz/recorder/capture", status: http.StatusOK, body: `{"status":"ok"}`},
		{path: "/healthz/recorder/render", status: http.StatusServiceUnavailable, body: `{"status":"unavailable"}`},
	} {
		response := httptest.NewRecorder()
		router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, test.path, nil))
		if response.Code != test.status {
			t.Fatalf("%s status = %d, want %d", test.path, response.Code, test.status)
		}
		if got := response.Body.String(); got != test.body+"\n" {
			t.Fatalf("%s body = %q", test.path, got)
		}
	}
}

func TestRecorderHealthRoutesFailClosedWithoutChecker(t *testing.T) {
	router := httpapi.NewRouter(httpapi.Options{})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/healthz/recorder/capture", nil))
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusServiceUnavailable)
	}
}
