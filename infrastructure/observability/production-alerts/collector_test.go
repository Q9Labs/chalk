package main

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"github.com/jackc/pgx/v5"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"text/template"
	"time"
)

func alertTestFile(name string) string {
	_, source, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(source), name)
}

func TestReadinessSnapshotsPreserveSafeReasonsAndRecovery(t *testing.T) {
	for _, fixture := range []struct {
		name, body, reason string
		status             int
		value              int64
	}{
		{"incident", `{"status":"unready","dependencies":{"reason":"database_unavailable"}}`, "database_unavailable", 503, 1},
		{"process unavailable", `{"status":"unready","reason":"readiness_process_unavailable"}`, "readiness_process_unavailable", 503, 1},
		{"unknown reason", `{"dependencies":{"reason":"private-test-payload @everyone"}}`, "http_503", 503, 1},
		{"non JSON", `private-test-payload`, "http_502", 502, 1},
		{"recovered", `{"status":"ready","dependencies":{}}`, "ready", 200, 0},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet || r.URL.Path != "/readyz" {
					t.Errorf("unexpected probe: %s %s", r.Method, r.URL.Path)
				}
				w.WriteHeader(fixture.status)
				fmt.Fprint(w, fixture.body)
			}))
			defer server.Close()
			item := collectReadiness(context.Background(), server.Client(), server.URL+"/readyz")
			if item.Rule != "sync-readiness" || item.Reason != fixture.reason || item.Value != fixture.value || item.Time == "" {
				t.Fatalf("unexpected snapshot: %+v", item)
			}
			formatMessage(&item)
			if !strings.Contains(item.Summary, fixture.reason) || strings.Contains(item.Summary, "private-test") {
				t.Fatal(item.Summary)
			}
			content := renderDiscord(t, map[string]interface{}{"Action": "Open", "Value": 1, "GroupKeys": []string{"alert_message"}, "GroupValues": []string{discordGroup(item)}})
			if !strings.Contains(content, fixture.reason) || !strings.Contains(content, "Sync has stayed unready") {
				t.Fatal(content)
			}
		})
	}
}

func TestReadinessSurvivesDatabaseCollectionFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		fmt.Fprint(w, `{"dependencies":{"reason":"database_unavailable"}}`)
	}))
	defer server.Close()
	items, err := collectState(context.Background(), server.Client(), "", server.URL, sfuProbe{})
	if err == nil || len(items) != 1 || items[0].Value != 1 || items[0].Reason != "database_unavailable" {
		t.Fatalf("database failure hid the independent probe: %+v, %v", items, err)
	}
}

