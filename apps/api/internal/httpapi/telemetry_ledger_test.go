package httpapi

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/ratelimit"
	"github.com/q9labs/chalk/apps/api/internal/sdktelemetry"
	"github.com/q9labs/chalk/apps/api/internal/telemetrydelivery"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const (
	ledgerSource     = "0b7c0000-0000-4000-8000-00000000000a"
	ledgerReload     = "0b7c0000-0000-4000-8000-00000000000b"
	ledgerBatch      = "5d1e0000-0000-4000-8000-000000000001"
	ledgerOtherBatch = "5d1e0000-0000-4000-8000-000000000002"
	ledgerRoute      = "/telemetry"
)

func ledgerEvent(seq int64) string {
	return fmt.Sprintf(`{"event_id":"9a4f0000-0000-4000-8000-%012d","seq":%d,"elapsed_ms":1,"type":"call_ended","end_reason":"left"}`, seq, seq)
}

func ledgerBody(source, batch string, nextSeq int64, events ...string) string {
	return fmt.Sprintf(`{"version":2,"source_id":%q,"batch_id":%q,"next_seq":%d,"events":[%s]}`, source, batch, nextSeq, strings.Join(events, ","))
}

type ledgerAnswer struct {
	Accepted   int                      `json:"accepted"`
	Rejected   int                      `json:"rejected"`
	Duplicates int                      `json:"duplicates"`
	Acks       []sdktelemetry.SeqRange  `json:"acks"`
	Rejections []sdktelemetry.Rejection `json:"rejections"`
}

func (f telemetryFixture) answer(t *testing.T, token, body string) ledgerAnswer {
	t.Helper()
	recorder := f.postWith(token, ledgerRoute, body)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", recorder.Code, recorder.Body.String())
	}
	var answer ledgerAnswer
	if err := json.Unmarshal(recorder.Body.Bytes(), &answer); err != nil {
		t.Fatal(err)
	}
	return answer
}

func (f telemetryFixture) sinkRows(t *testing.T) int {
	t.Helper()
	return len(f.rows(t, "sdk.telemetry"))
}

