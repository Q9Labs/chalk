package httpapi

import (
	"crypto/ed25519"
	"crypto/rand"
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
)

// A participant of the tenant that knows another client's source_id cannot add claims to it: the
// batch is refused whole with 400 and the reason source_owned, so the SDK drops it as refused and
// never retries it, and the owner's ledger is unchanged.
func TestTelemetryV2BatchOnASourceOfAnotherParticipantIsRefusedWithReasonSourceOwned(t *testing.T) {
	f := newTelemetryFixture(t)
	if answer := f.answer(t, f.telemetryToken, ledgerBody(ledgerSource, ledgerBatch, 4, ledgerEvent(0))); answer.Accepted != 1 {
		t.Fatalf("answer = %+v, want the owner's record accepted", answer)
	}
	before, _, _ := f.ledger.Source(t.Context(), f.subject.TenantID, mustLedgerID(t, ledgerSource))

	hostile := f.subject
	hostile.ParticipantID = mustLedgerID(t, "55555555-5555-4555-8555-555555555555")
	f.ledger.Join(telemetryIdentity(hostile))
	token, err := f.issuer.IssueTelemetry(t.Context(), hostile)
	if err != nil {
		t.Fatal(err)
	}
	body := fmt.Sprintf(`{"version":2,"source_id":%q,"batch_id":%q,"next_seq":4,"end":"closed","events":[%s]}`, ledgerSource, ledgerOtherBatch, strings.Join([]string{ledgerEvent(1), ledgerEvent(2), ledgerEvent(3)}, ","))
	recorder := f.postWith(token.Token, ledgerRoute, body)
	if recorder.Code != http.StatusBadRequest || strings.Contains(recorder.Body.String(), "acks") {
		t.Fatalf("status = %d, body = %s, want 400 with no acks", recorder.Code, recorder.Body.String())
	}
	if rows := f.rows(t, "sdk.telemetry.rejected"); len(rows) != 1 || rows[0]["reason"] != "source_owned" || rows[0]["source_id"] != ledgerSource {
		t.Fatalf("rejection rows = %v, want one with reason source_owned naming the source", rows)
	}
	if rows := f.sinkRows(t); rows != 1 {
		t.Fatalf("sink rows = %d, want only the owner's record", rows)
	}
	if after, _, _ := f.ledger.Source(t.Context(), f.subject.TenantID, mustLedgerID(t, ledgerSource)); !reflect.DeepEqual(after, before) {
		t.Fatalf("owner row = %+v, want it unchanged: %+v", after, before)
	}
}

// A still-valid credential of a purged tenant, or of a participant whose row is gone, is refused
// with 403 and the reason participant_gone, and no ledger row is made again.
func TestTelemetryV2BatchOfAParticipantThatIsNotLiveIsRefusedWithReasonParticipantGone(t *testing.T) {
	f := newTelemetryFixture(t)
	f.ledger.Purge(f.subject.TenantID)
	recorder := f.postWith(f.telemetryToken, ledgerRoute, ledgerBody(ledgerSource, ledgerBatch, 1, ledgerEvent(0)))
	if recorder.Code != http.StatusForbidden || strings.Contains(recorder.Body.String(), "acks") {
		t.Fatalf("status = %d, body = %s, want 403 with no acks", recorder.Code, recorder.Body.String())
	}
	if rows := f.rows(t, "sdk.telemetry.rejected"); len(rows) != 1 || rows[0]["reason"] != "participant_gone" {
		t.Fatalf("rejection rows = %v, want one with reason participant_gone", rows)
	}
	if _, found, _ := f.ledger.Source(t.Context(), f.subject.TenantID, mustLedgerID(t, ledgerSource)); found || f.sinkRows(t) != 0 {
		t.Fatal("a batch of a purged tenant made a row")
	}
}

// Version 1 has no ledger, but it has the same fence: a still-valid credential of a purged tenant,
// or of a participant whose row is gone, logs nothing and is refused with participant_gone.
func TestTelemetryV1BatchOfAParticipantThatIsNotLiveIsRefusedWithReasonParticipantGone(t *testing.T) {
	f := newTelemetryFixture(t)
	f.ledger.Purge(f.subject.TenantID)
	for name, token := range map[string]string{"telemetry token": f.telemetryToken, "media credential": f.mediaToken} {
		if recorder := f.postWith(token, ledgerRoute, ledgerV1Body); recorder.Code != http.StatusForbidden {
			t.Errorf("%s: status = %d, body = %s, want 403", name, recorder.Code, recorder.Body.String())
		}
	}
	if rows := f.rows(t, "sdk.telemetry"); len(rows) != 0 {
		t.Fatalf("a version 1 batch of a purged tenant logged %d rows, want none", len(rows))
	}
	if rows := f.rows(t, "sdk.telemetry.rejected"); len(rows) != 2 || rows[0]["reason"] != "participant_gone" {
		t.Fatalf("rejection rows = %v, want two with reason participant_gone", rows)
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
