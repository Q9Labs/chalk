package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestCertificateExpiryWarnsAtTwentyOneAndSevenDaysAndWhenTheDoorFails(t *testing.T) {
	probes, servers := newSFUFleet(t, ready(200, sfuBody(0, "")))
	// The test certificates live one hour, so "now" moves instead of the certificates.
	expiry := servers[0].Certificate().NotAfter
	cases := []struct {
		name  string
		now   time.Time
		value int64
		want  string
	}{
		{"far from expiry", expiry.Add(-30 * 24 * time.Hour), 0, "all_valid"},
		{"21 days left", expiry.Add(-20 * 24 * time.Hour), 1, "expires within 21 days"},
		{"7 days left", expiry.Add(-6 * 24 * time.Hour), 1, "expires within 7 days"},
		{"expired", expiry.Add(time.Minute), 1, "has expired"},
	}
	for _, c := range cases {
		items := collectCertificateExpiry(context.Background(), probes, "", c.now)
		if len(items) != 1 || items[0].Rule != "certificate-expiry" || items[0].Value != c.value || !strings.Contains(items[0].Reason, c.want) {
			t.Errorf("%s: %+v", c.name, items)
		}
	}
	// The soonest certificate decides: the API client certificate and the server certificate both live one hour here.
	items := collectCertificateExpiry(context.Background(), probes, "", expiry.Add(-6*24*time.Hour))
	formatMessage(&items[0])
	if !strings.Contains(items[0].Summary, "7 days") || strings.Contains(items[0].Summary+items[0].Next, "chalk-sfu") {
		t.Errorf("the message must name the window and no certificate name: %+v", items[0])
	}
	dead := httptest.NewUnstartedServer(http.NotFoundHandler())
	dead.StartTLS()
	deadURL := dead.URL
	dead.Close()
	items = collectCertificateExpiry(context.Background(), nil, deadURL, time.Now())
	if len(items) != 1 || items[0].Value != 1 || strings.Contains(items[0].Reason, "127.0.0.1") {
		t.Errorf("a door that cannot handshake must alert without an address: %+v", items)
	}
}

func TestCertificateExpiryRowOnlyWhenConfigured(t *testing.T) {
	if items := collectCertificateExpiry(context.Background(), nil, "", time.Now()); items != nil {
		t.Fatalf("nothing configured must emit no row: %+v", items)
	}
}

// certServer presents a certificate that ends at leafNotAfter, signed by a CA of its
// own whose PEM file and pool it returns, and asks for no client certificate. An
// hour ago is a node whose server certificate has run out; an hour from now is an
// impostor with a valid certificate from a CA the collector does not trust.
func certServer(t *testing.T, leafNotAfter time.Time) (*httptest.Server, string, *x509.CertPool) {
	t.Helper()
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	caTemplate := &x509.Certificate{SerialNumber: big.NewInt(8), Subject: pkix.Name{CommonName: "expired test ca"}, NotBefore: time.Now().Add(-72 * time.Hour), NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
	caDER, err := x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, &caKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	caCert, err := x509.ParseCertificate(caDER)
	if err != nil {
		t.Fatal(err)
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(9), Subject: pkix.Name{CommonName: "expired"}, NotBefore: time.Now().Add(-48 * time.Hour), NotAfter: leafNotAfter, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, KeyUsage: x509.KeyUsageDigitalSignature, DNSNames: []string{"chalk-sfu", "localhost"}}
	der, err := x509.CreateCertificate(rand.Reader, template, caCert, &key.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewUnstartedServer(http.NotFoundHandler())
	server.TLS = &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}, MinVersion: tls.VersionTLS13}
	server.StartTLS()
	t.Cleanup(server.Close)
	caFile := filepath.Join(t.TempDir(), "expired-ca.pem")
	if err := os.WriteFile(caFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER}), 0o600); err != nil {
		t.Fatal(err)
	}
	pool := x509.NewCertPool()
	pool.AddCert(caCert)
	return server, caFile, pool
}

func TestAnExpiredButTrustedServerCertificateReadsAsExpired(t *testing.T) {
	probes, _ := newSFUFleet(t, ready(200, sfuBody(0, "")))
	server, caFile, pool := certServer(t, time.Now().Add(-time.Hour))
	probes[0].URL, probes[0].CAFile = server.URL+"/readyz", caFile
	items := collectCertificateExpiry(context.Background(), probes, "", time.Now())
	if len(items) != 1 || items[0].Value != 1 || !strings.Contains(items[0].Reason, "a Chalk SFU server certificate has expired") || strings.Contains(items[0].Reason, "untrusted") {
		t.Fatalf("an expired trusted SFU certificate must alert as expired only: %+v", items)
	}
	doorRoots = pool
	t.Cleanup(func() { doorRoots = nil })
	door := collectCertificateExpiry(context.Background(), nil, strings.Replace(server.URL, "127.0.0.1", "localhost", 1), time.Now())
	if len(door) != 1 || door[0].Value != 1 || !strings.Contains(door[0].Reason, "the direct door certificate has expired") || strings.Contains(door[0].Reason, "could not be verified") {
		t.Fatalf("an expired trusted door certificate must alert as expired only: %+v", door)
	}
}

