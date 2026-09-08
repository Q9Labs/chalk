package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type dependencyReadinessStub struct{ err error }

func (s dependencyReadinessStub) Check(context.Context) error { return s.err }

func TestReadinessIdentifiesUnavailableRecorderPool(t *testing.T) {
	response := httptest.NewRecorder()
	handleReady(dependencyReadinessStub{}, dependencyReadinessStub{err: errors.New("pool unavailable")}, CapabilityStatus{Recording: true})(response, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if response.Code != http.StatusServiceUnavailable || !strings.Contains(response.Body.String(), `"recorder_pool":"unavailable"`) || strings.Contains(response.Body.String(), `"postgres":"unavailable"`) {
		t.Fatalf("misleading readiness response: status=%d body=%s", response.Code, response.Body.String())
	}
}
