package syncidentity

import (
	"crypto/tls"
	"crypto/x509"
	"net/http"
	"net/url"
	"testing"
	"time"
)

func TestVerifierAcceptsVerifiedSyncSPIFFEIdentity(t *testing.T) {
	now := time.Date(2026, 7, 13, 12, 0, 0, 0, time.UTC)
	verifier, err := NewVerifier("chalkmeet.com", "staging")
	if err != nil {
		t.Fatalf("new verifier: %v", err)
	}
	verifier.now = func() time.Time { return now }
	certificate := syncCertificate(t, "spiffe://chalkmeet.com/environment/staging/sync/11111111-1111-4111-8111-111111111111", now)
	request := &http.Request{TLS: &tls.ConnectionState{
		PeerCertificates: []*x509.Certificate{certificate},
		VerifiedChains:   [][]*x509.Certificate{{certificate}},
	}}

	if err := verifier.Verify(request); err != nil {
		t.Fatalf("verify sync identity: %v", err)
	}
}

func TestVerifierRejectsWrongRoleEnvironmentAndUnverifiedPeer(t *testing.T) {
	now := time.Date(2026, 7, 13, 12, 0, 0, 0, time.UTC)
	verifier, err := NewVerifier("chalkmeet.com", "staging")
	if err != nil {
		t.Fatalf("new verifier: %v", err)
	}
	verifier.now = func() time.Time { return now }

	tests := []struct {
		name    string
		request *http.Request
	}{
		{name: "no tls", request: &http.Request{}},
		{name: "unverified", request: &http.Request{TLS: &tls.ConnectionState{PeerCertificates: []*x509.Certificate{
			syncCertificate(t, "spiffe://chalkmeet.com/environment/staging/sync/11111111-1111-4111-8111-111111111111", now),
		}}}},
		{name: "wrong role", request: verifiedSyncRequest(syncCertificate(t, "spiffe://chalkmeet.com/environment/staging/recorder/11111111-1111-4111-8111-111111111111", now))},
		{name: "wrong environment", request: verifiedSyncRequest(syncCertificate(t, "spiffe://chalkmeet.com/environment/production/sync/11111111-1111-4111-8111-111111111111", now))},
		{name: "invalid instance", request: verifiedSyncRequest(syncCertificate(t, "spiffe://chalkmeet.com/environment/staging/sync/not-an-id", now))},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if err := verifier.Verify(test.request); err == nil {
				t.Fatal("expected identity rejection")
			}
		})
	}
}

func syncCertificate(t *testing.T, identity string, now time.Time) *x509.Certificate {
	t.Helper()
	uri, err := url.Parse(identity)
	if err != nil {
		t.Fatalf("parse identity: %v", err)
	}
	return &x509.Certificate{
		NotBefore: now.Add(-time.Minute),
		NotAfter:  now.Add(time.Minute),
		URIs:      []*url.URL{uri},
	}
}

func verifiedSyncRequest(certificate *x509.Certificate) *http.Request {
	return &http.Request{TLS: &tls.ConnectionState{
		PeerCertificates: []*x509.Certificate{certificate},
		VerifiedChains:   [][]*x509.Certificate{{certificate}},
	}}
}
