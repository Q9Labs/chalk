package httpapi

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
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
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/obs"
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
// db client-session row key on it. Its uuid part is the SDK fault tests' own
// client_session_id, so a report's stored row and the client's records name the
// same session.
const reportChainSession = "00000000-0000-4000-8000-000000000004"

// reportChainAt stamps every API record and durable timestamp the chain
// writes: a fixed instant inside the fixture window so replay reproduces the
// committed rows exactly.
var reportChainAt = time.UnixMilli(1_795_599_900_000).UTC()

// reportChainIDs are the fixed ids each run's minted report, upload and live
// request take in the committed hand-offs — the same ids the sync hop and the
// SDK hop write, so the fixture's rows join across hops.
// reportChainClientJourney is the journey the SDK fault test's send/dialog
// records name for each symptom, sent as the report body's journey_id so the
// API's submit/outcome rows share the client's journey.
var reportChainClientJourney = map[string]string{
	"report.cannot_send":    "00000000-0000-4000-8000-000000000101",
	"report.send_failed":    "00000000-0000-4000-8000-000000000102",
	"report.upload_missing": "00000000-0000-4000-8000-000000000104",
}

// reportChainClientIDs maps the fixed ids the SDK fault tests mint, to each
// run's chain ids — the frames predate the API's mints, so the remap joins them.
var reportChainClientIDs = map[string]struct{ report, upload, request string }{
	"report.send_failed.healthy":     {report: "00000000-0000-4000-8000-000000000103"},
	"report.upload_missing.positive": {report: "00000000-0000-4000-8000-000000000105", upload: "00000000-0000-4000-8000-000000000106"},
	"report.upload_missing.healthy":  {report: "00000000-0000-4000-8000-000000000105", upload: "00000000-0000-4000-8000-000000000106"},
	"live.no_reply.healthy":          {request: "00000000-0000-4000-8000-000000000110", upload: "00000000-0000-4000-8000-000000000111"},
	"live.upload_missing.positive":   {request: "00000000-0000-4000-8000-000000000112", upload: "00000000-0000-4000-8000-000000000113"},
	"live.upload_missing.healthy":    {request: "00000000-0000-4000-8000-000000000112", upload: "00000000-0000-4000-8000-000000000113"},
}

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
	participantStatus  string                // seat status at seed: "" means left
	sender             problemreports.Sender // the Discord hop; nil means not_configured
	report             bool                  // POST a problem report
	priorReport        bool                  // POST an accepted report first (an earlier report lives beside the fault)
	reportInvalid      bool                  // the report body is blank on purpose (send_failed's refusal)
	uploadTrigger      string                // "", "report" or "live": POST a diagnostic upload issue
	uploadComplete     bool                  // store the object and POST complete
	liveRequest        bool                  // POST /operator/diagnostics/live-requests
	liveUploadStored   bool                  // the live request's upload issues and stores (live_request_id, stored fields)
	priorLiveFlow      bool                  // a first live request that delivers, then issues+stores its upload
	storedReportUpload bool                  // an accepted report whose upload issues and stores (report_id, stored fields)
	seatLeftRequest    bool                  // a live request made after the seat left (seat_left_ms, unavailable_reason)
	failedUpload       bool                  // a second report whose upload completes with no object (failed)
	refusedIssue       bool                  // a second report-trigger issue the API refuses (reason_code)
	availability       bool                  // GET the availability endpoint first
}

