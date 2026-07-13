package httpapi_test

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	postgresadapter "github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/providerbridge"
	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
	"github.com/q9labs/chalk/apps/api/internal/syncidentity"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const (
	crossRuntimeEnabledEnv = "CHALK_PROVIDER_BRIDGE_CROSS_RUNTIME"
	databaseURLEnv         = "CHALK_DATABASE_URL"
	e2eEnabledEnv          = "CHALK_PROVIDER_BRIDGE_E2E"
	e2eBaseURLEnv          = "CHALK_PROVIDER_BRIDGE_E2E_URL"
	e2eCertFileEnv         = "CHALK_PROVIDER_BRIDGE_E2E_CERTFILE"
	e2eKeyFileEnv          = "CHALK_PROVIDER_BRIDGE_E2E_KEYFILE"
	e2eCAFileEnv           = "CHALK_PROVIDER_BRIDGE_E2E_CAFILE"
	e2eDatabaseURLEnv      = "CHALK_PROVIDER_BRIDGE_E2E_DATABASE_URL"
)

func TestProviderBridgeCrossRuntime(t *testing.T) {
	if os.Getenv(crossRuntimeEnabledEnv) != "1" {
		t.Skip("set CHALK_PROVIDER_BRIDGE_CROSS_RUNTIME=1 for cross-runtime proof")
	}
	databaseURL := strings.TrimSpace(os.Getenv(databaseURLEnv))
	if databaseURL == "" {
		t.Skip("set CHALK_DATABASE_URL for cross-runtime proof")
	}

	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open cross-runtime postgres pool: %v", err)
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		t.Fatalf("ping cross-runtime postgres pool: %v", err)
	}

	executor := &crossRuntimeExecutor{pool: pool}
	repository := postgresadapter.NewProviderOperationRepositoryWithPool(pool)
	service := providerbridge.NewService(repository, executor)
	verifier, err := syncidentity.NewVerifier("chalkmeet.com", "staging")
	if err != nil {
		t.Fatalf("create sync identity verifier: %v", err)
	}

	certificates := newCrossRuntimeCertificates(t)
	server := httptest.NewUnstartedServer(httpapi.NewProviderBridgeHandler(service, verifier))
	server.TLS = &tls.Config{
		MinVersion:   tls.VersionTLS13,
		ClientAuth:   tls.RequireAndVerifyClientCert,
		ClientCAs:    certificates.clientCAPool,
		Certificates: []tls.Certificate{certificates.serverCertificate},
	}
	server.StartTLS()
	defer server.Close()

	command := exec.Command("mix", "test", "test/chalk_sync/provider_bridge/e2e_test.exs", "--seed", "0")
	command.Dir = filepath.Join(repositoryRoot(t), "apps", "sync")
	command.Env = withEnvironment(os.Environ(), map[string]string{
		e2eEnabledEnv:                  "1",
		e2eBaseURLEnv:                  server.URL,
		e2eCertFileEnv:                 certificates.clientCertFile,
		e2eKeyFileEnv:                  certificates.clientKeyFile,
		e2eCAFileEnv:                   certificates.caFile,
		e2eDatabaseURLEnv:              databaseURL,
		"CHALK_SYNC_TEST_DATABASE_URL": databaseURL,
	})

	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("cross-runtime Elixir proof failed: %v\n%s", err, output)
	}

	dispatchCalls, dispatchState, operationID, dispatchError := executor.snapshot()
	if dispatchCalls != 1 {
		t.Fatalf("fake provider dispatch calls = %d, want 1\n%s", dispatchCalls, output)
	}
	if dispatchState != "dispatching" {
		t.Fatalf("receipt state observed by fake provider = %q, want dispatching\n%s", dispatchState, output)
	}
	if dispatchError != nil {
		t.Fatalf("fake provider receipt lookup: %v\n%s", dispatchError, output)
	}
	if operationID == "" {
		t.Fatal("fake provider did not receive an operation id")
	}

	cleanupQueries := []string{
		`delete from provider_operation_observations where tenant_id in (
			select tenant_id from provider_operation_receipts where operation_id = $1
		)`,
		`delete from provider_operation_observation_heads where tenant_id in (
			select tenant_id from provider_operation_receipts where operation_id = $1
		)`,
		`delete from provider_operation_receipts where operation_id = $1`,
	}
	for _, query := range cleanupQueries {
		if _, err := pool.Exec(ctx, query, operationID); err != nil {
			t.Fatalf("clean Go provider receipt: %v", err)
		}
	}
}

type crossRuntimeExecutor struct {
	pool          *pgxpool.Pool
	mu            sync.Mutex
	dispatchCalls int
	operationID   string
	dispatchState string
	dispatchError error
}

func (e *crossRuntimeExecutor) Dispatch(ctx context.Context, input provideroperations.OperationInput) providerbridge.ExecutionResult {
	var state string
	err := e.pool.QueryRow(ctx, `
		select state
		from provider_operation_receipts
		where operation_id = $1 and effect = $2`, input.OperationID, string(input.Effect)).Scan(&state)

	e.mu.Lock()
	e.dispatchCalls++
	e.operationID = input.OperationID
	e.dispatchState = state
	e.dispatchError = err
	e.mu.Unlock()

	return providerbridge.ExecutionResult{Outcome: provideroperations.OutcomeConfirmed}
}

func (e *crossRuntimeExecutor) snapshot() (int, string, string, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.dispatchCalls, e.dispatchState, e.operationID, e.dispatchError
}

