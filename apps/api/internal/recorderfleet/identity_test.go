package recorderfleet

import (
	"crypto/tls"
	"crypto/x509"
	"net/http"
	"net/url"
	"testing"
	"time"
)

func TestControllerVerifierAcceptsOnlyIndependentControllerRole(t *testing.T) {
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	verifier, err := NewControllerVerifier("workers.example.test", "staging")
	if err != nil {
		t.Fatalf("new verifier: %v", err)
	}
	verifier.now = func() time.Time { return now }

	controllerURI, _ := url.Parse("spiffe://workers.example.test/environment/staging/recorder-fleet-controller/55555555-5555-4555-8555-555555555555")
	identity, err := verifier.Verify(controllerRequest(now, controllerURI))
	if err != nil || identity.ControllerID.String() != "55555555-5555-4555-8555-555555555555" {
		t.Fatalf("controller identity/error = %+v/%v", identity, err)
	}

	workerURI, _ := url.Parse("spiffe://workers.example.test/environment/staging/capture/55555555-5555-4555-8555-555555555555")
	if _, err := verifier.Verify(controllerRequest(now, workerURI)); err != ErrInvalidControllerIdentity {
		t.Fatalf("capture worker identity error = %v", err)
	}
	wrongEnvironment, _ := url.Parse("spiffe://workers.example.test/environment/production/recorder-fleet-controller/55555555-5555-4555-8555-555555555555")
	if _, err := verifier.Verify(controllerRequest(now, wrongEnvironment)); err != ErrInvalidControllerIdentity {
		t.Fatalf("wrong environment identity error = %v", err)
	}
	certificate := controllerRequest(now, controllerURI).TLS.PeerCertificates[0]
	if identity, err := verifier.VerifyCertificate(certificate); err != nil || identity.ControllerID.String() != "55555555-5555-4555-8555-555555555555" {
		t.Fatalf("local controller certificate identity/error = %+v/%v", identity, err)
	}
}

func TestControllerVerifierRequiresVerifiedCurrentSingleURI(t *testing.T) {
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	verifier, _ := NewControllerVerifier("workers.example.test", "staging")
	verifier.now = func() time.Time { return now }
	controllerURI, _ := url.Parse("spiffe://workers.example.test/environment/staging/recorder-fleet-controller/55555555-5555-4555-8555-555555555555")

	if _, err := verifier.Verify(&http.Request{}); err != ErrUnverifiedControllerPeer {
		t.Fatalf("unverified request error = %v", err)
	}
	if _, err := verifier.VerifyCertificate(nil); err != ErrUnverifiedControllerPeer {
		t.Fatalf("nil certificate error = %v", err)
	}
	expired := controllerRequest(now, controllerURI)
	expired.TLS.PeerCertificates[0].NotAfter = now
	if _, err := verifier.Verify(expired); err != ErrUnverifiedControllerPeer {
		t.Fatalf("expired request error = %v", err)
	}
	multiple := controllerRequest(now, controllerURI)
	multiple.TLS.PeerCertificates[0].URIs = append(multiple.TLS.PeerCertificates[0].URIs, controllerURI)
	if _, err := verifier.Verify(multiple); err != ErrUnverifiedControllerPeer {
		t.Fatalf("multiple URI request error = %v", err)
	}
}

func controllerRequest(now time.Time, identity *url.URL) *http.Request {
	certificate := &x509.Certificate{NotBefore: now.Add(-time.Minute), NotAfter: now.Add(time.Minute), URIs: []*url.URL{identity}}
	return &http.Request{TLS: &tls.ConnectionState{
		PeerCertificates: []*x509.Certificate{certificate},
		VerifiedChains:   [][]*x509.Certificate{{certificate}},
	}}
}