func TestACAThatExpiresBeforeItsLeafSetsTheEffectiveExpiry(t *testing.T) {
	probes, _ := newSFUFleet(t, ready(200, sfuBody(0, "")))
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	// The CA ends in two days; the leaf it signed ends in a year.
	caTemplate := &x509.Certificate{SerialNumber: big.NewInt(11), Subject: pkix.Name{CommonName: "short ca"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(48 * time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
	caDER, err := x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, &caKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	caCert, err := x509.ParseCertificate(caDER)
	if err != nil {
		t.Fatal(err)
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	leafTemplate := &x509.Certificate{SerialNumber: big.NewInt(12), Subject: pkix.Name{CommonName: "long leaf"}, NotBefore: time.Now().Add(-30 * time.Minute), NotAfter: time.Now().Add(365 * 24 * time.Hour), ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, KeyUsage: x509.KeyUsageDigitalSignature, DNSNames: []string{"chalk-sfu"}}
	der, err := x509.CreateCertificate(rand.Reader, leafTemplate, caCert, &key.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewUnstartedServer(http.NotFoundHandler())
	server.TLS = &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}, MinVersion: tls.VersionTLS13}
	server.StartTLS()
	t.Cleanup(server.Close)
	caFile := filepath.Join(t.TempDir(), "short-ca.pem")
	if err := os.WriteFile(caFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER}), 0o600); err != nil {
		t.Fatal(err)
	}
	probes[0].URL, probes[0].CAFile = server.URL+"/readyz", caFile
	// Handshakes start failing when the CA ends, so the leaf's year-long NotAfter must not read as healthy.
	items := collectCertificateExpiry(context.Background(), probes[:1], "", time.Now())
	if len(items) != 1 || items[0].Value != 1 || !strings.Contains(items[0].Reason, "the CA of the Chalk SFU server certificates expires within 7 days") || strings.Contains(items[0].Reason, "a Chalk SFU server certificate expires") {
		t.Fatalf("the CA's earlier expiry must decide and be named: %+v", items)
	}
}

func TestAnImpostorCertificateRaisesAnUntrustedFindingInsteadOfHidingExpiry(t *testing.T) {
	// The fleet's CA is not the impostor's, so the impostor's far-future expiry must not read as healthy.
	probes, _ := newSFUFleet(t, ready(200, sfuBody(0, "")))
	impostor, _, _ := certServer(t, time.Now().Add(time.Hour))
	probes[0].URL = impostor.URL + "/readyz"
	items := collectCertificateExpiry(context.Background(), probes, "", time.Now())
	if len(items) != 1 || items[0].Value != 1 || !strings.Contains(items[0].Reason, "a Chalk SFU server certificate is untrusted") {
		t.Fatalf("a certificate from another CA must alert as untrusted: %+v", items)
	}
	door := collectCertificateExpiry(context.Background(), nil, strings.Replace(impostor.URL, "127.0.0.1", "localhost", 1), time.Now())
	if len(door) != 1 || door[0].Value != 1 || !strings.Contains(door[0].Reason, "the direct door could not be verified") {
		t.Fatalf("an untrusted door certificate must alert: %+v", door)
	}
}

func TestSlowNodesCostOneTimeoutNotOneEach(t *testing.T) {
	var probes []sfuProbe
	base, _ := newSFUFleet(t, ready(200, sfuBody(0, "")))
	for range 5 {
		// Accepts the connection and never answers the handshake.
		hung, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { hung.Close() })
		go func() {
			for {
				conn, err := hung.Accept()
				if err != nil {
					return
				}
				t.Cleanup(func() { conn.Close() })
			}
		}()
		probe := base[0]
		probe.URL = "https://" + hung.Addr().String() + "/readyz"
		probes = append(probes, probe)
	}
	start := time.Now()
	items := collectCertificateExpiry(context.Background(), probes, "", time.Now())
	if elapsed := time.Since(start); elapsed > certNodeTimeout+time.Second {
		t.Fatalf("five hung nodes took %s; the checks must run at once", elapsed)
	}
	if len(items) != 1 || strings.Contains(items[0].Reason, "server certificate") {
		t.Fatalf("an unreachable node is the readiness row's concern: %+v", items)
	}
}

func TestADoorFailureDoesNotHideAnSFUExpiryWarning(t *testing.T) {
	probes, servers := newSFUFleet(t, ready(200, sfuBody(0, "")))
	expiry := servers[0].Certificate().NotAfter
	dead := httptest.NewUnstartedServer(http.NotFoundHandler())
	dead.StartTLS()
	deadURL := dead.URL
	dead.Close()
	items := collectCertificateExpiry(context.Background(), probes, deadURL, expiry.Add(-6*24*time.Hour))
	if len(items) != 1 || !strings.Contains(items[0].Reason, "the direct door could not be verified") || !strings.Contains(items[0].Reason, "expires within 7 days") {
		t.Fatalf("every finding must reach the row: %+v", items)
	}
}
