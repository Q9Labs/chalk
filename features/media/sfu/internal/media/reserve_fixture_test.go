package media

import (
	"fmt"
	"io"
	"log/slog"
	"sync/atomic"
	"testing"
	"time"

	"github.com/q9labs/chalk/features/media/sfu/internal/config"
	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// The design's costs: a three-person Episode with two cameras each reserves 7,170 packets/s and
// a new Episode's first join 3,480, so two three-person Episodes fit a 16,000 budget and a third
// does not.
const (
	threePerson = 7170
	newEpisode  = 3480
)

type reserveFixture struct {
	node  *Node
	clock *atomic.Pointer[time.Time]
}

func newReserveNode(t *testing.T, configure ...func(*config.Config)) *reserveFixture {
	t.Helper()
	node, err := newReserveNodeErr(configure...)
	if err != nil {
		t.Fatalf("new node: %v", err)
	}
	t.Cleanup(node.Close)
	start := time.Now()
	clock := &atomic.Pointer[time.Time]{}
	clock.Store(&start)
	node.now = func() time.Time { return *clock.Load() }
	return &reserveFixture{node: node, clock: clock}
}

func newReserveNodeErr(configure ...func(*config.Config)) (*Node, error) {
	cfg := config.Config{
		UDPAddr:                "127.0.0.1:0",
		AnnounceIPs:            []string{"127.0.0.1"},
		IncludeLoopback:        true,
		MaxSessions:            64,
		PacketBudget:           16000,
		VideoStreamCost:        300,
		CameraUplinkCost:       390,
		CamerasPerParticipant:  2,
		AudioStreamCost:        50,
		ScreenStreamCost:       210,
		EpisodePacketCeiling:   11520,
		LargeCallParticipants:  6,
		SmallTileStreamCost:    90,
		MaxEpisodeParticipants: 16,
		MaxCapturesPerEpisode:  2,
		NegotiationTimeout:     time.Second,
		ConnectTimeout:         time.Minute,
		Memory:                 config.Memory{HistoryHighBytes: 400 << 10, HistoryLowBytes: 128 << 10, HistoryScreenBytes: 320 << 10, PacerQueueBytes: 128 << 10},
		Guard: config.Guard{
			MaxStealPercent: 3, MaxBusyPercent: 90, MaxSchedulerLatency: 5 * time.Second,
			MaxPacerDropPercent: 5, MaxUDPErrorsPerSecond: 5, Window: 30 * time.Second,
		},
	}
	for _, apply := range configure {
		apply(&cfg)
	}
	return NewNode(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
}

func (f *reserveFixture) advance(d time.Duration) {
	next := f.clock.Load().Add(d)
	f.clock.Store(&next)
}

func (f *reserveFixture) reserved() int {
	_, reserved := f.node.Budget()
	return reserved
}

var reserves atomic.Int64

func reserveRequest(episode string, participants int) protocol.ReserveEpisodeRequest {
	return protocol.ReserveEpisodeRequest{
		OperationID: fmt.Sprintf("reserve-%d", reserves.Add(1)), TenantID: "tenant", EpisodeID: episode, Generation: 1,
		Shape: protocol.EpisodeShape{Participants: participants, CamerasPerParticipant: 2},
	}
}
