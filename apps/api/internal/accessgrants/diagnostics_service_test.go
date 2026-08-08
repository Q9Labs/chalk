package accessgrants_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const diagnosticsServiceTestIssuer = "chalk-api"

var diagnosticsServiceTestNow = time.Date(2026, 8, 4, 12, 0, 0, 0, time.UTC)

func TestDiagnosticsServiceVerifierBindsPurposeAndProducerIdentity(t *testing.T) {
	fixture := newDiagnosticsServiceFixture(t, "development")
	token := mintDiagnosticsServiceToken(t, fixture.privateKey, validDiagnosticsServiceClaims("development"))

	subject, err := fixture.verifier.Verify(context.Background(), token)
	if err != nil {
		t.Fatalf("verify diagnostics service credential: %v", err)
	}
	want := accessgrants.DiagnosticsServiceSubject{
		Source:      accessgrants.DiagnosticsServiceSourceProvider,
		Service:     "recording-provider",
		InstanceID:  "provider-instance-01",
		Generation:  7,
		Capability:  accessgrants.DiagnosticsServiceCapabilityAppend,
		Environment: "development",
	}
	if subject != want {
		t.Fatalf("subject = %#v, want %#v", subject, want)
	}
}

func TestDiagnosticsServiceVerifierRequiresExactAudienceAndClosedSource(t *testing.T) {
	fixture := newDiagnosticsServiceFixture(t, "development")
	baseClaims := validDiagnosticsServiceClaims("development")
	tests := []struct {
		name  string
		field string
		value any
		want  error
	}{
		{name: "participant audience", field: "aud", value: "chalk-diagnostics", want: accessgrants.ErrInvalidDiagnosticsServiceAudience},
		{name: "audience array", field: "aud", value: []string{accessgrants.DiagnosticsServiceAudience}, want: accessgrants.ErrInvalidDiagnosticsServiceAudience},
		{name: "sync source with different service", field: "source", value: "sync", want: accessgrants.ErrInvalidDiagnosticsServiceIdentity},
		{name: "ui source", field: "source", value: "ui", want: accessgrants.ErrInvalidDiagnosticsServiceSource},
		{name: "wrong capability", field: "capability", value: "read", want: accessgrants.ErrInvalidDiagnosticsServiceCapability},
		{name: "wrong environment", field: "environment", value: "staging", want: accessgrants.ErrInvalidDiagnosticsServiceEnvironment},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			claims := cloneDiagnosticsServiceClaims(baseClaims)
			claims[test.field] = test.value
			token := mintDiagnosticsServiceToken(t, fixture.privateKey, claims)
			if _, err := fixture.verifier.Verify(context.Background(), token); !errors.Is(err, test.want) {
				t.Fatalf("error = %v, want %v", err, test.want)
			}
		})
	}
}

func TestDiagnosticsServiceIssuerRoundTripsDistinctHostedPrincipals(t *testing.T) {
	fixture := newDiagnosticsServiceFixture(t, "development")
	for _, source := range []accessgrants.DiagnosticsServiceSource{
		accessgrants.DiagnosticsServiceSourceAPI,
		accessgrants.DiagnosticsServiceSourceProvider,
		accessgrants.DiagnosticsServiceSourceWorker,
		accessgrants.DiagnosticsServiceSourceSync,
	} {
		t.Run(string(source), func(t *testing.T) {
			service := "chalk-" + string(source)
			if source == accessgrants.DiagnosticsServiceSourceSync {
				service = "sync"
			}
			subject, err := accessgrants.NewDiagnosticsServicePrincipal(source, service, string(source)+"-instance-01", 3, "development")
			if err != nil {
				t.Fatal(err)
			}
			credential, err := fixture.issuer.Issue(context.Background(), subject)
			if err != nil {
				t.Fatalf("issue: %v", err)
			}
			if credential.Source != source || credential.InstanceID != subject.InstanceID || credential.Generation != subject.Generation || credential.IntakePath != accessgrants.DiagnosticsIntakePath || !credential.ExpiresAt.Equal(diagnosticsServiceTestNow.Add(accessgrants.DiagnosticsServiceLifetime)) {
				t.Fatalf("credential metadata = %#v", credential)
			}
			verified, err := fixture.verifier.Verify(context.Background(), credential.Token)
			if err != nil || verified != subject {
				t.Fatalf("verified subject = %#v, err=%v, want %#v", verified, err, subject)
			}
		})
	}
}

