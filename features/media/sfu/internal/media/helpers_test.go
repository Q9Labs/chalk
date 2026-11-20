package media

import (
	"encoding/binary"
	"sync"
	"time"

	"github.com/pion/rtp"
	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// wireWriter records what a transport put on the wire.
type wireWriter struct {
	mu      sync.Mutex
	packets []wirePacket
}

type wirePacket struct {
	ssrc         uint32
	seq          uint16
	transportSeq uint16
	payloadSize  int
}

func (w *wireWriter) WriteRTP(header *rtp.Header, payload []byte) (int, error) {
	packet := wirePacket{ssrc: header.SSRC, seq: header.SequenceNumber, payloadSize: len(payload)}
	if extension := header.GetExtension(3); len(extension) == 2 {
		packet.transportSeq = binary.BigEndian.Uint16(extension)
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	w.packets = append(w.packets, packet)
	return len(payload), nil
}

func (w *wireWriter) Write(b []byte) (int, error) { return len(b), nil }

func (w *wireWriter) sent() []wirePacket {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([]wirePacket(nil), w.packets...)
}

func episodeScope(episode, participant string) protocol.Scope {
	return protocol.Scope{TenantID: "tenant-1", EpisodeID: episode, ParticipantID: participant, Generation: 1}
}

// nextTick returns a clock reading later than every packet already sent. A coarse clock (Windows)
// gives packets sent in the same few milliseconds one timestamp, so a lease granted without
// waiting would also cover the packets sent before it.
func nextTick() int64 {
	before := monotonic()
	for monotonic() == before {
		time.Sleep(time.Millisecond)
	}
	return monotonic()
}