var reportChainScenarios = map[string]map[string]chainScenario{
	"report.cannot_send": {
		// A blocked dialog never sends: the availability decision is the only
		// api evidence; the seat's own surface records carry the block.
		"positive": {participantStatus: "left", availability: true},
		"healthy":  {participantStatus: "left", availability: true, sender: reportChainSender{}, report: true, uploadTrigger: "report", uploadComplete: true},
	},
	"report.send_failed": {
		"positive": {sender: reportChainSender{}, priorReport: true, report: true, reportInvalid: true},
		"healthy":  {sender: reportChainSender{}, report: true, uploadTrigger: "report", uploadComplete: true},
	},
	"report.forward_failed": {
		"positive": {sender: reportChainSender{err: problemreports.DeliveryError{HTTPStatus: 404}}, report: true},
		"healthy":  {sender: reportChainSender{}, report: true, uploadTrigger: "report", uploadComplete: true},
	},
	"report.upload_missing": {
		// The report upload stays issued-never-stored; alongside it a live
		// upload stores, a second report's upload fails, and a duplicate issue
		// is refused — a real episode's other uploads around the missing one.
		"positive": {sender: reportChainSender{}, report: true, uploadTrigger: "report", refusedIssue: true, liveRequest: true, liveUploadStored: true, failedUpload: true},
		"healthy":  {sender: reportChainSender{}, report: true, uploadTrigger: "report", uploadComplete: true},
	},
	"live.target_unreachable": {
		"positive": {participantStatus: "active", liveRequest: true, seatLeftRequest: true},
		"healthy":  {participantStatus: "active", liveRequest: true, uploadTrigger: "live", uploadComplete: true},
	},
	"live.no_reply": {
		// A first request's full flow sits beside the stalled second one: the
		// client received and acked it, and its upload issued and stored. The
		// report side's refused and failed uploads run in the same episode.
		"positive": {participantStatus: "active", priorLiveFlow: true, liveRequest: true, seatLeftRequest: true, sender: reportChainSender{}, storedReportUpload: true, refusedIssue: true, failedUpload: true},
		"healthy":  {participantStatus: "active", liveRequest: true, uploadTrigger: "live", uploadComplete: true},
	},
	"live.upload_missing": {
		// The live upload stays issued-never-stored; around it a first request's
		// flow, a report's full upload lifecycle, a failed upload and a
		// seat-left request all ran in the same episode.
		"positive": {participantStatus: "active", priorLiveFlow: true, liveRequest: true, uploadTrigger: "live", sender: reportChainSender{}, storedReportUpload: true, refusedIssue: true, failedUpload: true, seatLeftRequest: true},
		"healthy":  {participantStatus: "active", liveRequest: true, uploadTrigger: "live", uploadComplete: true},
	},
}

// TestProblemReportsChain is the chain's API hop on real Postgres: it posts the
// SDK hop's frames through /telemetry, runs the real report/upload/live-request
// routes, relays the outbox to an Axiom fake, captures the api kernel's emits,
// and snapshots the durable rows the db source reads. `-args -scenario X`
// limits it to one symptom's chain.
// chainScenarioFlag carries hops.json's `-args -scenario <code>` into the
// test binary: a real flag, because the test runner rejects undefined ones.
var chainScenarioFlag = flag.String("scenario", "", "one symptom's chain to run")