func TestDiagnosticsServiceVerifierRejectsCredentialBoundsAndTimeFailures(t *testing.T) {
	fixture := newDiagnosticsServiceFixture(t, "staging")
	baseClaims := validDiagnosticsServiceClaims("staging")
	tests := []struct {
		name   string
		change func(map[string]any)
		want   error
	}{
		{name: "identity too long", change: func(claims map[string]any) { claims["sub"] = strings.Repeat("s", 129) }, want: accessgrants.ErrInvalidDiagnosticsServiceIdentity},
		{name: "instance has whitespace", change: func(claims map[string]any) { claims["instance_id"] = "provider instance" }, want: accessgrants.ErrInvalidDiagnosticsServiceInstance},
		{name: "generation zero", change: func(claims map[string]any) { claims["generation"] = 0 }, want: accessgrants.ErrInvalidDiagnosticsServiceGeneration},
		{name: "generation unbounded", change: func(claims map[string]any) { claims["generation"] = int64(1<<31) + 1 }, want: accessgrants.ErrInvalidDiagnosticsServiceGeneration},
		{name: "expired", change: func(claims map[string]any) {
			claims["iat"], claims["nbf"], claims["exp"] = diagnosticsServiceTestNow.Unix()-301, diagnosticsServiceTestNow.Unix()-301, diagnosticsServiceTestNow.Unix()-31
		}, want: accessgrants.ErrExpiredDiagnosticsServiceCredential},
		{name: "future", change: func(claims map[string]any) {
			claims["iat"], claims["nbf"], claims["exp"] = diagnosticsServiceTestNow.Unix()+31, diagnosticsServiceTestNow.Unix()+31, diagnosticsServiceTestNow.Unix()+331
		}, want: accessgrants.ErrDiagnosticsServiceNotYetValid},
		{name: "lifetime exceeded", change: func(claims map[string]any) { claims["exp"] = diagnosticsServiceTestNow.Unix() + 301 }, want: accessgrants.ErrDiagnosticsServiceLifetimeExceeded},
		{name: "nbf precedes iat", change: func(claims map[string]any) { claims["nbf"] = diagnosticsServiceTestNow.Unix() - 1 }, want: accessgrants.ErrInvalidDiagnosticsServiceTimeClaims},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			claims := cloneDiagnosticsServiceClaims(baseClaims)
			test.change(claims)
			token := mintDiagnosticsServiceToken(t, fixture.privateKey, claims)
			if _, err := fixture.verifier.Verify(context.Background(), token); !errors.Is(err, test.want) {
				t.Fatalf("error = %v, want %v", err, test.want)
			}
		})
	}
}

func TestDiagnosticsServiceVerifierRejectsSyncParticipantCredential(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	issuer, err := accessgrants.NewIssuer(accessgrants.IssuerConfig{
		Issuer: diagnosticsServiceTestIssuer, KeyID: "sync-key", PrivateKey: privateKey, Now: func() time.Time { return diagnosticsServiceTestNow },
	})
	if err != nil {
		t.Fatal(err)
	}
	tenantID, spaceID, episodeID, participantID := testServiceIDs(t)
	credential, err := issuer.Issue(context.Background(), accessgrants.Subject{
		TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID, ParticipantID: participantID,
		ParticipantGeneration: 1, Provider: accessgrants.ProviderCloudflareSFU, CloudflareConnectionID: "connection",
	})
	if err != nil {
		t.Fatal(err)
	}
	verifier, err := accessgrants.NewDiagnosticsServiceVerifier(accessgrants.DiagnosticsServiceVerifierConfig{
		Issuer: diagnosticsServiceTestIssuer, VerificationKeys: map[string]ed25519.PublicKey{"sync-key": publicKey}, Environment: "development", Now: func() time.Time { return diagnosticsServiceTestNow },
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := verifier.Verify(context.Background(), credential.Token); err == nil {
		t.Fatal("participant media credential was accepted as a diagnostics service credential")
	}
}

func TestDiagnosticsServiceVerifierRejectsSameKeySyncAudience(t *testing.T) {
	fixture := newDiagnosticsServiceFixture(t, "development")
	claims := validDiagnosticsServiceClaims("development")
	claims["aud"] = "chalk-sync"
	token := mintDiagnosticsServiceToken(t, fixture.privateKey, claims)
	if _, err := fixture.verifier.Verify(context.Background(), token); !errors.Is(err, accessgrants.ErrInvalidDiagnosticsServiceAudience) {
		t.Fatalf("same-key Sync audience error = %v, want %v", err, accessgrants.ErrInvalidDiagnosticsServiceAudience)
	}
}

func TestNewDiagnosticsAPIPrincipalBindsSource(t *testing.T) {
	subject, err := accessgrants.NewDiagnosticsAPIPrincipal("api", "api-instance-01", 3, "localhost")
	if err != nil {
		t.Fatalf("new API diagnostics principal: %v", err)
	}
	if subject.Source != accessgrants.DiagnosticsServiceSourceAPI || subject.Service != "api" || subject.InstanceID != "api-instance-01" || subject.Generation != 3 || subject.Capability != accessgrants.DiagnosticsServiceCapabilityAppend || subject.Environment != "localhost" {
		t.Fatalf("API principal = %#v", subject)
	}

	for _, test := range []struct {
		name        string
		service     string
		instanceID  string
		generation  int64
		environment string
	}{
		{name: "empty service", service: "", instanceID: "api-instance", generation: 1, environment: "localhost"},
		{name: "empty instance", service: "api", instanceID: "", generation: 1, environment: "localhost"},
		{name: "invalid generation", service: "api", instanceID: "api-instance", generation: 0, environment: "localhost"},
		{name: "invalid environment", service: "api", instanceID: "api-instance", generation: 1, environment: "preview"},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := accessgrants.NewDiagnosticsAPIPrincipal(test.service, test.instanceID, test.generation, test.environment); err == nil {
				t.Fatal("expected invalid API principal")
			}
		})
	}
}

