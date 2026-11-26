package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
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
		t.Skip("set CHALK_TELEMETRY_TEST_DATABASE_URL to a PostgreSQL database")
	}
	existing := os.Getenv("CHALK_CHAIN_EXISTING_EPISODE") == "1"
	var pool *pgxpool.Pool
	if existing {
		var err error
		pool, err = pgxpool.New(t.Context(), databaseURL)
		if err != nil {
			t.Fatal("open chain database")
		}
		defer pool.Close()
	} else {
		pool = isolatedChainDatabase(t, databaseURL)
	}
	ledger := postgres.NewTelemetryLedger(pool)
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

// isolatedChainDatabase keeps the end-to-end relay proof away from integration
// tests in other packages: relaying is intentionally global, and the shared gate
// database can contain synthetic payloads that are not production evidence rows.
