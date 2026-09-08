package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"log/slog"
	"math/big"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

func TestNewControllerHTTPClientRequiresControllerSPIFFEIdentity(t *testing.T) {
	t.Parallel()
	directory := t.TempDir()
	certificateFile, keyFile, caFile := writeControllerCertificate(t, directory, "recorder-fleet-controller")
	config := commandConfig{
		Fleet:          recorderfleet.Config{Key: recorderfleet.PoolKey{Environment: "staging", Role: workeridentity.RoleCapture}},
		ControllerCert: certificateFile, ControllerKey: keyFile, ServerCA: caFile,
		ServerName: "control.example", SPIFFETrustDomain: "workers.example.test",
	}
	client, err := newControllerHTTPClient(config)
	if err != nil {
		t.Fatalf("new controller HTTP client: %v", err)
	}
	transport, ok := client.Transport.(*http.Transport)
	if !ok || transport.TLSClientConfig == nil || transport.TLSClientConfig.MinVersion != tls.VersionTLS13 || len(transport.TLSClientConfig.Certificates) != 1 {
		t.Fatalf("controller transport = %#v", client.Transport)
	}
	if client.CheckRedirect == nil {
		t.Fatal("controller redirects were not disabled")
	}

	workerCertificate, workerKey, workerCA := writeControllerCertificate(t, t.TempDir(), "capture")
	config.ControllerCert = workerCertificate
	config.ControllerKey = workerKey
	config.ServerCA = workerCA
	if _, err := newControllerHTTPClient(config); !errors.Is(err, recorderfleet.ErrInvalidControllerIdentity) {
		t.Fatalf("worker certificate error = %v", err)
	}
}

func TestRunLoopReconcilesImmediatelyAndStopsOnCancellation(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithCancel(context.Background())
	runner := &cancelingReconciler{cancel: cancel}
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	if err := runLoop(ctx, time.Hour, runner, logger); err != nil {
		t.Fatalf("run loop: %v", err)
	}
	if runner.calls != 1 {
		t.Fatalf("reconcile calls = %d, want 1", runner.calls)
	}
	if !strings.Contains(logs.String(), `"action":"capacity_published"`) {
		t.Fatalf("log = %s", logs.String())
	}
}

type cancelingReconciler struct {
	cancel context.CancelFunc
	calls  int
}

func (r *cancelingReconciler) Reconcile(context.Context) (recorderfleet.Result, error) {
	r.calls++
	r.cancel()
	return recorderfleet.Result{
		Action: recorderfleet.ActionCapacityPublished,
		Projection: recorderfleet.PoolProjection{
			Reason: "ready", AdmissionOpen: true, ReadyCapacity: 4,
		},
	}, nil
}

func writeControllerCertificate(t *testing.T, directory, role string) (string, string, string) {
	t.Helper()
	now := time.Now()
	_, caKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate CA key: %v", err)
	}
	caTemplate := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "test-ca"},
		NotBefore: now.Add(-time.Minute), NotAfter: now.Add(time.Hour),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign,
	}
	caDER, err := x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, caKey.Public(), caKey)
	if err != nil {
		t.Fatalf("create CA: %v", err)
	}
	ca, err := x509.ParseCertificate(caDER)
	if err != nil {
		t.Fatalf("parse CA: %v", err)
	}
	_, clientKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate client key: %v", err)
	}
	spiffeID, err := url.Parse("spiffe://workers.example.test/environment/staging/" + role + "/55555555-5555-4555-8555-555555555555")
	if err != nil {
		t.Fatalf("parse SPIFFE ID: %v", err)
	}
	clientTemplate := &x509.Certificate{
		SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: role}, URIs: []*url.URL{spiffeID},
		NotBefore: now.Add(-time.Minute), NotAfter: now.Add(time.Hour),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}
	clientDER, err := x509.CreateCertificate(rand.Reader, clientTemplate, ca, clientKey.Public(), caKey)
	if err != nil {
		t.Fatalf("create client certificate: %v", err)
	}
	certificateFile := filepath.Join(directory, "controller.pem")
	keyFile := filepath.Join(directory, "controller-key.pem")
	caFile := filepath.Join(directory, "ca.pem")
	writePEM(t, certificateFile, "CERTIFICATE", clientDER)
	encodedKey, err := x509.MarshalPKCS8PrivateKey(clientKey)
	if err != nil {
		t.Fatalf("marshal client key: %v", err)
	}
	writePEM(t, keyFile, "PRIVATE KEY", encodedKey)
	writePEM(t, caFile, "CERTIFICATE", caDER)
	return certificateFile, keyFile, caFile
}

func writePEM(t *testing.T, path, blockType string, der []byte) {
	t.Helper()
	if err := os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: blockType, Bytes: der}), 0o600); err != nil {
		t.Fatalf("write PEM: %v", err)
	}
}
