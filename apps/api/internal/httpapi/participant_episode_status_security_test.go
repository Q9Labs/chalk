package httpapi

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
)

func TestParticipantEpisodeStatusRealCredential(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	issuedAt := time.Date(2026, 10, 28, 23, 0, 0, 0, time.UTC)
	now := issuedAt
	issuer, err := accessgrants.NewIssuer(accessgrants.IssuerConfig{Issuer: "review", KeyID: "review", PrivateKey: private, Now: func() time.Time { return issuedAt }})
	if err != nil {
		t.Fatal(err)
	}
	verifier, err := accessgrants.NewVerifier(accessgrants.VerifierConfig{Issuer: "review", VerificationKeys: map[string]ed25519.PublicKey{"review": public}, Now: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	subject := participantMediaSubject(t)
	token, err := issuer.Issue(context.Background(), subject)
	if err != nil {
		t.Fatal(err)
	}
	lookup := &participantEpisodeLookupStub{status: episodes.EpisodeStatusEnding}
	limits := DefaultRateLimitOptions()
	limits.Now = func() time.Time { return now }
	router := NewRouter(Options{Episodes: lookup, ParticipantMediaVerify: verifier, RateLimit: limits})
	path := fmt.Sprintf("/v1/tenants/%s/spaces/%s/episodes/%s/participants/%s/episode-status", subject.TenantID, subject.SpaceID, subject.EpisodeID, subject.ParticipantID)
	request := func(credential, url string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodGet, url, nil)
		if credential != "" {
			r.Header.Set("Authorization", "Bearer "+credential)
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w
	}
	for _, credential := range []string{"", "tenant-api-key", "malformed"} {
		before := lookup.calls
		if got := request(credential, path); got.Code != 401 || lookup.calls != before {
			t.Fatalf("wrong credential: status=%d lookup calls=%d", got.Code, lookup.calls-before)
		}
	}
	for i := 0; i < 2; i++ {
		got := request(token.Token, path)
		if got.Code != 200 || strings.TrimSpace(got.Body.String()) != `{"status":"ending"}` || got.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("valid/replayed credential: status=%d body=%s", got.Code, got.Body.String())
		}
	}
	foreignPath := strings.Replace(path, subject.ParticipantID.String(), "55555555-5555-4555-8555-555555555555", 1)
	before := lookup.calls
	if got := request(token.Token, foreignPath); got.Code != 403 || lookup.calls != before {
		t.Fatalf("foreign route: status=%d", got.Code)
	}
	parts := strings.Split(token.Token, ".")
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		t.Fatal(err)
	}
	sig[0] ^= 1
	parts[2] = base64.RawURLEncoding.EncodeToString(sig)
	if got := request(strings.Join(parts, "."), path); got.Code != 401 {
		t.Fatalf("tampered signature: status=%d", got.Code)
	}
	now = token.ExpiresAt.Add(accessgrants.ClockSkew + time.Second)
	if got := request(token.Token, path); got.Code != 401 {
		t.Fatalf("expired signature: status=%d", got.Code)
	}
	t.Log("expired but correctly signed credential -> 401, including for an ending Episode")
	now = issuedAt
	// Three valid requests already charged: two reads and the foreign-route 403.
	for i := 0; i < 297; i++ {
		if got := request(token.Token, path); got.Code != 200 {
			t.Fatalf("rate before limit %d: %d", i, got.Code)
		}
	}
	limited := request(token.Token, path)
	if limited.Code != 429 || limited.Header().Get("Retry-After") == "" {
		t.Fatalf("rate after limit: status=%d retry=%q", limited.Code, limited.Header().Get("Retry-After"))
	}
	t.Logf("request 301 -> 429 Retry-After=%s", limited.Header().Get("Retry-After"))
}

func TestParticipantEpisodeStatusRateLimitContract(t *testing.T) {
	contract := participantEpisodeStatusEndpoint(nil, nil).RouteContract()
	for _, problem := range contract.Errors {
		if problem.Status == http.StatusTooManyRequests {
			return
		}
	}
	t.Fatal("status route enforces 300/minute but its contract omits the real HTTP 429 response")
}
