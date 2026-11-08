package httpapi

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
)

type retryablePublicLeaveService struct {
	PublicInviteService
	err error
}

func (s retryablePublicLeaveService) Leave(context.Context, publicinvites.PublicInviteLeaveInput) error {
	return s.err
}

func TestPublicInviteLeaveUnavailableHasRetryHint(t *testing.T) {
	for _, test := range []struct {
		name   string
		err    error
		status int
		retry  string
	}{
		{"lock timeout", fmt.Errorf("%w: create remove_participant external operation: canceling statement due to lock timeout", publicinvites.ErrAccessUnavailable), http.StatusServiceUnavailable, "1"},
		{"other error remains internal", fmt.Errorf("unclassified database failure"), http.StatusInternalServerError, ""},
		{"successful retry", nil, http.StatusNoContent, ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			endpoint := leavePublicInviteArrivalEndpoint(retryablePublicLeaveService{err: test.err}, nil)
			request := httptest.NewRequest(http.MethodDelete, "/v1/public/space-invite-arrival", nil)
			request.Header.Set(publicInviteTokenHeader, "55555555-5555-4555-8555-555555555555")
			response := httptest.NewRecorder()
			endpoint.ServeHTTP(response, request)
			if response.Code != test.status || response.Header().Get("Retry-After") != test.retry {
				t.Fatalf("leave = %d, Retry-After=%q, body=%s", response.Code, response.Header().Get("Retry-After"), response.Body.String())
			}
			if test.status == http.StatusServiceUnavailable && !strings.Contains(response.Body.String(), `"code":"service.unavailable"`) {
				t.Fatalf("retryable leave body = %s", response.Body.String())
			}
		})
	}
}
