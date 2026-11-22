package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/obs"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/sdktelemetry"
	"github.com/q9labs/chalk/apps/api/internal/telemetrydelivery"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// chainDir holds the hand-off files of the end.wrong_screen chain (observability/fixtures/end.wrong_screen/README.md).
var chainDir = filepath.Join("..", "..", "..", "..", "observability", "fixtures", "end.wrong_screen", "chain")

// chainSubject is the seat whose client posted the chain's frames, in the Episode the fixture declares.
func chainSubject(t *testing.T) accessgrants.Subject {
	t.Helper()
	parse := func(raw string) utilities.ID {
		id, err := utilities.ParseID(raw)
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	return accessgrants.Subject{
		TenantID:              parse("c1000000-0000-4000-8000-000000000001"),
		SpaceID:               parse("d1000000-0000-4000-8000-000000000001"),
		EpisodeID:             parse("0f8fad5b-d9cb-469f-a165-70867728950e"),
		ParticipantID:         parse("a1000000-0000-4000-8000-000000000001"),
		ParticipantGeneration: 1,
		Provider:              accessgrants.ProviderChalkSFU,
		ConnectionID:          "pm-chain-0001",
	}
}

// chainReceivedAt is when the chain's API receives every frame: two seconds after the Episode's end, after the last record of
// either run, so the ledger hand-off is the same on every run.
var chainReceivedAt = time.UnixMilli(1_795_600_002_000).UTC()

// pinnedReceipt admits every batch as received at chainReceivedAt, the one clock the route reads that a test can't set.
type pinnedReceipt struct {
	postgres.TelemetryLedger
}

func (l pinnedReceipt) Admit(ctx context.Context, identity telemetrydelivery.Identity, batch sdktelemetry.Request, _ time.Time, stamp sdktelemetry.Stamp) (telemetrydelivery.Admission, error) {
	return l.TelemetryLedger.Admit(ctx, identity, batch, chainReceivedAt, stamp)
}

// TestTelemetryChainEndWrongScreen posts the SDK's real frames through the
// upload route and exports the committed rows to an HTTP Axiom fake. When
// invoked by Sync, its real end record is already pending in the same database.
func TestTelemetryChainEndWrongScreen(t *testing.T) {
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
	existing := os.Getenv("CHALK_CHAIN_EXISTING_EPISODE") == "1"
	for _, run := range []string{"positive", "healthy"} {
		t.Run(run, func(t *testing.T) {
			var frames []map[string]any
			readChainFile(t, "client-frames."+run+".json", &frames)
			subject := chainSubject(t)
			if !existing {
				seedChainEpisode(t, pool, subject)
			}
			f := newTelemetryFixtureWith(t, subject, func(*telemetrydelivery.MemoryLedger) TelemetryLedger { return pinnedReceipt{ledger} })
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
			var rows []map[string]any
			for _, row := range axiom.rows {
				var fields map[string]any
				body, packed := strings.CutPrefix(row.Body, "chalk-evidence-v2:")
				if !packed || json.Unmarshal([]byte(body), &fields) != nil {
					t.Fatal("relay did not export a readable evidence body")
				}
				if row.Service.Name == "chalk-api" && fields["kind"] != nil {
					rows = append(rows, fields)
				}
			}
			axiom.mu.Unlock()

			for _, record := range kernelRecords(frames) {
				row := rowOf(rows, record["event_id"])
				if row == nil {
					t.Fatalf("no row for record %v", record["event_id"])
				}
				for field, value := range record {
					if !reflect.DeepEqual(row[field], value) {
						t.Errorf("row %s = %v, the client sent %v", field, row[field], value)
					}
				}
			}
			for _, row := range rows {
				for field := range row {
					if !obs.KnownField(field) {
						t.Errorf("row %v carries %s, which is not a registry field", row["name"], field)
					}
				}
			}
			compareChainFile(t, "api-rows."+run+".json", rows)
			report, err := telemetrydelivery.EpisodeReport(t.Context(), ledger, subject.TenantID, subject.EpisodeID)
			if err != nil {
				t.Fatal(err)
			}
			compareChainFile(t, "ledger."+run+".json", report)
			if existing {
				verifyChainReadback(t, databaseURL, server.URL, run)
			}
		})
	}
}

func kernelRecords(frames []map[string]any) []map[string]any {
	var records []map[string]any
	for _, frame := range frames {
		events, _ := frame["events"].([]any)
		for _, event := range events {
			if record, ok := event.(map[string]any); ok && record["kind"] != nil {
				records = append(records, record)
			}
		}
	}
	return records
}

func rowOf(rows []map[string]any, eventID any) map[string]any {
	index := slices.IndexFunc(rows, func(row map[string]any) bool { return row["event_id"] == eventID })
	if index < 0 {
		return nil
	}
	return rows[index]
}

func readChainFile(t *testing.T, name string, into any) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(chainDir, name))
	if err != nil {
		t.Fatalf("read %s: %v (run the chain in order, see the README)", name, err)
	}
	if err := json.Unmarshal(raw, into); err != nil {
		t.Fatalf("parse %s: %v", name, err)
	}
}

