package workeridentity

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

func TestLoadTLSConfigRequiresVerifiedTLS13Clients(t *testing.T) {
	directory := t.TempDir()
	caCertificate, caKey := certificateAuthority(t)
	serverCertificate, serverKey := signedServerCertificate(t, caCertificate, caKey)
	certificateFile := filepath.Join(directory, "server.pem")
	keyFile := filepath.Join(directory, "server-key.pem")
	caFile := filepath.Join(directory, "client-ca.pem")
	writePEM(t, certificateFile, "CERTIFICATE", serverCertificate.Raw)
	writePEM(t, keyFile, "RSA PRIVATE KEY", x509.MarshalPKCS1PrivateKey(serverKey))
	writePEM(t, caFile, "CERTIFICATE", caCertificate.Raw)

	config, err := LoadTLSConfig(certificateFile, keyFile, caFile)
	if err != nil {
		t.Fatalf("load tls config: %v", err)
	}
	if config.MinVersion != tls.VersionTLS13 || config.ClientAuth != tls.RequireAndVerifyClientCert || len(config.Certificates) != 1 || config.ClientCAs == nil {
		t.Fatalf("tls config = %#v", config)
	}
}

func TestLoadTLSConfigRejectsIncompleteConfiguration(t *testing.T) {
	if _, err := LoadTLSConfig("", "", ""); err == nil {
		t.Fatal("incomplete mutual tls config accepted")
	}
}

func certificateAuthority(t *testing.T) (*x509.Certificate, *rsa.PrivateKey) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate ca key: %v", err)
	}
	template := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "Chalk recorder test CA"},
		NotBefore:             time.Now().Add(-time.Minute),
		NotAfter:              time.Now().Add(time.Hour),
		IsCA:                  true,
		KeyUsage:              x509.KeyUsageCertSign,
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("create ca certificate: %v", err)
	}
	certificate, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatalf("parse ca certificate: %v", err)
	}
	return certificate, key
}

func signedServerCertificate(t *testing.T, ca *x509.Certificate, caKey *rsa.PrivateKey) (*x509.Certificate, *rsa.PrivateKey) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate server key: %v", err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(2),
		Subject:      pkix.Name{CommonName: "recorder-control.local"},
		DNSNames:     []string{"recorder-control.local"},
		NotBefore:    time.Now().Add(-time.Minute),
		NotAfter:     time.Now().Add(time.Hour),
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		KeyUsage:     x509.KeyUsageDigitalSignature,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, ca, &key.PublicKey, caKey)
	if err != nil {
		t.Fatalf("create server certificate: %v", err)
	}
	certificate, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatalf("parse server certificate: %v", err)
	}
	return certificate, key
}

func writePEM(t *testing.T, path string, kind string, bytes []byte) {
	t.Helper()
	data := pem.EncodeToMemory(&pem.Block{Type: kind, Bytes: bytes})
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}