type diagnosticsServiceFixture struct {
	verifier   accessgrants.DiagnosticsServiceVerifier
	issuer     accessgrants.DiagnosticsServiceIssuer
	privateKey ed25519.PrivateKey
}

func newDiagnosticsServiceFixture(t *testing.T, environment string) diagnosticsServiceFixture {
	t.Helper()
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	verifier, err := accessgrants.NewDiagnosticsServiceVerifier(accessgrants.DiagnosticsServiceVerifierConfig{
		Issuer: diagnosticsServiceTestIssuer, VerificationKeys: map[string]ed25519.PublicKey{"service-key": publicKey}, Environment: environment, Now: func() time.Time { return diagnosticsServiceTestNow },
	})
	if err != nil {
		t.Fatal(err)
	}
	issuer, err := accessgrants.NewDiagnosticsServiceIssuer(accessgrants.DiagnosticsServiceIssuerConfig{
		Issuer: diagnosticsServiceTestIssuer, KeyID: "service-key", PrivateKey: privateKey, Environment: environment, Now: func() time.Time { return diagnosticsServiceTestNow },
	})
	if err != nil {
		t.Fatal(err)
	}
	return diagnosticsServiceFixture{verifier: verifier, issuer: issuer, privateKey: privateKey}
}

func validDiagnosticsServiceClaims(environment string) map[string]any {
	return map[string]any{
		"iss": diagnosticsServiceTestIssuer, "aud": accessgrants.DiagnosticsServiceAudience, "sub": "recording-provider", "jti": "dGVzdC1zZXJ2aWNlLWp0aQ",
		"iat": diagnosticsServiceTestNow.Unix(), "nbf": diagnosticsServiceTestNow.Unix(), "exp": diagnosticsServiceTestNow.Add(time.Minute).Unix(),
		"environment": environment, "source": string(accessgrants.DiagnosticsServiceSourceProvider), "instance_id": "provider-instance-01", "generation": 7, "capability": accessgrants.DiagnosticsServiceCapabilityAppend,
	}
}

func mintDiagnosticsServiceToken(t *testing.T, privateKey ed25519.PrivateKey, claims map[string]any) string {
	t.Helper()
	header, err := json.Marshal(map[string]any{"alg": "EdDSA", "typ": "JWT", "kid": "service-key"})
	if err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	headerPart := base64.RawURLEncoding.EncodeToString(header)
	payloadPart := base64.RawURLEncoding.EncodeToString(payload)
	input := headerPart + "." + payloadPart
	signature := ed25519.Sign(privateKey, []byte(input))
	return input + "." + base64.RawURLEncoding.EncodeToString(signature)
}

func cloneDiagnosticsServiceClaims(claims map[string]any) map[string]any {
	clone := make(map[string]any, len(claims))
	for key, value := range claims {
		clone[key] = value
	}
	return clone
}

func testServiceIDs(t *testing.T) (tenantID, spaceID, episodeID, participantID utilities.ID) {
	t.Helper()
	for _, target := range []*utilities.ID{&tenantID, &spaceID, &episodeID, &participantID} {
		id, err := utilities.NewID()
		if err != nil {
			t.Fatal(err)
		}
		*target = id
	}
	return tenantID, spaceID, episodeID, participantID
}
