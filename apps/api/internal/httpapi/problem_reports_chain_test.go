package httpapi

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/diagnosticuploads"
	"github.com/q9labs/chalk/apps/api/internal/obs"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/problemreports"
	"github.com/q9labs/chalk/apps/api/internal/ratelimit"
	"github.com/q9labs/chalk/apps/api/internal/telemetrydelivery"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// The slice-13 chain's hand-off directories: one per symptom under
// observability/fixtures, each hop writing what the next reads (hops.json).
var reportChainRoot = filepath.Join("..", "..", "..", "..", "observability", "fixtures")

// reportChainSubject is the seat the chain's fixtures declare.
var reportChainSubject = accessgrants.Subject{
	TenantID:              parseChainID("c1000000-0000-4000-8000-000000000001"),
	SpaceID:               parseChainID("d1000000-0000-4000-8000-000000000001"),
	EpisodeID:             parseChainID("1f8fad5b-d9cb-469f-a165-70867728950e"),
	ParticipantID:         parseChainID("a1000000-0000-4000-8000-000000000001"),
	ParticipantGeneration: 1,
	Provider:              accessgrants.ProviderCloudflareSFU,
	ConnectionID:          "pm-chain-0013",
}

// The cs_ telemetry source the reporting seat's outbox owns; the CHK code and the
// db client-session row key on it.
const reportChainSession = "00000000-0000-4000-8000-000000000042"

// reportChainAt stamps every API record and durable timestamp the chain
// writes: a fixed instant inside the fixture window so replay reproduces the
// committed rows exactly.
var reportChainAt = time.UnixMilli(1_795_599_900_000).UTC()

// reportChainIDs are the fixed ids each run's minted report, upload and live
// request take in the committed hand-offs — the same ids the sync hop and the
// SDK hop write, so the fixture's rows join across hops.
var reportChainIDs = map[string]struct{ request, report, upload string }{
	"report.cannot_send.positive":      {"f1000000-0000-4000-8000-000000000011", "b1000000-0000-4000-8000-000000000001", "d3000000-0000-4000-8000-000000000001"},
	"report.cannot_send.healthy":       {"f1000000-0000-4000-8000-000000000012", "b1000000-0000-4000-8000-000000000002", "d3000000-0000-4000-8000-000000000002"},
	"report.send_failed.positive":      {"f1000000-0000-4000-8000-000000000013", "b1000000-0000-4000-8000-000000000003", "d3000000-0000-4000-8000-000000000003"},
	"report.send_failed.healthy":       {"f1000000-0000-4000-8000-000000000014", "b1000000-0000-4000-8000-000000000004", "d3000000-0000-4000-8000-000000000004"},
	"report.forward_failed.positive":   {"f1000000-0000-4000-8000-000000000015", "b1000000-0000-4000-8000-000000000005", "d3000000-0000-4000-8000-000000000005"},
	"report.forward_failed.healthy":    {"f1000000-0000-4000-8000-000000000016", "b1000000-0000-4000-8000-000000000006", "d3000000-0000-4000-8000-000000000006"},
	"report.upload_missing.positive":   {"f1000000-0000-4000-8000-000000000017", "b1000000-0000-4000-8000-000000000007", "d3000000-0000-4000-8000-000000000007"},
	"report.upload_missing.healthy":    {"f1000000-0000-4000-8000-000000000018", "b1000000-0000-4000-8000-000000000008", "d3000000-0000-4000-8000-000000000008"},
	"live.target_unreachable.positive": {"f1000000-0000-4000-8000-000000000001", "b1000000-0000-4000-8000-000000000009", "d3000000-0000-4000-8000-000000000009"},
	"live.target_unreachable.healthy":  {"f1000000-0000-4000-8000-000000000002", "b1000000-0000-4000-8000-00000000000a", "d3000000-0000-4000-8000-00000000000a"},
	"live.no_reply.positive":           {"f1000000-0000-4000-8000-000000000003", "b1000000-0000-4000-8000-00000000000b", "d3000000-0000-4000-8000-00000000000b"},
	"live.no_reply.healthy":            {"f1000000-0000-4000-8000-000000000004", "b1000000-0000-4000-8000-00000000000c", "d3000000-0000-4000-8000-00000000000c"},
	"live.upload_missing.positive":     {"f1000000-0000-4000-8000-000000000005", "b1000000-0000-4000-8000-00000000000d", "d3000000-0000-4000-8000-00000000000d"},
	"live.upload_missing.healthy":      {"f1000000-0000-4000-8000-000000000006", "b1000000-0000-4000-8000-00000000000e", "d3000000-0000-4000-8000-00000000000e"},
}

