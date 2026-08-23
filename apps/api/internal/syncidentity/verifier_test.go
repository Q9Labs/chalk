package syncidentity_test

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/syncidentity"
)

type certificateAuthority struct {
	certificate *x509.Certificate
	privateKey  *rsa.PrivateKey
	pool        *x509.CertPool
}

func TestVerifierAcceptsSyncSPIFFEIdentityAfterMTLSHandshake(t *testing.T) {
	ca := newCertificateAuthority(t)
	clientCertificate := signedCertificate(t, ca, "spiffe://chalkmeet.com/environment/staging/sync/11111111-1111-4111-8111-111111111111", false)
	client, server := syncIdentityServer(t, ca, clientCertificate)

	response, err := client.Get(server.URL)
	if err != nil {
		t.Fatalf("mTLS request: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", response.StatusCode, http.StatusNoContent)
	}
}

func TestVerifierRejectsInvalidSPIFFEIdentityAfterMTLSHandshake(t *testing.T) {
	ca := newCertificateAuthority(t)
	clientCertificate := signedCertificate(t, ca, "spiffe://chalkmeet.com/environment/staging/sync/not-an-id", false)
	client, server := syncIdentityServer(t, ca, clientCertificate)

	response, err := client.Get(server.URL)
	if err != nil {
		t.Fatalf("mTLS request: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", response.StatusCode, http.StatusUnauthorized)
	}
}

func TestVerifierRejectsUntrustedClientCertificateDuringMTLSHandshake(t *testing.T) {
	trustedCA := newCertificateAuthority(t)
	clientCA := newCertificateAuthority(t)
	clientCertificate := signedCertificate(t, clientCA, "spiffe://chalkmeet.com/environment/staging/sync/11111111-1111-4111-8111-111111111111", false)
	client, server := syncIdentityServer(t, trustedCA, clientCertificate)

	if _, err := client.Get(server.URL); err == nil {
		t.Fatal("untrusted client certificate completed the mTLS handshake")
	}
}

func syncIdentityServer(t *testing.T, ca certificateAuthority, clientCertificate tls.Certificate) (*http.Client, *httptest.Server) {
	t.Helper()
	verifier, err := syncidentity.NewVerifier("chalkmeet.com", "staging")
	if err != nil {
		t.Fatalf("new verifier: %v", err)
	}
	serverCertificate := signedCertificate(t, ca, "", true)
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if err := verifier.Verify(request); err != nil {
			http.Error(response, "sync authentication required", http.StatusUnauthorized)
			return
		}
		response.WriteHeader(http.StatusNoContent)
	}))
	server.TLS = &tls.Config{
		MinVersion:   tls.VersionTLS13,
		ClientAuth:   tls.RequireAndVerifyClientCert,
		ClientCAs:    ca.pool,
		Certificates: []tls.Certificate{serverCertificate},
	}
	server.StartTLS()
	t.Cleanup(server.Close)

	client := &http.Client{Transport: &http.Transport{
		TLSClientConfig: &tls.Config{
			MinVersion:   tls.VersionTLS13,
			RootCAs:      ca.pool,
			Certificates: []tls.Certificate{clientCertificate},
		},
	}}
	t.Cleanup(client.CloseIdleConnections)
	return client, server
}

func newCertificateAuthority(t *testing.T) certificateAuthority {
	t.Helper()
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate CA key: %v", err)
	}
	certificate := &x509.Certificate{
		SerialNumber:          big.NewInt(time.Now().UnixNano()),
		Subject:               pkix.Name{CommonName: "Chalk test CA"},
		NotBefore:             time.Now().Add(-time.Minute),
		NotAfter:              time.Now().Add(time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign | x509.KeyUsageDigitalSignature,
	}
	der, err := x509.CreateCertificate(rand.Reader, certificate, certificate, &privateKey.PublicKey, privateKey)
	if err != nil {
		t.Fatalf("create CA certificate: %v", err)
	}
	parsed, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatalf("parse CA certificate: %v", err)
	}
	pemBytes := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(pemBytes) {
		t.Fatal("append CA certificate")
	}
	return certificateAuthority{certificate: parsed, privateKey: privateKey, pool: pool}
}

func signedCertificate(t *testing.T, ca certificateAuthority, identity string, server bool) tls.Certificate {
	t.Helper()
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate leaf key: %v", err)
	}
	template := &x509.Certificate{
		SerialNumber:          big.NewInt(time.Now().UnixNano()),
		Subject:               pkix.Name{CommonName: "Chalk test leaf"},
		NotBefore:             time.Now().Add(-time.Minute),
		NotAfter:              time.Now().Add(time.Hour),
		DNSNames:              []string{"localhost"},
		IPAddresses:           []net.IP{net.ParseIP("127.0.0.1")},
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		BasicConstraintsValid: true,
	}
	if identity != "" {
		uri, err := url.Parse(identity)
		if err != nil {
			t.Fatalf("parse SPIFFE identity: %v", err)
		}
		template.URIs = []*url.URL{uri}
	}
	if server {
		template.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}
	} else {
		template.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}
	}
	der, err := x509.CreateCertificate(rand.Reader, template, ca.certificate, &privateKey.PublicKey, ca.privateKey)
	if err != nil {
		t.Fatalf("create leaf certificate: %v", err)
	}
	certificatePEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(privateKey)})
	certificate, err := tls.X509KeyPair(certificatePEM, keyPEM)
	if err != nil {
		t.Fatalf("load leaf certificate: %v", err)
	}
	return certificate
}