func TestProblemReportsChain(t *testing.T) {
	databaseURL := os.Getenv("CHALK_TELEMETRY_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set CHALK_TELEMETRY_TEST_DATABASE_URL to an isolated, migrated database")
	}
	scenarios := []string{}
	if *chainScenarioFlag != "" {
		scenarios = []string{*chainScenarioFlag}
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
					order := driveChain(t, router, pool, code, run, scenario, subject, objects)
					remap := pinChainRows(t, pool, subject, code, run, scenario, order)
					apiRows := normalizeChainRows(append(relayChainAxiom(t, ledger, subject), capture.rows...), remap)
					compareChainJSON(t, filepath.Join(chainDir, "api-rows."+code+"."+run+".json"), apiRows)
					compareChainJSON(t, filepath.Join(chainDir, "db-rows."+code+"."+run+".json"), normalizeChainRows(reportChainDBRows(t, pool, subject, objects, order), remap))
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

// chainMintOrder is the order the drive minted each stored report and issued
// upload: the db snapshot sorts by it, since ctid order shifts once the pin
// update rewrites every row.
type chainMintOrder struct {
	reports  []string
	uploads  []string
	requests []string
}

// driveChain runs the scenario's calls against the mounted routes.
func driveChain(t *testing.T, router *chi.Mux, pool *pgxpool.Pool, code, run string, scenario chainScenario, subject accessgrants.Subject, objects *reportChainObjects) chainMintOrder {
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
	// The service's boot-time config emit, as main.go makes it: one record per
	// run saying whether the forward webhook is wired.
	obs.Fact(context.Background(), "problem_reports.config", obs.F("forwarding", scenario.sender != nil))
	if scenario.availability {
		call(http.MethodGet, "/v1/tenants/"+subject.TenantID.String()+"/problem-reports/availability", nil, media)
	}
	var order chainMintOrder
	postReport := func(description, journeyID string) (string, *httptest.ResponseRecorder) {
		body := map[string]any{
			"description":       description,
			"picked_symptom":    "report.forward_failed",
			"client_session_id": "cs_" + reportChainSession,
			"sdk_version":       "4.1.0",
		}
		if journeyID != "" {
			body["journey_id"] = journeyID
		}
		response := call(http.MethodPost, "/v1/tenants/"+subject.TenantID.String()+"/problem-reports", body, media)
		var sent struct {
			ReportID string `json:"report_id"`
		}
		_ = json.Unmarshal(response.Body.Bytes(), &sent)
		if sent.ReportID != "" {
			order.reports = append(order.reports, sent.ReportID)
		}
		return sent.ReportID, response
	}
	var reportID string
	if scenario.priorReport {
		reportID, _ = postReport("The chain's earlier accepted report", "")
	}
	if scenario.report {
		description := "The chain's deterministic report"
		if scenario.reportInvalid {
			description = ""
		}
		// The report under test shares the SDK fault test's journey, so the
		// client's send op and the API's submit/outcome rows name one journey.
		reportID, _ = postReport(description, reportChainClientJourney[code])
	}
	liveRequest := func() string {
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
		order.requests = append(order.requests, created.RequestID)
		return created.RequestID
	}
	issueUpload := func(trigger, reportID, liveRequestID string) (string, string) {
		body := map[string]any{"trigger": trigger}
		if trigger == "report" {
			body["report_id"] = reportID
		} else {
			body["live_request_id"] = liveRequestID
		}
		response := call(http.MethodPost, "/v1/tenants/"+subject.TenantID.String()+"/diagnostic-uploads", body, media)
		if response.Code >= 300 {
			return "", ""
		}
		var issued struct {
			UploadID string `json:"upload_id"`
			URL      string `json:"url"`
		}
		_ = json.Unmarshal(response.Body.Bytes(), &issued)
		order.uploads = append(order.uploads, issued.UploadID)
		return issued.UploadID, strings.TrimPrefix(issued.URL, "mem://put/")
	}
	completeUpload := func(uploadID, objectKey string, store bool) {
		if store {
			// The client PUTs its bundle to the presigned URL before complete:
			// the gzipped diagnostics doc the SDK builds, with the identity the
			// r2 readback matches on.
			objects.objects[objectKey] = chainBundle(t, subject)
		}
		body := map[string]any{"bytes": int64(len(objects.objects[objectKey]))}
		if store {
			sum := sha256.Sum256(objects.objects[objectKey])
			body["sha256"] = hex.EncodeToString(sum[:])
		}
		call(http.MethodPost, "/v1/tenants/"+subject.TenantID.String()+"/diagnostic-uploads/"+uploadID+"/complete", body, media)
	}
	var liveRequestID string
	if scenario.priorLiveFlow {
		// An earlier request's whole flow sits beside the fault run: Sync's own
		// hop proved the fault request's delivery, so the api hop writes the
		// delivered(1) mark the delivery path writes, then its upload runs.
		first := liveRequest()
		// The delivery path's mark, then its upload runs; the request expires
		// only after its upload completes, so issue is not refused as expired —
		// and the one-pending-per-seat rule lets the fault request post next.
		if _, err := pool.Exec(t.Context(), `update live_introspection_requests set delivery='delivered(1)', delivered_at=$2 where id=$1`, first, reportChainAt); err != nil {
			t.Fatal(err)
		}
		id, key := issueUpload("live", "", first)
		if id == "" {
			t.Fatal("prior live issue refused")
		}
		completeUpload(id, key, true)
		if _, err := pool.Exec(t.Context(), `update live_introspection_requests set expires_at='2001-01-01' where id=$1`, first); err != nil {
			t.Fatal(err)
		}
	}
	if scenario.liveRequest {
		liveRequestID = liveRequest()
	}
	var uploadID, objectKey string
	if scenario.uploadTrigger != "" {
		uploadID, objectKey = issueUpload(scenario.uploadTrigger, reportID, liveRequestID)
		if uploadID == "" {
			t.Fatal("issue refused")
		}
	}
	storedReport := ""
	if scenario.storedReportUpload {
		storedReport, _ = postReport("The chain's uploaded report", "")
		if storedReport == "" {
			t.Fatal("uploaded report refused")
		}
		id, key := issueUpload("report", storedReport, "")
		if id == "" {
			t.Fatal("report issue refused")
		}
		completeUpload(id, key, true)
	}
	if scenario.refusedIssue {
		// The one-upload-per-report rule refuses the duplicate with a reason.
		target := reportID
		if target == "" {
			target = storedReport
		}
		if id, _ := issueUpload("report", target, ""); id != "" {
			t.Fatal("duplicate issue accepted")
		}
	}
	if scenario.liveUploadStored {
		id, key := issueUpload("live", "", liveRequestID)
		if id == "" {
			t.Fatal("live issue refused")
		}
		completeUpload(id, key, true)
	}
	if scenario.failedUpload {
		// A second accepted report carries its own upload; the client completes
		// without ever PUTting the object: object_missing marks it failed.
		second, _ := postReport("The chain's second accepted report", "")
		if second == "" {
			t.Fatal("second report refused")
		}
		id, key := issueUpload("report", second, "")
		if id == "" {
			t.Fatal("failed-upload issue refused")
		}
		completeUpload(id, key, false)
	}
	if scenario.uploadComplete && uploadID != "" {
		completeUpload(uploadID, objectKey, true)
	}
	if scenario.seatLeftRequest {
		// A request made once the seat has already left carries the seat's own
		// left stamp: the seat_left_ms/unavailable_reason evidence's source.
		// The still-open fault request expires first so this one may post.
		if _, err := pool.Exec(t.Context(), `update live_introspection_requests set expires_at='2001-01-01' where tenant_id=$1`, subject.TenantID.String()); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(t.Context(), `update participants set status='left', left_at=$2 where id=$1`, subject.ParticipantID.String(), reportChainAt); err != nil {
			t.Fatal(err)
		}
		liveRequest()
	}
	return order
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
func reportChainDBRows(t *testing.T, pool *pgxpool.Pool, subject accessgrants.Subject, objects *reportChainObjects, order chainMintOrder) []map[string]any {
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
		 from problem_reports where tenant_id=$1 order by array_position($2::uuid[], id)`, subject.TenantID.String(), order.reports)
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
		 where u.tenant_id=$1 order by array_position($2::uuid[], u.id)`, subject.TenantID.String(), order.uploads)
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

func firstOrEmpty(ids []string) string {
	if len(ids) == 0 {
		return ""
	}
	return ids[0]
}

func firstOrNil(id *string) string {
	if id == nil {
		return ""
	}
	return *id
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
func pinChainRows(t *testing.T, pool *pgxpool.Pool, subject accessgrants.Subject, code, run string, scenario chainScenario, order chainMintOrder) map[string]string {
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
	// Each run's fixed id goes on one row the drive minted, in the drive's mint
	// order — ctid order shifts once the pin update above rewrites each row.
	// The fault request is the first request this hop's store never delivered:
	// the prior flow's request carries the delivery mark its update wrote.
	var faultRequest *string
	if err := pool.QueryRow(t.Context(),
		`select id::text from live_introspection_requests where tenant_id=$1 and delivered_at is null order by array_position($2::uuid[], id) nulls last limit 1`,
		subject.TenantID.String(), order.requests).Scan(&faultRequest); err != nil {
		faultRequest = nil
	}
	uploadFor := ""
	switch scenario.uploadTrigger {
	case "report":
		if len(order.reports) > 0 {
			_ = pool.QueryRow(t.Context(), `select id::text from diagnostic_uploads where report_id=$1`, order.reports[0]).Scan(&uploadFor)
		}
	case "live":
		if faultRequest != nil {
			_ = pool.QueryRow(t.Context(), `select id::text from diagnostic_uploads where live_request_id=$1`, *faultRequest).Scan(&uploadFor)
		}
	default:
		if len(order.uploads) > 0 {
			uploadFor = order.uploads[0]
		}
	}
	for _, pair := range [][2]string{
		{fixed.report, firstOrEmpty(order.reports)},
		{fixed.upload, uploadFor},
		{fixed.request, firstOrNil(faultRequest)},
	} {
		if pair[1] != "" {
			remap[pair[1]] = pair[0]
		}
	}
	if client, ok := reportChainClientIDs[code+"."+run]; ok {
		for _, pair := range [][2]string{{client.report, fixed.report}, {client.upload, fixed.upload}, {client.request, fixed.request}} {
			if pair[0] != "" {
				remap[pair[0]] = pair[1]
			}
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
			if key == "schema_ver" {
				continue
			}
			if (key == "duration_ms" || key == "shown_ms") && row["source_id"] != "db-snapshot" && row["module"] == "api" {
				// Only the api kernel's own timing is volatile; client and db
				// rows carry deterministic values the fixture must keep so the
				// gate sees each witness field on a real row.
				out[key] = int64(17)
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
