package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"github.com/jackc/pgx/v5"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"text/template"
	"time"
)

func TestIngestRejectsPartialAcceptanceWithoutLeakingResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"ingested":1,"failed":1,"failures":["private-test-payload"]}`))
	}))
	defer server.Close()
	err := ingest(context.Background(), server.Client(), server.URL, "private-test-token", []snapshot{{Rule: "recording"}, {Rule: "export"}})
	if err == nil || strings.Contains(err.Error(), "private-test") {
		t.Fatalf("partial ingest must fail with a redacted error: %v", err)
	}
}

func TestIngestRejectsUnexpectedSuccessBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{}`))
	}))
	defer server.Close()
	if err := ingest(context.Background(), server.Client(), server.URL, "test", []snapshot{{Rule: "recording"}}); err == nil {
		t.Fatal("a 200 without acceptance evidence must not count as delivery")
	}
}

func TestDiscordTemplateProducesPlainMessagesAndHonestClosure(t *testing.T) {
	body, err := os.ReadFile("discord-body.tmpl")
	if err != nil {
		t.Fatal(err)
	}
	tmpl, err := template.New("discord").Parse(string(body))
	if err != nil {
		t.Fatal(err)
	}
	for _, action := range []string{"Open", "Closed"} {
		headline, summary, next := message("export")
		var output bytes.Buffer
		data := map[string]interface{}{"Action": action, "Title": "internal title", "Description": "internal description", "Value": 2, "GroupKeys": []string{"summary", "rule", "headline", "next", "engineers"}, "GroupValues": []string{summary, "export", headline, next, "For engineers: export; trace command."}}
		if err := tmpl.Execute(&output, data); err != nil {
			t.Fatal(err)
		}
		var payload struct {
			Content         string `json:"content"`
			AllowedMentions struct {
				Parse []string `json:"parse"`
			} `json:"allowed_mentions"`
		}
		if err := json.Unmarshal(output.Bytes(), &payload); err != nil {
			t.Fatalf("invalid Discord JSON: %v", err)
		}
		if len(payload.AllowedMentions.Parse) != 0 {
			t.Fatal("mentions must be disabled")
		}
		if action == "Open" && (!strings.HasPrefix(payload.Content, headline+"\n") || !strings.Contains(payload.Content, "Affected items: 2.")) {
			t.Fatal(payload.Content)
		}
		if action == "Closed" && (!strings.Contains(payload.Content, "does not prove") || strings.Contains(payload.Content, "Resolved")) {
			t.Fatal(payload.Content)
		}
	}
}

func TestTenantNamesCannotBreakDiscordJSON(t *testing.T) {
	for _, raw := range []string{"Example school", "@everyone\n```\x01\x7f\x85\u202e\" school", strings.Repeat("学", 100)} {
		item := snapshot{Rule: "recording", Tenant: "synthetic", TenantName: raw, Value: 1}
		formatMessage(&item)
		body, err := os.ReadFile("discord-body.tmpl")
		if err != nil {
			t.Fatal(err)
		}
		tmpl, err := template.New("discord").Parse(string(body))
		if err != nil {
			t.Fatal(err)
		}
		var output bytes.Buffer
		if err := tmpl.Execute(&output, map[string]interface{}{"Action": "Open", "Value": 1, "GroupKeys": []string{"rule", "headline", "summary", "next", "engineers"}, "GroupValues": []string{item.Rule, item.Headline, item.Summary, item.Next, "For engineers: recording."}}); err != nil {
			t.Fatal(err)
		}
		if !json.Valid(output.Bytes()) {
			t.Fatalf("invalid Discord JSON for sanitized name")
		}
		if !strings.Contains(item.Summary, "Tenant:") {
			t.Fatal("missing attribution")
		}
	}
}

func TestExpiryMessageDoesNotPromiseRecovery(t *testing.T) {
	future := time.Now().Add(time.Hour)
	item := snapshot{Rule: "export", Value: 1, ExpiresAt: &future, UnknownExpiry: 1}
	formatMessage(&item)
	if !strings.Contains(item.Next, future.UTC().Format(time.RFC3339)) || !strings.Contains(item.Next, "unknown") {
		t.Fatal(item.Next)
	}
	past := time.Now().Add(-time.Hour)
	item.ExpiresAt = &past
	formatMessage(&item)
	if !strings.Contains(item.Next, "recovery is not promised") {
		t.Fatal(item.Next)
	}
}

