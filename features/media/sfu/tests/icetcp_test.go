package tests

import (
	"net"
	"runtime"
	"strconv"
	"strings"
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
	svc := startService(t, ca, func(cfg *config.Config) { cfg.TCPAddrs = []string{"127.0.0.1:0"} })
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

// A peer whose network allows only one of the node's TCP listeners still reaches the node:
// the answer's other TCP candidates are removed, and the selected pair must use the second listener.
func TestICETCPSecondListenerCarriesMediaForATCPOnlyPeer(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the SFU deploys only on Linux; Windows loopback ICE-TCP does not exercise the production path")
	}
	firstPort, secondPort := freeTCPPort(t), freeTCPPort(t)
	for secondPort == firstPort {
		secondPort = freeTCPPort(t)
	}
	ca := newAuthority(t, "chalk test CA")
	svc := startService(t, ca, func(cfg *config.Config) {
		cfg.TCPAddrs = []string{tcpAddress(firstPort), tcpAddress(secondPort)}
	})
	svc.grantSources(t, scopeA, scopeB)

	connA := svc.createSession(t, "create-alice", scopeA)
	connB := svc.createSession(t, "create-bob", scopeB)
	second := strconv.Itoa(secondPort)
	advertisedSecond, advertisedFirst := 0, 0
	onlySecondListener := func(sdp string) string {
		var filtered strings.Builder
		for _, line := range strings.SplitAfter(sdp, "\n") {
			trimmed := strings.TrimRight(line, "\r\n")
			if strings.HasPrefix(trimmed, "a=candidate:") {
				fields := strings.Fields(strings.TrimPrefix(trimmed, "a=candidate:"))
				if len(fields) > 5 && strings.EqualFold(fields[2], "tcp") {
					if fields[5] == second {
						advertisedSecond++
					} else {
						advertisedFirst++
						continue
					}
				} else {
					continue
				}
			}
			filtered.WriteString(line)
		}
		return filtered.String()
	}
	alice := publishKnownMediaWithAnswer(t, svc, connA, scopeA, onlySecondListener, func(settings *webrtc.SettingEngine) {
		settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeTCP4})
	})
	defer alice.stop()
	if advertisedSecond == 0 || advertisedFirst == 0 {
		t.Fatalf("answer advertised %d second-listener and %d other TCP candidates", advertisedSecond, advertisedFirst)
	}
	_, received := subscribeKnownMedia(t, svc, connB, scopeB, connA)

	eventually(t, "30 audio and 30 video packets through the second TCP listener", 20*time.Second, func() bool {
		return received.count(webrtc.RTPCodecTypeAudio) >= 30 && received.count(webrtc.RTPCodecTypeVideo) >= 30
	})
	pair, err := alice.peer.pc.SCTP().Transport().ICETransport().GetSelectedCandidatePair()
	if err != nil || pair == nil {
		t.Fatalf("selected candidate pair: %v, %v", pair, err)
	}
	if pair.Remote.Protocol != webrtc.ICEProtocolTCP || pair.Remote.Port != uint16(secondPort) {
		t.Fatalf("publisher connected to %s/%d, want tcp/%d", pair.Remote.Protocol, pair.Remote.Port, secondPort)
	}
}

func freeTCPPort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = listener.Close() }()
	return listener.Addr().(*net.TCPAddr).Port
}

func tcpAddress(port int) string {
	return "127.0.0.1:" + strconv.Itoa(port)
}