func compareChainFile(t *testing.T, name string, value any) {
	t.Helper()
	text, _ := json.MarshalIndent(value, "", "  ")
	text = append(text, '\n')
	if os.Getenv("CHALK_CHAIN_WRITE") == "1" {
		if err := os.WriteFile(filepath.Join(chainDir, name), text, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	var want, got any
	readChainFile(t, name, &want)
	_ = json.Unmarshal(text, &got)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%s is stale: the API wrote\n%s", name, text)
	}
}

func seedChainEpisode(t *testing.T, pool *pgxpool.Pool, subject accessgrants.Subject) {
	t.Helper()
	tenant, space, episode, participant := subject.TenantID.String(), subject.SpaceID.String(), subject.EpisodeID.String(), subject.ParticipantID.String()
	write := func(query string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(context.Background(), query, args...); err != nil {
			t.Fatal(err)
		}
	}
	write(`insert into tenants(id, name) values ($1::text::uuid, 'Chain')`, tenant)
	t.Cleanup(func() {
		for _, table := range []string{"telemetry_sources", "participants", "episodes", "spaces"} {
			write("delete from "+table+" where tenant_id = $1::text::uuid", tenant)
		}
		write(`delete from tenants where id = $1::text::uuid`, tenant)
	})
	plane := mediaplane.ProviderChalkSFU.SettingName()
	write(`insert into spaces(id, tenant_id, name, slug, media_plane) values ($1::text::uuid, $2::text::uuid, 'Chain', 'chain', $3)`, space, tenant, plane)
	write(`insert into episodes(id, tenant_id, space_id, status, config_snapshot)
	       values ($1::text::uuid, $2::text::uuid, $3::text::uuid, 'active', jsonb_build_object('media_plane_binding', jsonb_build_object('provider', $4::text)))`, episode, tenant, space, plane)
	write(`insert into participants(id, tenant_id, space_id, episode_id, capabilities, generation, status, role)
	       values ($1::text::uuid, $2::text::uuid, $3::text::uuid, $4::text::uuid, '{subscribe}', 1, 'left', 'collaborator')`, participant, tenant, space, episode)
}

type chainRow struct {
	Service struct {
		Name string `json:"name"`
	} `json:"service"`
	Attributes map[string]any `json:"attributes"`
	Body       string         `json:"body"`
}

// chainAxiom only serves rows it received through actual ingest requests.
type chainAxiom struct {
	mu      sync.Mutex
	episode string
	rows    []chainRow
}

func (a *chainAxiom) serve(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	defer a.mu.Unlock()
	switch r.URL.Path {
	case "/v1/ingest/chain":
		var rows []chainRow
		if err := json.NewDecoder(r.Body).Decode(&rows); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		a.rows = append(a.rows, rows...)
		_ = json.NewEncoder(w).Encode(map[string]int{"ingested": len(rows), "failed": 0})
	case "/v1/datasets/_apl":
		var query struct {
			APL       string
			StartTime time.Time
			EndTime   time.Time
		}
		if err := json.NewDecoder(r.Body).Decode(&query); err != nil || !strings.Contains(query.APL, "['attributes.episode_id'] == '"+a.episode+"'") {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		// These writes reached Axiom after the event-time deadline.
		ingested := chainReceivedAt.Add(180 * time.Second)
		matches := []map[string]any{}
		if !ingested.Before(query.StartTime) && !ingested.After(query.EndTime) {
			for i, row := range a.rows {
				if row.Attributes["episode_id"] == a.episode {
					matches = append(matches, map[string]any{"_time": ingested, "_rowId": strconv.Itoa(i), "data": row})
				}
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"matches": matches})
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func verifyChainReadback(t *testing.T, databaseURL, axiomURL, scenario string) {
	t.Helper()
	path := filepath.Join("..", "..", "..", "..", "scripts", "diagnose-call", "proof", "end-wrong-screen-chain.test.mjs")
	cmd := exec.CommandContext(t.Context(), "node", "--test", "--test-name-pattern=live readback", path)
	cmd.Env = append(os.Environ(), "CHALK_DATABASE_URL="+databaseURL, "CHALK_CHAIN_AXIOM_URL="+axiomURL, "CHALK_CHAIN_SCENARIO="+scenario)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("live reader failed: %v\n%s", err, out)
	}
}
