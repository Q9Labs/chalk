package media

import (
	"math"
	"testing"

	"github.com/q9labs/chalk/features/media/sfu/internal/config"
)

// grantedAndUngranted is two cameras of one Episode, each with its first
// subscriber. The ungranted one has the more recent speaker, so a plan or an
// allocation that counts it lowers the granted camera first.
func grantedAndUngranted(t *testing.T, hBps, lBps, pps float64) (granted, ungranted *subscription) {
	t.Helper()
	cameras := [2]*subscription{}
	for index := range cameras {
		pub, layers, _ := benchPublication(t)
		pub.session, pub.order = &Session{}, uint64(index+1)
		for _, layer := range layers {
			bps := hBps
			if layer.rid == "l" {
				bps = lBps
			}
			layer.meter.pps.Store(math.Float64bits(pps))
			layer.meter.bps.Store(math.Float64bits(bps))
		}
		cameras[index] = (*pub.subscribers.Load())[0]
	}
	ungranted = cameras[1]
	ungranted.pub.authority = &sourceAuthority{}
	ungranted.pub.authority.window.Store(closedWindow)
	ungranted.pub.session.lastVoiced.Store(monotonic())
	return cameras[0], ungranted
}

func TestAnUngrantedSourceTakesNoShareOfTheEpisodeCeiling(t *testing.T) {
	node := newTestNode(t, func(cfg *config.Config) { cfg.EpisodePacketCeiling = 1000 })
	granted, ungranted := grantedAndUngranted(t, 1.2e6, 300_000, 300)
	// 600 packets/s of ingress and the granted camera's 300 fit the 1,000 ceiling.
	episode := &episodeTick{
		sessions:      []*Session{granted.pub.session, ungranted.pub.session, {}, {}},
		subscriptions: []*subscription{granted, ungranted},
		base:          600,
		cameras:       map[*publication]*plannedCamera{},
	}
	if reserved := node.episodeReservation(len(episode.sessions)); reserved != 1000 {
		t.Fatalf("the Episode reserves %d, want the 1,000 ceiling", reserved)
	}
	node.plan(episodeKey{}, episode, monotonic())
	if granted.pub.plan != planOpen {
		t.Fatalf("the granted camera's plan is %d, want open: a source without a grant was counted", granted.pub.plan)
	}
	// Once a grant opens the other source, the next pass counts it: 1,200 packets/s
	// is over the ceiling, so the quieter granted camera gives way.
	ungranted.pub.authority.window.Store(openWindow)
	episode.cameras = map[*publication]*plannedCamera{}
	node.plan(episodeKey{}, episode, monotonic())
	if granted.pub.plan != planPaused {
		t.Fatalf("the granted camera's plan is %d after the grant, want paused: the newly granted source was not counted", granted.pub.plan)
	}
}

func TestAnUngrantedSourceTakesNoShareOfTheDownlink(t *testing.T) {
	granted, ungranted := grantedAndUngranted(t, 1.2e6, 300_000, 300)
	granted.alloc = allocation{decided: true, rid: "h", backoff: backoffMin}
	ungranted.alloc = allocation{decided: true, rid: "h", backoff: backoffMin}
	now := monotonic()
	transport := granted.transport
	transport.mu.Lock()
	// The path carries 1.6 Mbit/s: one camera on h, not two.
	transport.estimator.feedbacks, transport.estimator.estimate = 1, 1.6e6
	transport.estimator.probeFloor, transport.estimator.probeUntil = 1.6e6, math.MaxInt64
	transport.mu.Unlock()
	granted.transport, ungranted.transport = transport, transport
	session := &Session{transport: transport, subscribed: map[string]*subscription{"0": granted, "1": ungranted}}
	allocateSession(session, false, now)
	if granted.alloc.rid != "h" {
		t.Fatalf("the granted camera is on %q, want h: a source without a grant took the downlink", granted.alloc.rid)
	}
}

func TestAMissingLayerWithoutFallbackTakesNoShareOfTheDownlink(t *testing.T) {
	strict, other := grantedAndUngranted(t, 1.2e6, 300_000, 300)
	now := monotonic()
	for index := range strict.pub.layers {
		if layer := strict.pub.layers[index].Load(); layer != nil && layer.rid == "h" {
			layer.lastRTP.Store(0)
		}
	}
	strict.mu.Lock()
	strict.request = layerRequest{ceiling: "h"}
	strict.mu.Unlock()
	if layers := strict.allocatable(strict.currentRequest(), now); layers != nil {
		t.Fatalf("a missing h without fallback lists %+v, want nothing: it sends nothing", layers)
	}
	if layers := other.allocatable(other.currentRequest(), now); len(layers) == 0 {
		t.Fatal("a camera with fallback lists no layers")
	}
}

// Probe padding is not load the plan must fit: counting it in the base put a burst of probes at
// a join over the ceiling, and the plan paused every camera for seconds. It still takes room, so
// an Episode whose probes and video fill its ceiling starts no further probe.
func TestProbePaddingTakesRoomButDoesNotPauseCameras(t *testing.T) {
	node := newTestNode(t, func(cfg *config.Config) { cfg.EpisodePacketCeiling = 1000 })
	for _, probing := range []float64{0, 600, 800} {
		granted, ungranted := grantedAndUngranted(t, 1.2e6, 300_000, 300)
		episode := &episodeTick{
			sessions:      []*Session{granted.pub.session, ungranted.pub.session, {}, {}},
			subscriptions: []*subscription{granted},
			cameras:       map[*publication]*plannedCamera{},
		}
		episode.addEgress(classRepair, 100)
		episode.addEgress(classProbe, probing)
		node.plan(episodeKey{}, episode, monotonic())
		if granted.pub.plan != planOpen {
			t.Fatalf("with %.0f probe packets/s the camera's plan is %d, want open", probing, granted.pub.plan)
		}
		if want := probing == 0; episode.room != want {
			t.Fatalf("with %.0f probe packets/s room is %v, want %v", probing, episode.room, want)
		}
	}
}

// The first tick of a join as a bench node logged it: three Participants, six cameras, ceiling
// 7,170, and a base of 7,472.6 packets/s of which 4,131.5 were probe padding. With the padding in
// the base the plan paused all six cameras; the cameras then came back one every two seconds.
// Each camera's open cost is the logged 2,346 packets/s of camera video divided by six; the
// lowest-layer cost is assumed.
func TestAJoinTimeBurstOfProbesLeavesTheCamerasOpen(t *testing.T) {
	const ceiling = 7170
	episode := &episodeTick{base: 3341.2} // the logged base without its probes
	episode.addEgress(classProbe, 4131.4)
	cameras := make([]*plannedCamera, 6)
	for index := range cameras {
		cameras[index] = &plannedCamera{order: uint64(index), cost: [planLevels]float64{planOpen: 391, planLowest: 130}}
	}
	planEpisode(cameras, episode.base, ceiling, true)
	for index, camera := range cameras {
		if camera.level != planOpen {
			t.Fatalf("camera %d is at plan level %d, want open: its Episode's probes fill %.0f of the %d ceiling", index, camera.level, episode.probing, ceiling)
		}
	}
	if episode.measured < 4131 {
		t.Fatalf("the probes measure %.0f packets/s, want the padding measured", episode.measured)
	}
}
