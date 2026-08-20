package httpapi

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/episodediagnostics"
)

func TestProductionHostedDiagnosticsLoadsIssuesVerifiesAndServesParticipantRequest(t *testing.T) {
	setProductionHostedDiagnosticsEnvironment(t, "true")
	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("load production hosted diagnostics config: %v", err)
	}

	environment := episodediagnostics.Environment(cfg.EpisodeDiagnostics.Environment)
	participantIssuer, err := accessgrants.NewDiagnosticsIssuer(accessgrants.DiagnosticsIssuerConfig{
		Issuer: cfg.SyncToken.Issuer, KeyID: cfg.SyncToken.KeyID, PrivateKey: cfg.SyncToken.PrivateKey, Environment: string(environment),
	})
	if err != nil {
		t.Fatalf("configure participant issuer: %v", err)
	}
	participantVerifier, err := accessgrants.NewDiagnosticsVerifier(accessgrants.DiagnosticsVerifierConfig{
		Issuer: cfg.SyncToken.Issuer, VerificationKeys: cfg.SyncToken.VerificationKeys, Environment: string(environment),
	})
	if err != nil {
		t.Fatalf("configure participant verifier: %v", err)
	}
	serviceIssuer, err := accessgrants.NewDiagnosticsServiceIssuer(accessgrants.DiagnosticsServiceIssuerConfig{
		Issuer: cfg.EpisodeDiagnostics.ServiceToken.Issuer, KeyID: cfg.EpisodeDiagnostics.ServiceToken.KeyID,
		PrivateKey: cfg.EpisodeDiagnostics.ServiceToken.PrivateKey, Environment: string(environment),
	})
	if err != nil {
		t.Fatalf("configure service issuer: %v", err)
	}
	serviceVerifier, err := accessgrants.NewDiagnosticsServiceVerifier(accessgrants.DiagnosticsServiceVerifierConfig{
		Issuer: cfg.EpisodeDiagnostics.ServiceToken.Issuer, VerificationKeys: cfg.EpisodeDiagnostics.ServiceToken.VerificationKeys, Environment: string(environment),
	})
	if err != nil {
		t.Fatalf("configure service verifier: %v", err)
	}
	operatorVerifier, err := accessgrants.NewDiagnosticsOperatorVerifier(accessgrants.DiagnosticsOperatorVerifierConfig{
		Issuer: cfg.EpisodeDiagnostics.OperatorIssuer, Audience: cfg.EpisodeDiagnostics.OperatorAudience,
		JWKS: cfg.EpisodeDiagnostics.OperatorJWKS, Environment: string(environment),
	})
	if err != nil {
		t.Fatalf("configure operator verifier: %v", err)
	}

	tenantID := mustDiagnosticID(t, "11111111-1111-4111-8111-111111111111")
	spaceID := mustDiagnosticID(t, "22222222-2222-4222-8222-222222222222")
	episodeID := mustDiagnosticID(t, "33333333-3333-4333-8333-333333333333")
	participantID := mustDiagnosticID(t, "44444444-4444-4444-8444-444444444444")
	subject := accessgrants.DiagnosticsSubject{
		TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID, ParticipantID: participantID,
		ParticipantGeneration: 7, Capability: accessgrants.DiagnosticsCapability, Environment: string(environment),
	}
	participantCredential, err := participantIssuer.Issue(context.Background(), subject)
	if err != nil {
		t.Fatalf("issue production participant credential: %v", err)
	}
	verifiedSubject, err := participantVerifier.Verify(context.Background(), participantCredential.Token)
	if err != nil || verifiedSubject != subject {
		t.Fatalf("verify production participant credential = %#v, %v; want %#v", verifiedSubject, err, subject)
	}

	serviceSubject, err := accessgrants.NewDiagnosticsServicePrincipal(accessgrants.DiagnosticsServiceSourceSync, "sync", "sync-production-1", 4, string(environment))
	if err != nil {
		t.Fatalf("configure production service principal: %v", err)
	}
	serviceCredential, err := serviceIssuer.Issue(context.Background(), serviceSubject)
	if err != nil {
		t.Fatalf("issue production service credential: %v", err)
	}
	verifiedServiceSubject, err := serviceVerifier.Verify(context.Background(), serviceCredential.Token)
	if err != nil || verifiedServiceSubject != serviceSubject {
		t.Fatalf("verify production service credential = %#v, %v; want %#v", verifiedServiceSubject, err, serviceSubject)
	}

	service := &episodeDiagnosticsHTTPServiceStub{}
	handler := NewRouter(Options{EpisodeDiagnostics: EpisodeDiagnosticsHTTPOptions{
		Mode: cfg.EpisodeDiagnostics.Mode, Environment: environment, Service: service,
		ParticipantVerifier: participantVerifier, ServiceVerifier: serviceVerifier, OperatorVerifier: operatorVerifier,
	}})
	body := `{"version":1,"producer":{"id":"sdk","instanceId":"browser-1","generation":7},"events":[{"version":1,"eventId":"event_1","producerSequence":1,"occurredAt":"2026-08-04T00:00:00Z","source":"sdk","name":"participant.join","phase":"started","state":"started"}]}`
	request := httptest.NewRequest(http.MethodPost, "/_internal/episode-diagnostic-events", strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer "+participantCredential.Token)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || service.appendPrincipal.ParticipantID != participantID || service.appendPrincipal.Environment != environment {
		t.Fatalf("production request status = %d, body = %s, principal = %#v", response.Code, response.Body.String(), service.appendPrincipal)
	}
}

