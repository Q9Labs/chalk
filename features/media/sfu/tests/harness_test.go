package tests

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/q9labs/chalk/features/media/sfu/internal/config"
	"github.com/q9labs/chalk/features/media/sfu/internal/control"
	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// service is the real HTTP service plus a client that holds the API's certificate.
type service struct {
	server  *control.Server
	baseURL string
	client  *http.Client
	stop    func()
	logs    *logBuffer // everything the service logged, at every level
}

// logBuffer collects a service's log output for scanning.
type logBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *logBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *logBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// op returns a fresh operation ID for a test request.
func op() string { return fmt.Sprintf("op-%d", operations.Add(1)) }

// grantSources grants every source of each Participant once, as Sync does when it
// lets them publish. The default test lease outlasts any test, so nothing renews.
func (s *service) grantSources(t *testing.T, scopes ...protocol.Scope) {
	t.Helper()
	s.grantSourcesAt(t, 1, scopes...)
}

// grantSourcesAt grants every source at one revision. A later revision renews a lease that
// a short TTL would otherwise end.
func (s *service) grantSourcesAt(t *testing.T, revision int64, scopes ...protocol.Scope) {
	t.Helper()
	for _, scope := range scopes {
		var controls []protocol.SourceControl
		for _, source := range []string{"microphone", "camera", "screen", "screen_audio"} {
			controls = append(controls, protocol.SourceControl{ParticipantID: scope.ParticipantID, Source: source, Action: protocol.SourceGrant, Revision: revision})
		}
		var response protocol.SourceControlResponse
		s.mustCall(t, "/v1/episodes/sources", protocol.SourceControlRequest{TenantID: scope.TenantID, EpisodeID: scope.EpisodeID, Controls: controls}, &response)
	}
}

func startService(t *testing.T, ca *authority, configure ...func(*config.Config)) *service {
	t.Helper()
	dir := t.TempDir()
	_, serverCert, serverKey := ca.issue("localhost", x509.ExtKeyUsageServerAuth)
	cfg := config.Config{
		ControlAddr:           "127.0.0.1:0",
		UDPAddr:               "127.0.0.1:0",
		AnnounceIPs:           []string{"127.0.0.1"},
		IncludeLoopback:       true,
		TLSCertFile:           writeFile(t, dir, "server.pem", serverCert),
		TLSKeyFile:            writeFile(t, dir, "server.key", serverKey),
		ClientCAFile:          writeFile(t, dir, "ca.pem", ca.pem),
		ClientIdentity:        apiIdentity,
		MaxSessions:           8,
		PacketBudget:          1 << 20,
		VideoStreamCost:       150,
		CameraUplinkCost:      150,
		CamerasPerParticipant: 2,
		AudioStreamCost:       50,
		ScreenStreamCost:      210,
		EpisodePacketCeiling:  1 << 20,
		Memory:                config.Memory{HistoryHighBytes: 400 << 10, HistoryLowBytes: 128 << 10, HistoryScreenBytes: 320 << 10, PacerQueueBytes: 128 << 10},
		// A test process shares its CPUs with other packages, so its own scheduler
		// latency says nothing about a node; guard tests that read it set their own.
		Guard: config.Guard{
			MaxStealPercent: 3, MaxBusyPercent: 90, MaxSchedulerLatency: 5 * time.Second,
			MaxPacerDropPercent: 5, MaxUDPErrorsPerSecond: 5, Window: 30 * time.Second,
		},
		MaxEpisodeParticipants:     16,
		MaxPublishedPerSession:     4,
		MaxSubscriptionsPerSession: 8,
		MaxCapturesPerEpisode:      2,
		MaxCaptureSubscriptions:    8,
		MaxRequestBytes:            384 << 10,
		NegotiationTimeout:         time.Second,
		ConnectTimeout:             30 * time.Second,
		ShutdownTimeout:            5 * time.Second,
		SourceLeaseTTL:             time.Hour,
	}
	for _, apply := range configure {
		apply(&cfg)
	}
	logs := &logBuffer{}
	log := slog.New(slog.NewTextHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	server, err := control.Start(cfg, log)
	if err != nil {
		t.Fatalf("start service: %v", err)
	}
	var once sync.Once
	svc := &service{server: server, baseURL: "https://" + server.Addr().String(), logs: logs}
	svc.stop = func() {
		once.Do(func() {
			if err := server.Stop(context.Background()); err != nil {
				t.Errorf("stop service: %v", err)
			}
		})
	}
	t.Cleanup(svc.stop)
	svc.client = clientFor(t, ca, ca, apiIdentity)
	return svc
}

// clientFor builds an HTTPS client whose certificate comes from clientCA and names identity.
// It trusts the service's CA (serverCA).
func clientFor(t *testing.T, clientCA, serverCA *authority, identity string) *http.Client {
	t.Helper()
	pair, _, _ := clientCA.issue(identity, x509.ExtKeyUsageClientAuth)
	pool := x509.NewCertPool()
	pool.AddCert(serverCA.cert)
	transport := &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS13, RootCAs: pool, Certificates: []tls.Certificate{pair}}}
	t.Cleanup(transport.CloseIdleConnections)
	return &http.Client{Transport: transport, Timeout: 20 * time.Second}
}

// call posts a JSON body and decodes a 2xx answer into out. It returns the status and, for
// an error answer, the protocol error code.
func (s *service) call(t *testing.T, path string, body, out any) (int, string) {
	t.Helper()
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	response, err := s.client.Post(s.baseURL+path, "application/json", bytes.NewReader(encoded))
	if err != nil {
		t.Fatalf("POST %s: %v", path, err)
	}
	defer response.Body.Close()
	raw, _ := io.ReadAll(response.Body)
	if response.StatusCode >= 300 {
		var problem protocol.ErrorResponse
		_ = json.Unmarshal(raw, &problem)
		return response.StatusCode, problem.Error.Code
	}
	if out != nil && len(raw) > 0 {
		if err := json.Unmarshal(raw, out); err != nil {
			t.Fatalf("decode %s: %v (%s)", path, err, raw)
		}
	}
	return response.StatusCode, ""
}

func (s *service) mustCall(t *testing.T, path string, body, out any) {
	t.Helper()
	if status, code := s.call(t, path, body, out); status >= 300 {
		t.Fatalf("POST %s: status %d code %q", path, status, code)
	}
}

func (s *service) createSession(t *testing.T, operation string, scope protocol.Scope) string {
	t.Helper()
	var response protocol.CreateSessionResponse
	s.mustCall(t, "/v1/sessions", protocol.CreateSessionRequest{OperationID: operation, Scope: scope}, &response)
	return response.ConnectionID
}

func (s *service) sessions(t *testing.T) int {
	t.Helper()
	response, err := s.client.Get(s.baseURL + "/readyz")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var ready protocol.ReadyResponse
	if err := json.NewDecoder(response.Body).Decode(&ready); err != nil {
		t.Fatal(err)
	}
	return ready.Sessions
}

func (s *service) inspect(t *testing.T, id string, scope protocol.Scope) []protocol.InspectedTrack {
	t.Helper()
	var response protocol.InspectResponse
	s.mustCall(t, "/v1/sessions/"+id+"/inspect", protocol.InspectRequest{Scope: scope}, &response)
	return response.Tracks
}
