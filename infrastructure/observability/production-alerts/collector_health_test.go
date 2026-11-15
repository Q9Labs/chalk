package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func status(code int) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(code) }))
}

func rowFor(t *testing.T, items []snapshot, rule string) snapshot {
	t.Helper()
	for _, item := range items {
		if item.Rule == rule {
			return item
		}
	}
	t.Fatalf("no %s row in %+v", rule, items)
	return snapshot{}
}

func TestAnUnreachableDatabaseWritesARowThatPages(t *testing.T) {
	ready := status(200)
	defer ready.Close()
	// A closed port stands in for a database that has gone to sleep.
	items, err := collectState(context.Background(), ready.Client(), "postgres://chalk@127.0.0.1:1/chalk?connect_timeout=1", ready.URL, nil)
	if err == nil {
		t.Fatal("an unreachable database must still fail the run")
	}
	row := rowFor(t, items, "database-unreachable")
	if row.Value != 1 {
		t.Fatalf("the row must page: %+v", row)
	}
	formatMessage(&row)
	healthEngineers(&row)
	if row.Headline == "" || !strings.HasPrefix(row.Engineers, "For engineers: database-unreachable") || strings.Contains(row.Summary+row.Next, "TEST") {
		t.Fatalf("the row needs its own text: %+v", row)
	}
	if sync := rowFor(t, items, "sync-readiness"); sync.Value != 0 {
		t.Fatalf("the Sync row is independent of the database: %+v", sync)
	}
}

func TestAMissingDatabaseConfigurationIsNotAnOutage(t *testing.T) {
	ready := status(200)
	defer ready.Close()
	items, err := collectState(context.Background(), ready.Client(), "", ready.URL, nil)
	if err == nil {
		t.Fatal("a missing database URL must fail the run")
	}
	for _, item := range items {
		if item.Rule == ruleDatabase {
			t.Fatalf("a configuration error must not write a database row: %+v", item)
		}
	}
}

func TestRuntimeHealthFollowsTheAPIAndTheTunnel(t *testing.T) {
	healthy, failing := status(200), status(503)
	defer healthy.Close()
	defer failing.Close()
	for _, test := range []struct {
		name        string
		api, tunnel string
		value       int64
		reason      string
	}{
		{"both up", healthy.URL, healthy.URL, 0, "healthy"},
		{"api refusing", failing.URL, healthy.URL, 1, "api_unhealthy"},
		{"tunnel down", healthy.URL, "http://127.0.0.1:1/ready", 1, "tunnel_unhealthy"},
		{"both down", failing.URL, failing.URL, 1, "api+tunnel_unhealthy"},
		{"no connector on the host", healthy.URL, "", 0, "healthy"},
		{"no connector and the api refusing", failing.URL, "", 1, "api_unhealthy"},
	} {
		t.Run(test.name, func(t *testing.T) {
			item := collectRuntimeHealth(context.Background(), healthy.Client(), test.api, test.tunnel)
			if item.Rule != "runtime-health" || item.Value != test.value || item.Reason != test.reason || item.Time == "" {
				t.Fatalf("unexpected row: %+v", item)
			}
		})
	}
}

func TestEveryHealthRuleHasItsOwnText(t *testing.T) {
	for _, rule := range []string{ruleSyncReadiness, ruleDatabase, ruleRuntimeHealth} {
		item := snapshot{Rule: rule, Value: 1, Reason: "unreachable"}
		formatMessage(&item)
		healthEngineers(&item)
		if strings.Contains(item.Headline, "TEST") || !strings.HasPrefix(item.Engineers, "For engineers: "+rule+";") {
			t.Fatalf("%s has no text of its own: %+v", rule, item)
		}
	}
}

func TestTheTunnelIsProbedOnlyWhereTheConnectorIsInstalled(t *testing.T) {
	quadlet := filepath.Join(t.TempDir(), "chalk-cloudflared.container")
	t.Setenv("CHALK_ALERT_TUNNEL_QUADLET", quadlet)
	t.Setenv("CHALK_ALERT_TUNNEL_READY_URL", "")
	if got := tunnelProbeURL(); got != "" {
		t.Fatalf("a host without the connector must not probe the tunnel, got %q", got)
	}
	if err := os.WriteFile(quadlet, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if got := tunnelProbeURL(); got != "http://127.0.0.1:12000/ready" {
		t.Fatalf("a host with the connector probes the default tunnel URL, got %q", got)
	}
	t.Setenv("CHALK_ALERT_TUNNEL_READY_URL", "http://127.0.0.1:9/ready")
	if got := tunnelProbeURL(); got != "http://127.0.0.1:9/ready" {
		t.Fatalf("the configured URL wins, got %q", got)
	}
}
