package workeridentity

import (
	"crypto/tls"
	"crypto/x509"
	"net/http"
	"net/url"
	"testing"
	"time"
)

func TestVerifierAcceptsVerifiedRoleScopedIdentity(t *testing.T) {
	now := time.Date(2026, 7, 13, 0, 0, 0, 0, time.UTC)
	verifier, err := NewVerifier("chalkmeet.com", "staging")
	if err != nil {
		t.Fatalf("new verifier: %v", err)
	}
	verifier.now = func() time.Time { return now }

	certificate := certificateWithURI(t, "spiffe://chalkmeet.com/environment/staging/capture/11111111-1111-4111-8111-111111111111", now)
	request := &http.Request{TLS: &tls.ConnectionState{
		PeerCertificates: []*x509.Certificate{certificate},
		VerifiedChains:   [][]*x509.Certificate{{certificate}},
	}}

	identity, err := verifier.Verify(request)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if identity.Role != RoleCapture {
		t.Fatalf("role = %q, want %q", identity.Role, RoleCapture)
	}
	if got := identity.WorkerID.String(); got != "11111111-1111-4111-8111-111111111111" {
		t.Fatalf("worker id = %q", got)
	}
}

func TestVerifierRejectsUnverifiedOrBroaderIdentity(t *testing.T) {
	now := time.Date(2026, 7, 13, 0, 0, 0, 0, time.UTC)
	verifier, err := NewVerifier("chalkmeet.com", "production")
	if err != nil {
		t.Fatalf("new verifier: %v", err)
	}
	verifier.now = func() time.Time { return now }

	tests := []struct {
		name    string
		request *http.Request
	}{
		{name: "missing tls", request: &http.Request{}},
		{
			name: "unverified chain",
			request: &http.Request{TLS: &tls.ConnectionState{PeerCertificates: []*x509.Certificate{
				certificateWithURI(t, "spiffe://chalkmeet.com/environment/production/render/11111111-1111-4111-8111-111111111111", now),
			}}},
		},
		{
			name:    "wrong environment",
			request: verifiedRequest(certificateWithURI(t, "spiffe://chalkmeet.com/environment/staging/render/11111111-1111-4111-8111-111111111111", now)),
		},
		{
			name:    "unknown role",
			request: verifiedRequest(certificateWithURI(t, "spiffe://chalkmeet.com/environment/production/admin/11111111-1111-4111-8111-111111111111", now)),
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := verifier.Verify(test.request); err == nil {
				t.Fatal("verify succeeded")
			}
		})
	}
}

func certificateWithURI(t *testing.T, value string, now time.Time) *x509.Certificate {
	t.Helper()
	uri, err := url.Parse(value)
	if err != nil {
		t.Fatalf("parse uri: %v", err)
	}
	return &x509.Certificate{NotBefore: now.Add(-time.Minute), NotAfter: now.Add(time.Minute), URIs: []*url.URL{uri}}
}

func verifiedRequest(certificate *x509.Certificate) *http.Request {
	return &http.Request{TLS: &tls.ConnectionState{
		PeerCertificates: []*x509.Certificate{certificate},
		VerifiedChains:   [][]*x509.Certificate{{certificate}},
	}}
}