func parseChainID(raw string) utilities.ID {
	id, err := utilities.ParseID(raw)
	if err != nil {
		panic(err)
	}
	return id
}

// captureHandler collects the API kernel's emitted records as rows, the way the
// operation log ships them to Axiom — the api kernel's half of api-rows.
type captureHandler struct {
	mu   sync.Mutex
	rows []map[string]any
}

func (h *captureHandler) Enabled(context.Context, slog.Level) bool { return true }
func (h *captureHandler) WithAttrs([]slog.Attr) slog.Handler       { return h }
func (h *captureHandler) WithGroup(string) slog.Handler            { return h }
func (h *captureHandler) Handle(_ context.Context, record slog.Record) error {
	row := map[string]any{"name": record.Message}
	record.Attrs(func(attr slog.Attr) bool {
		row[attr.Key] = attr.Value.Any()
		return true
	})
	h.mu.Lock()
	h.rows = append(h.rows, row)
	h.mu.Unlock()
	return nil
}

// reportChainSender is the Discord hop the scenario says: nil means no webhook
// (not_configured), an error is the bounded class the forward op records.
type reportChainSender struct{ err error }

func (s reportChainSender) Send(context.Context, problemreports.Delivery) error { return s.err }

// reportChainObjects is the object store the upload service presigns and
// inspects through: a bucket the test fills and reads like R2 would.
type reportChainObjects struct {
	objects map[string][]byte
}

func (s *reportChainObjects) CreateUploadURL(_ context.Context, input objectstorage.CreateUploadURLInput) (objectstorage.SignedURL, error) {
	return objectstorage.SignedURL{URL: "mem://put/" + input.Key, Method: http.MethodPut, ExpiresAt: reportChainAt.Add(120 * time.Second)}, nil
}

func (s *reportChainObjects) InspectObject(_ context.Context, key string) (objectstorage.ObjectFacts, error) {
	body, ok := s.objects[key]
	if !ok {
		return objectstorage.ObjectFacts{}, objectstorage.ErrObjectNotFound
	}
	return objectstorage.ObjectFacts{Object: objectstorage.Object{Size: int64(len(body))}}, nil
}

// chainScenario drives one run through the real routes and services. Anything
// unset is simply not called — the fault is the missing evidence, not a stub.
type chainScenario struct {
	participantStatus string                  // seat status at seed: "" means left
	sender            problemreports.Sender   // the Discord hop; nil means not_configured
	report            bool                    // POST a problem report
	reportInvalid     bool                    // the report body is blank on purpose (send_failed's refusal)
	uploadTrigger     string                  // "", "report" or "live": POST a diagnostic upload issue
	uploadComplete    bool                    // store the object and POST complete
	liveRequest       bool                    // POST /operator/diagnostics/live-requests
	availability      bool                    // GET the availability endpoint first
}

var reportChainScenarios = map[string]map[string]chainScenario{
	"report.cannot_send": {
		// A blocked dialog never sends: the availability decision is the only
		// api evidence; the seat's own surface records carry the block.
		"positive": {participantStatus: "left", availability: true},
		"healthy":  {participantStatus: "left", availability: true, sender: reportChainSender{}, report: true, uploadTrigger: "report", uploadComplete: true},
	},
	"report.send_failed": {
		"positive": {sender: reportChainSender{}, report: true, reportInvalid: true},
		"healthy":  {sender: reportChainSender{}, report: true, uploadTrigger: "report", uploadComplete: true},
	},
	"report.forward_failed": {
		"positive": {sender: reportChainSender{err: problemreports.DeliveryError{HTTPStatus: 404}}, report: true},
		"healthy":  {sender: reportChainSender{}, report: true, uploadTrigger: "report", uploadComplete: true},
	},
	"report.upload_missing": {
		"positive": {sender: reportChainSender{}, report: true, uploadTrigger: "report"}, // issued, never stored
		"healthy":  {sender: reportChainSender{}, report: true, uploadTrigger: "report", uploadComplete: true},
	},
	"live.target_unreachable": {
		"positive": {participantStatus: "active", liveRequest: true},
		"healthy":  {participantStatus: "active", liveRequest: true, uploadTrigger: "live", uploadComplete: true},
	},
	"live.no_reply": {
		"positive": {participantStatus: "active", liveRequest: true},
		"healthy":  {participantStatus: "active", liveRequest: true, uploadTrigger: "live", uploadComplete: true},
	},
	"live.upload_missing": {
		"positive": {participantStatus: "active", liveRequest: true, uploadTrigger: "live"}, // issued, never stored
		"healthy":  {participantStatus: "active", liveRequest: true, uploadTrigger: "live", uploadComplete: true},
	},
}

