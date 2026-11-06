package media

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/q9labs/chalk/features/media/sfu/internal/config"
	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// sdkCameraPackets is what one real SDK camera sends in packets/s, measured on a deployed node:
// the h layer about 300 and the l layer about 90.
const (
	sdkCameraH = 300
	sdkCameraL = 90
)

// defaultsNode is a node on the shipped defaults, so these tests fail if a default drifts from
// what the SDK's cameras really cost.
func defaultsNode(t *testing.T) *Node {
	t.Helper()
	values := map[string]string{
		"SFU_TLS_CERT_FILE": "c", "SFU_TLS_KEY_FILE": "k", "SFU_CLIENT_CA_FILE": "a", "SFU_CLIENT_IDENTITY": "i",
	}
	defaults, err := config.Load(func(key string) (string, bool) { value, ok := values[key]; return value, ok })
	if err != nil {
		t.Fatal(err)
	}
	return newTestNode(t, func(cfg *config.Config) {
		cfg.PacketBudget, cfg.EpisodePacketCeiling = defaults.PacketBudget, defaults.EpisodePacketCeiling
		cfg.VideoStreamCost, cfg.CameraUplinkCost = defaults.VideoStreamCost, defaults.CameraUplinkCost
		cfg.AudioStreamCost, cfg.ScreenStreamCost = defaults.AudioStreamCost, defaults.ScreenStreamCost
		cfg.CamerasPerParticipant, cfg.MaxSessions = defaults.CamerasPerParticipant, 64
		cfg.LargeCallParticipants, cfg.SmallTileStreamCost = defaults.LargeCallParticipants, defaults.SmallTileStreamCost
	})
}

// A 3-person class of two cameras each sends 6·(300+90) camera uplink packets/s and receives 12
// camera streams at 300, plus audio and a screen share. Admission has to reserve all of it, so a
// 16,000 packets/s budget holds two such classes, not the six that 150 packets/s per camera allowed.
func TestAdmissionReservesWhatSDKSimulcastCosts(t *testing.T) {
	node := defaultsNode(t)
	const people = 3
	uplinks := people * (2*(sdkCameraH+sdkCameraL) + 50)
	downlinks := people * (people - 1) * (2*sdkCameraH + 50)
	screen := people * (210 + 50)
	want := uplinks + downlinks + screen
	if got := node.nominalReservation(people); got != want {
		t.Fatalf("a 3-person 2-camera class reserves %d packets/s, want the %d it sends and receives", got, want)
	}

	for class := range 2 {
		for person := range people {
			node.newTestSession(t, episodeScope("class-"+itoa(class), "p"+itoa(person)))
		}
	}
	if _, reserved := node.Budget(); reserved != 2*want {
		t.Fatalf("two classes reserve %d, want %d", reserved, 2*want)
	}
	_, err := node.CreateSession("create-third-class", episodeScope("class-2", "p0"))
	if !errors.Is(err, errNodeFull) {
		t.Fatalf("a third class on a 16,000 budget: %v, want the node full", err)
	}
}

// The plan lowers camera downlinks only. With the real SDK's rates the reservation leaves room
// for every camera at its top layer, so no camera is capped or paused.
func TestPlanKeepsRealSDKCamerasOpenInAnAdmittedEpisode(t *testing.T) {
	node := defaultsNode(t)
	const people, cameras = 3, 6
	// Ingress the plan cannot lower: every layer of six cameras, every microphone to everyone
	// and the screen share.
	base := float64(cameras*(sdkCameraH+sdkCameraL) + people*people*50 + people*(210+50))
	planned := make([]*plannedCamera, cameras)
	for index := range planned {
		// Two subscribers receive each camera.
		planned[index] = &plannedCamera{order: uint64(index), cost: [planLevels]float64{2 * sdkCameraH, 2 * sdkCameraL, 0}}
	}
	ceiling := float64(node.episodeReservation(people))
	if planEpisode(planned, base, ceiling, false) {
		t.Fatalf("the plan lowered a camera of an admitted Episode: ceiling %.0f, base %.0f", ceiling, base)
	}
	for _, camera := range planned {
		if camera.level != planOpen {
			t.Fatalf("a camera is at level %d, want open", camera.level)
		}
	}
}