func mustLedgerID(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func ranges(pairs ...int64) []sdktelemetry.SeqRange {
	out := []sdktelemetry.SeqRange{}
	for index := 0; index < len(pairs); index += 2 {
		out = append(out, sdktelemetry.SeqRange{From: pairs[index], To: pairs[index+1]})
	}
	return out
}

func TestTelemetryV2AnswersARetryOfTheSameBatchWithDuplicatesAndWritesNoSinkRows(t *testing.T) {
	f := newTelemetryFixture(t)
	body := ledgerBody(ledgerSource, ledgerBatch, 3, ledgerEvent(0), ledgerEvent(1), ledgerEvent(2))
	first := f.answer(t, f.telemetryToken, body)
	if want := (ledgerAnswer{Accepted: 3, Acks: ranges(0, 3), Rejections: []sdktelemetry.Rejection{}}); !reflect.DeepEqual(first, want) {
		t.Fatalf("first answer = %+v, want %+v", first, want)
	}
	retry := f.answer(t, f.telemetryToken, body)
	if want := (ledgerAnswer{Duplicates: 3, Acks: ranges(0, 3), Rejections: []sdktelemetry.Rejection{}}); !reflect.DeepEqual(retry, want) {
		t.Fatalf("retry answer = %+v, want %+v: every record was settled before, so none is new and all are acked", retry, want)
	}
	if rows := f.sinkRows(t); rows != 3 {
		t.Fatalf("sink rows = %d, want 3: the retry must not write them again", rows)
	}
}

func TestTelemetryV2PartialOverlapWritesOnlyTheNewRecords(t *testing.T) {
	f := newTelemetryFixture(t)
	f.answer(t, f.telemetryToken, ledgerBody(ledgerSource, ledgerBatch, 2, ledgerEvent(0), ledgerEvent(1)))
	overlap := f.answer(t, f.telemetryToken, ledgerBody(ledgerSource, ledgerOtherBatch, 4, ledgerEvent(1), ledgerEvent(2), ledgerEvent(3)))
	if want := (ledgerAnswer{Accepted: 2, Duplicates: 1, Acks: ranges(1, 4), Rejections: []sdktelemetry.Rejection{}}); !reflect.DeepEqual(overlap, want) {
		t.Fatalf("overlap answer = %+v, want %+v", overlap, want)
	}
	if rows := f.sinkRows(t); rows != 4 {
		t.Fatalf("sink rows = %d, want 4 (seqs 0 to 3 once each)", rows)
	}
}

func TestTelemetryV2RejectedRecordsAreSettledAndNamedOnce(t *testing.T) {
	f := newTelemetryFixture(t)
	bad := `{"event_id":"9a4f0000-0000-4000-8000-000000000001","seq":1,"elapsed_ms":1,"type":"recovery_attempt","mechanism":"ice_restart","outage_ms":4000,"free_text":"hello"}`
	body := ledgerBody(ledgerSource, ledgerBatch, 2, ledgerEvent(0), bad)
	first := f.answer(t, f.telemetryToken, body)
	if first.Accepted != 1 || first.Rejected != 1 || !reflect.DeepEqual(first.Acks, ranges(0, 2)) || len(first.Rejections) != 1 || first.Rejections[0].Seq != 1 {
		t.Fatalf("first answer = %+v, want one accepted, seq 1 rejected, both acked", first)
	}
	retry := f.answer(t, f.telemetryToken, body)
	if retry.Duplicates != 2 || retry.Accepted != 0 || retry.Rejected != 0 || !reflect.DeepEqual(retry.Acks, ranges(0, 2)) {
		t.Fatalf("retry answer = %+v, want two duplicates and both seqs acked", retry)
	}
	if strings.Contains(f.logs.String(), "hello") {
		t.Fatalf("free text reached the log:\n%s", f.logs.String())
	}
}

// A reload is a new source, so its seq 0 is new even though the old source stored its own seq 0.
func TestTelemetryV2DedupesBySourceAcrossAReload(t *testing.T) {
	f := newTelemetryFixture(t)
	f.answer(t, f.telemetryToken, ledgerBody(ledgerSource, ledgerBatch, 1, ledgerEvent(0)))
	reloaded := f.answer(t, f.telemetryToken, ledgerBody(ledgerReload, ledgerBatch, 1, ledgerEvent(0)))
	if reloaded.Accepted != 1 || reloaded.Duplicates != 0 || !reflect.DeepEqual(reloaded.Acks, ranges(0, 1)) {
		t.Fatalf("reloaded source answer = %+v, want its seq 0 stored as new", reloaded)
	}
	if rows := f.sinkRows(t); rows != 2 {
		t.Fatalf("sink rows = %d, want 2", rows)
	}
}

func TestTelemetryV2PredecessorDropRecordNamesTheLostSeqsOfTheOldSource(t *testing.T) {
	f := newTelemetryFixture(t)
	drop := fmt.Sprintf(`{"event_id":"9a4f0000-0000-4000-8000-%012d","seq":0,"elapsed_ms":1,"type":"telemetry_dropped","dropped":4,"drop_reason":"queue_full","dropped_seqs":[{"from":6,"to":10}],"dropped_source_id":%q}`, 0, ledgerSource)
	if answer := f.answer(t, f.telemetryToken, ledgerBody(ledgerReload, ledgerBatch, 1, drop)); answer.Accepted != 1 {
		t.Fatalf("answer = %+v, want the drop record accepted", answer)
	}
	rows, err := f.ledger.Source(t.Context(), f.subject.TenantID, mustLedgerID(t, ledgerSource))
	if err != nil || len(rows) != 1 {
		t.Fatalf("predecessor rows = %v, %v, want one", rows, err)
	}
	if want := telemetrydelivery.NewSet(sdktelemetry.SeqRange{From: 6, To: 10}); !reflect.DeepEqual(rows[0].Ranges.Dropped["queue_full"], want) {
		t.Fatalf("predecessor dropped = %v, want %v", rows[0].Ranges.Dropped, want)
	}
	gaps, _ := telemetrydelivery.Gaps(rows)
	var named bool
	for _, gap := range gaps {
		named = named || (gap.Cause == telemetrydelivery.GapDropped && gap.DropReason == "queue_full" && gap.FromSeq == 6 && gap.ToSeq != nil && *gap.ToSeq == 10)
	}
	if !named {
		t.Fatalf("gaps = %+v, want [6,10) named as dropped for queue_full", gaps)
	}
}

func TestTelemetryV2LedgerFailureIs503WithRetryAfterAndAcksNothing(t *testing.T) {
	f := newTelemetryFixture(t)
	body := ledgerBody(ledgerSource, ledgerBatch, 2, ledgerEvent(0), ledgerEvent(1))
	f.ledger.Fail = errors.New("database is down")
	recorder := f.postWith(f.telemetryToken, ledgerRoute, body)
	if recorder.Code != http.StatusServiceUnavailable || recorder.Header().Get("Retry-After") == "" {
		t.Fatalf("status = %d, Retry-After = %q, want 503 with a Retry-After", recorder.Code, recorder.Header().Get("Retry-After"))
	}
	if strings.Contains(recorder.Body.String(), "acks") || strings.Contains(recorder.Body.String(), "database is down") {
		t.Fatalf("503 body = %s, want no acks and no cause", recorder.Body.String())
	}
	if rows := f.sinkRows(t); rows != 0 {
		t.Fatalf("sink rows = %d, want none when the ledger failed first", rows)
	}
	if failures := f.rows(t, "sdk.telemetry.ledger_failed"); len(failures) != 1 {
		t.Fatalf("ledger failure rows = %d, want 1\n%s", len(failures), f.logs.String())
	}
	if strings.Contains(f.logs.String(), f.telemetryToken) {
		t.Fatal("the token reached the log")
	}

	f.ledger.Fail = nil
	if retry := f.answer(t, f.telemetryToken, body); retry.Accepted != 2 || retry.Duplicates != 0 || !reflect.DeepEqual(retry.Acks, ranges(0, 2)) {
		t.Fatalf("retry after the outage = %+v, want both records accepted as new", retry)
	}
}

// A crash between the sink write and the commit acks nothing; the retry finds the records new and
// writes them again with the same event ids.
func TestTelemetryV2CrashAfterTheSinkWriteAcksNothingAndTheRetryWritesAgain(t *testing.T) {
	f := newTelemetryFixture(t)
	body := ledgerBody(ledgerSource, ledgerBatch, 2, ledgerEvent(0), ledgerEvent(1))
	f.ledger.CrashAfterSink = errors.New("crash")
	if code := f.postWith(f.telemetryToken, ledgerRoute, body).Code; code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", code)
	}
	f.ledger.CrashAfterSink = nil
	if retry := f.answer(t, f.telemetryToken, body); retry.Accepted != 2 || retry.Duplicates != 0 {
		t.Fatalf("retry = %+v, want both records new", retry)
	}
}

