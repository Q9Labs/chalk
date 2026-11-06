package media

import (
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/rtcp"
)

// The node asks a publisher to resend lost video itself, instead of using
// Pion's NACK generator: Pion's never sees a packet repaired over RTX, so it
// would keep asking for packets that already arrived.
const (
	// nackPending bounds the lost packets one layer waits for. A longer gap is
	// repaired with a keyframe instead.
	nackPending = 64
	// nackGrace lets a packet reordered in transit arrive before it is reported lost.
	nackGrace = 5 * time.Millisecond
	// nackRetry is how long the node waits for a repair before asking again.
	nackRetry = 60 * time.Millisecond
	// nackTries bounds how often one packet is asked for.
	nackTries = 3
)

type missingPacket struct {
	ext   uint64 // 0 marks a free slot; extended numbers start at 1<<16
	due   int64  // monotonic time of the next request
	tries uint8
}

// nackTracker is one ingress layer's lost packets. The layer's reader records
// arrivals and a timer sends the requests, so the reader never waits on them.
type nackTracker struct {
	mu       sync.Mutex
	missing  [nackPending]missingPacket
	timer    *time.Timer
	deadline int64               // monotonic time the timer fires, or 0 while it is idle
	send     func(seqs []uint16) // writes one NACK; nil after the layer closes
	gaveUp   func()              // asks for a keyframe instead; called without t.mu

	requested atomic.Uint64 // sequence numbers asked for, retries included
	abandoned atomic.Uint64 // gaps repaired with a keyframe instead
}

// observe records one arrival. highest is the newest extended sequence number
// before it, or 0 for the layer's first packet.
func (t *nackTracker) observe(ext, highest uint64, now int64) {
	t.mu.Lock()
	switch {
	case highest == 0 || ext == highest:
	case ext < highest:
		t.clear(ext)
	case ext == highest+1:
	case ext-highest-1 > nackPending:
		t.reset()
		t.mu.Unlock()
		t.giveUp()
		return
	default:
		due := now + int64(nackGrace)
		for lost := highest + 1; lost < ext; lost++ {
			if !t.add(lost, due) {
				t.reset()
				t.mu.Unlock()
				t.giveUp()
				return
			}
		}
		t.arm(due, now)
	}
	t.mu.Unlock()
}

func (t *nackTracker) giveUp() {
	t.abandoned.Add(1)
	if t.gaveUp != nil {
		t.gaveUp()
	}
}

// add stores one lost packet; it reports false when the table is full.
func (t *nackTracker) add(ext uint64, due int64) bool {
	for index := range t.missing {
		if t.missing[index].ext == 0 {
			t.missing[index] = missingPacket{ext: ext, due: due}
			return true
		}
	}
	return false
}

func (t *nackTracker) clear(ext uint64) {
	for index := range t.missing {
		if t.missing[index].ext == ext {
			t.missing[index] = missingPacket{}
		}
	}
}

func (t *nackTracker) reset() { t.missing = [nackPending]missingPacket{} }

// arm makes the timer fire by due. It never postpones an earlier deadline, so a
// steady run of gaps cannot starve the requests already waiting. The caller holds t.mu.
func (t *nackTracker) arm(due, now int64) {
	if t.deadline != 0 && t.deadline <= due {
		return
	}
	t.deadline = due
	after := time.Duration(max(due-now, 0))
	if t.timer == nil {
		t.timer = time.AfterFunc(after, t.fire)
		return
	}
	t.timer.Reset(after)
}

// fire requests every lost packet that is due, and gives up on one that was
// asked for nackTries times or is older than the history a publisher keeps.
func (t *nackTracker) fire() {
	now := monotonic()
	t.mu.Lock()
	t.deadline = 0
	var seqs []uint16
	exhausted := false
	next := int64(-1)
	for index := range t.missing {
		entry := &t.missing[index]
		if entry.ext == 0 {
			continue
		}
		// The last request still gets its full response window before the keyframe fallback.
		if entry.tries >= nackTries && entry.due <= now {
			*entry = missingPacket{}
			exhausted = true
			continue
		}
		if entry.due <= now {
			seqs = append(seqs, uint16(entry.ext))
			entry.tries++
			entry.due = now + int64(nackRetry)
		}
		if next < 0 || entry.due < next {
			next = entry.due
		}
	}
	if next >= 0 {
		t.arm(next, now)
	}
	send := t.send
	t.mu.Unlock()
	if len(seqs) > 0 && send != nil {
		t.requested.Add(uint64(len(seqs)))
		send(seqs)
	}
	if exhausted {
		t.giveUp()
	}
}

func (t *nackTracker) stop() {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.timer != nil {
		t.timer.Stop()
	}
	t.deadline = 0
	t.reset()
	t.send = nil
}

// nackPacket builds the RTCP request for lost packets of one stream.
func nackPacket(ssrc uint32, seqs []uint16) []rtcp.Packet {
	return []rtcp.Packet{&rtcp.TransportLayerNack{MediaSSRC: ssrc, Nacks: rtcp.NackPairsFromSequenceNumbers(seqs)}}
}
