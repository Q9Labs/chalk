package tests

import (
	"os"
	"os/exec"
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

// A peer whose network allows only TCP 443 still reaches the node: the test runs in a
// network namespace where an unprivileged test process may bind 443, keeps only the
// answer's TCP 443 candidates, and requires the selected pair to use that port.
func TestICETCPPort443CarriesMediaForATCP443OnlyPeer(t *testing.T) {
	if os.Getenv("CHALK_SFU_TCP443_NETNS") != "1" {
		rerunInTCP443Namespace(t)
		return
	}

	ca := newAuthority(t, "chalk test CA")
	svc := startService(t, ca, func(cfg *config.Config) {
		cfg.TCPAddrs = []string{"127.0.0.1:50000", "127.0.0.1:443"}
	})
	svc.grantSources(t, scopeA, scopeB)

	connA := svc.createSession(t, "create-alice", scopeA)
	connB := svc.createSession(t, "create-bob", scopeB)
	advertised443, advertised50000 := 0, 0
	onlyTCP443 := func(sdp string) string {
		var filtered strings.Builder
		for _, line := range strings.SplitAfter(sdp, "\n") {
			trimmed := strings.TrimRight(line, "\r\n")
			if strings.HasPrefix(trimmed, "a=candidate:") {
				fields := strings.Fields(strings.TrimPrefix(trimmed, "a=candidate:"))
				if len(fields) > 5 && strings.EqualFold(fields[2], "tcp") {
					switch fields[5] {
					case "443":
						advertised443++
					case "50000":
						advertised50000++
					}
					if fields[5] != "443" {
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
	alice := publishKnownMediaWithAnswer(t, svc, connA, scopeA, onlyTCP443, func(settings *webrtc.SettingEngine) {
		settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeTCP4})
	})
	defer alice.stop()
	if advertised443 == 0 || advertised50000 == 0 {
		t.Fatalf("answer advertised %d TCP/443 and %d TCP/50000 candidates", advertised443, advertised50000)
	}
	_, received := subscribeKnownMedia(t, svc, connB, scopeB, connA)

	eventually(t, "30 audio and 30 video packets through TCP 443", 20*time.Second, func() bool {
		return received.count(webrtc.RTPCodecTypeAudio) >= 30 && received.count(webrtc.RTPCodecTypeVideo) >= 30
	})
	pair, err := alice.peer.pc.SCTP().Transport().ICETransport().GetSelectedCandidatePair()
	if err != nil || pair == nil {
		t.Fatalf("selected candidate pair: %v, %v", pair, err)
	}
	if pair.Remote.Protocol != webrtc.ICEProtocolTCP || pair.Remote.Port != 443 {
		t.Fatalf("publisher connected to %s/%d, want tcp/443", pair.Remote.Protocol, pair.Remote.Port)
	}
}

func rerunInTCP443Namespace(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("unshare"); err != nil {
		t.Skip("unshare is not available")
	}
	command := exec.Command("unshare", "-Urn", "sh", "-c", "ip link set lo up && exec \"$1\" -test.run '^TestICETCPPort443CarriesMediaForATCP443OnlyPeer$'", "sh", os.Args[0])
	command.Env = append(os.Environ(), "CHALK_SFU_TCP443_NETNS=1")
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("network-namespace test failed: %v\n%s", err, output)
	}
	t.Logf("network-namespace test passed\n%s", output)
}
