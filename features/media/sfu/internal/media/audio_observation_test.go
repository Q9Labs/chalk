package media

import (
	"log/slog"
	"testing"
	"time"

	"github.com/pion/rtp"

	"github.com/q9labs/chalk/features/media/sfu/internal/obs"
)

func init() {
	obs.Configure(obs.Config{Module: "sfu", Env: "test"})
}

func TestMicrophoneIngressReportsSignalFromThePacketHeader(t *testing.T) {
	trail := &trailLog{}
	obs.Configure(obs.Config{Logger: slog.New(trail), Module: "sfu", Env: "test"})
	t.Cleanup(func() { obs.Configure(obs.Config{Module: "sfu", Env: "test"}) })
	session := newTestNode(t, nil).newTestSession(t, testScope("alice", 1))
	pub, layer := audioPublication()
	pub.session, layer.audioLevelID = session, 1
	var header rtp.Header
	writer := &packetWriter{}
	for i, sample := range []struct {
		level byte
		claim string
	}{{127, "ingress_packets"}, {30, "ingress_signal"}} {
		pub.audioSampleAt = monotonic() - int64(5*time.Second)
		pub.forward(layer, voicedPacket(t, uint16(i)+1, sample.level), false, &header, writer)
		session.traceMicrophoneIngress(pub, uint64(i)+1, uint64(i), monotonic())
		if len(trail.records) != i+1 {
			t.Fatalf("microphone level %d: got %d observations, want %d", sample.level, len(trail.records), i+1)
		}
		row := trail.records[i]
		if row["name"] != obs.EventAudioSfuIngress || row["audio_observation"] != sample.claim || row["participant_id"] != "alice" {
			t.Fatalf("microphone level %d: got %v, want %s for alice", sample.level, row, sample.claim)
		}
	}
}
