package digitalocean

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"testing/synctest"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

func TestRequestBudgetSharesPacingAndCooldownAcrossClients(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		budget := NewRequestBudget()
		var sent []time.Time
		transport := budgetTransport(func(r *http.Request) (*http.Response, error) {
			sent = append(sent, time.Now())
			header, status := make(http.Header), http.StatusNoContent
			if len(sent) == 1 {
				header.Set("Retry-After", "12")
				status = http.StatusTooManyRequests
			}
			return &http.Response{StatusCode: status, Header: header, Body: io.NopCloser(http.NoBody)}, nil
		})
		first := budgetAdapter(t, budget, transport)
		second := budgetAdapter(t, budget, transport)
		if err := first.doJSON(t.Context(), http.MethodGet, "/v2/droplets", nil, nil, nil, http.StatusNoContent); !errors.Is(err, recorderfleet.ErrProviderUnavailable) {
			t.Fatalf("missing 429: %v", err)
		}
		before := time.Now()
		var limited *recorderfleet.ProviderRateLimitError
		if err := second.doJSON(t.Context(), http.MethodGet, "/v2/droplets", nil, nil, nil, http.StatusNoContent); !errors.As(err, &limited) || len(sent) != 1 || !time.Now().Equal(before) || !limited.RetryAt.Equal(before.Add(12*time.Second)) {
			t.Fatalf("shared cooldown blocked or sent a request: %v, calls=%d", err, len(sent))
		}
		time.Sleep(12 * time.Second)
		for _, adapter := range []*RecorderFleet{second, first} {
			if err := adapter.doJSON(t.Context(), http.MethodGet, "/v2/droplets", nil, nil, nil, http.StatusNoContent); err != nil {
				t.Fatal(err)
			}
		}
		if sent[1].Sub(sent[0]) != 12*time.Second || sent[2].Sub(sent[1]) != 3*time.Second {
			t.Fatalf("clients did not share cooldown and spacing: %v", sent)
		}
		ctx, cancel := context.WithTimeout(t.Context(), time.Second)
		defer cancel()
		if err := second.doJSON(ctx, http.MethodGet, "/v2/droplets", nil, nil, nil, http.StatusNoContent); !errors.Is(err, context.DeadlineExceeded) || len(sent) != 3 {
			t.Fatalf("cancelled pacing wait sent a request: %v, calls=%d", err, len(sent))
		}
	})
}

type budgetTransport func(*http.Request) (*http.Response, error)

func (f budgetTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func budgetAdapter(t *testing.T, budget *RequestBudget, transport http.RoundTripper) *RecorderFleet {
	t.Helper()
	adapter, err := NewRecorderFleet(RecorderFleetConfig{
		RequestBudget: budget, HTTPClient: &http.Client{Transport: transport},
		Token: "fixture-token", Environment: "nightly", Role: workeridentity.RoleCapture, OwnerTag: "chalk-recorder-owned",
	})
	if err != nil {
		t.Fatal(err)
	}
	return adapter
}

func TestRequestBudgetReschedulesRejectedCreateWithoutBlocking(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var calls []string
		adapter := budgetAdapter(t, NewRequestBudget(), budgetTransport(func(r *http.Request) (*http.Response, error) {
			calls = append(calls, r.Method)
			status, header := http.StatusAccepted, make(http.Header)
			body, err := io.ReadAll(r.Body)
			if err != nil || string(body) != `{"name":"worker"}` {
				t.Fatalf("create body=%s, error=%v", body, err)
			}
			if len(calls) == 1 {
				header.Set("Retry-After", "12")
				status = http.StatusTooManyRequests
			}
			return &http.Response{StatusCode: status, Header: header, Body: io.NopCloser(strings.NewReader(""))}, nil
		}))
		start := time.Now()
		create := func() error {
			return adapter.doJSON(t.Context(), http.MethodPost, "/v2/droplets", nil, map[string]string{"name": "worker"}, nil, http.StatusAccepted)
		}
		var limited *recorderfleet.ProviderRateLimitError
		if err := create(); !errors.As(err, &limited) || !time.Now().Equal(start) {
			t.Fatalf("rejected create blocked: %v", err)
		}
		if err := adapter.doJSON(t.Context(), http.MethodGet, "/v2/droplets", nil, nil, nil, http.StatusOK); !errors.As(err, &limited) || len(calls) != 1 || !time.Now().Equal(start) {
			t.Fatalf("inventory consumed cooldown allowance: %v, calls=%v", err, calls)
		}
		time.Sleep(time.Until(limited.RetryAt))
		if err := create(); err != nil || len(calls) != 2 || calls[1] != http.MethodPost {
			t.Fatalf("rescheduled create failed: %v, calls=%v", err, calls)
		}
	})
}
