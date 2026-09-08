package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type dependencyReadinessStub struct{ err error }

func (s dependencyReadinessStub) Check(context.Context) error { return s.err }

func TestReadinessDoesNotRequireRecordingPoolAdmission(t *testing.T) {
	response := httptest.NewRecorder()
	handleReady(dependencyReadinessStub{}, CapabilityStatus{Recording: true})(response, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"recording":"enabled"`) || strings.Contains(response.Body.String(), `"recorder_pool":"unavailable"`) {
		t.Fatalf("misleading readiness response: status=%d body=%s", response.Code, response.Body.String())
	}
}
