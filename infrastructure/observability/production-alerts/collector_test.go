package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// newSFUFleet is a throwaway CA, one server per handler that requires a client
// certificate signed by it over TLS 1.3, and the files the collector reads. Every
// returned probe shares the one certificate, like the production nodes.
func newSFUFleet(t *testing.T, handlers ...http.HandlerFunc) ([]sfuProbe, []*httptest.Server) {
	t.Helper()
	dir := t.TempDir()
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	caTemplate := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "test ca"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
	caDER, err := x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, &caKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	caCert, err := x509.ParseCertificate(caDER)
	if err != nil {
		t.Fatal(err)
	}
	issue := func(serial int64, usage x509.ExtKeyUsage) tls.Certificate {
		key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		template := &x509.Certificate{SerialNumber: big.NewInt(serial), Subject: pkix.Name{CommonName: "test"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), ExtKeyUsage: []x509.ExtKeyUsage{usage}, KeyUsage: x509.KeyUsageDigitalSignature, DNSNames: []string{"chalk-sfu"}}
		der, err := x509.CreateCertificate(rand.Reader, template, caCert, &key.PublicKey, caKey)
		if err != nil {
			t.Fatal(err)
		}
		return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
	}
	write := func(name, kind string, der []byte) string {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: kind, Bytes: der}), 0o600); err != nil {
			t.Fatal(err)
		}
		return path
	}
	client := issue(2, x509.ExtKeyUsageClientAuth)
	clientKey, err := x509.MarshalPKCS8PrivateKey(client.PrivateKey)
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(caCert)
	clientCertFile := write("client.pem", "CERTIFICATE", client.Certificate[0])
	clientKeyFile := write("client-key.pem", "PRIVATE KEY", clientKey)
	caFile := write("ca.pem", "CERTIFICATE", caDER)
	serverCert := issue(3, x509.ExtKeyUsageServerAuth)
	var probes []sfuProbe
	var servers []*httptest.Server
	for _, handler := range handlers {
		server := httptest.NewUnstartedServer(handler)
		server.TLS = &tls.Config{Certificates: []tls.Certificate{serverCert}, ClientCAs: roots, ClientAuth: tls.RequireAndVerifyClientCert, MinVersion: tls.VersionTLS13}
		server.StartTLS()
		t.Cleanup(server.Close)
		servers = append(servers, server)
		probes = append(probes, sfuProbe{URL: server.URL + "/readyz", ServerName: "chalk-sfu", ClientCertFile: clientCertFile, ClientKeyFile: clientKeyFile, CAFile: caFile})
	}
	return probes, servers
}

func ready(status int, body string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(status)
		fmt.Fprint(w, body)
	}
}

func sfuBody(reserved int, admission string) string {
	reason := ""
	if admission != "" {
		reason = `"admissionReason":"` + admission + `",`
	}
	return fmt.Sprintf(`{"nodeIncarnation":"incarnation-private-test","packetBudget":16000,"reservedPackets":%d,"host":{%s"queueDelayP95Ms":1.5}}`, reserved, reason)
}

func TestSFUFleetReadinessIsOneRowThatFollowsAnyUnhealthyNode(t *testing.T) {
	healthy, draining, closed := ready(200, sfuBody(100, "")), ready(503, sfuBody(0, "")), ready(200, sfuBody(100, "cpu_steal"))
	for _, fixture := range []struct {
		name     string
		handlers []http.HandlerFunc
		reason   string
		value    int64
	}{
		{"one healthy node", []http.HandlerFunc{healthy}, "ready", 0},
		{"one draining node", []http.HandlerFunc{draining}, "draining", 1},
		{"all nodes healthy", []http.HandlerFunc{healthy, healthy, healthy}, "ready", 0},
		{"a draining standby", []http.HandlerFunc{healthy, draining}, "draining", 1},
		{"a node with admission closed", []http.HandlerFunc{healthy, closed, healthy}, "admission_cpu_steal", 1},
		{"the first unhealthy node names the reason", []http.HandlerFunc{healthy, closed, draining}, "admission_cpu_steal", 1},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			probes, servers := newSFUFleet(t, fixture.handlers...)
			item := collectSFUFleetReadiness(context.Background(), probes)
			if item.Rule != "sfu-readiness" || item.Reason != fixture.reason || item.Value != fixture.value || item.Time == "" {
				t.Fatalf("unexpected snapshot: %+v", item)
			}
			formatMessage(&item)
			encoded, err := json.Marshal(item)
			if err != nil {
				t.Fatal(err)
			}
			for _, server := range servers {
				if strings.Contains(string(encoded), server.URL) || strings.Contains(string(encoded), "private-test") {
					t.Fatal(string(encoded))
				}
			}
		})
	}
}

