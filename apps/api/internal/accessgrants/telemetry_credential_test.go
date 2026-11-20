package accessgrants_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
)

type telemetryFixture struct {
	credentialFixture
	token     string
	expiresAt time.Time
}

func newTelemetryFixture(t *testing.T) telemetryFixture {
	t.Helper()
	fixture := newCredentialFixture(t)
	issuer, err := accessgrants.NewIssuer(accessgrants.IssuerConfig{
		Issuer: testIssuer, KeyID: testKeyID, PrivateKey: fixture.privateKey, Now: func() time.Time { return testNow },
	})
	if err != nil {
		t.Fatal(err)
	}
	credential, err := issuer.IssueTelemetry(context.Background(), fixture.subject)
	if err != nil {
		t.Fatal(err)
	}
	return telemetryFixture{credentialFixture: fixture, token: credential.Token, expiresAt: credential.ExpiresAt}
}

func TestTelemetryCredentialCarriesTheMediaSubjectForTwentyFourHours(t *testing.T) {
	fixture := newTelemetryFixture(t)
	subject, err := fixture.verifier.VerifyTelemetry(context.Background(), fixture.token)
	if err != nil {
		t.Fatal(err)
	}
	if subject != fixture.subject {
		t.Fatalf("subject = %#v, want the media credential's %#v", subject, fixture.subject)
	}
	if want := testNow.Truncate(time.Second).Add(accessgrants.TelemetryLifetime); !fixture.expiresAt.Equal(want) || accessgrants.TelemetryLifetime != 24*time.Hour {
		t.Fatalf("expires at %v, want %v", fixture.expiresAt, want)
	}
	claims := decodePart(t, tokenParts(t, fixture.token)[1])
	if claims["aud"] != "chalk-telemetry" || claims["sub"] != fixture.subject.ParticipantID.String() {
		t.Fatalf("claims = %v, want audience chalk-telemetry and the participant as subject", claims)
	}
}

func TestTelemetryCredentialDoesNotVerifyAsMediaAndMediaDoesNotVerifyAsTelemetry(t *testing.T) {
	fixture := newTelemetryFixture(t)
	ctx := context.Background()
	if _, err := fixture.verifier.Verify(ctx, fixture.token); !errors.Is(err, accessgrants.ErrInvalidAudience) {
		t.Errorf("telemetry credential as media: error = %v, want ErrInvalidAudience", err)
	}
	if _, err := fixture.verifier.VerifyForRecovery(ctx, fixture.token); !errors.Is(err, accessgrants.ErrInvalidAudience) {
		t.Errorf("telemetry credential for media recovery: error = %v, want ErrInvalidAudience", err)
	}
	if _, err := fixture.verifier.VerifyTelemetry(ctx, fixture.credentialFixture.token); !errors.Is(err, accessgrants.ErrInvalidAudience) {
		t.Errorf("media credential as telemetry: error = %v, want ErrInvalidAudience", err)
	}
}

func TestTelemetryVerifierHasItsOwnLifetimeCapAndExpiry(t *testing.T) {
	fixture := newTelemetryFixture(t)
	now := testNow.Unix()
	day := int64(accessgrants.TelemetryLifetime / time.Second)
	for _, test := range []struct {
		name   string
		change func(map[string]any)
		want   error
	}{
		{"a media-length lifetime is fine", func(c map[string]any) { c["iat"], c["nbf"], c["exp"] = now, now, now+300 }, nil},
		{"more than a day", func(c map[string]any) { c["iat"], c["nbf"], c["exp"] = now, now, now+day+1 }, accessgrants.ErrLifetimeExceeded},
		{"expired beyond skew", func(c map[string]any) { c["iat"], c["nbf"], c["exp"] = now-day, now-day, now-31 }, accessgrants.ErrExpired},
		{"future beyond skew", func(c map[string]any) { c["iat"], c["nbf"], c["exp"] = now+31, now+31, now+day }, accessgrants.ErrNotYetValid},
	} {
		t.Run(test.name, func(t *testing.T) {
			token := rewriteClaims(t, fixture.token, fixture.privateKey, test.change)
			subject, err := fixture.verifier.VerifyTelemetry(context.Background(), token)
			if !errors.Is(err, test.want) || (test.want == nil && err != nil) {
				t.Fatalf("error = %v, want %v", err, test.want)
			}
			if errors.Is(test.want, accessgrants.ErrExpired) && subject != fixture.subject {
				t.Fatalf("an expired credential returns its subject, as the media verifier does, got %#v", subject)
			}
		})
	}
}

func TestMediaVerifierKeepsItsFiveMinuteCapAgainstATwentyFourHourClaim(t *testing.T) {
	fixture := newCredentialFixture(t)
	now := testNow.Unix()
	token := rewriteClaims(t, fixture.token, fixture.privateKey, func(c map[string]any) { c["iat"], c["nbf"], c["exp"] = now, now, now+int64(24*time.Hour/time.Second) })
	if _, err := fixture.verifier.Verify(context.Background(), token); !errors.Is(err, accessgrants.ErrLifetimeExceeded) {
		t.Fatalf("error = %v, want ErrLifetimeExceeded", err)
	}
}
