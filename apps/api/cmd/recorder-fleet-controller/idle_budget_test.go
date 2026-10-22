package main

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"testing/synctest"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/digitalocean"
	"github.com/q9labs/chalk/apps/api/internal/adapters/recorderfleetcontrol"
	"github.com/q9labs/chalk/apps/api/internal/adapters/recorderfleetjournal"
	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

// Count real controller/provider requests with empty, idle pools, not elapsed CPU.
func TestIdleControllerProviderRequestBudget(t *testing.T) {
	for _, role := range []workeridentity.Role{workeridentity.RoleCapture, workeridentity.RoleRender} {
		t.Run(string(role), func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				env := validCommandEnvironment()
				env["CHALK_RECORDER_FLEET_ROLE"] = string(role)
				if role == workeridentity.RoleRender {
					env["CHALK_RECORDER_FLEET_MAX_NODES"] = "10"
					env["CHALK_RECORDER_FLEET_ARCHIVE_KEY"] = strings.ReplaceAll(env["CHALK_RECORDER_FLEET_ARCHIVE_KEY"], "/capture/", "/render/")
				}
				config, err := loadCommandConfig(nil, func(key string) string { return env[key] })
				if err != nil {
					t.Fatal(err)
				}
				ctx, cancel := context.WithTimeout(t.Context(), 5*time.Minute)
				defer cancel()
				providerCalls, unexpected := 0, 0
				client := &http.Client{Transport: rateLimitTransport(func(r *http.Request) (*http.Response, error) {
					if r.Context().Err() != nil {
						return nil, r.Context().Err()
					}
					body := map[string]any{"schema_version": recorderfleet.DemandSchemaVersion, "environment": config.Fleet.Key.Environment, "role": role, "revision": "idle", "desired_nodes": 0, "observed_at": time.Now().UTC().Format(time.RFC3339Nano)}
					status := http.StatusOK
					switch r.URL.Path {
					case "/v2/droplets":
						providerCalls++
						body = map[string]any{"droplets": []any{}}
					case "/internal/v1/recorder/fleet/demand":
						if r.URL.Query().Get("wait") == "8" {
							select {
							case <-time.After(8 * time.Second):
							case <-r.Context().Done():
								return nil, r.Context().Err()
							}
							body["observed_at"] = time.Now().UTC().Format(time.RFC3339Nano)
						}
					case "/internal/v1/recorder/fleet/nodes":
						body = map[string]any{"schema_version": recorderfleet.NodesSchemaVersion, "environment": config.Fleet.Key.Environment, "role": role, "nodes": []any{}}
					case "/internal/v1/recorder/fleet/pool":
						status = http.StatusNoContent
					default:
						unexpected++
						status = http.StatusInternalServerError
					}
					data, err := json.Marshal(body)
					return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(string(data)))}, err
				})}
				control, err := recorderfleetcontrol.New(recorderfleetcontrol.Config{BaseURL: "https://control.example", HTTPClient: client, Key: config.Fleet.Key})
				if err != nil {
					t.Fatal(err)
				}
				config.Provider.HTTPClient = client
				provider, err := digitalocean.NewRecorderFleet(config.Provider)
				if err != nil {
					t.Fatal(err)
				}
				journal, err := recorderfleetjournal.New(filepath.Join(t.TempDir(), "journal.json"))
				if err != nil {
					t.Fatal(err)
				}
				runner, err := recorderfleet.NewReconciler(config.Fleet, control, journal, provider, control, control)
				if err != nil {
					t.Fatal(err)
				}
				if err := runLoop(ctx, config.ReconcileInterval, runner, slog.New(slog.NewTextHandler(io.Discard, nil))); err != nil {
					t.Fatal(err)
				}
				want := 60
				if role == workeridentity.RoleCapture {
					want = 23
				}
				if providerCalls != want || unexpected != 0 {
					t.Fatalf("idle requests=%d, want%d; unexpected=%d", providerCalls, want, unexpected)
				}
				t.Logf("%s: %d provider requests / 5 virtual idle minutes = %.1f/minute", role, providerCalls, float64(providerCalls)/5)
			})
		})
	}
}
