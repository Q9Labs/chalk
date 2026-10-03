package recorderfleetissuer

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"math/big"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recorderbootstrapprotocol"
	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

func TestBootstrapPersistsExactIdentityCertificateAndRevocation(t *testing.T) {
	now := time.Date(2026, 9, 8, 12, 0, 0, 0, time.UTC)
	key := recorderfleet.PoolKey{Environment: "local", Role: workeridentity.RoleCapture}
	node := recorderfleet.Node{
		ProviderID: "12345", Name: "chalk-recorder-capture-local-1-test", Status: "active", Region: "fra1", Size: "c-2",
		ImageID: 77, Tags: []string{"chalk-owner", recorderfleet.EnvironmentTag("local"), recorderfleet.RoleTag(workeridentity.RoleCapture), recorderfleet.ReleaseTag("release-1"), recorderfleet.ImageTag("sha256:" + repeat("ab", 32)), recorderfleet.BootTag(1)},
		FirewallIDs: []string{"firewall-1"}, BootGeneration: 1, CreatedAt: now.Add(-time.Minute),
	}
	registrationRequest := recorderfleet.BootstrapRequest{
		Key: key, ProviderID: node.ProviderID, NodeName: node.Name, Region: node.Region, ReleaseID: "release-1",
		ImageDigest: "sha256:" + repeat("ab", 32), BootGeneration: 1, InventoryDigest: recorderfleet.InventoryDigest(node),
	}
	ca, caPEM := testCertificateAuthority(t, now)
	storePath := filepath.Join(t.TempDir(), "issuer-state.json")
	store, err := OpenStore(storePath)
	if err != nil {
		t.Fatal(err)
	}
	clock := now
	service := testService(t, store, ca, node, &clock)

	identity, delivered, err := service.Register(context.Background(), registrationRequest)
	if err != nil || delivered || identity.WorkerID == "" {
		t.Fatalf("register identity/delivered/error = %+v/%t/%v", identity, delivered, err)
	}
	csrPEM, privateKey := testCSR(t)
	diagnosticRequest := recorderbootstrapprotocol.DiagnosticRequest{
		SchemaVersion: recorderbootstrapprotocol.DiagnosticSchemaVersion, ProviderID: node.ProviderID,
		ReleaseID: registrationRequest.ReleaseID, ImageDigest: registrationRequest.ImageDigest,
		BootGeneration: registrationRequest.BootGeneration, CSRPEM: csrPEM,
		Diagnostic: recorderfleet.BootstrapDiagnostic{SchemaVersion: recorderfleet.BootstrapDiagnosticSchemaVersion, Step: "challenge", AttemptCount: 3, LastReasonCode: "bootstrap.challenge_unavailable", LastHTTPStatus: 503},
	}
	diagnosticProof, err := recorderbootstrapprotocol.CanonicalDiagnosticProof(diagnosticRequest)
	if err != nil {
		t.Fatal(err)
	}
	diagnosticRequest.Signature = base64.RawURLEncoding.EncodeToString(ed25519.Sign(privateKey, diagnosticProof))
	invalidDiagnostic := diagnosticRequest
	invalidDiagnostic.Signature = base64.RawURLEncoding.EncodeToString(make([]byte, ed25519.SignatureSize))
	if err := service.RecordDiagnostic(context.Background(), netip.MustParseAddr("192.0.2.10"), invalidDiagnostic); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("unsigned diagnostic error = %v", err)
	}
	if err := service.RecordDiagnostic(context.Background(), netip.MustParseAddr("192.0.2.10"), diagnosticRequest); err != nil {
		t.Fatalf("record diagnostic: %v", err)
	}
	stored, err := service.registration(node.ProviderID)
	if err != nil || stored.BootstrapDiagnostic == nil || *stored.BootstrapDiagnostic != diagnosticRequest.Diagnostic {
		t.Fatalf("stored diagnostic/error = %+v/%v", stored.BootstrapDiagnostic, err)
	}
	challengeRequest := recorderbootstrapprotocol.ChallengeRequest{
		SchemaVersion: recorderbootstrapprotocol.ChallengeSchemaVersion, ProviderID: node.ProviderID,
		ReleaseID: registrationRequest.ReleaseID, ImageDigest: registrationRequest.ImageDigest,
		BootGeneration: registrationRequest.BootGeneration, CSRPEM: csrPEM,
	}
	if _, err := service.Challenge(context.Background(), netip.MustParseAddr("192.0.2.11"), challengeRequest); !errors.Is(err, ErrUnauthorized) || !strings.Contains(err.Error(), "peer address differs") {
		t.Fatalf("wrong source IP challenge error = %v", err)
	}
	mismatched := challengeRequest
	mismatched.ReleaseID, mismatched.BootGeneration = "release-2", 2
	_, err = service.Challenge(context.Background(), netip.MustParseAddr("192.0.2.10"), mismatched)
	if !errors.Is(err, ErrUnauthorized) || !strings.Contains(err.Error(), `release_id sent="release-2" registered="release-1"`) || !strings.Contains(err.Error(), "boot_generation sent=2 registered=1") {
		t.Fatalf("mismatched challenge error = %v", err)
	}
	peerIP := netip.MustParseAddr("192.0.2.10")
	challenge, err := service.Challenge(context.Background(), peerIP, challengeRequest)
	if err != nil {
		t.Fatal(err)
	}
	bootstrapRequest := recorderbootstrapprotocol.BootstrapRequest{
		SchemaVersion: recorderbootstrapprotocol.BootstrapSchemaVersion, ProviderID: node.ProviderID,
		ReleaseID: registrationRequest.ReleaseID, ImageDigest: registrationRequest.ImageDigest,
		BootGeneration: registrationRequest.BootGeneration, CSRPEM: csrPEM, Nonce: challenge.Nonce,
		ExpiresAt: challenge.ExpiresAt, InventoryDigest: challenge.InventoryDigest,
	}
	proof, err := recorderbootstrapprotocol.CanonicalBootstrapProof(bootstrapRequest)
	if err != nil {
		t.Fatal(err)
	}
	bootstrapRequest.Signature = base64.RawURLEncoding.EncodeToString(ed25519.Sign(privateKey, proof))
	bootstrap, err := service.Bootstrap(context.Background(), peerIP, bootstrapRequest)
	if err != nil {
		t.Fatal(err)
	}
	if bootstrap.Identity != identity || bootstrap.ClientCertificatePEM == "" || bootstrap.ClientCAChainPEM != string(caPEM) || bootstrap.RenewalEndpoint != "https://issuer.example.test"+recorderbootstrapprotocol.RenewPath {
		t.Fatalf("unexpected bootstrap response: %+v", bootstrap)
	}
	certificate := parseCertificate(t, bootstrap.ClientCertificatePEM)
	wantURI := "spiffe://workers.example.test/environment/local/capture/" + identity.WorkerID
	if len(certificate.URIs) != 1 || certificate.URIs[0].String() != wantURI || certificate.NotAfter.Sub(clock) != 12*time.Hour {
		t.Fatalf("worker certificate identity/lifetime = %v/%s", certificate.URIs, certificate.NotAfter.Sub(clock))
	}

	_, delivered, err = service.Register(context.Background(), registrationRequest)
	if err != nil || !delivered {
		t.Fatalf("delivered registration state = %t, %v", delivered, err)
	}
	reopened, err := OpenStore(storePath)
	if err != nil {
		t.Fatal(err)
	}
	restarted := testService(t, reopened, ca, node, &clock)
	clock = clock.Add(3 * time.Minute)
	replayed, err := restarted.Bootstrap(context.Background(), peerIP, bootstrapRequest)
	if err != nil || replayed.ClientCertificatePEM != bootstrap.ClientCertificatePEM || replayed.Identity != identity {
		t.Fatalf("bootstrap replay changed result: %+v, %v", replayed, err)
	}

	clock = clock.Add(5*time.Hour - 3*time.Minute)
	workerID, _ := utilities.ParseID(identity.WorkerID)
	renewed, err := restarted.Renew(context.Background(), peerIP, workeridentity.Identity{WorkerID: workerID, Role: identity.Role}, recorderbootstrapprotocol.RenewRequest{
		SchemaVersion: recorderbootstrapprotocol.RenewSchemaVersion, CSRPEM: csrPEM,
	})
	if err != nil || renewed.ClientCertificatePEM == bootstrap.ClientCertificatePEM {
		t.Fatalf("renewed certificate/error = %t/%v", renewed.ClientCertificatePEM != bootstrap.ClientCertificatePEM, err)
	}
	retried, err := restarted.Renew(context.Background(), peerIP, workeridentity.Identity{WorkerID: workerID, Role: identity.Role}, recorderbootstrapprotocol.RenewRequest{
		SchemaVersion: recorderbootstrapprotocol.RenewSchemaVersion, CSRPEM: csrPEM,
	})
	if err != nil || retried.ClientCertificatePEM != renewed.ClientCertificatePEM {
		t.Fatalf("renew retry changed certificate: %v", err)
	}
	if err := restarted.AbandonBootstrap(registrationRequest); err != nil {
		t.Fatal(err)
	}
	if err := reopened.read(func(state persistedState) error {
		if len(state.Challenges) != 0 || state.Abandonments[node.ProviderID] == nil || state.Abandonments[node.ProviderID].Request != registrationRequest {
			t.Fatalf("abandoned issuer state = %+v", state)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	crlPEM, err := restarted.RevocationList()
	if err != nil {
		t.Fatal(err)
	}
	block, _ := pem.Decode(crlPEM)
	crl, err := x509.ParseRevocationList(block.Bytes)
	if err != nil || len(crl.RevokedCertificateEntries) != 2 {
		t.Fatalf("revocation entries/error = %d/%v", len(crl.RevokedCertificateEntries), err)
	}
	reopenedAfterRevoke, err := OpenStore(storePath)
	if err != nil {
		t.Fatal(err)
	}
	afterRestart := testService(t, reopenedAfterRevoke, ca, node, &clock)
	if _, _, err := afterRestart.Register(context.Background(), registrationRequest); err != ErrConflict {
		t.Fatalf("revocation was not durable: %v", err)
	}
}

func TestAbandonBootstrapBeforeRegisterPersistsFailClosedTombstone(t *testing.T) {
	now := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	node := recorderfleet.Node{
		ProviderID: "12345", Name: "chalk-recorder-capture-local-1-test", Status: "active", Region: "fra1", Size: "c-2", ImageID: 77,
		Tags:        []string{"chalk-owner", recorderfleet.EnvironmentTag("local"), recorderfleet.RoleTag(workeridentity.RoleCapture), recorderfleet.ReleaseTag("release-1"), recorderfleet.ImageTag("sha256:" + repeat("ab", 32)), recorderfleet.BootTag(1)},
		FirewallIDs: []string{"firewall-1"}, BootGeneration: 1, CreatedAt: now.Add(-time.Minute),
	}
	request := recorderfleet.BootstrapRequest{
		Key:        recorderfleet.PoolKey{Environment: "local", Role: workeridentity.RoleCapture},
		ProviderID: node.ProviderID, NodeName: node.Name, Region: node.Region, ReleaseID: "release-1",
		ImageDigest: "sha256:" + repeat("ab", 32), BootGeneration: 1, InventoryDigest: recorderfleet.InventoryDigest(node),
	}
	ca, _ := testCertificateAuthority(t, now)
	path := filepath.Join(t.TempDir(), "issuer-state.json")
	store, err := OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	service := testService(t, store, ca, node, &now)
	if err := service.AbandonBootstrap(request); err != nil {
		t.Fatalf("abandon missing registration: %v", err)
	}
	if err := service.AbandonBootstrap(request); err != nil {
		t.Fatalf("idempotent abandon: %v", err)
	}

	reopened, err := OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	restarted := testService(t, reopened, ca, node, &now)
	if _, _, err := restarted.Register(context.Background(), request); err != ErrConflict {
		t.Fatalf("late registration error = %v", err)
	}
	mismatch := request
	mismatch.ReleaseID = "release-2"
	if err := restarted.AbandonBootstrap(mismatch); err != ErrConflict {
		t.Fatalf("mismatched abandonment error = %v", err)
	}
	if err := reopened.read(func(state persistedState) error {
		tombstone := state.Abandonments[request.ProviderID]
		if tombstone == nil || tombstone.Request != request || !tombstone.RevokedAt.Equal(now) {
			t.Fatalf("durable tombstone = %+v", tombstone)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestOpenStoreMigratesLegacyStateToFailClosedSchema(t *testing.T) {
	path := filepath.Join(t.TempDir(), "issuer-state.json")
	legacy := newState()
	legacy.SchemaVersion = legacySchemaVersion
	legacy.Abandonments = nil
	encoded, err := json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := OpenStore(path)
	if err != nil {
		t.Fatalf("migrate legacy store: %v", err)
	}
	if err := store.read(func(state persistedState) error {
		if state.SchemaVersion != stateSchemaVersion || state.Abandonments == nil {
			t.Fatalf("migrated state = %+v", state)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var persisted persistedState
	if err := json.Unmarshal(contents, &persisted); err != nil || persisted.SchemaVersion != stateSchemaVersion || persisted.Abandonments == nil {
		t.Fatalf("persisted migration = %+v, %v", persisted, err)
	}
}

func TestAbandonBootstrapBlocksRegisterAlreadyInspectingInventory(t *testing.T) {
	now := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	node := recorderfleet.Node{
		ProviderID: "12345", Name: "chalk-recorder-capture-local-1-test", Status: "active", Region: "fra1", Size: "c-2", ImageID: 77,
		Tags:        []string{"chalk-owner", recorderfleet.EnvironmentTag("local"), recorderfleet.RoleTag(workeridentity.RoleCapture), recorderfleet.ReleaseTag("release-1"), recorderfleet.ImageTag("sha256:" + repeat("ab", 32)), recorderfleet.BootTag(1)},
		FirewallIDs: []string{"firewall-1"}, BootGeneration: 1, CreatedAt: now.Add(-time.Minute),
	}
	request := recorderfleet.BootstrapRequest{
		Key:        recorderfleet.PoolKey{Environment: "local", Role: workeridentity.RoleCapture},
		ProviderID: node.ProviderID, NodeName: node.Name, Region: node.Region, ReleaseID: "release-1",
		ImageDigest: "sha256:" + repeat("ab", 32), BootGeneration: 1, InventoryDigest: recorderfleet.InventoryDigest(node),
	}
	ca, _ := testCertificateAuthority(t, now)
	store, err := OpenStore(filepath.Join(t.TempDir(), "issuer-state.json"))
	if err != nil {
		t.Fatal(err)
	}
	inventory := &blockingInventoryStub{
		node: node, ip: netip.MustParseAddr("192.0.2.10"), entered: make(chan struct{}), release: make(chan struct{}),
	}
	service, err := New(Config{
		Environment: "local", OwnerTag: "chalk-owner", Store: store, Inventory: inventory, CertificateAuthority: ca,
		ControlPlaneURL: "https://control.example.test", ControlPlaneServerName: "control.example.test",
		ControlPlaneServerCAPEM: "control-ca", PublicBaseURL: "https://issuer.example.test", Now: func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}
	registerResult := make(chan error, 1)
	go func() {
		_, _, err := service.Register(context.Background(), request)
		registerResult <- err
	}()
	<-inventory.entered
	if err := service.AbandonBootstrap(request); err != nil {
		t.Fatalf("abandon during registration: %v", err)
	}
	close(inventory.release)
	if err := <-registerResult; err != ErrConflict {
		t.Fatalf("in-flight registration error = %v", err)
	}
}

type inventoryStub struct {
	node recorderfleet.Node
	ip   netip.Addr
	err  error
}

type blockingInventoryStub struct {
	node    recorderfleet.Node
	ip      netip.Addr
	entered chan struct{}
	release chan struct{}
}

func (stub *blockingInventoryStub) InspectNode(_ context.Context, _ recorderfleet.PoolKey, _ string) (recorderfleet.Node, netip.Addr, error) {
	close(stub.entered)
	<-stub.release
	return stub.node, stub.ip, nil
}

func (stub inventoryStub) InspectNode(_ context.Context, _ recorderfleet.PoolKey, _ string) (recorderfleet.Node, netip.Addr, error) {
	return stub.node, stub.ip, stub.err
}

func testService(t *testing.T, store *Store, ca *CertificateAuthority, node recorderfleet.Node, clock *time.Time) *Service {
	t.Helper()
	service, err := New(Config{
		Environment: "local", OwnerTag: "chalk-owner", Store: store,
		Inventory: inventoryStub{node: node, ip: netip.MustParseAddr("192.0.2.10")}, CertificateAuthority: ca,
		ControlPlaneURL: "https://control.example.test", ControlPlaneServerName: "control.example.test",
		ControlPlaneServerCAPEM: "control-ca", PublicBaseURL: "https://issuer.example.test",
		Now: func() time.Time { return *clock },
	})
	if err != nil {
		t.Fatal(err)
	}
	return service
}

func testCertificateAuthority(t *testing.T, now time.Time) (*CertificateAuthority, []byte) {
	t.Helper()
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "test worker CA"},
		NotBefore: now.Add(-time.Hour), NotAfter: now.Add(24 * time.Hour), IsCA: true, BasicConstraintsValid: true,
		KeyUsage:     x509.KeyUsageCertSign | x509.KeyUsageCRLSign | x509.KeyUsageDigitalSignature,
		SubjectKeyId: []byte{1, 2, 3, 4},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, publicKey, privateKey)
	if err != nil {
		t.Fatal(err)
	}
	caPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyDER, err := x509.MarshalPKCS8PrivateKey(privateKey)
	if err != nil {
		t.Fatal(err)
	}
	authority, err := NewCertificateAuthority(caPEM, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER}), "workers.example.test")
	if err != nil {
		t.Fatal(err)
	}
	return authority, caPEM
}

func testCSR(t *testing.T) (string, ed25519.PrivateKey) {
	t.Helper()
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{Subject: pkix.Name{CommonName: "bootstrap"}}, privateKey)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: der})), privateKey
}

func parseCertificate(t *testing.T, encoded string) *x509.Certificate {
	t.Helper()
	block, _ := pem.Decode([]byte(encoded))
	certificate, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	return certificate
}

func repeat(value string, count int) string {
	result := ""
	for range count {
		result += value
	}
	return result
}

func TestRegisterWaitsForInventoryWithoutRelaxingIdentityChecks(t *testing.T) {
	now := time.Now().UTC()
	node := recorderfleet.Node{
		ProviderID: "12345", Name: "chalk-recorder-capture-local-1-test", Status: "active", Region: "fra1", Size: "c-2", ImageID: 77,
		Tags:        []string{"chalk-owner", recorderfleet.EnvironmentTag("local"), recorderfleet.RoleTag(workeridentity.RoleCapture), recorderfleet.ReleaseTag("release-1"), recorderfleet.ImageTag("sha256:" + repeat("ab", 32)), recorderfleet.BootTag(1)},
		FirewallIDs: []string{"firewall-1"}, BootGeneration: 1, CreatedAt: now.Add(-30 * time.Second),
	}
	request := recorderfleet.BootstrapRequest{Key: recorderfleet.PoolKey{Environment: "local", Role: workeridentity.RoleCapture}, ProviderID: node.ProviderID, NodeName: node.Name, Region: node.Region, ReleaseID: "release-1", ImageDigest: "sha256:" + repeat("ab", 32), BootGeneration: 1, InventoryDigest: recorderfleet.InventoryDigest(node)}
	ca, _ := testCertificateAuthority(t, now)
	for _, test := range []struct {
		name      string
		mutate    func(*recorderfleet.Node)
		missingIP bool
		want      error
	}{
		{"new", func(n *recorderfleet.Node) { n.Status = "new" }, false, recorderfleet.ErrInventoryNotReady},
		{"no public IP", func(*recorderfleet.Node) {}, true, recorderfleet.ErrInventoryNotReady},
		{"off", func(n *recorderfleet.Node) { n.Status = "off" }, false, ErrUnauthorized},
		{"unknown status", func(n *recorderfleet.Node) { n.Status = "unknown" }, false, ErrUnauthorized},
		{"wrong image while new", func(n *recorderfleet.Node) { n.Status = "new"; n.ImageID++ }, false, ErrUnauthorized},
		{"wrong tags without IP", func(n *recorderfleet.Node) { n.Tags = []string{"other"} }, true, ErrUnauthorized},
		{"wrong firewall while new", func(n *recorderfleet.Node) { n.Status = "new"; n.FirewallIDs = nil }, false, ErrUnauthorized},
		{"wrong name while new", func(n *recorderfleet.Node) { n.Status = "new"; n.Name = "other" }, false, ErrUnauthorized},
		{"wrong generation while new", func(n *recorderfleet.Node) { n.Status = "new"; n.BootGeneration++ }, false, ErrUnauthorized},
	} {
		t.Run(test.name, func(t *testing.T) {
			store, err := OpenStore(filepath.Join(t.TempDir(), "issuer.json"))
			if err != nil {
				t.Fatal(err)
			}
			service := testService(t, store, ca, node, &now)
			observed := node
			test.mutate(&observed)
			inventory := inventoryStub{node: observed, ip: netip.MustParseAddr("192.0.2.10")}
			if test.missingIP {
				inventory.ip = netip.Addr{}
				inventory.err = recorderfleet.ErrInventoryNotReady
			}
			service.inventory = inventory
			identity, _, err := service.Register(t.Context(), request)
			if !errors.Is(err, test.want) || identity != (recorderfleet.NodeIdentity{}) {
				t.Fatalf("identity/error = %+v/%v, want %v", identity, err, test.want)
			}
			if err := store.read(func(state persistedState) error {
				if len(state.Registrations) != 0 {
					t.Fatal("ineligible node registered")
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			service.inventory = inventoryStub{node: node, ip: netip.MustParseAddr("192.0.2.10")}
			identity, delivered, err := service.Register(t.Context(), request)
			if err != nil || delivered || identity.WorkerID == "" {
				t.Fatalf("eligible retry = %+v/%v/%v", identity, delivered, err)
			}
			if _, err := service.verifyInventory(t.Context(), request, netip.MustParseAddr("192.0.2.99")); !errors.Is(err, ErrUnauthorized) {
				t.Fatalf("wrong peer accepted: %v", err)
			}
		})
	}
}
