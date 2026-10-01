package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
)

type passwordResetHTTPService struct {
	AuthenticationService
	err error
}

func (s passwordResetHTTPService) RequestPasswordReset(context.Context, string) error { return s.err }
func (s passwordResetHTTPService) CompletePasswordReset(context.Context, string, string) (authentication.User, error) {
	return authentication.User{}, authentication.ErrPasswordResetTokenInvalid
}

func TestPasswordResetRequestDoesNotExposeOperationalFailures(t *testing.T) {
	var expected string
	for _, failure := range []error{nil, errors.New("database unavailable"), errors.New("email unavailable")} {
		router := chi.NewRouter()
		router.Route("/v1", func(r chi.Router) {
			requestPasswordResetEndpoint(passwordResetHTTPService{err: failure}).Mount(r, DefaultRateLimitOptions())
		})
		response := httptest.NewRecorder()
		router.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/v1/auth/password-reset/request", strings.NewReader(`{"email":"account@example.com"}`)))
		if response.Code != http.StatusAccepted {
			t.Fatalf("request status = %d", response.Code)
		}
		if expected == "" {
			expected = response.Body.String()
		} else if response.Body.String() != expected {
			t.Fatal("request response reveals operational failure")
		}
	}
}

type blockingPasswordResetHTTPService struct {
	AuthenticationService
	started chan struct{}
	release chan struct{}
}

func (s blockingPasswordResetHTTPService) RequestPasswordReset(ctx context.Context, _ string) error {
	s.started <- struct{}{}
	select {
	case <-s.release:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func TestPasswordResetResponseDoesNotWaitForLookupOrDelivery(t *testing.T) {
	service := blockingPasswordResetHTTPService{started: make(chan struct{}, 32), release: make(chan struct{})}
	t.Cleanup(func() { close(service.release) })
	router := chi.NewRouter()
	router.Route("/v1", func(r chi.Router) { requestPasswordResetEndpoint(service).Mount(r, RateLimitOptions{}) })
	// Fill all processing slots; the next request must still receive the identical reply.
	var expected string
	for attempt := 0; attempt < 33; attempt++ {
		response := httptest.NewRecorder()
		done := make(chan struct{})
		go func() {
			defer close(done)
			router.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/v1/auth/password-reset/request", strings.NewReader(`{"email":"account@example.com"}`)))
		}()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatal("public response waited for lookup or email delivery")
		}
		if response.Code != http.StatusAccepted {
			t.Fatalf("request status = %d", response.Code)
		}
		if expected == "" {
			expected = response.Body.String()
		} else if response.Body.String() != expected {
			t.Fatal("saturation changed the public response")
		}
	}
}

func TestPasswordResetUnauthenticatedRoutesAreRateLimited(t *testing.T) {
	for _, path := range []string{"/v1/auth/password-reset/request", "/v1/auth/password-reset/complete"} {
		t.Run(path, func(t *testing.T) {
			router := chi.NewRouter()
			router.Route("/v1", func(r chi.Router) {
				mountAuthRoutes(r, passwordResetHTTPService{}, SessionCookieOptions{}, DefaultRateLimitOptions())
			})
			for attempt := 0; attempt <= authPasswordResetRateLimit.Limit; attempt++ {
				response := httptest.NewRecorder()
				request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(`{"email":"account@example.com","token":"invalid","password":"new-password"}`))
				router.ServeHTTP(response, request)
				if attempt == authPasswordResetRateLimit.Limit && response.Code != http.StatusTooManyRequests {
					t.Fatalf("request beyond limit = %d", response.Code)
				}
			}
		})
	}
}