func TestStateSQLSeparatesFailuresAndClearsTenantGroups(t *testing.T) {
	databaseURL := os.Getenv("CHALK_ALERT_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("requires an isolated CHALK_ALERT_TEST_DATABASE_URL")
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	schema := fmt.Sprintf("alert_fixture_%d", time.Now().UnixNano())
	ident := pgx.Identifier{schema}.Sanitize()
	if _, err := conn.Exec(ctx, "CREATE SCHEMA "+ident); err != nil {
		t.Fatal(err)
	}
	defer conn.Exec(ctx, "DROP SCHEMA "+ident+" CASCADE")
	if _, err := conn.Exec(ctx, "SET search_path TO "+ident); err != nil {
		t.Fatal(err)
	}
	// The fixture schema has only the columns this read-only collector consumes.
	fixture := `
 CREATE TABLE tenants(id uuid, name text);
 CREATE TABLE episodes(id uuid, config_snapshot jsonb);
 CREATE TABLE recording_pipelines(recording_id uuid, capture_completed_at timestamptz);
 CREATE TABLE recording_jobs(tenant_id uuid, recording_id uuid, episode_id uuid, kind text, state text, terminal_at timestamptz, created_at timestamptz);
 CREATE TABLE transcriptions(tenant_id uuid, recording_id uuid, status text, source_expires_at timestamptz, updated_at timestamptz, created_at timestamptz);
 CREATE TABLE webhook_deliveries(id uuid, tenant_id uuid, state text, terminal_at timestamptz);
 CREATE FUNCTION recording_deferred_retention_seconds(config_snapshot jsonb) RETURNS bigint LANGUAGE sql IMMUTABLE STRICT AS $$SELECT coalesce(nullif((config_snapshot -> 'artifact_policy' -> 'recording' ->> 'retention_seconds')::bigint, 0), 2592000)$$;
 INSERT INTO tenants VALUES ('00000000-0000-4000-8000-000000000001','Example school'),('00000000-0000-4000-8000-000000000002','Internal test school');
 INSERT INTO episodes VALUES ('00000000-0000-4000-8000-000000000003','{"artifact_policy":{"recording":{"retention_seconds":86400}}}');
 INSERT INTO recording_pipelines VALUES ('00000000-0000-4000-8000-000000000004',now()-interval '1 hour');
 INSERT INTO recording_jobs VALUES
 ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000003','render','terminal_failure',now(),now()),
 ('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000005','00000000-0000-4000-8000-000000000003','capture','terminal_failure',now(),now());`
	if _, err := conn.Exec(ctx, fixture); err != nil {
		t.Fatal(err)
	}
	if baselinePath := os.Getenv("CHALK_ALERT_BASELINE_SQL"); baselinePath != "" {
		baseline, err := os.ReadFile(baselinePath)
		if err != nil {
			t.Fatal(err)
		}
		rows, err := conn.Query(ctx, string(baseline))
		if err != nil {
			t.Fatal(err)
		}
		counts := make(map[string]int64)
		for rows.Next() {
			var rule, summary string
			var value int64
			if err := rows.Scan(&rule, &value, &summary); err != nil {
				t.Fatal(err)
			}
			counts[rule] = value
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		rows.Close()
		if counts["recording"] != 2 || counts["export"] != 1 {
			t.Fatal(counts)
		}
		t.Log("baseline: two actual failures counted three times (Capture/Render=2, Export=1); after: Capture=1, Export=1")
	}
	parsed, err := url.Parse(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	query := parsed.Query()
	query.Set("search_path", schema)
	parsed.RawQuery = query.Encode()
	start := time.Now()
	items, err := collect(ctx, parsed.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("collector fixture query: %s; %d snapshots", time.Since(start), len(items))
	if len(items) != 12 {
		t.Fatalf("got %d snapshots; want four per Tenant plus four heartbeat rows", len(items))
	}
	for _, item := range items {
		if item.TenantName == "Example school" && item.Rule == "recording" && item.Value != 0 {
			t.Fatal("Render was double counted as Capture")
		}
		if item.TenantName == "Example school" && item.Rule == "export" && (item.Value != 1 || item.ExpiresAt == nil) {
			t.Fatal("missing Render or expiry")
		}
		if item.TenantName == "Internal test school" && item.Rule == "recording" && item.Value != 1 {
			t.Fatal("missing test Tenant failure")
		}
	}
	if _, err := conn.Exec(ctx, `INSERT INTO transcriptions VALUES ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000004','preparing',now()+interval '1 hour',now(),now()-interval '31 minutes'); INSERT INTO webhook_deliveries VALUES ('00000000-0000-4000-8000-000000000006','00000000-0000-4000-8000-000000000001','exhausted',now()); UPDATE recording_jobs SET state='pending',created_at=now()-interval '15 hours' WHERE kind='render'`); err != nil {
		t.Fatal(err)
	}
	items, err = collect(ctx, parsed.String())
	if err != nil {
		t.Fatal(err)
	}
	positive := map[string]int64{}
	for _, item := range items {
		positive[item.Rule] += item.Value
	}
	if positive["export"] != 1 || positive["transcript"] != 1 || positive["webhook"] != 1 {
		t.Fatal(positive)
	}
	if _, err := conn.Exec(ctx, "UPDATE transcriptions SET status='complete'; UPDATE webhook_deliveries SET state='succeeded'"); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, "UPDATE recording_jobs SET state='succeeded'"); err != nil {
		t.Fatal(err)
	}
	items, err = collect(ctx, parsed.String())
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range items {
		if item.Value != 0 {
			t.Fatal("cleared failure must emit zero")
		}
	}
}

func TestClosedMessagesPreserveTenantContext(t *testing.T) {
	body, err := os.ReadFile("discord-body.tmpl")
	if err != nil {
		t.Fatal(err)
	}
	tmpl, err := template.New("discord").Parse(string(body))
	if err != nil {
		t.Fatal(err)
	}
	var outputs []string
	for _, name := range []string{"Example school one", "Example school two"} {
		item := snapshot{Rule: "export", Tenant: "synthetic", TenantName: name}
		formatMessage(&item)
		var output bytes.Buffer
		if err := tmpl.Execute(&output, map[string]interface{}{"Action": "Closed", "Value": 0, "GroupKeys": []string{"rule", "headline", "summary", "next", "engineers"}, "GroupValues": []string{item.Rule, item.Headline, item.Summary, item.Next, "For engineers: export."}}); err != nil {
			t.Fatal(err)
		}
		var payload struct {
			Content string `json:"content"`
		}
		if err := json.Unmarshal(output.Bytes(), &payload); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(payload.Content, name) || !strings.Contains(payload.Content, "does not prove") {
			t.Fatal(payload.Content)
		}
		outputs = append(outputs, payload.Content)
	}
	if outputs[0] == outputs[1] {
		t.Fatal("different Tenants must not produce identical closure messages")
	}
}
