package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"testing/synctest"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/digitalocean"
	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
	"github.com/q9labs/chalk/apps/api/internal/recorderworker"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

func TestProviderBackoffDoesNotDelayCaptureClaimRequest(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ctx, cancel := context.WithCancel(t.Context())
		defer cancel()
		start := time.Now()
		providerCalls := 0
		client := &http.Client{Transport: rateLimitTransport(func(r *http.Request) (*http.Response, error) {
			if r.URL.Host == "control.example" {
				if r.URL.Path != "/internal/v1/recorder/jobs/claim" || time.Since(start) != time.Second {
					t.Errorf("capture claim was delayed: %s at %s", r.URL.Path, time.Since(start))
				}
				cancel()
				return &http.Response{StatusCode: http.StatusNoContent, Header: make(http.Header), Body: http.NoBody}, nil
			}
			providerCalls++
			return &http.Response{StatusCode: http.StatusTooManyRequests, Header: http.Header{"Retry-After": {"3600"}}, Body: http.NoBody}, nil
		})}
		provider, err := digitalocean.NewRecorderFleet(digitalocean.RecorderFleetConfig{
			Token: "fake", Environment: "nightly", Role: workeridentity.RoleCapture, OwnerTag: "chalk-recorder-owned", HTTPClient: client,
		})
		if err != nil {
			t.Fatal(err)
		}
		control, err := recorderworker.NewControlPlaneClient("https://control.example", client)
		if err != nil {
			t.Fatal(err)
		}
		claimDone := make(chan error, 1)
		go func() {
			time.Sleep(time.Second)
			id, err := utilities.NewID()
			if err == nil {
				_, err = control.ClaimJob(t.Context(), id, time.Minute)
			}
			claimDone <- err
		}()
		runner := inventoryReconciler{adapter: provider, key: recorderfleet.PoolKey{Environment: "nightly", Role: workeridentity.RoleCapture}}
		if err := runLoop(ctx, 5*time.Second, runner, slog.New(slog.NewTextHandler(io.Discard, nil))); err != nil {
			t.Fatal(err)
		}
		if err := <-claimDone; !errors.Is(err, recorderworker.ErrNoWork) || providerCalls != 1 || time.Since(start) != time.Second {
			t.Fatalf("claim/cancel during provider cooldown: %v, provider calls %d, elapsed %s", err, providerCalls, time.Since(start))
		}
	})
}

func TestEveryReconcileLogsProviderRemainingAndRequestCount(t *testing.T) {
	var logs bytes.Buffer
	calls := 0
	client := &http.Client{Transport: rateLimitTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		status, remaining := http.StatusTooManyRequests, "0"
		if calls == 2 {
			status, remaining = http.StatusOK, "17"
		}
		return &http.Response{StatusCode: status, Header: http.Header{"Ratelimit-Remaining": {remaining}, "Ratelimit-Limit": {"5000"}}, Body: io.NopCloser(strings.NewReader(`{"droplets":[]}`))}, nil
	})}
	key := recorderfleet.PoolKey{Environment: "nightly", Role: workeridentity.RoleRender}
	provider, err := digitalocean.NewRecorderFleet(digitalocean.RecorderFleetConfig{Token: "fake", Environment: key.Environment, Role: key.Role, OwnerTag: "chalk-recorder-owned", HTTPClient: client})
	if err != nil {
		t.Fatal(err)
	}
	runner := observedReconciler{runner: inventoryReconciler{adapter: provider, key: key}, provider: provider, key: key, logger: slog.New(slog.NewJSONHandler(&logs, nil))}
	_, _ = runner.Reconcile(t.Context())
	_, _ = runner.Reconcile(t.Context())
	lines := strings.Split(strings.TrimSpace(logs.String()), "\n")
	if len(lines) != 2 {
		t.Fatalf("budget logs = %s", logs.String())
	}
	for i, requests := range []float64{1, 0} {
		var event map[string]any
		if err := json.Unmarshal([]byte(lines[i]), &event); err != nil {
			t.Fatal(err)
		}
		if event["role"] != "render" || event["environment"] != "nightly" || event["rate_limit_remaining"] != float64(0) || event["provider_requests"] != requests {
			t.Fatalf("missing provider budget attribution: %s", lines[i])
		}
	}
}