func TestTelemetryV2RangeCapIsAMalformedBatchWithReasonLedgerFull(t *testing.T) {
	f := newTelemetryFixture(t)
	// Every other seq is stored, so each is its own range.
	next := int64(0)
	var refused *httptest.ResponseRecorder
	for batch := 0; batch < 45 && refused == nil; batch++ {
		events := make([]string, 0, sdktelemetry.EventLimit)
		for range sdktelemetry.EventLimit {
			events = append(events, ledgerEvent(next))
			next += 2
		}
		recorder := f.postWith(f.telemetryToken, ledgerRoute, ledgerBody(ledgerSource, fmt.Sprintf("5d1e0000-0000-4000-8000-%012d", batch+10), next, events...))
		if recorder.Code != http.StatusOK {
			refused = recorder
		}
	}
	if refused == nil || refused.Code != http.StatusBadRequest {
		t.Fatalf("no batch was refused with 400 after %d ranges", next/2)
	}
	if rows := f.rows(t, "sdk.telemetry.rejected"); len(rows) != 1 || rows[0]["reason"] != "ledger_full" {
		t.Fatalf("rejection rows = %v, want one with reason ledger_full", rows)
	}
}

func TestTelemetryV1IsUnchangedAndNeverTouchesTheLedger(t *testing.T) {
	f := newTelemetryFixture(t)
	f.ledger.Fail = errors.New("database is down")
	body := `{"version":1,"client_session_id":"` + telemetrySession + `","events":[{"type":"call_ended","seq":0,"elapsed_ms":1,"end_reason":"left"}]}`
	recorder := f.post(ledgerRoute, body)
	if recorder.Code != http.StatusOK || strings.TrimSpace(recorder.Body.String()) != `{"accepted":1,"rejected":0,"duplicates":0,"acks":[],"rejections":[]}` {
		t.Fatalf("response = %d %s, want the version 1 answer with no acks", recorder.Code, recorder.Body.String())
	}
}

