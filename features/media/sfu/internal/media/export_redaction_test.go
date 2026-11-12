package media_test

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/q9labs/chalk/features/media/sfu/internal/config"
	"github.com/q9labs/chalk/features/media/sfu/internal/media"
	"github.com/q9labs/chalk/features/media/sfu/internal/telemetry"
	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// A malformed offer makes the negotiation error quote the SDP the caller sent. The journal may keep
// that line; the exporter must not, while the trail still says the negotiation failed.
func TestMalformedSDPStaysOnTheNode(t *testing.T) {
	var mu sync.Mutex
	var exported []byte
	sink := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		mu.Lock()
		exported = append(exported, raw...)
		mu.Unlock()
	}))
	defer sink.Close()
	t.Setenv("OTEL_EXPORTER_OTLP_LOGS_HEADERS", "Authorization=Bearer test-token")
	var journal bytes.Buffer
	logger, shutdown, err := telemetry.NewLogger(context.Background(), config.Telemetry{OTLPEndpoint: sink.URL, OTLPInsecure: true}, slog.NewJSONHandler(&journal, nil))
	if err != nil {
		t.Fatal(err)
	}
	node, err := media.NewNode(config.Config{
		UDPAddr: "127.0.0.1:0", AnnounceIPs: []string{"127.0.0.1"}, IncludeLoopback: true,
		MaxSessions: 8, MaxPublishedPerSession: 4, MaxSubscriptionsPerSession: 4,
		MaxEpisodeParticipants: 16, PacketBudget: 1 << 20, EpisodePacketCeiling: 1 << 20,
		VideoStreamCost: 150, CameraUplinkCost: 150, CamerasPerParticipant: 1, AudioStreamCost: 50, ScreenStreamCost: 210,
		Memory:             config.Memory{HistoryHighBytes: 400 << 10, HistoryLowBytes: 128 << 10, HistoryScreenBytes: 320 << 10, PacerQueueBytes: 128 << 10},
		Guard:              config.Guard{MaxStealPercent: 3, MaxBusyPercent: 90, MaxSchedulerLatency: 5 * time.Second, MaxPacerDropPercent: 5, MaxUDPErrorsPerSecond: 5, Window: 30 * time.Second},
		NegotiationTimeout: 5 * time.Second, ConnectTimeout: 30 * time.Second, ShutdownTimeout: 5 * time.Second, SourceLeaseTTL: time.Hour,
	}, logger)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(node.Close)

	scope := protocol.Scope{TenantID: "tenant-1", EpisodeID: "episode-1", ParticipantID: "alice", Generation: 1}
	created, err := node.CreateSession("create-1", scope)
	if err != nil {
		t.Fatal(err)
	}
	session, err := node.Session(created.ConnectionID, scope)
	if err != nil {
		t.Fatal(err)
	}
	const sentinel = "PRIVATE-SDP-CONTENT"
	_, err = session.AddTracks(context.Background(), protocol.TracksRequest{
		OperationID: "malformed-offer", Scope: scope,
		SessionDescription: &protocol.SessionDescription{Type: "offer", SDP: "v=0\r\no=- 0 0 IN " + sentinel + " 127.0.0.1\r\n"},
	})
	if err == nil {
		t.Fatal("a malformed offer was accepted")
	}
	node.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := shutdown(ctx); err != nil {
		t.Fatal(err)
	}

	mu.Lock()
	defer mu.Unlock()
	if !strings.Contains(journal.String(), sentinel) {
		t.Fatal("the journal lacks the SDP text, so the test proves nothing about the exporter")
	}
	if strings.Contains(string(exported), sentinel) {
		t.Fatal("SDP text left the node")
	}
	for _, want := range []string{"sfu.session.closed", "episode-1"} {
		if !strings.Contains(string(exported), want) {
			t.Errorf("the trail lost %q, so the export did not run", want)
		}
	}
}
