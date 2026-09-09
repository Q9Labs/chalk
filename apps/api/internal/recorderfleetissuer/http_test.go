package recorderfleetissuer

import (
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recorderbootstrapprotocol"
	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

func TestControllerRegistrationReturnsIdentityOnlyAfterNodeDelivery(t *testing.T) {
	now := time.Date(2026, 9, 8, 12, 0, 0, 0, time.UTC)
	key := recorderfleet.PoolKey{Environment: "local", Role: workeridentity.RoleCapture}
	node := recorderfleet.Node{
		ProviderID: "12345", Name: "chalk-recorder-capture-local-1-test", Status: "active", Region: "fra1", Size: "c-2", ImageID: 77,
		Tags:        []string{"chalk-owner", recorderfleet.EnvironmentTag("local"), recorderfleet.RoleTag(workeridentity.RoleCapture), recorderfleet.ReleaseTag("release-1"), recorderfleet.ImageTag("sha256:" + repeat("ab", 32)), recorderfleet.BootTag(1)},
		FirewallIDs: []string{"firewall-1"}, BootGeneration: 1, CreatedAt: now.Add(-time.Minute),
	}
	bootstrapRequest := recorderfleet.BootstrapRequest{
		Key: key, ProviderID: node.ProviderID, NodeName: node.Name, Region: node.Region, ReleaseID: "release-1",
		ImageDigest: "sha256:" + repeat("ab", 32), BootGeneration: 1, InventoryDigest: recorderfleet.InventoryDigest(node),
	}
	ca, _ := testCertificateAuthority(t, now)
	store, err := OpenStore(filepath.Join(t.TempDir(), "issuer-state.json"))
	if err != nil {
		t.Fatal(err)
	}
	service := testService(t, store, ca, node, &now)
	controllerVerifier, _ := recorderfleet.NewControllerVerifier("workers.example.test", "local")
	workerVerifier, _ := workeridentity.NewVerifier("workers.example.test", "local")
	handler, err := NewHTTPHandler(service, controllerVerifier, workerVerifier, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(registerRequest{
		SchemaVersion: recorderbootstrapprotocol.ControllerBootstrapSchemaVersion, BootstrapRequest: bootstrapRequest,
	})

	unauthenticated := httptest.NewRequest(http.MethodPost, recorderbootstrapprotocol.ControllerBootstrapPath, bytes.NewReader(encoded))
	unauthenticated.Header.Set("X-Forwarded-For", "192.0.2.10")
	unauthenticatedResponse := httptest.NewRecorder()
	handler.ServeHTTP(unauthenticatedResponse, unauthenticated)
	if unauthenticatedResponse.Code != http.StatusForbidden {
		t.Fatalf("unauthenticated controller status = %d", unauthenticatedResponse.Code)
	}

	controllerURI, _ := url.Parse("spiffe://workers.example.test/environment/local/recorder-fleet-controller/55555555-5555-4555-8555-555555555555")
	controllerCertificate := &x509.Certificate{NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), URIs: []*url.URL{controllerURI}}
	requestTLS := &tls.ConnectionState{PeerCertificates: []*x509.Certificate{controllerCertificate}, VerifiedChains: [][]*x509.Certificate{{controllerCertificate}}}
	first := httptest.NewRequest(http.MethodPost, recorderbootstrapprotocol.ControllerBootstrapPath, bytes.NewReader(encoded))
	first.TLS = requestTLS
	firstResponse := httptest.NewRecorder()
	handler.ServeHTTP(firstResponse, first)
	if firstResponse.Code != http.StatusAccepted {
		t.Fatalf("pending registration status/body = %d/%s", firstResponse.Code, firstResponse.Body.String())
	}

	if err := store.update(func(state *persistedState) error {
		state.Registrations[node.ProviderID].Certificates["1"] = certificateRecord{SerialNumber: "1"}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	second := httptest.NewRequest(http.MethodPost, recorderbootstrapprotocol.ControllerBootstrapPath, bytes.NewReader(encoded))
	second.TLS = requestTLS
	secondResponse := httptest.NewRecorder()
	handler.ServeHTTP(secondResponse, second)
	if secondResponse.Code != http.StatusOK {
		t.Fatalf("delivered registration status/body = %d/%s", secondResponse.Code, secondResponse.Body.String())
	}
	var response registerResponse
	if err := json.NewDecoder(secondResponse.Body).Decode(&response); err != nil || response.Identity.ProviderID != node.ProviderID || response.Identity.WorkerID == "" {
		t.Fatalf("delivered registration response/error = %+v/%v", response, err)
	}
	abandonBody, _ := json.Marshal(abandonRequest{
		SchemaVersion: recorderbootstrapprotocol.ControllerAbandonSchemaVersion, BootstrapRequest: bootstrapRequest,
	})
	abandon := httptest.NewRequest(http.MethodPost, recorderbootstrapprotocol.ControllerAbandonPath, bytes.NewReader(abandonBody))
	abandon.TLS = requestTLS
	abandonResponse := httptest.NewRecorder()
	handler.ServeHTTP(abandonResponse, abandon)
	if abandonResponse.Code != http.StatusNoContent {
		t.Fatalf("abandon status/body = %d/%s", abandonResponse.Code, abandonResponse.Body.String())
	}
	late := httptest.NewRequest(http.MethodPost, recorderbootstrapprotocol.ControllerBootstrapPath, bytes.NewReader(encoded))
	late.TLS = requestTLS
	lateResponse := httptest.NewRecorder()
	handler.ServeHTTP(lateResponse, late)
	if lateResponse.Code != http.StatusForbidden {
		t.Fatalf("late registration status/body = %d/%s", lateResponse.Code, lateResponse.Body.String())
	}
}
