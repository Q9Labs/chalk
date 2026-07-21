package apikeys_test

import (
	"context"
	"errors"
	"net/netip"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/apikeys"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
)

func TestAuthenticateBuildsTenantPrincipalAndAttributesUsage(t *testing.T) {
	repository := newRepository()
	telemetry := &telemetryRecorder{}
	service := newService(repository, telemetry)
	created := createKey(t, service, testNow.Add(time.Hour))
	clientIP := netip.MustParseAddr("192.0.2.10")

	principal, err := service.Authenticate(context.Background(), apikeys.AuthenticateInput{
		RawKey: created.RawKey, IPAddress: clientIP,
	})
	if err != nil {
		t.Fatalf("authenticate: %v", err)
	}
	if principal.Kind != authentication.PrincipalAPIKey || principal.TenantID != tenantID || principal.APIKeyID != created.Key.ID {
		t.Fatalf("principal = %+v, want tenant-bound API key", principal)
	}
	if len(principal.Scopes) != 1 || principal.Scopes[0] != authentication.ScopeRoomsRead {
		t.Fatalf("scopes = %v, want rooms:read", principal.Scopes)
	}
	if repository.lastUsage.KeyID != created.Key.ID || repository.lastUsage.IPAddress != clientIP || !repository.lastUsage.UsedAt.Equal(testNow) {
		t.Fatalf("usage = %+v, want key, time, and IP attribution", repository.lastUsage)
	}
	if telemetry.authentication[len(telemetry.authentication)-1].Outcome != apikeys.AuthenticationAccepted {
		t.Fatalf("authentication telemetry = %+v, want accepted", telemetry.authentication)
	}
	if telemetry.usage[len(telemetry.usage)-1] != apikeys.UsageTouchSucceeded {
		t.Fatalf("usage telemetry = %v, want succeeded", telemetry.usage)
	}
}

func TestAuthenticateUsesOneGenericErrorForRejectedKeys(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*repository, apikeys.CreateResult) string
	}{
		{name: "malformed", mutate: func(_ *repository, _ apikeys.CreateResult) string { return "chalk_sk_bad" }},
		{name: "unknown", mutate: func(_ *repository, created apikeys.CreateResult) string {
			raw := []byte(created.RawKey)
			raw[len("chalk_sk_")] = differentBase64Byte(raw[len("chalk_sk_")])
			return string(raw)
		}},
		{name: "wrong secret", mutate: func(_ *repository, created apikeys.CreateResult) string {
			raw := []byte(created.RawKey)
			raw[len(raw)-1] = differentBase64Byte(raw[len(raw)-1])
			return string(raw)
		}},
		{name: "revoked", mutate: func(repository *repository, created apikeys.CreateResult) string {
			record := repository.records[created.Key.ID.String()]
			revokedAt := testNow
			record.RevokedAt = &revokedAt
			repository.records[created.Key.ID.String()] = record
			return created.RawKey
		}},
		{name: "expired", mutate: func(repository *repository, created apikeys.CreateResult) string {
			record := repository.records[created.Key.ID.String()]
			record.ExpiresAt = testNow
			repository.records[created.Key.ID.String()] = record
			return created.RawKey
		}},
		{name: "invalid stored hash", mutate: func(repository *repository, created apikeys.CreateResult) string {
			record := repository.records[created.Key.ID.String()]
			record.KeyHash = "not-a-sha256-hash"
			repository.records[created.Key.ID.String()] = record
			return created.RawKey
		}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			repository := newRepository()
			telemetry := &telemetryRecorder{}
			service := newService(repository, telemetry)
			created := createKey(t, service, testNow.Add(time.Hour))

			_, err := service.Authenticate(context.Background(), apikeys.AuthenticateInput{RawKey: test.mutate(repository, created)})
			if !errors.Is(err, apikeys.ErrUnauthenticated) {
				t.Fatalf("error = %v, want %v", err, apikeys.ErrUnauthenticated)
			}
			if telemetry.authentication[len(telemetry.authentication)-1].Outcome != apikeys.AuthenticationRejected {
				t.Fatalf("telemetry = %+v, want rejected", telemetry.authentication)
			}
		})
	}
}

func TestAuthenticateDoesNotRejectValidKeyWhenUsageTouchFails(t *testing.T) {
	repository := newRepository()
	repository.touchErr = errors.New("database unavailable")
	telemetry := &telemetryRecorder{}
	service := newService(repository, telemetry)
	created := createKey(t, service, testNow.Add(time.Hour))

	principal, err := service.Authenticate(context.Background(), apikeys.AuthenticateInput{RawKey: created.RawKey})
	if err != nil {
		t.Fatalf("authenticate: %v", err)
	}
	if principal.APIKeyID != created.Key.ID {
		t.Fatalf("principal key id = %v, want %v", principal.APIKeyID, created.Key.ID)
	}
	if len(telemetry.usage) != 1 || telemetry.usage[0] != apikeys.UsageTouchFailed {
		t.Fatalf("usage telemetry = %v, want one failed outcome", telemetry.usage)
	}
}

func TestAuthenticateReportsRepositoryFailureWithoutCredentialAttributes(t *testing.T) {
	repository := newRepository()
	telemetry := &telemetryRecorder{}
	service := newService(repository, telemetry)
	created := createKey(t, service, testNow.Add(time.Hour))
	repository.getByPrefixErr = errors.New("database unavailable")

	_, err := service.Authenticate(context.Background(), apikeys.AuthenticateInput{RawKey: created.RawKey})
	if err == nil || errors.Is(err, apikeys.ErrUnauthenticated) {
		t.Fatalf("error = %v, want operational failure", err)
	}
	last := telemetry.authentication[len(telemetry.authentication)-1]
	if last.Outcome != apikeys.AuthenticationFailed || last.Latency < 0 {
		t.Fatalf("telemetry = %+v, want bounded failed outcome and latency", last)
	}
}

func differentBase64Byte(value byte) byte {
	if value == 'A' {
		return 'B'
	}
	return 'A'
}
