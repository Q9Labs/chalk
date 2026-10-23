package main

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"testing/synctest"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/digitalocean"
	"github.com/q9labs/chalk/apps/api/internal/adapters/recorderfleetcontrol"
	"github.com/q9labs/chalk/apps/api/internal/adapters/recorderfleetjournal"
	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
)

func TestProviderResetDoesNotBlockReconciliation(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		env := validCommandEnvironment()
		config, err := loadCommandConfig(nil, func(key string) string { return env[key] })
		if err != nil {
			t.Fatal(err)
		}
		providerCalls, demandCalls := 0, 0
		client := &http.Client{Transport: rateLimitTransport(func(r *http.Request) (*http.Response, error) {
			header, status := make(http.Header), http.StatusOK
			var body any
			switch r.URL.Path {
			case "/v2/droplets":
				providerCalls++
				header.Set("RateLimit-Remaining", "0")
				header.Set("RateLimit-Reset", strconv.FormatInt(time.Now().Add(time.Hour).Unix(), 10))
				body = map[string]any{"droplets": []any{}}
			case "/internal/v1/recorder/fleet/demand":
				demandCalls++
				body = map[string]any{"schema_version": recorderfleet.DemandSchemaVersion, "environment": config.Fleet.Key.Environment, "role": config.Fleet.Key.Role, "revision": "empty", "desired_nodes": 0, "observed_at": time.Now().UTC().Format(time.RFC3339Nano)}
			case "/internal/v1/recorder/fleet/nodes":
				body = map[string]any{"schema_version": recorderfleet.NodesSchemaVersion, "environment": config.Fleet.Key.Environment, "role": config.Fleet.Key.Role, "nodes": []any{}}
			case "/internal/v1/recorder/fleet/pool":
				status = http.StatusNoContent
			default:
				t.Errorf("unexpected request: %s", r.URL.Path)
			}
			data, err := json.Marshal(body)
			if status == http.StatusNoContent {
				data = nil
			}
			return &http.Response{StatusCode: status, Header: header, Body: io.NopCloser(strings.NewReader(string(data)))}, err
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
		ctx, cancel := context.WithTimeout(t.Context(), 25*time.Second)
		defer cancel()
		if err := runLoop(ctx, config.ReconcileInterval, runner, slog.New(slog.NewTextHandler(io.Discard, nil))); err != nil {
			t.Fatal(err)
		}
		if providerCalls != 1 || demandCalls < 3 {
			t.Fatalf("reset blocked other reconciliation work: provider=%d demand=%d", providerCalls, demandCalls)
		}
	})
}
