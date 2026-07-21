package providerbridgeserver

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"io"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/config"
)

func TestServerRequiresMutualTLSAndShutsDown(t *testing.T) {
	cfg, roots, clientCertificate := testConfig(t)
	server, err := New(cfg, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "ready")
	}))
	if err != nil {
		t.Fatalf("new provider bridge server: %v", err)
	}
	result, err := server.Start()
	if err != nil {
		t.Fatalf("start provider bridge server: %v", err)
	}

	client := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{
		MinVersion:   tls.VersionTLS13,
		RootCAs:      roots,
		Certificates: []tls.Certificate{clientCertificate},
	}}}
	response, err := client.Get("https://" + server.Address() + "/healthz")
	if err != nil {
		t.Fatalf("get provider bridge health: %v", err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("health status = %d, want 200", response.StatusCode)
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		t.Fatalf("shutdown provider bridge server: %v", err)
	}
	if err := <-result; err != nil {
		t.Fatalf("serve provider bridge: %v", err)
	}
}

func TestServerRejectsIncompleteConfig(t *testing.T) {
	if _, err := New(config.ProviderBridgeConfig{Enabled: true, Address: "127.0.0.1:0"}, http.NotFoundHandler()); err == nil {
		t.Fatal("incomplete provider bridge config accepted")
	}
}

func testConfig(t *testing.T) (config.ProviderBridgeConfig, *x509.CertPool, tls.Certificate) {
	t.Helper()
	directory := t.TempDir()
	caCertificate, caKey, caPEM, _ := createCertificate(t, nil, nil, true, x509.ExtKeyUsageAny)
	_, _, serverCertificatePEM, serverKey := createCertificate(t, caCertificate, caKey, false, x509.ExtKeyUsageServerAuth)
	_, _, clientCertificatePEM, clientKey := createCertificate(t, caCertificate, caKey, false, x509.ExtKeyUsageClientAuth)

	serverCertFile := writeTestPEM(t, directory, "server.pem", serverCertificatePEM)
	serverKeyFile := writeTestPEM(t, directory, "server-key.pem", serverKey)
	caFile := writeTestPEM(t, directory, "ca.pem", caPEM)
	clientCertificate, err := tls.X509KeyPair(clientCertificatePEM, clientKey)
	if err != nil {
		t.Fatalf("load client key pair: %v", err)
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(caPEM) {
		t.Fatal("append test ca")
	}
	return config.ProviderBridgeConfig{
		Enabled: true, Address: "127.0.0.1:0", ServerCertFile: serverCertFile,
		ServerKeyFile: serverKeyFile, ClientCAFile: caFile, SPIFFETrustDomain: "chalk.test",
	}, roots, clientCertificate
}

func createCertificate(t *testing.T, parent *x509.Certificate, parentKey *ecdsa.PrivateKey, isCA bool, usage x509.ExtKeyUsage) (*x509.Certificate, *ecdsa.PrivateKey, []byte, []byte) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: pkix.Name{CommonName: "provider-bridge-test"},
		NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour),
		BasicConstraintsValid: true, IsCA: isCA, KeyUsage: x509.KeyUsageDigitalSignature,
	}
	if isCA {
		template.KeyUsage |= x509.KeyUsageCertSign
	} else {
		template.ExtKeyUsage = []x509.ExtKeyUsage{usage}
		template.IPAddresses = []net.IP{net.ParseIP("127.0.0.1")}
	}
	if parent == nil {
		parent, parentKey = template, key
	}
	der, err := x509.CreateCertificate(rand.Reader, template, parent, &key.PublicKey, parentKey)
	if err != nil {
		t.Fatalf("create certificate: %v", err)
	}
	certificate, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatalf("parse certificate: %v", err)
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatalf("marshal key: %v", err)
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER})
	return certificate, key, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), keyPEM
}

func writeTestPEM(t *testing.T, directory string, name string, data []byte) string {
	t.Helper()
	path := filepath.Join(directory, name)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
	return path
}
