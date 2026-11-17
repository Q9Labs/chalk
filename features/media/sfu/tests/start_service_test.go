package tests

import (
	"context"
	"crypto/x509"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/q9labs/chalk/features/media/sfu/internal/config"
	"github.com/q9labs/chalk/features/media/sfu/internal/control"
)

func startService(t *testing.T, ca *authority, configure ...func(*config.Config)) *service {
	t.Helper()
	return startServiceLogging(t, ca, func(local slog.Handler) *slog.Logger { return slog.New(local) }, configure...)
}

// startServiceLogging starts a service whose logger is built from the handler that collects its
// log output, so a test can send the same records elsewhere, as the node does when it exports.
func startServiceLogging(t *testing.T, ca *authority, logger func(local slog.Handler) *slog.Logger, configure ...func(*config.Config)) *service {
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
	log := logger(slog.NewTextHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
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
