package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/obs"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/sdktelemetry"
	"github.com/q9labs/chalk/apps/api/internal/telemetrydelivery"
)

// crashChains names each slice-9 symptom's fixture chain and which server-side witness rows its Postgres hop writes:
// a Sync websocket close for a dead tab or app, an SFU session close and the durable participant_media_sessions row for a
// tab death. The client emitters produced the frames in hop (a); this hop is the upload route and the ledger.
type crashChain struct {
	code         string
	syncClose    bool // write sync.websocket.closed rows
	sfuClose     bool // write sfu.session.closed rows
	mediaSession bool // seed and read participant_media_sessions
}

var crashChains = []crashChain{
	{code: "page.crashed"},
	{code: "page.uncaught_error"},
	{code: "page.tab_died", syncClose: true, sfuClose: true, mediaSession: true},
	{code: "perf.ui_unresponsive"},
	{code: "perf.memory_pressure"},
	{code: "perf.device_overloaded"},
	{code: "app.crashed", syncClose: true},
	{code: "app.crashed_at_launch"},
	{code: "app.killed_in_background", syncClose: true},
}

// crashReceivedAt is when the chain's API receives every frame: after the latest record of any run, so the ledger
// hand-off is the same on every run.
var crashReceivedAt = time.UnixMilli(1_795_702_000_000).UTC()

type crashReceipt struct {
	postgres.TelemetryLedger
}

func (l crashReceipt) Admit(ctx context.Context, identity telemetrydelivery.Identity, batch sdktelemetry.Request, _ time.Time, stamp sdktelemetry.Stamp) (telemetrydelivery.Admission, error) {
	return l.TelemetryLedger.Admit(ctx, identity, batch, crashReceivedAt, stamp)
}

// TestTelemetryChainCrash posts each symptom's client frames through the real upload route into the real Postgres
// outbox, seeds the close rows Sync and the SFU write for a dead tab's witnesses, runs the real relay to the Axiom
// fake, and saves what each hop hands off (observability/fixtures/<code>/README.md).
func TestTelemetryChainCrash(t *testing.T) {
	databaseURL := os.Getenv("CHALK_TELEMETRY_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set CHALK_TELEMETRY_TEST_DATABASE_URL to an isolated, migrated database")
	}
	pool, err := pgxpool.New(t.Context(), databaseURL)
	if err != nil {
		t.Fatal("open chain database")
	}
	defer pool.Close()
	ledger := postgres.NewTelemetryLedger(pool)

	for _, chain := range crashChains {
		chainDir := filepath.Join("..", "..", "..", "..", "observability", "fixtures", chain.code, "chain")
		for _, run := range []string{"positive", "healthy"} {
			t.Run(chain.code+"/"+run, func(t *testing.T) {
				var frames []map[string]any
				readChain(t, chainDir, "client-frames."+run+".json", &frames)
				subject := chainSubject(t)
				seedChainEpisode(t, pool, subject)
				seedServerClose(t, pool, subject, chain, run)
				f := newTelemetryFixtureWith(t, subject, func(*telemetrydelivery.MemoryLedger) TelemetryLedger { return crashReceipt{ledger} })
				for _, frame := range frames {
					body, _ := json.Marshal(frame)
					recorder := f.postWith(f.telemetryToken, "/telemetry", string(body))
					if recorder.Code != http.StatusOK {
						t.Fatalf("status = %d, body %s", recorder.Code, recorder.Body)
					}
					var response sdktelemetry.Response
					if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil || response.Rejected != 0 {
						t.Fatalf("response = %s, want every record taken", recorder.Body)
					}
				}
				axiom := &chainAxiom{episode: subject.EpisodeID.String()}
				server := httptest.NewServer(http.HandlerFunc(axiom.serve))
				defer server.Close()
				sink, err := observability.NewAxiomEvidence(server.URL, "Authorization=Bearer%20synthetic,x-axiom-dataset=chain")
				if err != nil {
					t.Fatal(err)
				}
				for {
					count, err := ledger.RelayEvidence(t.Context(), sink.Export)
					if err != nil {
						t.Fatal(err)
					}
					if count == 0 {
						break
					}
				}
				axiom.mu.Lock()
				var apiRows, serverRows []map[string]any
				for _, row := range axiom.rows {
					var fields map[string]any
					body, packed := strings.CutPrefix(row.Body, "chalk-evidence-v2:")
					if !packed || json.Unmarshal([]byte(body), &fields) != nil {
						t.Fatal("relay did not export a readable evidence body")
					}
					if fields["kind"] == nil {
						continue
					}
					name, _ := fields["name"].(string)
					if name == "sync.websocket.closed" || name == "sfu.session.closed" {
						serverRows = append(serverRows, fields)
					} else {
						apiRows = append(apiRows, fields)
					}
				}
				axiom.mu.Unlock()

				for _, record := range kernelRecords(frames) {
					row := rowOf(apiRows, record["event_id"])
					if row == nil {
						t.Fatalf("no row for record %v", record["event_id"])
					}
					for field, value := range record {
						if field == "schema_ver" {
							continue
						}
						if !reflect.DeepEqual(row[field], value) {
							t.Errorf("row %s = %v, the client sent %v", field, row[field], value)
						}
					}
				}
				for _, row := range append(apiRows, serverRows...) {
					for field := range row {
						if !obs.KnownField(field) {
							t.Errorf("row %v carries %s, which is not a registry field", row["name"], field)
						}
					}
				}
				compareChain(t, chainDir, "api-rows."+run+".json", apiRows)
				if serverRows != nil {
					compareChain(t, chainDir, "server-rows."+run+".json", serverRows)
				}
				if chain.mediaSession {
					readMediaSessions(t, databaseURL, chainDir, subject, run)
				}
				report, err := telemetrydelivery.EpisodeReport(t.Context(), ledger, subject.TenantID, subject.EpisodeID)
				if err != nil {
					t.Fatal(err)
				}
				compareChain(t, chainDir, "ledger."+run+".json", report)
			})
		}
	}
}