func (*crossRuntimeExecutor) Reconcile(context.Context, provideroperations.OperationInput) providerbridge.ExecutionResult {
	return providerbridge.ExecutionResult{Outcome: provideroperations.OutcomeConfirmed}
}

type crossRuntimeCertificates struct {
	caFile            string
	clientCertFile    string
	clientKeyFile     string
	clientCAPool      *x509.CertPool
	serverCertificate tls.Certificate
}

func newCrossRuntimeCertificates(t *testing.T) crossRuntimeCertificates {
	t.Helper()
	directory := t.TempDir()
	now := time.Now()

	caKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate cross-runtime CA key: %v", err)
	}
	caCertificate := &x509.Certificate{
		SerialNumber:          crossRuntimeSerial(t),
		Subject:               pkix.Name{CommonName: "chalk cross-runtime test CA"},
		NotBefore:             now.Add(-5 * time.Minute),
		NotAfter:              now.Add(time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign | x509.KeyUsageDigitalSignature,
	}
	caDER, err := x509.CreateCertificate(rand.Reader, caCertificate, caCertificate, &caKey.PublicKey, caKey)
	if err != nil {
		t.Fatalf("create cross-runtime CA certificate: %v", err)
	}
	caPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER})
	caPool := x509.NewCertPool()
	if !caPool.AppendCertsFromPEM(caPEM) {
		t.Fatal("append cross-runtime CA certificate")
	}

	serverCertificate, _, _ := crossRuntimeLeafCertificate(t, caCertificate, caKey, "chalk cross-runtime server", nil, []string{"localhost"}, []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")}, x509.ExtKeyUsageServerAuth)
	clientURI, err := url.Parse(fmt.Sprintf("spiffe://chalkmeet.com/environment/staging/sync/%s", crossRuntimeID(t)))
	if err != nil {
		t.Fatalf("parse sync SPIFFE URI: %v", err)
	}
	_, clientPEM, clientKeyPEM := crossRuntimeLeafCertificate(t, caCertificate, caKey, "chalk cross-runtime sync", []*url.URL{clientURI}, nil, nil, x509.ExtKeyUsageClientAuth)

	caFile := crossRuntimeWriteFile(t, directory, "ca.pem", caPEM)
	clientCertFile := crossRuntimeWriteFile(t, directory, "sync-client.pem", clientPEM)
	clientKeyFile := crossRuntimeWriteFile(t, directory, "sync-client-key.pem", clientKeyPEM)
	return crossRuntimeCertificates{
		caFile:            caFile,
		clientCertFile:    clientCertFile,
		clientKeyFile:     clientKeyFile,
		clientCAPool:      caPool,
		serverCertificate: serverCertificate,
	}
}

func crossRuntimeLeafCertificate(t *testing.T, ca *x509.Certificate, caKey *rsa.PrivateKey, commonName string, uris []*url.URL, dnsNames []string, ipAddresses []net.IP, usage x509.ExtKeyUsage) (tls.Certificate, []byte, []byte) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate %s key: %v", commonName, err)
	}
	template := &x509.Certificate{
		SerialNumber:          crossRuntimeSerial(t),
		Subject:               pkix.Name{CommonName: commonName},
		NotBefore:             ca.NotBefore,
		NotAfter:              ca.NotAfter,
		DNSNames:              dnsNames,
		IPAddresses:           ipAddresses,
		URIs:                  uris,
		ExtKeyUsage:           []x509.ExtKeyUsage{usage},
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, ca, &key.PublicKey, caKey)
	if err != nil {
		t.Fatalf("create %s certificate: %v", commonName, err)
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})
	return mustTLSCertificate(t, certPEM, keyPEM), certPEM, keyPEM
}

func mustTLSCertificate(t *testing.T, certPEM, keyPEM []byte) tls.Certificate {
	t.Helper()
	certificate, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		t.Fatalf("load cross-runtime TLS certificate: %v", err)
	}
	return certificate
}

func crossRuntimeWriteFile(t *testing.T, directory, name string, contents []byte) string {
	t.Helper()
	path := filepath.Join(directory, name)
	if err := os.WriteFile(path, contents, 0o600); err != nil {
		t.Fatalf("write temporary cross-runtime certificate %s: %v", name, err)
	}
	return path
}

func crossRuntimeSerial(t *testing.T) *big.Int {
	t.Helper()
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 120))
	if err != nil {
		t.Fatalf("generate cross-runtime certificate serial: %v", err)
	}
	return serial
}

func crossRuntimeID(t *testing.T) string {
	t.Helper()
	id, err := utilities.NewID()
	if err != nil {
		t.Fatalf("generate cross-runtime SPIFFE id: %v", err)
	}
	return id.String()
}

func repositoryRoot(t *testing.T) string {
	t.Helper()
	workingDirectory, err := os.Getwd()
	if err != nil {
		t.Fatalf("get API test working directory: %v", err)
	}
	return filepath.Clean(filepath.Join(workingDirectory, "..", "..", "..", ".."))
}

func withEnvironment(base []string, values map[string]string) []string {
	result := make([]string, 0, len(base)+len(values))
	for _, value := range base {
		key, _, found := strings.Cut(value, "=")
		if !found {
			continue
		}
		if _, replace := values[key]; !replace {
			result = append(result, value)
		}
	}
	for key, value := range values {
		result = append(result, key+"="+value)
	}
	return result
}