func TestRunLoopHonorsDigitalOcean429Burst(t *testing.T) {
	for _, role := range []workeridentity.Role{workeridentity.RoleCapture, workeridentity.RoleRender} {
		t.Run(string(role), func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				ctx, cancel := context.WithCancel(t.Context())
				defer cancel()
				var calls []time.Time
				client := &http.Client{Transport: rateLimitTransport(func(r *http.Request) (*http.Response, error) {
					calls = append(calls, time.Now())
					status := http.StatusTooManyRequests
					header := make(http.Header)
					switch len(calls) {
					case 1:
						// DigitalOcean's documented burst 429: zero remaining, a Retry-After, and a far reset.
						header.Set("RateLimit-Remaining", "0")
						header.Set("Retry-After", "13")
						header.Set("RateLimit-Reset", strconv.FormatInt(time.Now().Add(50*time.Minute).Unix(), 10))
					case 3:
						header.Set("Retry-After", time.Now().Add(33*time.Second).UTC().Format(http.TimeFormat))
					case 4, 6:
						status = http.StatusOK
					}
					if len(calls) == 6 {
						cancel()
					}
					return &http.Response{StatusCode: status, Header: header, Body: io.NopCloser(strings.NewReader(`{"droplets":[]}`))}, nil
				})}
				adapter, err := digitalocean.NewRecorderFleet(digitalocean.RecorderFleetConfig{
					Token: "fake", Environment: "nightly", Role: role, OwnerTag: "chalk-recorder-owned", HTTPClient: client,
				})
				if err != nil {
					t.Fatal(err)
				}
				runner := inventoryReconciler{adapter: adapter, key: recorderfleet.PoolKey{Environment: "nightly", Role: role}}
				if err := runLoop(ctx, 5*time.Second, runner, slog.New(slog.NewTextHandler(io.Discard, nil))); err != nil {
					t.Fatal(err)
				}
				bounds := [][2]time.Duration{{15 * time.Second, 15 * time.Second}, {5 * time.Second, 5 * time.Second}, {35 * time.Second, 35 * time.Second}, {5 * time.Second, 5 * time.Second}, {5 * time.Second, 5 * time.Second}}
				for i, bound := range bounds {
					if got := calls[i+1].Sub(calls[i]); got < bound[0] || got > bound[1] {
						t.Fatalf("request %d retry delay %s outside %s..%s", i+1, got, bound[0], bound[1])
					}
				}
			})
		})
	}
}

func TestProviderCooldownKeepsReconcileCadenceResponsive(t *testing.T) {
	var cadence reconcileCadence
	for attempt := range 20 {
		delay := cadence.nextDelay(5*time.Second, recorderfleet.ActionNodeEnsured, &recorderfleet.ProviderRateLimitError{})
		if delay != 5*time.Second {
			t.Fatalf("attempt%d retry delay=%s", attempt, delay)
		}
	}
	deadline := time.Now().Add(2 * time.Hour)
	if delay := cadence.nextDelay(5*time.Second, recorderfleet.ActionNodeEnsured, &recorderfleet.ProviderRateLimitError{RetryAt: deadline}); delay != 5*time.Second {
		t.Fatal("provider reset blocked demand and health refresh")
	}
}

type rateLimitTransport func(*http.Request) (*http.Response, error)

func (f rateLimitTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

type inventoryReconciler struct {
	adapter *digitalocean.RecorderFleet
	key     recorderfleet.PoolKey
}

func (r inventoryReconciler) Reconcile(ctx context.Context) (recorderfleet.Result, error) {
	_, err := r.adapter.ListNodes(ctx, r.key)
	return recorderfleet.Result{}, err
}