// TestProblemReportsChain is the chain's API hop on real Postgres: it posts the
// SDK hop's frames through /telemetry, runs the real report/upload/live-request
// routes, relays the outbox to an Axiom fake, captures the api kernel's emits,
// and snapshots the durable rows the db source reads. `-args -scenario X`
// limits it to one symptom's chain.
func TestProblemReportsChain(t *testing.T) {
	databaseURL := os.Getenv("CHALK_TELEMETRY_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set CHALK_TELEMETRY_TEST_DATABASE_URL to an isolated, migrated database")
	}
	scenarios := []string{}
	if i := slices.Index(os.Args, "-scenario"); i >= 0 && i+1 < len(os.Args) {
		scenarios = []string{os.Args[i+1]}
	} else {
		for code := range reportChainScenarios {
			scenarios = append(scenarios, code)
		}
	}
	slices.Sort(scenarios)
	pool, err := pgxpool.New(t.Context(), databaseURL)
	if err != nil {
		t.Fatal("open chain database")
	}
	defer pool.Close()
	ledger := postgres.NewTelemetryLedger(pool)
	for _, code := range scenarios {
		runs, ok := reportChainScenarios[code]
		if !ok {
			t.Fatalf("no scenario %s", code)
		}
		t.Run(code, func(t *testing.T) {
			chainDir := filepath.Join(reportChainRoot, code, "chain")
			for _, run := range []string{"positive", "healthy"} {
				t.Run(run, func(t *testing.T) {
					scenario := runs[run]
					subject := reportChainSubject
					seedReportChain(t, pool, subject, scenario.participantStatus)
					capture := &captureHandler{}
					var kernelSeq int64
					obs.Configure(obs.Config{
						Mode: obs.ModeOpen, Module: "api", Env: "test", Platform: "server", ReleaseSHA: "chain",
						Logger:  slog.New(capture),
						Clock:   func() time.Time { return reportChainAt },
						EventID: func() string { return chainEventID(&kernelSeq) },
						Seq:     func() int64 { return kernelSeq },
						Trail: func(ctx context.Context) []slog.Attr {
							s, ok := accessgrants.SubjectFromContext(ctx)
							if !ok {
								return nil
							}
							return []slog.Attr{obs.F("tenant_id", s.TenantID.String()), obs.F("episode_id", s.EpisodeID.String()), obs.F("participant_id", s.ParticipantID.String())}
						},
					})
					defer obs.Configure(obs.Config{})

					objects := &reportChainObjects{objects: map[string][]byte{}}
					router := reportChainRouter(pool, subject, scenario, objects)
					postChainClientFrames(t, chainDir, code, run, subject, ledger)
					driveChain(t, router, run, scenario, subject, objects)
					remap := pinChainRows(t, pool, subject, code, run)
					apiRows := normalizeChainRows(append(relayChainAxiom(t, ledger, subject), capture.rows...), remap)
					compareChainJSON(t, filepath.Join(chainDir, "api-rows."+code+"."+run+".json"), apiRows)
					compareChainJSON(t, filepath.Join(chainDir, "db-rows."+code+"."+run+".json"), normalizeChainRows(reportChainDBRows(t, pool, subject, objects), remap))
					report, err := telemetrydelivery.EpisodeReport(t.Context(), ledger, subject.TenantID, subject.EpisodeID)
					if err != nil {
						t.Fatal(err)
					}
					compareChainJSON(t, filepath.Join(chainDir, "ledger."+code+"."+run+".json"), normalizeChainValue(report, remap))
				})
			}
		})
	}
}

// reportChainRouter mounts only what the scenario can call, on real services:
// nil services and a nil sender make the route report honestly unavailable.
func reportChainRouter(pool *pgxpool.Pool, subject accessgrants.Subject, scenario chainScenario, objects *reportChainObjects) *chi.Mux {
	reports := problemreports.NewService(postgres.NewProblemReportRepository(pool), scenario.sender)
	uploads := diagnosticuploads.NewService(postgres.NewDiagnosticUploadRepository(pool), objects)
	verifier := subjectVerifier{subject: subject}
	router := chi.NewRouter()
	limits := RateLimitOptions{Limiter: ratelimit.NewLocalLimiter()}
	router.Route(apiPrefix, func(r chi.Router) {
		for _, endpoint := range problemReportEndpoints(reports, verifier, limits) {
			endpoint.Mount(r, limits)
		}
		for _, endpoint := range diagnosticUploadEndpoints(uploads, verifier) {
			endpoint.Mount(r, limits)
		}
	})
	router.Post("/operator/diagnostics/live-requests", handleLiveRequestPost(postgres.NewLiveIntrospectionRepository(pool), chainOperatorHash()))
	return router
}