func TestTelemetryRouteAcceptsTheTelemetryTokenAndTheMediaCredentialOnly(t *testing.T) {
	f := newTelemetryFixture(t)
	body := ledgerBody(ledgerSource, ledgerBatch, 1, ledgerEvent(0))
	for name, token := range map[string]string{"telemetry token": f.telemetryToken, "media credential": f.mediaToken} {
		if code := f.postWith(token, ledgerRoute, body).Code; code != http.StatusOK {
			t.Errorf("%s: status = %d, want 200", name, code)
		}
	}
	if code := f.postWith("not-a-token", ledgerRoute, body).Code; code != http.StatusUnauthorized {
		t.Errorf("junk token: status = %d, want 401", code)
	}
	request := httptest.NewRequest(http.MethodPost, f.path+ledgerRoute, strings.NewReader(body))
	recorder := httptest.NewRecorder()
	f.router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusUnauthorized {
		t.Errorf("no credential: status = %d, want 401", recorder.Code)
	}
}

func TestTelemetryTokenIsRefusedByEveryOtherParticipantRoute(t *testing.T) {
	f := newTelemetryFixture(t)
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	issuer, err := accessgrants.NewIssuer(accessgrants.IssuerConfig{Issuer: "chalk", KeyID: "key", PrivateKey: private, Now: func() time.Time { return time.Now() }})
	if err != nil {
		t.Fatal(err)
	}
	verifier, err := accessgrants.NewVerifier(accessgrants.VerifierConfig{Issuer: "chalk", VerificationKeys: map[string]ed25519.PublicKey{"key": public}})
	if err != nil {
		t.Fatal(err)
	}
	telemetry, err := issuer.IssueTelemetry(t.Context(), f.subject)
	if err != nil {
		t.Fatal(err)
	}
	media, err := issuer.Issue(t.Context(), f.subject)
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	callStatsEndpoint(verifier).Mount(router, RateLimitOptions{Limiter: ratelimit.NewLocalLimiter()})
	post := func(token string) int {
		request := httptest.NewRequest(http.MethodPost, f.path+"/call-stats", strings.NewReader(`{"version":1,"samples":[]}`))
		request.Header.Set("Authorization", "Bearer "+token)
		request.Header.Set("Content-Type", "application/json")
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		return recorder.Code
	}
	if code := post(telemetry.Token); code != http.StatusUnauthorized {
		t.Errorf("telemetry token on call-stats: status = %d, want 401", code)
	}
	if code := post(media.Token); code == http.StatusUnauthorized {
		t.Errorf("media credential on call-stats: status = %d, want it accepted", code)
	}
}

func TestTelemetryRefusesATokenOfAnotherTenant(t *testing.T) {
	f := newTelemetryFixture(t)
	other := f
	other.path = "/tenants/" + strings.Replace(f.subject.TenantID.String(), "1", "9", -1)
	if code := other.postWith(f.telemetryToken, ledgerRoute, ledgerBody(ledgerSource, ledgerBatch, 1, ledgerEvent(0))).Code; code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 for a tenant the token does not name", code)
	}
}

// Every source a batch names can create a ledger row, so each one costs the budget on top of the bytes.
func TestTelemetryChargePricesEachPredecessorABatchNames(t *testing.T) {
	drop := func(predecessor string) string {
		return fmt.Sprintf(`{"event_id":"9a4f0000-0000-4000-8000-%012d","seq":0,"elapsed_ms":1,"type":"telemetry_dropped","dropped":1,"drop_reason":"queue_full","dropped_seqs":[{"from":6,"to":7}],"dropped_source_id":%q}`, 0, predecessor)
	}
	for _, test := range []struct {
		name         string
		body         string
		predecessors int
	}{
		{"its own source alone", ledgerBody(ledgerSource, ledgerBatch, 1, ledgerEvent(0)), 0},
		{"a predecessor it names", ledgerBody(ledgerSource, ledgerBatch, 1, drop(ledgerReload)), 1},
		{"its own source named again", ledgerBody(ledgerSource, ledgerBatch, 1, drop(ledgerSource)), 0},
		{"a source id that is not an id", ledgerBody("nope", ledgerBatch, 1, ledgerEvent(0)), 0},
	} {
		t.Run(test.name, func(t *testing.T) {
			batch, frame := sdktelemetry.Decode(strings.NewReader(test.body))
			request := telemetryRequest{Batch: batch, Frame: frame, Bytes: len(test.body)}
			policy, _ := telemetryCharge(request)
			if want := len(test.body) + telemetrySourceCost*test.predecessors; policy.Cost != want {
				t.Errorf("cost = %d (frame %q), want %d", policy.Cost, frame, want)
			}
		})
	}
}
