package tests

import (
	"testing"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/q9labs/chalk/features/media/sfu/internal/config"
)

// A peer whose network blocks UDP still reaches the node when the node listens on TCP: the
// peer here offers only TCP candidates, and its media must arrive at a subscriber over the
// node's TCP listener.
func TestICETCPCarriesMediaForAPeerWithoutUDP(t *testing.T) {
	ca := newAuthority(t, "chalk test CA")
	svc := startService(t, ca, func(cfg *config.Config) { cfg.TCPAddr = "127.0.0.1:0" })
	svc.grantSources(t, scopeA, scopeB)

	connA := svc.createSession(t, "create-alice", scopeA)
	connB := svc.createSession(t, "create-bob", scopeB)
	alice := publishKnownMedia(t, svc, connA, scopeA, func(settings *webrtc.SettingEngine) {
		settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeTCP4})
	})
	defer alice.stop()
	_, received := subscribeKnownMedia(t, svc, connB, scopeB, connA)

	eventually(t, "30 audio and 30 video packets from a TCP-only publisher", 20*time.Second, func() bool {
		return received.count(webrtc.RTPCodecTypeAudio) >= 30 && received.count(webrtc.RTPCodecTypeVideo) >= 30
	})
	pair, err := alice.peer.pc.SCTP().Transport().ICETransport().GetSelectedCandidatePair()
	if err != nil || pair == nil {
		t.Fatalf("selected candidate pair: %v, %v", pair, err)
	}
	if pair.Local.Protocol != webrtc.ICEProtocolTCP {
		t.Fatalf("publisher used %s, want tcp", pair.Local.Protocol)
	}
}
