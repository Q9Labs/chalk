package media

import "net/netip"

type queued struct {
	addr netip.AddrPort
	n    int
	buf  [datagramMax]byte
}

// ring is a fixed queue of datagrams that drops its oldest when full.
type ring struct {
	slots       []queued
	head, count int
}

func newRing(size int) ring { return ring{slots: make([]queued, size)} }

func (r *ring) at(i int) *queued {
	i += r.head
	if i >= len(r.slots) {
		i -= len(r.slots)
	}
	return &r.slots[i]
}

// claim returns the slot for the next datagram. When the ring is full it takes the oldest
// datagram's slot and reports that one as dropped.
func (r *ring) claim() (slot *queued, dropped bool) {
	if r.count == len(r.slots) {
		r.head++
		if r.head == len(r.slots) {
			r.head = 0
		}
		r.count--
		dropped = true
	}
	slot = r.at(r.count)
	r.count++
	return slot, dropped
}

// sendQueue is what the callers fill and the writer takes: audio-class datagrams (everything
// that is not video) and video datagrams.
type sendQueue struct{ audio, video ring }

func newSendQueue() *sendQueue {
	return &sendQueue{audio: newRing(audioRing), video: newRing(videoRing)}
}

func (q *sendQueue) len() int { return q.audio.count + q.video.count }