// The operator token's hash as the config would return it: SHA-256 of the
// bearer, hex-free in memory.
const chainOperatorToken = "chain-operator-token"

func chainOperatorHash() []byte {
	sum := sha256.Sum256([]byte(chainOperatorToken))
	return sum[:]
}

// postChainClientFrames relays the SDK hop's frames through the real /telemetry
// route so the client's records settle through the ledger like production.
func postChainClientFrames(t *testing.T, chainDir, code, run string, subject accessgrants.Subject, ledger postgres.TelemetryLedger) {
	t.Helper()
	path := filepath.Join(chainDir, "client-frames."+code+"."+run+".json")
	raw, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var frames []map[string]any
	if err := json.Unmarshal(raw, &frames); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	f := newTelemetryFixtureWith(t, subject, func(*telemetrydelivery.MemoryLedger) TelemetryLedger { return pinnedReceipt{ledger} })
	for _, frame := range frames {
		body, _ := json.Marshal(frame)
		recorder := f.postWith(f.telemetryToken, "/telemetry", string(body))
		if recorder.Code != http.StatusOK {
			t.Fatalf("status = %d, body %s", recorder.Code, recorder.Body)
		}
	}
}

// driveChain runs the scenario's calls against the mounted routes.
func driveChain(t *testing.T, router *chi.Mux, run string, scenario chainScenario, subject accessgrants.Subject, objects *reportChainObjects) {
	t.Helper()
	const media = "chain-media"
	call := func(method, path string, body any, token string) *httptest.ResponseRecorder {
		var reader *bytes.Reader
		if body != nil {
			payload, _ := json.Marshal(body)
			reader = bytes.NewReader(payload)
		} else {
			reader = bytes.NewReader(nil)
		}
		request := httptest.NewRequest(method, path, reader)
		if token != "" {
			request.Header.Set("authorization", "Bearer "+token)
		}
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		return recorder
	}
	if scenario.availability {
		call(http.MethodGet, "/v1/tenants/"+subject.TenantID.String()+"/problem-reports/availability", nil, media)
	}
	var reportID string
	if scenario.report {
		description := "The chain's deterministic report"
		if scenario.reportInvalid {
			description = ""
		}
		response := call(http.MethodPost, "/v1/tenants/"+subject.TenantID.String()+"/problem-reports", map[string]any{
			"description":       description,
			"picked_symptom":    "report.forward_failed",
			"client_session_id": "cs_" + reportChainSession,
			"sdk_version":       "4.1.0",
		}, media)
		var sent struct {
			ReportID string `json:"report_id"`
		}
		_ = json.Unmarshal(response.Body.Bytes(), &sent)
		reportID = sent.ReportID
	}
	var liveRequestID string
	if scenario.liveRequest {
		response := call(http.MethodPost, "/operator/diagnostics/live-requests", map[string]any{
			"tenant_id": subject.TenantID.String(), "episode_id": subject.EpisodeID.String(), "participant_id": subject.ParticipantID.String(),
		}, chainOperatorToken)
		if response.Code != http.StatusAccepted {
			t.Fatalf("live request status = %d, body %s", response.Code, response.Body)
		}
		var created struct {
			RequestID string `json:"request_id"`
		}
		_ = json.Unmarshal(response.Body.Bytes(), &created)
		liveRequestID = created.RequestID
	}
	var uploadID, objectKey string
	if scenario.uploadTrigger != "" {
		body := map[string]any{"trigger": scenario.uploadTrigger}
		if scenario.uploadTrigger == "report" {
			body["report_id"] = reportID
		} else {
			body["live_request_id"] = liveRequestID
		}
		response := call(http.MethodPost, "/v1/tenants/"+subject.TenantID.String()+"/diagnostic-uploads", body, media)
		if response.Code >= 300 {
			t.Fatalf("issue status = %d, body %s", response.Code, response.Body)
		}
		var issued struct {
			UploadID string `json:"upload_id"`
			URL      string `json:"url"`
		}
		_ = json.Unmarshal(response.Body.Bytes(), &issued)
		uploadID = issued.UploadID
		objectKey = strings.TrimPrefix(issued.URL, "mem://put/")
	}
	if scenario.uploadComplete && uploadID != "" {
		// The client PUTs its bundle to the presigned URL before complete: the
		// gzipped diagnostics doc the SDK builds, with the identity the r2
		// readback matches on.
		objects.objects[objectKey] = chainBundle(t, subject)
		response := call(http.MethodPost, "/v1/tenants/"+subject.TenantID.String()+"/diagnostic-uploads/"+uploadID+"/complete",
			map[string]any{"bytes": int64(len(objects.objects[objectKey]))}, media)
		if response.Code >= 300 {
			t.Fatalf("complete status = %d, body %s", response.Code, response.Body)
		}
	}
}

