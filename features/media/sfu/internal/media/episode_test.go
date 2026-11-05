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
