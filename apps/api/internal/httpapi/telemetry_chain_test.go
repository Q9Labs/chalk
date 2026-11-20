package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/obs"
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
		Provider:              accessgrants.ProviderCloudflareSFU,
		ConnectionID:          "pm-chain-0001",
	}
}

// chainReceivedAt is when the chain's API receives every frame: two seconds after the Episode's end, after the last record of
// either run, so the ledger hand-off is the same on every run.
var chainReceivedAt = time.UnixMilli(1_795_600_002_000).UTC()

// pinnedReceipt admits every batch as received at chainReceivedAt, the one clock the route reads that a test can't set.
type pinnedReceipt struct {
	*telemetrydelivery.MemoryLedger
}

func (l pinnedReceipt) Admit(ctx context.Context, identity telemetrydelivery.Identity, batch sdktelemetry.Request, _ time.Time) (telemetrydelivery.Admission, error) {
	return l.MemoryLedger.Admit(ctx, identity, batch, chainReceivedAt)
}

// Hop (b) of the end.wrong_screen chain: the frames the SDK outbox posted (hop a) go to the real telemetry route with a real
// credential and the memory ledger, and the rows it logs are compared with the committed rows that hop (d) judges. Each row is
// a kernel record in the registry row shape: every field the client sent arrives under the same name with the same value, and
// every other field is a registry field. The ledger's report of the Episode, the telemetry-watermarks output the live reader
// reads, is the hop's second hand-off. CHALK_CHAIN_WRITE=1 rewrites both.
func TestTelemetryChainEndWrongScreen(t *testing.T) {
	for _, run := range []string{"positive", "healthy"} {
		t.Run(run, func(t *testing.T) {
			var frames []map[string]any
			readChainFile(t, "client-frames."+run+".json", &frames)
			subject := chainSubject(t)
			f := newTelemetryFixtureWith(t, subject, func(ledger *telemetrydelivery.MemoryLedger) TelemetryLedger { return pinnedReceipt{ledger} })
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
			rows := recordRows(t, f.logs.Bytes())
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
			report, err := telemetrydelivery.EpisodeReport(t.Context(), f.ledger, subject.TenantID, subject.EpisodeID)
			if err != nil {
				t.Fatal(err)
			}
			compareChainFile(t, "ledger."+run+".json", report)
		})
	}
}

// recordRows are the logged rows of kernel records without the logger's own fields: the log time, which changes between runs, and
// the level and the message, which is the record's name. What is left is the record, so every field must be a registry field.
func recordRows(t *testing.T, logs []byte) []map[string]any {
	t.Helper()
	var rows []map[string]any
	for _, raw := range bytes.Split(bytes.TrimSpace(logs), []byte("\n")) {
		var row map[string]any
		if json.Unmarshal(raw, &row) != nil || row["kind"] == nil {
			continue
		}
		if row["msg"] != row["name"] || row["level"] != "INFO" {
			t.Fatalf("row %v is logged as %v at %v, want its name at INFO", row["name"], row["msg"], row["level"])
		}
		delete(row, "time")
		delete(row, "msg")
		delete(row, "level")
		rows = append(rows, row)
	}
	return rows
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