func TestReadinessDoesNotFollowRedirectsOrHideTransportFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/readyz" {
			http.Redirect(w, r, "/healthy", http.StatusFound)
			return
		}
		t.Error("probe followed a redirect")
	}))
	defer server.Close()
	if item := collectReadiness(context.Background(), server.Client(), server.URL+"/readyz"); item.Value != 1 || item.Reason != "http_302" {
		t.Fatal(item)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if item := collectReadiness(ctx, server.Client(), server.URL); item.Value != 1 || item.Reason != "unreachable" {
		t.Fatal(item)
	}
}

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
	body, err := os.ReadFile(alertTestFile("discord-body.tmpl"))
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
		data := map[string]interface{}{"Action": action, "Title": "internal title", "Description": "internal description", "Value": 2, "GroupKeys": []string{"alert_message"}, "GroupValues": []string{discordGroup(snapshot{Rule: "export", Headline: headline, Summary: summary, Next: next, Engineers: "For engineers: export; trace command."})}}
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
		body, err := os.ReadFile(alertTestFile("discord-body.tmpl"))
		if err != nil {
			t.Fatal(err)
		}
		tmpl, err := template.New("discord").Parse(string(body))
		if err != nil {
			t.Fatal(err)
		}
		var output bytes.Buffer
		if err := tmpl.Execute(&output, map[string]interface{}{"Action": "Open", "Value": 1, "GroupKeys": []string{"alert_message"}, "GroupValues": []string{discordGroup(snapshot{Tenant: item.Tenant, Rule: item.Rule, Headline: item.Headline, Summary: item.Summary, Next: item.Next, Engineers: "For engineers: recording."})}}); err != nil {
			t.Fatal(err)
		}
		if !json.Valid(output.Bytes()) {
			t.Fatalf("invalid Discord JSON for sanitized name")
		}
		if !strings.Contains(item.Summary, "Tenant:") {
			t.Fatal("missing attribution")
		}
		encoded, err := json.Marshal(item)
		if err != nil {
			t.Fatal(err)
		}
		var ingested struct {
			TenantName string `json:"chalk_alert_tenant_name"`
		}
		if err := json.Unmarshal(encoded, &ingested); err != nil {
			t.Fatal(err)
		}
		if ingested.TenantName != safeTenantName(raw) {
			t.Fatal("connection-report enrichment must ingest only the sanitized Tenant name")
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
 CREATE TABLE recording_pipelines(recording_id uuid, capture_completed_at timestamptz, tenant_id uuid);
 CREATE TABLE sync_recordings(tenant_id uuid, recording_id uuid, status text);
 CREATE TABLE recording_jobs(tenant_id uuid, recording_id uuid, episode_id uuid, kind text, state text, terminal_at timestamptz, created_at timestamptz);
 CREATE TABLE transcriptions(tenant_id uuid, recording_id uuid, status text, source_expires_at timestamptz, updated_at timestamptz, created_at timestamptz);
 CREATE TABLE webhook_deliveries(id uuid, tenant_id uuid, state text, terminal_at timestamptz);
 CREATE FUNCTION recording_deferred_retention_seconds(config_snapshot jsonb) RETURNS bigint LANGUAGE sql IMMUTABLE STRICT AS $$SELECT coalesce(nullif((config_snapshot -> 'artifact_policy' -> 'recording' ->> 'retention_seconds')::bigint, 0), 2592000)$$;
 INSERT INTO tenants VALUES ('00000000-0000-4000-8000-000000000001','Example school'),('00000000-0000-4000-8000-000000000002','Internal test school');
 INSERT INTO episodes VALUES ('00000000-0000-4000-8000-000000000003','{"artifact_policy":{"recording":{"retention_seconds":86400}}}');
 INSERT INTO recording_pipelines VALUES ('00000000-0000-4000-8000-000000000004',now()-interval '1 hour','00000000-0000-4000-8000-000000000001');
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
	if len(items) != 15 {
		t.Fatalf("got %d snapshots; want five per Tenant plus five heartbeat rows", len(items))
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
	// Capture succeeded, but Sync never received the stopped callback. Other
	// rows are recent, incomplete, healthy, or belong to a different Tenant.
	if _, err := conn.Exec(ctx, `
 INSERT INTO sync_recordings VALUES
 ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000004','stopping'),
 ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000010','stopping'),
 ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000011','stopping'),
 ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000012','stopped'),
 ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000013','recording'),
 ('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000004','stopping');
 INSERT INTO recording_pipelines VALUES
 ('00000000-0000-4000-8000-000000000010',now()-interval '1 minute','00000000-0000-4000-8000-000000000001'),
 ('00000000-0000-4000-8000-000000000011',NULL,'00000000-0000-4000-8000-000000000001'),
 ('00000000-0000-4000-8000-000000000012',now()-interval '1 hour','00000000-0000-4000-8000-000000000001'),
 ('00000000-0000-4000-8000-000000000013',now()-interval '1 hour','00000000-0000-4000-8000-000000000001');
 INSERT INTO recording_jobs VALUES
 ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000003','capture','succeeded',now(),now());`); err != nil {
		t.Fatal(err)
	}
	items, err = collect(ctx, parsed.String())
	if err != nil {
		t.Fatal(err)
	}
	var stranded int64
	for _, item := range items {
		if item.Rule == "recording-stop" && item.Tenant == "00000000-0000-4000-8000-000000000001" {
			stranded += item.Value
		} else if item.Value != 0 {
			t.Fatalf("healthy row counted: %+v", item)
		}
	}
	if stranded != 1 {
		t.Fatalf("succeeded capture with missing stop callback: got %d; want 1", stranded)
	}
	if _, err := conn.Exec(ctx, "UPDATE sync_recordings SET status='stopped'"); err != nil {
		t.Fatal(err)
	}
	items, err = collect(ctx, parsed.String())
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range items {
		if item.Value != 0 {
			t.Fatal("repaired stop must emit zero")
		}
	}
}

func TestClosedMessagesPreserveTenantContext(t *testing.T) {
	body, err := os.ReadFile(alertTestFile("discord-body.tmpl"))
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
		if err := tmpl.Execute(&output, map[string]interface{}{"Action": "Closed", "Value": 0, "GroupKeys": []string{"alert_message"}, "GroupValues": []string{discordGroup(snapshot{Tenant: item.Tenant, Rule: item.Rule, Headline: item.Headline, Summary: item.Summary, Next: item.Next, Engineers: "For engineers: export."})}}); err != nil {
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

// sfuFixture is a throwaway CA, a server that requires a client certificate
// signed by it over TLS 1.3, and the files the collector reads.
type sfuFixture struct {
	probe  sfuProbe
	server *httptest.Server
}

func newSFUFixture(t *testing.T, handler http.HandlerFunc) sfuFixture {
	t.Helper()
	dir := t.TempDir()
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	caTemplate := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "test ca"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
	caDER, err := x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, &caKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	caCert, err := x509.ParseCertificate(caDER)
	if err != nil {
		t.Fatal(err)
	}
	issue := func(serial int64, usage x509.ExtKeyUsage) tls.Certificate {
		key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		template := &x509.Certificate{SerialNumber: big.NewInt(serial), Subject: pkix.Name{CommonName: "test"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), ExtKeyUsage: []x509.ExtKeyUsage{usage}, KeyUsage: x509.KeyUsageDigitalSignature, DNSNames: []string{"chalk-sfu"}}
		der, err := x509.CreateCertificate(rand.Reader, template, caCert, &key.PublicKey, caKey)
		if err != nil {
			t.Fatal(err)
		}
		return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
	}
	write := func(name, kind string, der []byte) string {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: kind, Bytes: der}), 0o600); err != nil {
			t.Fatal(err)
		}
		return path
	}
	client := issue(2, x509.ExtKeyUsageClientAuth)
	clientKey, err := x509.MarshalPKCS8PrivateKey(client.PrivateKey)
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(caCert)
	server := httptest.NewUnstartedServer(handler)
	server.TLS = &tls.Config{Certificates: []tls.Certificate{issue(3, x509.ExtKeyUsageServerAuth)}, ClientCAs: roots, ClientAuth: tls.RequireAndVerifyClientCert, MinVersion: tls.VersionTLS13}
	server.StartTLS()
	t.Cleanup(server.Close)
	return sfuFixture{server: server, probe: sfuProbe{
		URL:            server.URL + "/readyz",
		ServerName:     "chalk-sfu",
		ClientCertFile: write("client.pem", "CERTIFICATE", client.Certificate[0]),
		ClientKeyFile:  write("client-key.pem", "PRIVATE KEY", clientKey),
		CAFile:         write("ca.pem", "CERTIFICATE", caDER),
	}}
}

