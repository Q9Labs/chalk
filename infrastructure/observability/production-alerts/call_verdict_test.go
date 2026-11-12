package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

// scripts/diagnose-call/fixtures/cases.json is read by the command's tests as well, so the verdict the collector
// flags and the verdict an engineer reads from the command cannot differ.
func TestVerdictMatchesCommandFixtures(t *testing.T) {
	payload, err := os.ReadFile("../../../scripts/diagnose-call/fixtures/cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name    string           `json:"name"`
		Rows    []map[string]any `json:"rows"`
		Verdict string           `json:"verdict"`
	}
	if err := json.Unmarshal(payload, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) < 5 {
		t.Fatalf("expected the five shared scenarios, got %d", len(cases))
	}
	thresholds := loadVerdictThresholds()
	for _, c := range cases {
		rows := make([]logRow, 0, len(c.Rows))
		for _, raw := range c.Rows {
			rows = append(rows, normalizeLogRow(raw))
		}
		if got := verdictLine(diagnoseRows(rows, thresholds)); got != c.Verdict {
			t.Errorf("%s:\n got  %s\n want %s", c.Name, got, c.Verdict)
		}
	}
}

func TestEpisodeRowsReadsByIdAndFollowsConnections(t *testing.T) {
	const episode = "9feb0ff6-1111-4222-8333-444455556666"
	var queries []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct{ APL string }
		_ = json.NewDecoder(r.Body).Decode(&body)
		queries = append(queries, body.APL)
		if r.Header.Get("Authorization") != "Bearer query-token" || r.Header.Get("X-Axiom-Org-Id") != "org" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if strings.Contains(body.APL, "chalk-sfu") {
			_, _ = w.Write([]byte(`{"matches":[{"_time":"2026-11-11T10:00:20Z","data":{"service":{"name":"chalk-sfu"},"attributes":{"event":"sfu.subscription.paused","connection_id":"conn-a"}}}]}`))
			return
		}
		_, _ = w.Write([]byte(`{"matches":[{"_time":"2026-11-11T10:00:10Z","data":{"attributes":{"event":"sdk.call_stats","episode_id":"` + episode + `","connection_id":"conn-a"}}}]}`))
	}))
	defer server.Close()
	querier := axiomQuerier{client: server.Client(), token: "query-token", org: "org", dataset: "logs", url: server.URL}

	rows, err := querier.episodeRows(context.Background(), episode, time.Date(2026, 11, 11, 10, 5, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 || !rows[1].sfu {
		t.Fatalf("expected the API row and the node row of its connection, got %+v", rows)
	}
	if !strings.Contains(queries[0], "episode_id") || strings.Contains(queries[0], "_time") || !strings.Contains(queries[1], "'conn-a'") {
		t.Fatalf("both reads must be by id: %v", queries)
	}
	if _, err := querier.episodeRows(context.Background(), "x' or true", time.Now()); err == nil {
		t.Fatal("an Episode id that is not an id must be refused before it reaches a query")
	}
}

func TestMissingNodeFieldDoesNotFailTheVerdict(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct{ APL string }
		_ = json.NewDecoder(r.Body).Decode(&body)
		if strings.Contains(body.APL, "chalk-sfu") {
			http.Error(w, `{"message":"invalid field: \"attributes.connection_id\""}`, http.StatusBadRequest)
			return
		}
		_, _ = w.Write([]byte(`{"matches":[{"_time":"2026-11-11T10:00:10Z","data":{"attributes":{"event":"sdk.call_stats","connection_id":"conn-a"}}}]}`))
	}))
	defer server.Close()
	querier := axiomQuerier{client: server.Client(), token: "t", dataset: "logs", url: server.URL}
	rows, err := querier.episodeRows(context.Background(), "9feb0ff6-1111-4222-8333-444455556666", time.Now())
	if err != nil || len(rows) != 1 {
		t.Fatalf("a dataset that has not received node events yet leaves the API rows to be judged: rows=%d err=%v", len(rows), err)
	}
}

func TestBadVerdictBecomesOneAlertRowAndAGoodOneNone(t *testing.T) {
	payload, err := os.ReadFile("../../../scripts/diagnose-call/fixtures/cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name string           `json:"name"`
		Rows []map[string]any `json:"rows"`
	}
	if err := json.Unmarshal(payload, &cases); err != nil {
		t.Fatal(err)
	}
	rowsOf := map[string][]map[string]any{}
	for _, c := range cases {
		rowsOf[c.Name] = c.Rows
	}
	served := ""
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		matches := []map[string]any{}
		for _, raw := range rowsOf[served] {
			matches = append(matches, map[string]any{"_time": raw["_time"], "data": raw})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"matches": matches})
	}))
	defer server.Close()
	querier := axiomQuerier{client: server.Client(), token: "t", dataset: "logs", url: server.URL}
	episodes := []endedEpisode{{tenantID: "tenant-1", tenantName: "Acme", episodeID: "9feb0ff6-1111-4222-8333-444455556666", endedAt: time.Now()}}

	served = "failed join"
	flags, err := collectCallVerdicts(context.Background(), querier, episodes, loadVerdictThresholds())
	if err != nil || len(flags) != 1 {
		t.Fatalf("a failed join must raise one row: %v %v", flags, err)
	}
	item := flags[0]
	formatMessage(&item)
	if item.Rule != callVerdictRulePrefix+episodes[0].episodeID || item.Value != 1 || item.Tenant != "tenant-1" || !strings.HasPrefix(item.Summary, "Tenant: Acme. ") || !strings.Contains(item.Summary, "could not join") {
		t.Fatalf("unexpected row: %+v", item)
	}

	for _, quiet := range []string{"healthy call", "viewer hid the video itself"} {
		served = quiet
		flags, err = collectCallVerdicts(context.Background(), querier, episodes, loadVerdictThresholds())
		if err != nil || len(flags) != 0 {
			t.Fatalf("%s must raise nothing: %v %v", quiet, flags, err)
		}
	}
}

func TestVerdictRowLandsWithinTheFlagBound(t *testing.T) {
	worst := callVerdictSettle + callVerdictBand + callVerdictBudget
	if bound := time.Duration(loadVerdictThresholds().FlagWithinMS) * time.Millisecond; worst > bound {
		t.Fatalf("an Episode is judged up to %s after it ends, past the %s bound in call-verdict.json", worst, bound)
	}
}
