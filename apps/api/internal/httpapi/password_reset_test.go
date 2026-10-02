package httpapi

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
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
	var logs bytes.Buffer
	previousLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previousLogger) })
	var expected string
	for _, failure := range []error{nil, errors.New("database unavailable"), errors.New("provider rejected account@example.com token=private-reset-token")} {
		router := chi.NewRouter()
		router.Route("/v1", func(r chi.Router) {
			passwordResetRequestEndpointWithTimeout(passwordResetHTTPService{err: failure}, 100*time.Millisecond, 100*time.Millisecond).Mount(r, DefaultRateLimitOptions())
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
	if !strings.Contains(logs.String(), "auth.password_reset.failed") {
		t.Fatal("password reset failure was not logged")
	}
	for _, private := range []string{"account@example.com", "private-reset-token", "provider rejected"} {
		if strings.Contains(logs.String(), private) {
			t.Fatal("password reset failure log leaked provider input")
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

func TestPasswordResetResponseWaitsForDeliveryAfterRequestCancellation(t *testing.T) {
	service := blockingPasswordResetHTTPService{started: make(chan struct{}, 1), release: make(chan struct{})}
	router := chi.NewRouter()
	router.Route("/v1", func(r chi.Router) {
		passwordResetRequestEndpointWithTimeout(service, 100*time.Millisecond, 100*time.Millisecond).Mount(r, RateLimitOptions{})
	})
	response := httptest.NewRecorder()
	requestContext, cancelRequest := context.WithCancel(context.Background())
	request := httptest.NewRequest(http.MethodPost, "/v1/auth/password-reset/request", strings.NewReader(`{"email":"account@example.com"}`)).WithContext(requestContext)
	done := make(chan struct{})
	go func() {
		defer close(done)
		router.ServeHTTP(response, request)
	}()
	<-service.started
	cancelRequest()
	select {
	case <-done:
		t.Fatal("request returned before email delivery completed")
	case <-time.After(50 * time.Millisecond):
	}
	close(service.release)
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("request did not return after email delivery completed")
	}
	if response.Code != http.StatusAccepted {
		t.Fatalf("request status = %d", response.Code)
	}
}

func TestPasswordResetUnauthenticatedRoutesAreRateLimited(t *testing.T) {
	for _, path := range []string{"/v1/auth/password-reset/request", "/v1/auth/password-reset/complete"} {
		t.Run(path, func(t *testing.T) {
			router := chi.NewRouter()
			router.Route("/v1", func(r chi.Router) {
				if path == "/v1/auth/password-reset/request" {
					passwordResetRequestEndpointWithTimeout(passwordResetHTTPService{}, time.Millisecond, time.Millisecond).Mount(r, DefaultRateLimitOptions())
				} else {
					mountAuthRoutes(r, passwordResetHTTPService{}, SessionCookieOptions{}, DefaultRateLimitOptions())
				}
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

// Delays above the former timing floor must still fit the same public envelope.
type delayedPasswordResetHTTPService struct {
	AuthenticationService
	delay time.Duration
}

func (s delayedPasswordResetHTTPService) RequestPasswordReset(ctx context.Context, _ string) error {
	select {
	case <-time.After(s.delay):
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func TestPasswordResetResponseUsesSameEnvelopeForSlowAndMissingAccounts(t *testing.T) {
	// Deliveries faster than the floor all respond at the floor; a slower one may
	// respond when it finishes, but never after the processing budget.
	for _, test := range []struct {
		delay    time.Duration
		min, max time.Duration
	}{
		{delay: 0, min: 100 * time.Millisecond, max: 180 * time.Millisecond},
		{delay: 70 * time.Millisecond, min: 100 * time.Millisecond, max: 180 * time.Millisecond},
		{delay: 400 * time.Millisecond, min: 300 * time.Millisecond, max: 380 * time.Millisecond},
	} {
		router := chi.NewRouter()
		router.Route("/v1", func(r chi.Router) {
			passwordResetRequestEndpointWithTimeout(delayedPasswordResetHTTPService{delay: test.delay}, 300*time.Millisecond, 100*time.Millisecond).Mount(r, RateLimitOptions{})
		})
		response := httptest.NewRecorder()
		started := time.Now()
		router.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/v1/auth/password-reset/request", strings.NewReader(`{"email":"account@example.com"}`)))
		elapsed := time.Since(started)
		if response.Code != http.StatusAccepted || elapsed < test.min || elapsed > test.max {
			t.Fatalf("delay=%v status=%d elapsed=%v", test.delay, response.Code, elapsed)
		}
	}
}

func TestPasswordResetProcessingHasGlobalConcurrencyBound(t *testing.T) {
	service := blockingPasswordResetHTTPService{started: make(chan struct{}, 33), release: make(chan struct{})}
	router := chi.NewRouter()
	router.Route("/v1", func(r chi.Router) {
		passwordResetRequestEndpointWithTimeout(service, 200*time.Millisecond, 200*time.Millisecond).Mount(r, RateLimitOptions{})
	})
	var requests sync.WaitGroup
	for attempt := 0; attempt < 33; attempt++ {
		requests.Add(1)
		go func() {
			defer requests.Done()
			router.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/v1/auth/password-reset/request", strings.NewReader(`{"email":"account@example.com"}`)))
		}()
	}
	for attempt := 0; attempt < 32; attempt++ {
		select {
		case <-service.started:
		case <-time.After(time.Second):
			t.Fatal("processing slots did not fill")
		}
	}
	select {
	case <-service.started:
		t.Error("more than 32 service calls ran concurrently")
	case <-time.After(20 * time.Millisecond):
	}
	close(service.release)
	requests.Wait()
}
