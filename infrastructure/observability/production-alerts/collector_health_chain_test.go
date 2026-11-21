package main

// Chain hop for the host-side witnesses of db.unreachable and
// edge.origin_unreachable: healthRows and collectRuntimeHealth produce the
// real collector rows here, and the test projects each snapshot onto the
// citation and claim fields the reader adds on a live read. Stamps are pinned
// so the chain replays byte-identically. Run it:
//
//	go -C infrastructure/observability/production-alerts test -run TestCollectorHealthChain -count=1

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

var hostChainDirs = map[string]string{
	"unreachable": filepath.Join("..", "..", "..", "observability", "fixtures", "db.unreachable", "chain"),
	"edge":        filepath.Join("..", "..", "..", "observability", "fixtures", "edge.origin_unreachable", "chain"),
}

const hostChainBase = 1795176000000 // 2026-11-20T12:00:00Z, one row a minute

// projected mints the fields platform-sources.mjs adds to a live host row: the
// event id and server time it cites, the environment the read belongs to, and
// the reach claim chalk_alert_value carries.
func projected(item snapshot, index int) map[string]any {
	row := map[string]any{
		"chalk_alert_rule":   item.Rule,
		"chalk_alert_value":  item.Value,
		"chalk_alert_reason": item.Reason,
		"event_id":           fmt.Sprintf("chain-host-%04d", index),
		"est_server_ms":      hostChainBase + int64(index)*60_000,
		"env":                "test",
	}
	reach := "up"
	if item.Value == 1 {
		reach = "down"
	}
	switch item.Rule {
	case ruleDatabase:
		row["db_reach"] = reach
	case ruleRuntimeHealth:
		row["origin_reach"] = reach
	}
	return row
}

func compareHostChain(t *testing.T, dir, name string, value any) {
	t.Helper()
	text, _ := json.MarshalIndent(value, "", "  ")
	text = append(text, '\n')
	path := filepath.Join(dir, name)
	if os.Getenv("CHALK_CHAIN_WRITE") == "1" {
		if err := os.WriteFile(path, text, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Skipf("chain file %s is not written yet; run the hop with CHALK_CHAIN_WRITE=1", path)
	}
	var want, got any
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(text, &got); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%s is stale: the collector wrote\n%s", path, text)
	}
}

func TestCollectorHealthChain(t *testing.T) {
	t.Run("unreachable", func(t *testing.T) {
		var rows []map[string]any
		for i := 0; i < 2; i++ {
			for _, item := range healthRows(context.Background(), http.DefaultClient, nil, unreachableError("chain database refused")) {
				if item.Rule != ruleDatabase {
					continue
				}
				rows = append(rows, projected(item, i))
			}
		}
		compareHostChain(t, hostChainDirs["unreachable"], "host.fault.json", rows)
	})

	t.Run("healthy", func(t *testing.T) {
		var rows []map[string]any
		for i := 0; i < 4; i++ {
			for _, item := range healthRows(context.Background(), http.DefaultClient, []snapshot{{Rule: ruleDeliveryTest}}, nil) {
				if item.Rule != ruleDatabase {
					continue
				}
				rows = append(rows, projected(item, i))
			}
		}
		compareHostChain(t, hostChainDirs["unreachable"], "host.healthy.json", rows)
	})

	t.Run("edge", func(t *testing.T) {
		// The runtime-health probe answers sick: the api probe fails, so the
		// reason reads api_unhealthy and the edge module table picks api.process.
		sick := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusServiceUnavailable) }))
		defer sick.Close()
		t.Setenv("CHALK_ALERT_API_READY_URL", sick.URL)
		t.Setenv("CHALK_ALERT_TUNNEL_QUADLET", filepath.Join(t.TempDir(), "absent"))
		var fault []map[string]any
		for i := 0; i < 2; i++ {
			item := collectRuntimeHealth(context.Background(), http.DefaultClient, sick.URL, "")
			fault = append(fault, projected(item, i))
		}
		compareHostChain(t, hostChainDirs["edge"], "host.fault.json", fault)

		well := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }))
		defer well.Close()
		var healthy []map[string]any
		for i := 0; i < 4; i++ {
			item := collectRuntimeHealth(context.Background(), http.DefaultClient, well.URL, "")
			healthy = append(healthy, projected(item, i))
		}
		compareHostChain(t, hostChainDirs["edge"], "host.healthy.json", healthy)
	})
}