func TestSFUFleetReadinessCatchesANodeThatIsDown(t *testing.T) {
	probes, servers := newSFUFleet(t, ready(200, sfuBody(100, "")), ready(200, sfuBody(100, "")))
	servers[1].Close()
	if item := collectSFUFleetReadiness(context.Background(), probes); item.Value != 1 || item.Reason != "unreachable" {
		t.Fatalf("a node that does not answer must page: %+v", item)
	}
}

func TestSFUReadinessRowOnlyWhenConfigured(t *testing.T) {
	sync := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer sync.Close()
	items, _ := collectState(context.Background(), sync.Client(), "", sync.URL, nil)
	if len(items) != 1 || items[0].Rule != "sync-readiness" {
		t.Fatalf("an unconfigured SFU must emit no row: %+v", items)
	}
	probes, _ := newSFUFleet(t, ready(200, sfuBody(0, "")), ready(200, sfuBody(0, "")))
	items, _ = collectState(context.Background(), sync.Client(), "", sync.URL, probes)
	if len(items) != 2 || items[0].Rule != "sync-readiness" || items[1].Rule != "sfu-readiness" || items[1].Value != 0 {
		t.Fatalf("a configured fleet emits one global row: %+v", items)
	}
}

func TestSFUProbesFromEnv(t *testing.T) {
	t.Setenv("CHALK_ALERT_SFU_SERVER_NAME", "chalk-sfu")
	urls := func() []string {
		var got []string
		for _, probe := range sfuProbesFromEnv() {
			if probe.ServerName != "chalk-sfu" {
				t.Fatalf("every node shares the server name: %+v", probe)
			}
			got = append(got, probe.URL)
		}
		return got
	}
	if got := urls(); got != nil {
		t.Fatalf("no URL must disable the probe: %v", got)
	}
	t.Setenv("CHALK_ALERT_SFU_READY_URL", "https://a/readyz")
	if got, want := urls(), []string{"https://a/readyz"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("the single-node variable must keep working: %v", got)
	}
	t.Setenv("CHALK_ALERT_SFU_READY_URLS", " https://b/readyz, ,https://a/readyz,https://c/readyz ")
	if got, want := urls(), []string{"https://b/readyz", "https://a/readyz", "https://c/readyz"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("the list keeps its order and drops blanks and duplicates: %v", got)
	}
}

func TestRetirementDebtSQLAgesTheOldestDebt(t *testing.T) {
	databaseURL := os.Getenv("CHALK_ALERT_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("requires an isolated CHALK_ALERT_TEST_DATABASE_URL")
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	ident := pgx.Identifier{fmt.Sprintf("alert_fixture_%d", time.Now().UnixNano())}.Sanitize()
	if _, err := conn.Exec(ctx, "CREATE SCHEMA "+ident); err != nil {
		t.Fatal(err)
	}
	defer conn.Exec(ctx, "DROP SCHEMA "+ident+" CASCADE")
	if _, err := conn.Exec(ctx, "SET search_path TO "+ident+"; CREATE TABLE sfu_retirement_debts(created_at timestamptz NOT NULL DEFAULT now())"); err != nil {
		t.Fatal(err)
	}
	age := func() int64 {
		var seconds int64
		if err := conn.QueryRow(ctx, sfuRetirementDebtSQL).Scan(&seconds); err != nil {
			t.Fatal(err)
		}
		return seconds
	}
	if got := age(); got != 0 {
		t.Fatalf("no debt must read as zero: %d", got)
	}
	if _, err := conn.Exec(ctx, "INSERT INTO sfu_retirement_debts(created_at) VALUES (now() - interval '20 minutes'), (now() - interval '1 minute')"); err != nil {
		t.Fatal(err)
	}
	if got := age(); got < 1200 || got > 1230 {
		t.Fatalf("the oldest debt is 20 minutes old: %d", got)
	}
}

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
	if len(items) != 1 || items[0].Value != 1 || !strings.Contains(items[0].Reason, "an own SFU server certificate has expired") || strings.Contains(items[0].Reason, "untrusted") {
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
	if len(items) != 1 || items[0].Value != 1 || !strings.Contains(items[0].Reason, "an own SFU server certificate expires within 7 days") {
		t.Fatalf("the CA's earlier expiry must decide: %+v", items)
	}
}

func TestAnImpostorCertificateRaisesAnUntrustedFindingInsteadOfHidingExpiry(t *testing.T) {
	// The fleet's CA is not the impostor's, so the impostor's far-future expiry must not read as healthy.
	probes, _ := newSFUFleet(t, ready(200, sfuBody(0, "")))
	impostor, _, _ := certServer(t, time.Now().Add(time.Hour))
	probes[0].URL = impostor.URL + "/readyz"
	items := collectCertificateExpiry(context.Background(), probes, "", time.Now())
	if len(items) != 1 || items[0].Value != 1 || !strings.Contains(items[0].Reason, "an own SFU server certificate is untrusted") {
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
