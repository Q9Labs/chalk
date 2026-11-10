package media

import (
	"sync/atomic"

	"github.com/pion/webrtc/v4"
)

// section is one media section the node sends a subscriber's tracks on. It keeps one sender, and
// so one set of SSRCs, from its first track to the end of the session. Pion holds the SRTP
// rollover and replay state of every SSRC until the transport closes, and its RTCP sender reports
// and negotiated parameters belong to the sender its own connection made. A new sender for each
// pull would grow that state without bound and lose both. A closed video subscription parks the
// section, and the next pull of the same kind takes it, so what a session holds follows its
// sections and not its pulls.
type section struct {
	transceiver *webrtc.RTPTransceiver
	sender      *webrtc.RTPSender
	// current is the subscription sending on the section, nil while it is parked.
	current atomic.Pointer[subscription]
	// reading is set once the section's RTCP reader runs. The reader serves the section's
	// sender for its life, whichever subscription is current.
	reading atomic.Bool
	// stream is where the last subscription left the outgoing stream. The next one continues it,
	// so the subscriber's SRTP replay window and decoder see one stream. It is written before the
	// section is parked and read after it is taken, under the session's mu.
	stream translator
	// rtx numbers the section's RTX stream. Every subscription's binding on the section draws from
	// this one counter, so a writer of an earlier subscription that is still running (a bandwidth
	// probe, a repair in flight) takes a number no later binding takes, and no number repeats.
	rtx *atomic.Uint32
}

func newSection(transceiver *webrtc.RTPTransceiver) *section {
	return &section{transceiver: transceiver, sender: transceiver.Sender()}
}

// readFeedback serves the subscriber's RTCP until the section's sender stops: keyframe requests go
// to the publisher's forwarded layer, and lost packets are resent from the layer's shared
// history. Pion also needs this read to run its RTCP interceptors. Transport-wide feedback
// reaches the transport from the session's RTCP buffers instead, whichever SSRC it names.
func (sec *section) readFeedback() {
	writer := &packetWriter{}
	for {
		packets, _, err := sec.sender.ReadRTCP()
		if err != nil {
			return
		}
		if sub := sec.current.Load(); sub != nil && !sub.closed.Load() {
			sub.handleFeedback(packets, writer)
		}
	}
}