// seedServerClose writes the close records a dead run leaves on the server side: Sync's abnormal websocket close and the
// SFU's session close. The records are the same bytes those kernels stamp, written at the outbox boundary because a
// single test process cannot run three services; the durable outbox, the relay and the export path are real.
func seedServerClose(t *testing.T, pool *pgxpool.Pool, subject accessgrants.Subject, chain crashChain, run string) {
	t.Helper()
	if !chain.syncClose && !chain.sfuClose {
		return
	}
	tenant := subject.TenantID.String()
	closeKind, reason, sfuOutcome, cause := "abnormal", "transport_error", "dropped", "peer_failed"
	if run == "healthy" {
		closeKind, reason, sfuOutcome, cause = "normal", "normal", "left", "participant_left"
	}
	type row struct {
		service    string
		attributes map[string]any
	}
	hash := sha256.Sum256([]byte(subject.ParticipantID.String()))
	shared := map[string]any{
		"event_id":      fmt.Sprintf("e0000000-0000-4000-8000-%012x", len(chain.code)),
		"est_server_ms": 1_795_700_090_000,
		"clock_state":   "server",
		"tenant_id":     tenant,
		"space_id":      subject.SpaceID.String(),
		"episode_id":    subject.EpisodeID.String(),
	}
	var rows []row
	if chain.syncClose {
		rows = append(rows, row{"chalk-sync", merge(shared, map[string]any{
			"kind": "fact", "module": "sync", "name": "sync.websocket.closed",
			"close_reason": reason, "close_kind": closeKind,
			"participant_id_hash": hex.EncodeToString(hash[:]),
			"heartbeat_gap_ms":    45_000, "socket_age_ms": 91_000, "protocol": 1,
		})})
	}
	if chain.sfuClose {
		rows = append(rows, row{"chalk-sfu", merge(shared, map[string]any{
			"kind": "fact", "module": "sfu", "name": "sfu.session.closed",
			"event_id": "f0000000-0000-4000-8000-000000000001",
			"sfu_cause": cause, "sfu_outcome": sfuOutcome, "connected": run == "healthy",
			"connection_id": subject.ConnectionID, "lifetime_ms": 90_000,
		})})
	}
	for _, record := range rows {
		payload, _ := json.Marshal([]map[string]any{{"service": map[string]string{"name": record.service}, "attributes": record.attributes}})
		if _, err := pool.Exec(context.Background(), `insert into telemetry_outbox (tenant_id, payload) values ($1::text::uuid, $2::jsonb)`, tenant, string(payload)); err != nil {
			t.Fatal(err)
		}
	}
	if chain.mediaSession {
		connected, outcome := run == "healthy", "dropped"
		if connected {
			outcome = "left"
		}
		if _, err := pool.Exec(context.Background(), `insert into participant_media_sessions (tenant_id, space_id, episode_id, participant_id, generation, connection_id, cause, outcome, connected, ended_at, lifetime_ms, connect_ms, disconnects, outage_ms)
			values ($1::text::uuid, $2::text::uuid, $3::text::uuid, $4::text::uuid, 1, $5, $6, $7, $8, to_timestamp(1795700090), 90000, 120, 0, 0)`,
			tenant, subject.SpaceID.String(), subject.EpisodeID.String(), subject.ParticipantID.String(), subject.ConnectionID, cause, outcome, connected); err != nil {
			t.Fatal(err)
		}
	}
}

func merge(base map[string]any, more map[string]any) map[string]any {
	out := map[string]any{}
	for key, value := range base {
		out[key] = value
	}
	for key, value := range more {
		out[key] = value
	}
	return out
}

// readMediaSessions writes the durable media-session row the evidence reader returns for this Episode, in registry shape.
func readMediaSessions(t *testing.T, databaseURL, chainDir string, subject accessgrants.Subject, run string) {
	t.Helper()
	root := filepath.Join("..", "..", "..", "..")
	cmd := exec.Command("node", filepath.Join("scripts", "crash-check", "evidence.mjs"), databaseURL, subject.TenantID.String(), subject.EpisodeID.String(), run)
	cmd.Dir = root
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("evidence.mjs: %v\n%s", err, out)
	}
	var rows []map[string]any
	if err := json.Unmarshal(out, &rows); err != nil {
		t.Fatalf("evidence.mjs output: %v\n%s", err, out)
	}
	compareChain(t, chainDir, "db-rows."+run+".json", rows)
}

func readChain(t *testing.T, dir, name string, into any) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		t.Fatalf("read %s: %v (run the chain in order, see the README)", name, err)
	}
	if err := json.Unmarshal(raw, into); err != nil {
		t.Fatalf("parse %s: %v", name, err)
	}
}

func compareChain(t *testing.T, dir, name string, value any) {
	t.Helper()
	text, _ := json.MarshalIndent(value, "", "  ")
	text = append(text, '\n')
	if os.Getenv("CHALK_CHAIN_WRITE") == "1" {
		if err := os.WriteFile(filepath.Join(dir, name), text, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	var want, got any
	readChain(t, dir, name, &want)
	_ = json.Unmarshal(text, &got)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%s is stale: the API wrote\n%s", name, text)
	}
}