func TestProductionHostedDiagnosticsStillRequiresOptInBeforeCredentialWiring(t *testing.T) {
	setProductionHostedDiagnosticsEnvironment(t, "")
	if _, err := config.Load(); err == nil || !strings.Contains(err.Error(), config.EpisodeDiagnosticsProductionOptIn) {
		t.Fatalf("load error = %v, want production opt-in rejection", err)
	}
}

func setProductionHostedDiagnosticsEnvironment(t *testing.T, optIn string) {
	t.Helper()
	t.Setenv(config.APIEnvironment, "production")
	t.Setenv(config.DatabaseURL, "postgres://db.internal/chalk?sslmode=verify-full")
	t.Setenv(config.AuthRecentAuthSecret, strings.Repeat("r", 32))
	t.Setenv(config.IntegrationsEnabled, "false")
	t.Setenv(config.TranscriptionEnabled, "false")
	t.Setenv(config.CloudflareRealtimeAppID, "sfu-app")
	t.Setenv(config.CloudflareRealtimeAppSecret, "sfu-secret")
	t.Setenv(config.ProviderBridgeAddress, "127.0.0.1:8443")
	t.Setenv(config.ProviderBridgeServerCertFile, "/tmp/chalk-server.crt")
	t.Setenv(config.ProviderBridgeServerKeyFile, "/tmp/chalk-server.key")
	t.Setenv(config.ProviderBridgeClientCAFile, "/tmp/chalk-client-ca.crt")
	t.Setenv(config.ProviderBridgeSPIFFETrustDomain, "chalk.test")
	t.Setenv(config.WebhookEncryptionKey, base64.StdEncoding.EncodeToString([]byte(strings.Repeat("k", 32))))
	t.Setenv(config.OpsIngestToken, strings.Repeat("o", 32))
	t.Setenv(config.EpisodeDiagnosticsMode, config.EpisodeDiagnosticsModeHosted)
	t.Setenv(config.EpisodeDiagnosticsHMACKey, strings.Repeat("h", 32))
	t.Setenv(config.EpisodeDiagnosticsProductionOptIn, optIn)

	publicInvitePublicKey, publicInvitePrivateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv(config.PublicInviteManagedTenantID, "11111111-1111-4111-8111-111111111111")
	t.Setenv(config.PublicInviteDefaultMediaPlane, "cf_rtk")
	t.Setenv(config.PublicInviteWebOrigin, "https://app.chalk.test")
	t.Setenv(config.PublicInviteKeyID, "public-1")
	t.Setenv(config.PublicInvitePrivateKey, base64.RawURLEncoding.EncodeToString(publicInvitePrivateKey))
	t.Setenv(config.PublicInviteVerificationKeys, `{"public-1":"`+base64.RawURLEncoding.EncodeToString(publicInvitePublicKey)+`"}`)

	operatorPublicKey, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv(config.EpisodeDiagnosticsOperatorIssuer, "https://identity.chalk.test")
	t.Setenv(config.EpisodeDiagnosticsOperatorAudience, "chalk-diagnostics-operator")
	operatorJWKS, err := json.Marshal(map[string]any{"keys": []map[string]any{{"kty": "OKP", "crv": "Ed25519", "alg": "EdDSA", "use": "sig", "kid": "operator-1", "x": base64.RawURLEncoding.EncodeToString(operatorPublicKey)}}})
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv(config.EpisodeDiagnosticsOperatorJWKS, string(operatorJWKS))

	_, servicePrivateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv(config.EpisodeDiagnosticsServiceIssuer, "https://diagnostics.chalk.test")
	t.Setenv(config.EpisodeDiagnosticsServiceKeyID, "diagnostics-1")
	t.Setenv(config.EpisodeDiagnosticsServicePrivateKey, base64.RawURLEncoding.EncodeToString(servicePrivateKey))

	_, syncPrivateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv(config.SyncTokenAudience, "chalk-sync")
	t.Setenv(config.SyncTokenIssuer, "https://api.chalk.test")
	t.Setenv(config.SyncTokenKeyID, "sync-1")
	t.Setenv(config.SyncTokenPrivateKey, base64.RawURLEncoding.EncodeToString(syncPrivateKey))
}
