package mtls

import (
	"bytes"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestLoadClientConfigPinsTLS13MutualIdentity(t *testing.T) {
	directory := t.TempDir()
	ca, caKey := testCertificateAuthority(t)
	client, clientKey := testClientCertificate(t, ca, caKey)
	certificateFile := filepath.Join(directory, "client.pem")
	keyFile := filepath.Join(directory, "client-key.pem")
	caFile := filepath.Join(directory, "server-ca.pem")
	writeTestPEM(t, certificateFile, "CERTIFICATE", client.Raw)
	writeTestPEM(t, keyFile, "RSA PRIVATE KEY", x509.MarshalPKCS1PrivateKey(clientKey))
	writeTestPEM(t, caFile, "CERTIFICATE", ca.Raw)

	config, err := LoadClientConfig(certificateFile, keyFile, caFile, "recorder-control.internal")
	if err != nil {
		t.Fatalf("load client config: %v", err)
	}
	if config.MinVersion != tls.VersionTLS13 || len(config.Certificates) != 1 || config.RootCAs == nil || config.ServerName != "recorder-control.internal" {
		t.Fatalf("client tls config = %#v", config)
	}
}

func TestLoadClientConfigRejectsAmbientOrMalformedTrust(t *testing.T) {
	for name, input := range map[string][4]string{
		"empty":       {},
		"server port": {"certificate", "key", "ca", "control.internal:443"},
		"server path": {"certificate", "key", "ca", "control.internal/path"},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := LoadClientConfig(input[0], input[1], input[2], input[3]); err == nil {
				t.Fatal("invalid client mutual tls config accepted")
			}
		})
	}
}

func TestLoadReloadingClientConfigReadsRenewedCertificate(t *testing.T) {
	directory := t.TempDir()
	ca, caKey := testCertificateAuthority(t)
	first, firstKey := testClientCertificate(t, ca, caKey)
	second, secondKey := testClientCertificate(t, ca, caKey)
	certificateFile := filepath.Join(directory, "client.pem")
	keyFile := filepath.Join(directory, "client-key.pem")
	caFile := filepath.Join(directory, "server-ca.pem")
	writeTestPEM(t, certificateFile, "CERTIFICATE", first.Raw)
	writeTestPEM(t, keyFile, "RSA PRIVATE KEY", x509.MarshalPKCS1PrivateKey(firstKey))
	writeTestPEM(t, caFile, "CERTIFICATE", ca.Raw)

	config, err := LoadReloadingClientConfig(certificateFile, keyFile, caFile, "recorder-control.internal")
	if err != nil {
		t.Fatalf("load reloading config: %v", err)
	}
	loaded, err := config.GetClientCertificate(&tls.CertificateRequestInfo{})
	if err != nil || len(loaded.Certificate) == 0 || !bytes.Equal(loaded.Certificate[0], first.Raw) {
		t.Fatalf("initial certificate/error = %#v/%v", loaded, err)
	}
	writeTestPEM(t, certificateFile, "CERTIFICATE", second.Raw)
	writeTestPEM(t, keyFile, "RSA PRIVATE KEY", x509.MarshalPKCS1PrivateKey(secondKey))
	loaded, err = config.GetClientCertificate(&tls.CertificateRequestInfo{})
	if err != nil || len(loaded.Certificate) == 0 || !bytes.Equal(loaded.Certificate[0], second.Raw) {
		t.Fatalf("renewed certificate/error = %#v/%v", loaded, err)
	}
}

func TestReloadingClientTransportRotatesConnectionPool(t *testing.T) {
	directory := t.TempDir()
	ca, caKey := testCertificateAuthority(t)
	first, firstKey := testClientCertificate(t, ca, caKey)
	second, secondKey := testClientCertificate(t, ca, caKey)
	certificateFile := filepath.Join(directory, "client.pem")
	keyFile := filepath.Join(directory, "client-key.pem")
	caFile := filepath.Join(directory, "server-ca.pem")
	writeTestPEM(t, certificateFile, "CERTIFICATE", first.Raw)
	writeTestPEM(t, keyFile, "RSA PRIVATE KEY", x509.MarshalPKCS1PrivateKey(firstKey))
	writeTestPEM(t, caFile, "CERTIFICATE", ca.Raw)

	transport, err := NewReloadingClientTransport(certificateFile, keyFile, caFile, "recorder-control.internal")
	if err != nil {
		t.Fatalf("new reloading transport: %v", err)
	}
	initialPool := transport.current
	writeTestPEM(t, certificateFile, "CERTIFICATE", second.Raw)
	writeTestPEM(t, keyFile, "RSA PRIVATE KEY", x509.MarshalPKCS1PrivateKey(secondKey))
	request, _ := http.NewRequest(http.MethodGet, "http://127.0.0.1:1", nil)
	_, _ = transport.RoundTrip(request)
	if transport.current == initialPool {
		t.Fatal("renewed certificate reused the previous connection pool")
	}
}

func testCertificateAuthority(t *testing.T) (*x509.Certificate, *rsa.PrivateKey) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate ca key: %v", err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "Chalk recorder test CA"},
		NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour),
		IsCA: true, KeyUsage: x509.KeyUsageCertSign, BasicConstraintsValid: true,
	}
	encoded, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("create ca certificate: %v", err)
	}
	certificate, err := x509.ParseCertificate(encoded)
	if err != nil {
		t.Fatalf("parse ca certificate: %v", err)
	}
	return certificate, key
}

func testClientCertificate(t *testing.T, ca *x509.Certificate, caKey *rsa.PrivateKey) (*x509.Certificate, *rsa.PrivateKey) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate client key: %v", err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: "capture-worker"},
		NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour),
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}, KeyUsage: x509.KeyUsageDigitalSignature,
	}
	encoded, err := x509.CreateCertificate(rand.Reader, template, ca, &key.PublicKey, caKey)
	if err != nil {
		t.Fatalf("create client certificate: %v", err)
	}
	certificate, err := x509.ParseCertificate(encoded)
	if err != nil {
		t.Fatalf("parse client certificate: %v", err)
	}
	return certificate, key
}

func writeTestPEM(t *testing.T, path string, kind string, data []byte) {
	t.Helper()
	encoded := pem.EncodeToMemory(&pem.Block{Type: kind, Bytes: data})
	if err := os.WriteFile(path, encoded, 0o600); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}