func sfuBody(reserved int, admission string) string {
	reason := ""
	if admission != "" {
		reason = `"admissionReason":"` + admission + `",`
	}
	return fmt.Sprintf(`{"nodeIncarnation":"incarnation-private-test","sessions":3,"packetBudget":16000,"reservedPackets":%d,"newEpisodePackets":240,"host":{%s"queueDelayP95Ms":1.5,"schedulerLatencyP99Ms":2,"packetsPerSecond":900,"udpReceiveBufferBytes":8388608}}`, reserved, reason)
}

func TestSFUReadinessReasonsAndSafeExport(t *testing.T) {
	for _, fixture := range []struct {
		name, body, reason string
		status             int
		value              int64
	}{
		{"ready", sfuBody(100, ""), "ready", 200, 0},
		{"below budget threshold", sfuBody(14399, ""), "ready", 200, 0},
		{"budget at 90 percent", sfuBody(14400, ""), "packet_budget", 200, 1},
		{"budget exhausted", sfuBody(16000, ""), "packet_budget", 200, 1},
		{"draining", sfuBody(0, ""), "draining", 503, 1},
		{"cpu steal closes admission", sfuBody(100, "cpu_steal"), "admission_cpu_steal", 200, 1},
		{"pacer delay closes admission", sfuBody(100, "pacer_queue_delay"), "admission_pacer_queue_delay", 200, 1},
		{"admission wins over budget", sfuBody(16000, "cpu_steal"), "admission_cpu_steal", 200, 1},
		{"unknown admission reason", sfuBody(100, "private-test-reason"), "invalid_response", 200, 1},
		{"other status", sfuBody(100, ""), "http_status", 500, 1},
		{"invalid JSON", `private-test-payload`, "invalid_response", 200, 1},
		{"missing budget", `{"sessions":1}`, "invalid_response", 200, 1},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			sfu := newSFUFixture(t, func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet || r.URL.Path != "/readyz" || r.TLS == nil || r.TLS.Version != tls.VersionTLS13 || len(r.TLS.PeerCertificates) != 1 {
					t.Errorf("unexpected probe: %s %s", r.Method, r.URL.Path)
				}
				w.WriteHeader(fixture.status)
				fmt.Fprint(w, fixture.body)
			})
			item := collectSFUReadiness(context.Background(), sfu.probe)
			if item.Rule != "sfu-readiness" || item.Reason != fixture.reason || item.Value != fixture.value || item.Time == "" {
				t.Fatalf("unexpected snapshot: %+v", item)
			}
			formatMessage(&item)
			encoded, err := json.Marshal(item)
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(item.Summary, fixture.reason) || strings.Contains(string(encoded), "private-test") || strings.Contains(string(encoded), sfu.server.URL) || !strings.Contains(item.Headline, "own SFU") {
				t.Fatal(string(encoded))
			}
		})
	}
}