// relayChainAxiom exports the ledger's settled outbox to an HTTP Axiom fake and
// returns the rows it received — the server-visible copy of the client's frames.
func relayChainAxiom(t *testing.T, ledger postgres.TelemetryLedger, subject accessgrants.Subject) []map[string]any {
	t.Helper()
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
	var rows []map[string]any
	for _, row := range axiom.rows {
		var fields map[string]any
		body, ok := strings.CutPrefix(row.Body, "chalk-evidence-v2:")
		if !ok || json.Unmarshal([]byte(body), &fields) != nil {
			t.Fatal("relay did not export a readable evidence body")
		}
		if fields["kind"] != nil {
			rows = append(rows, fields)
		}
	}
	return rows
}

// compareChainJSON is compareChainFile for hand-off files outside the
// end.wrong_screen chain: in write mode it rewrites, else it verifies.
func compareChainJSON(t *testing.T, path string, value any) {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	// Round-trip so a struct argument marshals with the map's sorted keys the
	// committed file has, not the struct's field order.
	var normalized any
	if err := json.Unmarshal(encoded, &normalized); err != nil {
		t.Fatal(err)
	}
	text, err := json.MarshalIndent(normalized, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	text = append(text, '\n')
	if os.Getenv("CHALK_CHAIN_WRITE") == "1" {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, text, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	var want any
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v (run the chain in order)", path, err)
	}
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	// Compare canonical JSON: Go's %v spells a large float64 like
	// est_server_ms as 1.7956e+12 while the int64 it mirrored prints digits, so
	// the committed file must round-trip through the encoder, not the printer.
	canonical, err := json.MarshalIndent(want, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	canonical = append(canonical, '\n')
	if !bytes.Equal(canonical, text) {
		t.Fatalf("%s is stale: this run wrote\n%s", path, text)
	}
}

// reportChainDBRows snapshots the durable tables into the db-source kernel rows
// the live reader emits for its db/report reads, each spanning row creation to
// this read, the way report-store.mjs shapes them. The live request's delivery
// lands later — the Sync hop writes that row, so the snapshot skips it.
func reportChainDBRows(t *testing.T, pool *pgxpool.Pool, subject accessgrants.Subject, objects *reportChainObjects) []map[string]any {
	t.Helper()
	readAt := reportChainAt.Add(1500 * time.Millisecond)
	rows := []map[string]any{}
	seq := 0
	envelope := func(name string, at time.Time, fields map[string]any) map[string]any {
		seq++
		row := map[string]any{
			"event_id":      fmt.Sprintf("13000000-0000-4000-8000-%012d", seq),
			"name":          name,
			"kind":          "fact",
			"module":        "checker",
			"env":           "test",
			"platform":      "server",
			"clock_state":   "server",
			"est_server_ms": at.UnixMilli(),
			"duration_ms":   readAt.Sub(at).Milliseconds(),
			"source_id":     "db-snapshot",
			"tenant_id":     subject.TenantID.String(),
			"episode_id":    subject.EpisodeID.String(),
		}
		for k, v := range fields {
			row[k] = v
		}
		return row
	}
	// The seat's durable status.
	var status string
	var leftAt *time.Time
	if err := pool.QueryRow(t.Context(),
		`select status, left_at from participants where tenant_id=$1 and id=$2`,
		subject.TenantID.String(), subject.ParticipantID.String()).Scan(&status, &leftAt); err != nil {
		t.Fatal(err)
	}
	fields := map[string]any{"participant_id": subject.ParticipantID.String(), "participant_status": status}
	if leftAt != nil {
		fields["seat_left_ms"] = leftAt.UnixMilli()
	}
	rows = append(rows, envelope("report.db_participant", rowCreatedAt(leftAt, readAt), fields))
	// The cs_ source row: what live.db_client_session reads of the session the
	// reporting seat's outbox owns.
	rows = append(rows, envelope("live.db_client_session", readAt, map[string]any{
		"participant_id": subject.ParticipantID.String(), "client_session_id": reportChainSession, "sdk_version": "4.1.0",
	}))
	// Stored reports.
	reportRows, err := pool.Query(t.Context(),
		`select id, journey_id, chk_code, picked_symptom, forward_outcome, sdk_version, client_session_id, created_at
		 from problem_reports where tenant_id=$1`, subject.TenantID.String())
	if err != nil {
		t.Fatal(err)
	}
	defer reportRows.Close()
	for reportRows.Next() {
		var id, chkCode, picked, forward string
		var journeyID, sdkVersion, clientSessionID *string
		var createdAt time.Time
		if err := reportRows.Scan(&id, &journeyID, &chkCode, &picked, &forward, &sdkVersion, &clientSessionID, &createdAt); err != nil {
			t.Fatal(err)
		}
		fields := map[string]any{
			"report_id": id, "chk_code": chkCode, "picked_symptom": picked,
			"forward_outcome": forward, "created_ms": createdAt.UnixMilli(),
			"participant_id": subject.ParticipantID.String(),
		}
		if journeyID != nil {
			fields["journey_id"] = *journeyID
		}
		if sdkVersion != nil {
			fields["sdk_version"] = *sdkVersion
		}
		if clientSessionID != nil {
			fields["client_session_id"] = *clientSessionID
		}
		rows = append(rows, envelope("report.db", createdAt, fields))
	}
	// Upload rows. participant_id joins the owner the way report-store.mjs does,
	// so the observation binds to the reporting seat like a live read.
	uploadRows, err := pool.Query(t.Context(),
		`select u.id, u.trigger, u.report_id, u.live_request_id, u.state, u.bytes, u.sha256, u.issued_at, u.stored_at, u.failed_at, u.expires_at, u.object_key,
		        coalesce(rp.participant_id, l.participant_id)::text
		 from diagnostic_uploads u
		 left join problem_reports rp on rp.id = u.report_id
		 left join live_introspection_requests l on l.id = u.live_request_id
		 where u.tenant_id=$1 order by u.issued_at, u.id`, subject.TenantID.String())
	if err != nil {
		t.Fatal(err)
	}
	defer uploadRows.Close()
	for uploadRows.Next() {
		var id, trigger, state, objectKey string
		var reportID, liveRequestID, sha256, participant *string
		var bytesN *int64
		var issuedAt time.Time
		var storedAt, failedAt *time.Time
		var expiresAt time.Time
		if err := uploadRows.Scan(&id, &trigger, &reportID, &liveRequestID, &state, &bytesN, &sha256, &issuedAt, &storedAt, &failedAt, &expiresAt, &objectKey, &participant); err != nil {
			t.Fatal(err)
		}
		fields := map[string]any{
			"diagnostic_upload_id": id, "upload_trigger": trigger, "upload_state": state,
			"issued_ms": issuedAt.UnixMilli(), "expires_ms": expiresAt.UnixMilli(),
		}
		if participant != nil {
			fields["participant_id"] = *participant
		}
		if reportID != nil {
			fields["report_id"] = *reportID
		}
		if liveRequestID != nil {
			fields["live_request_id"] = *liveRequestID
		}
		if storedAt != nil {
			fields["stored_ms"] = storedAt.UnixMilli()
		}
		if failedAt != nil {
			fields["failed_ms"] = failedAt.UnixMilli()
		}
		if bytesN != nil {
			fields["bytes"] = *bytesN
		}
		if sha256 != nil {
			fields["sha256"] = *sha256
		}
		rows = append(rows, envelope("report.db_upload", issuedAt, fields))
		if state == "stored" {
			// The checker's own r2 readback of the object the complete PUT
			// landed: get, gunzip, parse and identity match — the same
			// judgement stores.mjs's readbacksOf makes over a real R2.
			rows = append(rows, chainReadback(t, envelope, objects, objectKey, id, subject, storedAt))
		}
	}
	return rows
}

// chainBundle is the gzipped diagnostics doc the SDK's PUT lands in the object
// store: diagnostic_bundle 1, the state part's identity and the three parts the
// readback reports on.
func chainBundle(t *testing.T, subject accessgrants.Subject) []byte {
	t.Helper()
	doc, err := json.Marshal(map[string]any{
		"diagnostic_bundle": 1,
		"state": map[string]any{
			"episode_id":        subject.EpisodeID.String(),
			"participant_id":    subject.ParticipantID.String(),
			"client_session_id": reportChainSession,
		},
		"parts": map[string]any{
			"state":           map[string]any{"status": "observed", "bytes": 41},
			"surface_tree":    map[string]any{"status": "observed", "bytes": 42},
			"flight_recorder": map[string]any{"status": "observed", "bytes": 43},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	var buffer bytes.Buffer
	gzipWriter := gzip.NewWriter(&buffer)
	if _, err := gzipWriter.Write(doc); err != nil {
		t.Fatal(err)
	}
	if err := gzipWriter.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

// chainReadback is r2Readback's judgement over the chain's stored object: the
// claim and part lines a live read of this object would emit.
func chainReadback(t *testing.T, envelope func(string, time.Time, map[string]any) map[string]any, objects *reportChainObjects, objectKey, uploadID string, subject accessgrants.Subject, storedAt *time.Time) map[string]any {
	t.Helper()
	body, ok := objects.objects[objectKey]
	if !ok {
		return envelope("report.r2_upload", *storedAt, map[string]any{"diagnostic_upload_id": uploadID, "readback": "missing"})
	}
	doc, err := func() (map[string]any, error) {
		reader, err := gzip.NewReader(bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		var doc map[string]any
		return doc, json.NewDecoder(reader).Decode(&doc)
	}()
	if err != nil || doc["diagnostic_bundle"] != float64(1) {
		return envelope("report.r2_upload", *storedAt, map[string]any{"diagnostic_upload_id": uploadID, "readback": "parse_failed", "bytes": len(body)})
	}
	parts, _ := doc["parts"].(map[string]any)
	partStatus := func(name string) string {
		part, _ := parts[name].(map[string]any)
		if part == nil {
			return "unavailable(not_built)"
		}
		if part["status"] == "observed" {
			return fmt.Sprintf("observed(%v)", part["bytes"])
		}
		return fmt.Sprintf("unavailable(%v)", part["reason"])
	}
	fields := map[string]any{
		"diagnostic_upload_id": uploadID, "readback": "ok", "bytes": len(body),
		"state_part": partStatus("state"), "surface_tree_part": partStatus("surface_tree"), "flight_recorder_part": partStatus("flight_recorder"),
	}
	state, _ := doc["state"].(map[string]any)
	for key, want := range map[string]string{"episode_id": subject.EpisodeID.String(), "participant_id": subject.ParticipantID.String(), "client_session_id": reportChainSession} {
		if state[key] != want {
			fields["readback"] = "identity_mismatch"
			break
		}
	}
	return envelope("report.r2_upload", *storedAt, fields)
}

func rowCreatedAt(at *time.Time, fallback time.Time) time.Time {
	if at != nil {
		return *at
	}
	return fallback
}

// chainEventID mints the fixed ids the API kernel puts on chain rows: counter
// uuids so committed artifacts are byte-stable across replays.
func chainEventID(seq *int64) string {
	*seq += 1
	return fmt.Sprintf("11000000-0000-4000-8000-%012x", *seq)
}

// pinChainRows pins every volatile timestamp the run wrote to reportChainAt and
// answers the run's minted→fixed id map: report, upload and live request ids
// become the chain's f100/b100/d300 values the other hops committed.
func pinChainRows(t *testing.T, pool *pgxpool.Pool, subject accessgrants.Subject, code, run string) map[string]string {
	t.Helper()
	remap := map[string]string{}
	fixed := reportChainIDs[code+"."+run]
	at, exp := reportChainAt, reportChainAt.Add(120*time.Second)
	queries := [][2]any{
		{`update problem_reports set created_at=$2::timestamptz where tenant_id=$1`, []any{subject.TenantID.String(), at}},
		{`update diagnostic_uploads set issued_at=$2::timestamptz, expires_at=$3::timestamptz, stored_at=case when stored_at is null then null else $2::timestamptz end, failed_at=case when failed_at is null then null else $2::timestamptz end where tenant_id=$1`, []any{subject.TenantID.String(), at, exp}},
		{`update live_introspection_requests set requested_at=$2::timestamptz, expires_at=$3::timestamptz, delivered_at=case when delivered_at is null then null else $2::timestamptz end where tenant_id=$1`, []any{subject.TenantID.String(), at, exp}},
	}
	for _, query := range queries {
		if _, err := pool.Exec(t.Context(), query[0].(string), query[1].([]any)...); err != nil {
			t.Fatal(err)
		}
	}
	type binding struct{ table, column, fixed string }
	for _, binding := range []binding{
		{"problem_reports", "id", fixed.report},
		{"diagnostic_uploads", "id", fixed.upload},
		{"live_introspection_requests", "id", fixed.request},
	} {
		var minted *string
		if err := pool.QueryRow(t.Context(),
			fmt.Sprintf("select id::text from %s where tenant_id=$1 order by id limit 1", binding.table),
			subject.TenantID.String()).Scan(&minted); err != nil && minted == nil {
			continue
		}
		if minted != nil && *minted != "" {
			remap[*minted] = binding.fixed
		}
	}
	return remap
}

// chainVolatileKeys are envelope ids minted per record: each distinct value
// maps to one deterministic token, so references stay joined while replay
// compares byte-for-byte.
var chainVolatileKeys = map[string]bool{
	"event_id": true, "decision_id": true, "journey_id": true,
	"op_id": true, "operation_id": true, "trace_id": true, "span_id": true,
	"report_id": true, "diagnostic_upload_id": true, "live_request_id": true,
	"source_id": true, "session_id": true, "request_id": true, "upload_id": true,
}

// normalizeChainValue recursively swaps minted ids for the run's fixed chain
// ids and drops clock fields the committed artifact does not pin.
func normalizeChainValue(value any, remap map[string]string) any {
	switch typed := value.(type) {
	case map[string]any:
		next := map[string]any{}
		for key, entry := range typed {
			if key == "duration_ms" || key == "shown_ms" || key == "schema_ver" {
				continue
			}
			next[key] = normalizeChainValue(entry, remap)
		}
		return next
	case []any:
		next := make([]any, len(typed))
		for index, entry := range typed {
			next[index] = normalizeChainValue(entry, remap)
		}
		return next
	case string:
		if fixed, ok := remap[typed]; ok {
			return fixed
		}
		return typed
	default:
		return typed
	}
}

// normalizeChainRows applies normalizeChainValue to each row, remapping
// volatile envelope ids through first-sight stable tokens for keys the run's
// fixed ids don't already cover.
func normalizeChainRows(rows []map[string]any, remap map[string]string) []map[string]any {
	counter := 0
	volatile := map[string]string{}
	next := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		// Keys iterate sorted: the volatile tokens must assign in one order on
		// the write run and every replay run — Go's map order differs per call.
		keys := make([]string, 0, len(row))
		for key := range row {
			keys = append(keys, key)
		}
		slices.Sort(keys)
		out := map[string]any{}
		for _, key := range keys {
			value := row[key]
			if key == "duration_ms" || key == "shown_ms" || key == "schema_ver" {
				continue
			}
			if chainVolatileKeys[key] {
				if text, ok := value.(string); ok && len(text) == 36 {
					fixed, seen := volatile[text]
					if !seen {
						counter++
						if pinned, ok := remap[text]; ok {
							fixed = pinned
						} else {
							fixed = fmt.Sprintf("12000000-0000-4000-8000-%012x", counter)
						}
						volatile[text] = fixed
					}
					out[key] = fixed
					continue
				}
			}
			out[key] = normalizeChainValue(value, remap)
		}
		next = append(next, out)
	}
	return next
}

// seedReportChain is seedChainEpisode plus the seat status and the client
// session source the reporting seat's outbox owns.
func seedReportChain(t *testing.T, pool *pgxpool.Pool, subject accessgrants.Subject, participantStatus string) {
	t.Helper()
	seedChainEpisode(t, pool, subject)
	if participantStatus == "" {
		participantStatus = "left"
	}
	leftAt := "null"
	if participantStatus == "left" {
		leftAt = fmt.Sprintf("'%s'::timestamptz", reportChainAt.Add(-500*time.Millisecond).Format("2006-01-02 15:04:05.999999Z07:00"))
	}
	// The sync-entry rollout trigger guards status writes; the chain's writer
	// carries the same flag production writers set on their transactions.
	conn, err := pool.Acquire(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Release()
	if _, err := conn.Exec(t.Context(), "select set_config('chalk.entry_writer','1',false)"); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(t.Context(),
		fmt.Sprintf(`update participants set status=$1, left_at=%s where tenant_id=$2 and id=$3`, leftAt), participantStatus, subject.TenantID.String(), subject.ParticipantID.String()); err != nil {
		t.Fatal(err)
	}
}