func TestACameraBeyondTheReservedCamerasIsRefused(t *testing.T) {
	node := newTestNode(t, func(cfg *config.Config) { cfg.CamerasPerParticipant = 2 })
	session := node.newTestSession(t, episodeScope("a", "alice"))
	peer := newTestPeer(t)
	peer.sendOnly(t, webrtc.RTPCodecTypeVideo, 3)
	response, err := session.AddTracks(context.Background(), protocol.TracksRequest{
		OperationID: op(), Scope: session.scope, SessionDescription: peer.offer(t), Tracks: localTracks("cam", peer.mids(), "camera"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(response.Tracks) != 2 || len(response.TrackErrors) != 1 || response.TrackErrors[0].Code != protocol.TrackCodeLimitExceeded {
		t.Fatalf("three cameras against two reserved: %+v, want two published and one limit_exceeded", response)
	}
	if refusals := node.Telemetry().Refusals; refusals[RefusedCameras] != 1 {
		t.Fatalf("refusals %v, want one for cameras", refusals)
	}
}

// The pacer's queue signal has to see a queue that fills: audio leaves at once and says nothing
// about it, and a dropped video packet is a packet that would have waited behind a full queue.
func TestPacerDropsAndAudioDoNotHideCongestion(t *testing.T) {
	delays := &delayHistogram{}
	transport := newTransport(delays, 128<<10, nil)
	wire := &wireWriter{}
	video := &egressBinding{writer: wire, ssrc: 10, payloadType: 96, twccID: 3}
	audio := &egressBinding{writer: wire, ssrc: 11, payloadType: 111, twccID: 3}
	transport.mu.Lock()
	transport.refill(monotonic())
	transport.tokens = -1e6 // the pace lets no video out
	transport.mu.Unlock()
	var w packetWriter
	payload := make([]byte, 500)
	for seq := range uint16(5000) {
		transport.send(&egressPacket{binding: audio, class: classAudio, seq: seq, payload: payload}, &w)
	}
	for seq := range uint16(400) { // the queue fills and the rest is dropped
		transport.send(&egressPacket{binding: video, class: classVideo, seq: seq, payload: payload}, &w)
	}
	if transport.counters.Dropped == 0 {
		t.Fatal("the pacer dropped no video, so the queue never filled")
	}
	if p95 := percentile(delays.collect(), 0.95); p95 < 50*time.Millisecond {
		t.Fatalf("queue delay p95 is %v while the pacer drops video, want at least the 50 ms guard threshold", p95)
	}
}

// A pause the Episode plan orders is not congestion: the subscriber's downlink is fine.
func TestPlannerPausesAreNotCountedAsCongestion(t *testing.T) {
	node := newTestNode(t, func(cfg *config.Config) { cfg.EpisodePacketCeiling = 1000 })
	session := node.newTestSession(t, episodeScope("a", "alice"))
	granted, _ := grantedAndUngranted(t, 1.2e6, 300_000, 2000)
	// The downlink is open at the top layer; only the 1,000 packets/s ceiling is short.
	granted.alloc = allocation{decided: true, rid: "h", backoff: backoffMin}
	session.mu.Lock()
	session.subscribed = map[string]*subscription{"0": granted}
	session.mu.Unlock()

	node.allocate()
	stats := node.stats.Load()
	if granted.pub.plan != planPaused {
		t.Fatalf("the camera's plan is %d, want paused by the 1,000 ceiling", granted.pub.plan)
	}
	if stats.plannerPaused != 1 || stats.congested != 0 {
		t.Fatalf("stats count %d planner pauses and %d congestion pauses, want 1 and 0", stats.plannerPaused, stats.congested)
	}
	if got := node.Telemetry(); got.PlannerPaused != 1 || got.CongestionPaused != 0 {
		t.Fatalf("telemetry reports %d planner and %d congestion pauses", got.PlannerPaused, got.CongestionPaused)
	}

	// The same pause from a downlink that cannot carry the lowest layer is congestion.
	granted.pub.plan = planOpen
	node.cfg.EpisodePacketCeiling = 1 << 20
	granted.alloc = allocation{decided: true, paused: true, backoff: backoffMin}
	node.allocate()
	if stats := node.stats.Load(); stats.congested != 1 || stats.plannerPaused != 0 {
		t.Fatalf("stats count %d congestion pauses and %d planner pauses, want 1 and 0", stats.congested, stats.plannerPaused)
	}
}

// udpHost is a host whose UDP buffers drop receive and send datagrams every second.
type udpHost struct{ errors udpErrors }

func (h *udpHost) read() (udpErrors, bool) { return h.errors, true }

func runWindow(node *Node, seconds int, each func()) {
	for range seconds {
		each()
		node.guard.tick()
	}
}

func TestUDPBufferErrorsCloseAdmissionAndNameTheReason(t *testing.T) {
	for _, test := range []struct {
		name string
		step func(*udpErrors)
	}{
		{"receive", func(e *udpErrors) { e.receive += 20 }},
		{"send", func(e *udpErrors) { e.send += 20 }},
	} {
		t.Run(test.name, func(t *testing.T) {
			node := newTestNode(t, nil)
			node.guard.readSteal = func() (cpuTimes, bool) { return cpuTimes{}, false }
			host := &udpHost{}
			node.guard.readUDP = host.read
			// The node's own socket leaves its counters alone, so steal's absence does not matter:
			// 20 datagrams a second for a full window is above the 5 a second threshold.
			runWindow(node, 31, func() { test.step(&host.errors) })
			if reason := node.guard.closedReason(); reason != reasonUDPBufferErrors {
				t.Fatalf("admission reason %q, want %q", reason, reasonUDPBufferErrors)
			}
			_, err := node.CreateSession("create-new", episodeScope("new", "bob"))
			if !errors.Is(err, errAdmissionClosed) {
				t.Fatalf("a new Episode while buffers overflow: %v, want admission closed", err)
			}
			if refusals := node.Telemetry().Refusals; refusals[RefusedUDPErrors] != 1 {
				t.Fatalf("refusals %v, want one for %s", refusals, RefusedUDPErrors)
			}
			// A quiet window reopens admission.
			runWindow(node, 31, func() {})
			if reason := node.guard.closedReason(); reason != "" {
				t.Fatalf("admission still closed after the errors stopped: %s", reason)
			}
		})
	}
}

func TestPacerDropsCloseAdmission(t *testing.T) {
	node := newTestNode(t, nil)
	node.guard.readSteal = func() (cpuTimes, bool) { return cpuTimes{}, false }
	node.guard.readUDP = func() (udpErrors, bool) { return udpErrors{}, false }
	var load pacerLoad
	// 10% of video dropped: 100 dropped for every 900 sent each second.
	runWindow(node, 31, func() {
		load.dropped += 100
		load.sent += 900
		node.guard.observePacer(load)
	})
	health := node.guard.snapshot()
	if health.AdmissionReason != reasonPacerDrops || math.Abs(health.PacerDropPercent-10) > 0.5 {
		t.Fatalf("health %+v, want pacer_drops near 10%%", health)
	}
	// A handful of drops among plenty of video is noise.
	quiet := newTestNode(t, nil)
	quiet.guard.readSteal = func() (cpuTimes, bool) { return cpuTimes{}, false }
	quiet.guard.readUDP = func() (udpErrors, bool) { return udpErrors{}, false }
	load = pacerLoad{}
	runWindow(quiet, 31, func() {
		load.dropped++
		load.sent += 9
		quiet.guard.observePacer(load)
	})
	if reason := quiet.guard.closedReason(); reason != "" {
		t.Fatalf("admission closed for %q on 31 drops in a window", reason)
	}
}

func TestBusyCPUClosesAdmission(t *testing.T) {
	node := newTestNode(t, nil)
	host := &fakeSteal{}
	node.guard.readSteal = host.read
	node.guard.readUDP = func() (udpErrors, bool) { return udpErrors{}, false }
	// A fully busy host with no steal: 95 of every 100 ticks working.
	runWindow(node, 31, func() {
		host.times.total += 100
		host.times.idle += 5
	})
	if reason := node.guard.closedReason(); reason != reasonCPUBusy {
		t.Fatalf("admission reason %q at 95%% busy, want %q", reason, reasonCPUBusy)
	}
}

func TestEveryRefusalLogsItsReason(t *testing.T) {
	var logs bytes.Buffer
	node := newTestNode(t, nil)
	node.log = slog.New(slog.NewTextHandler(&logs, nil))
	node.mu.Lock()
	_ = node.refuse(RefusedNodeFull, errNodeFull)
	node.mu.Unlock()
	if !strings.Contains(logs.String(), "reason=node_full") {
		t.Fatalf("refusal log %q names no reason", logs.String())
	}
}

// A ten-person call shows its Participants as small tiles, so each viewer receives one featured
// Participant's two cameras at 300 and the other eight Participants' at 90. The all-top-layer
// reservation was 69,400 and the Episode ceiling refused the ninth Participant on audio and camera
// uplinks alone. A large call takes the node budget as its ceiling and a class keeps its own.
func TestALargeCallReservesTheSmallTilesItShows(t *testing.T) {
	node := defaultsNode(t)
	node.cfg.PacketBudget = 32_000
	const people = 10
	uplinks := people * (2*(sdkCameraH+sdkCameraL) + 50)
	downlinks := people * ((people-1)*50 + 2*sdkCameraH + (people-2)*2*sdkCameraL)
	screen := people * (210 + 50)
	if got, want := node.nominalReservation(people), uplinks+downlinks+screen; got != want {
		t.Fatalf("a ten-person call reserves %d packets/s, want %d", got, want)
	}
	if got := node.episodeReservation(people); got != 32_000 {
		t.Fatalf("the call reserves %d, want the 32,000 budget as its ceiling", got)
	}
	if mandatory := node.mandatoryPackets(people, true); mandatory > node.episodeCeiling(people) {
		t.Fatalf("the call's %d mandatory packets/s do not fit its ceiling %d", mandatory, node.episodeCeiling(people))
	}
	if got := node.episodeCeiling(node.cfg.LargeCallParticipants); got != defaultsNode(t).cfg.EpisodePacketCeiling {
		t.Fatalf("an Episode at the threshold has ceiling %d, want the class ceiling", got)
	}
	// A class at the threshold still reserves every camera at the top layer.
	class := node.cfg.LargeCallParticipants
	if got, want := node.nominalReservation(class), class*(2*(sdkCameraH+sdkCameraL)+50)+class*((class-1)*(2*sdkCameraH+50))+class*260; got != want {
		t.Fatalf("a %d-person class reserves %d, want %d", class, got, want)
	}
}

// A call that loses a Participant must never reserve more than it did before, or a departure could
// push the node's total over its budget.
func TestAnEpisodeNeverReservesMoreWhenItShrinks(t *testing.T) {
	node := defaultsNode(t)
	node.cfg.PacketBudget, node.cfg.EpisodePacketCeiling = 32_000, 32_000
	for people := 2; people <= 16; people++ {
		if smaller, larger := node.episodeReservation(people-1), node.episodeReservation(people); smaller > larger {
			t.Fatalf("%d Participants reserve %d but %d reserve only %d", people-1, smaller, people, larger)
		}
	}
}

// A call that shrinks to the threshold takes the class ceiling back. A configuration whose class
// ceiling cannot carry the threshold's mandatory media is refused at start, because the call's
// admitted media would then outgrow its reservation.
func TestALargeCallThresholdThatTheClassCeilingCannotCarryIsRefused(t *testing.T) {
	// Six Participants need 8,040 mandatory packets/s with a screen share; the class ceiling is 7,000.
	for _, test := range []struct {
		name    string
		maximum int
		refused bool
	}{
		{"a maximum that lets a call cross the threshold", 16, true},
		{"a maximum one above the threshold", 7, true},
		{"a maximum equal to the threshold", 6, false},
		{"a maximum below the threshold", 3, false},
	} {
		cfg := config.Config{
			UDPAddr: "127.0.0.1:0", PacketBudget: 14_000, EpisodePacketCeiling: 7_000, CamerasPerParticipant: 2,
			VideoStreamCost: 300, CameraUplinkCost: 390, AudioStreamCost: 50, ScreenStreamCost: 210,
			LargeCallParticipants: 6, SmallTileStreamCost: 90, MaxEpisodeParticipants: test.maximum,
		}
		node, err := NewNode(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
		if test.refused {
			if err == nil || !strings.Contains(err.Error(), "SFU_LARGE_CALL_PARTICIPANTS") {
				t.Fatalf("%s gave %v, want a refusal naming the setting", test.name, err)
			}
			continue
		}
		if err != nil {
			t.Fatalf("%s gave %v, want a node that starts: no call can cross the threshold", test.name, err)
		}
		node.Close()
	}
}