func TestSFUReadinessFailsClosedWithoutLeakingErrors(t *testing.T) {
	sfu := newSFUFixture(t, func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, sfuBody(0, "")) })
	broken := func(mutate func(*sfuProbe)) sfuProbe {
		probe := sfu.probe
		mutate(&probe)
		return probe
	}
	garbage := filepath.Join(t.TempDir(), "garbage.pem")
	if err := os.WriteFile(garbage, []byte("private-test-garbage"), 0o600); err != nil {
		t.Fatal(err)
	}
	other := newSFUFixture(t, func(http.ResponseWriter, *http.Request) {})
	for name, probe := range map[string]sfuProbe{
		"missing client cert": broken(func(p *sfuProbe) { p.ClientCertFile = "/nonexistent/private-test" }),
		"unset files":         {URL: sfu.probe.URL},
		"invalid key":         broken(func(p *sfuProbe) { p.ClientKeyFile = garbage }),
		"invalid CA":          broken(func(p *sfuProbe) { p.CAFile = garbage }),
		"plaintext URL":       broken(func(p *sfuProbe) { p.URL = strings.Replace(p.URL, "https://", "http://", 1) }),
	} {
		t.Run(name, func(t *testing.T) {
			if item := collectSFUReadiness(context.Background(), probe); item.Value != 1 || item.Reason != "tls_config" {
				t.Fatalf("unexpected snapshot: %+v", item)
			}
		})
	}
	t.Run("server the CA does not trust", func(t *testing.T) {
		probe := sfu.probe
		probe.CAFile = other.probe.CAFile
		if item := collectSFUReadiness(context.Background(), probe); item.Value != 1 || item.Reason != "unreachable" {
			t.Fatalf("unexpected snapshot: %+v", item)
		}
	})
	t.Run("address URL without the certificate's server name", func(t *testing.T) {
		probe := sfu.probe
		probe.ServerName = ""
		if item := collectSFUReadiness(context.Background(), probe); item.Value != 1 || item.Reason != "unreachable" {
			t.Fatalf("unexpected snapshot: %+v", item)
		}
	})
	t.Run("client certificate from another CA", func(t *testing.T) {
		probe := sfu.probe
		probe.ClientCertFile, probe.ClientKeyFile = other.probe.ClientCertFile, other.probe.ClientKeyFile
		if item := collectSFUReadiness(context.Background(), probe); item.Value != 1 || item.Reason != "unreachable" {
			t.Fatalf("unexpected snapshot: %+v", item)
		}
	})
	t.Run("server down", func(t *testing.T) {
		probe := sfu.probe
		sfu.server.Close()
		if item := collectSFUReadiness(context.Background(), probe); item.Value != 1 || item.Reason != "unreachable" {
			t.Fatalf("unexpected snapshot: %+v", item)
		}
	})
}

func TestSFUReadinessRowOnlyWhenConfigured(t *testing.T) {
	sync := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer sync.Close()
	items, _ := collectState(context.Background(), sync.Client(), "", sync.URL, sfuProbe{})
	if len(items) != 1 || items[0].Rule != "sync-readiness" {
		t.Fatalf("an unconfigured SFU must emit no row: %+v", items)
	}
	sfu := newSFUFixture(t, func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, sfuBody(0, "")) })
	items, _ = collectState(context.Background(), sync.Client(), "", sync.URL, sfu.probe)
	if len(items) != 2 || items[0].Rule != "sync-readiness" || items[1].Rule != "sfu-readiness" || items[1].Value != 0 {
		t.Fatalf("a configured SFU emits one global row: %+v", items)
	}
	t.Setenv("CHALK_ALERT_SFU_READY_URL", "")
	if sfuProbeFromEnv().URL != "" {
		t.Fatal("an unset URL must disable the SFU probe")
	}
}
