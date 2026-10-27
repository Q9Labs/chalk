package httpapi

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/chatattachments"
	"github.com/q9labs/chalk/apps/api/internal/synctokens"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestChatAttachmentCORSUsesVerifiedParticipantTenant(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := synctokens.NewService(synctokens.Config{Issuer: "chat-cors", Audience: "chalk-sync", KeyID: "test", PrivateKey: private})
	if err != nil {
		t.Fatal(err)
	}
	verifier, err := synctokens.NewVerifier(synctokens.VerifierConfig{Issuer: "chat-cors", Audience: "chalk-sync", VerificationKeys: map[string]ed25519.PublicKey{"test": public}})
	if err != nil {
		t.Fatal(err)
	}
	first, err := utilities.ParseID(corsTestTenantID)
	if err != nil {
		t.Fatal(err)
	}
	second, err := utilities.ParseID("22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatal(err)
	}
	issue := func(tenant utilities.ID) string {
		token, err := signer.Issue(context.Background(), synctokens.Input{TenantID: tenant, SpaceID: first, EpisodeID: first, ParticipantID: first, ParticipantGeneration: 1, AdmissionLifecycleIntentID: first, DisplayName: "CORS proof", Role: "collaborator", Capabilities: []string{"sendChat"}})
		if err != nil {
			t.Fatal(err)
		}
		return token.Value
	}
	origins := &corsTestTenantAuthorizer{allowed: map[string]map[string]bool{first.String(): {"https://portal.example": true, "http://localhost:3001": true}, second.String(): {"https://other.example": true}}}
	options := CORSOptions{TenantOrigins: origins, ChatParticipants: chatattachments.NewParticipantVerifier(verifier)}
	paths := []string{"/v1/chat/attachments/uploads", "/v1/chat/attachments/uploads/11111111-1111-4111-8111-111111111111/finalize", "/v1/chat/attachments/11111111-1111-4111-8111-111111111111/download"}
	firstToken, secondToken := issue(first), issue(second)
	for _, path := range paths {
		t.Run(path, func(t *testing.T) {
			for _, test := range []struct {
				name, origin, token string
				allowed             bool
			}{
				{"tenant portal", "https://portal.example", firstToken, true},
				{"localhost", "http://localhost:3001", firstToken, true},
				{"wrong port", "http://localhost:3002", firstToken, false},
				{"other tenant", "https://portal.example", secondToken, false},
				{"unknown origin", "https://unknown.example", firstToken, false},
				{"no credential", "https://portal.example", "", false},
				{"invalid credential", "https://portal.example", "not-a-token", false},
			} {
				t.Run(test.name, func(t *testing.T) {
					request := httptest.NewRequest(http.MethodPost, path+"?tenant_id="+first.String(), nil)
					request.Header.Set("Origin", test.origin)
					if test.token != "" {
						request.Header.Set("Authorization", "Bearer "+test.token)
					}
					response := httptest.NewRecorder()
					next := requireChatParticipant(options.ChatParticipants)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))
					allowCORS(options, DefaultRateLimitOptions())(next).ServeHTTP(response, request)
					if got := response.Header().Get("Access-Control-Allow-Origin"); (got == test.origin) != test.allowed {
						t.Fatalf("CORS origin = %q, allowed=%v", got, test.allowed)
					}
					if test.allowed && response.Code != http.StatusNoContent {
						t.Fatalf("status=%d", response.Code)
					}
					if !test.allowed && (test.token == "" || test.token == "not-a-token") && response.Code != http.StatusUnauthorized {
						t.Fatalf("unauthenticated status=%d", response.Code)
					}
				})
			}
			preflight := executeCORSRequest(t, options, http.MethodOptions, path, "https://unknown.example")
			if preflight.Code != http.StatusNoContent || preflight.Header().Get("Access-Control-Allow-Origin") != "https://unknown.example" || preflight.Header().Get("Access-Control-Max-Age") != "60" {
				t.Fatalf("preflight=%d %v", preflight.Code, preflight.Header())
			}
		})
	}
	// Revocation is checked on actual responses even when a browser cached preflight.
	delete(origins.allowed[first.String()], "https://portal.example")
	request := httptest.NewRequest(http.MethodPost, paths[0], nil)
	request.Header.Set("Origin", "https://portal.example")
	request.Header.Set("Authorization", "Bearer "+firstToken)
	response := httptest.NewRecorder()
	allowCORS(options, DefaultRateLimitOptions())(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })).ServeHTTP(response, request)
	if response.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("revoked origin still readable")
	}
	origins.err = errors.New("policy unavailable")
	response = httptest.NewRecorder()
	allowCORS(options, DefaultRateLimitOptions())(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Fatal("policy outage reached handler") })).ServeHTTP(response, request)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("policy outage=%d", response.Code)
	}
}

func TestChatCORSDoesNotOpenOtherUnscopedEndpoints(t *testing.T) {
	options := CORSOptions{ChatParticipants: chatattachments.NewParticipantVerifier(nil), TenantOrigins: &corsTestTenantAuthorizer{}}
	for _, path := range []string{"/v1/regions", "/v1/public/spaces", "/v1/chat/attachments-other"} {
		response := executeCORSRequest(t, options, http.MethodOptions, path, "https://portal.example")
		if response.Code != http.StatusForbidden {
			t.Fatalf("%s status=%d", path, response.Code)
		}
	}
}

func TestChatCORSRouterWiresParticipantVerifier(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := synctokens.NewService(synctokens.Config{Issuer: "chat-cors", Audience: "chalk-sync", KeyID: "test", PrivateKey: private})
	if err != nil {
		t.Fatal(err)
	}
	verifier, err := synctokens.NewVerifier(synctokens.VerifierConfig{Issuer: "chat-cors", Audience: "chalk-sync", VerificationKeys: map[string]ed25519.PublicKey{"test": public}})
	if err != nil {
		t.Fatal(err)
	}
	id, err := utilities.ParseID(corsTestTenantID)
	if err != nil {
		t.Fatal(err)
	}
	token, err := signer.Issue(context.Background(), synctokens.Input{TenantID: id, SpaceID: id, EpisodeID: id, ParticipantID: id, ParticipantGeneration: 1, AdmissionLifecycleIntentID: id, DisplayName: "CORS proof", Role: "collaborator", Capabilities: []string{"sendChat"}})
	if err != nil {
		t.Fatal(err)
	}
	origins := &corsTestTenantAuthorizer{allowed: map[string]map[string]bool{corsTestTenantID: {"https://portal.example": true}}}
	router := NewRouter(Options{CORS: CORSOptions{TenantOrigins: origins}, ChatParticipants: chatattachments.NewParticipantVerifier(verifier), RateLimit: DefaultRateLimitOptions()})
	request := httptest.NewRequest(http.MethodGet, "/v1/chat/attachments/11111111-1111-4111-8111-111111111111/download", nil)
	request.Header.Set("Origin", "https://portal.example")
	request.Header.Set("Authorization", "Bearer "+token.Value)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusServiceUnavailable || response.Header().Get("Access-Control-Allow-Origin") != "https://portal.example" {
		t.Fatalf("router status=%d CORS=%q", response.Code, response.Header().Get("Access-Control-Allow-Origin"))
	}
}
