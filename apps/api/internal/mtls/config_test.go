package mtls

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
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
