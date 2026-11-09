package media

import (
	"sync"
	"time"
)

// historyAge is the oldest packet a retransmission may repeat. An older loss is
// repaired with a keyframe instead.
const historyAge = time.Second

// history keeps the recent packets of one ingress stream, once for every
// subscriber of that stream. Payloads live in one fixed byte arena that is
// written in order and wraps, so the history never grows past its budget. The
// stream's reader stores; subscribers' retransmissions load.
type history struct {
	mu      sync.Mutex
	arena   []byte
	written uint64 // absolute arena position after the newest payload
	slots   []historySlot
	mask    uint64
}

type historySlot struct {
	extSeq      uint64
	position    uint64 // absolute arena position of the payload
	length      uint16
	timestamp   uint32
	arrival     int64
	marker      bool
	paddingSize byte
	used        bool
}

// newHistory sizes the arena to bytes and the index to slots, rounded up to a
// power of two.
func newHistory(bytes, slots int) *history {
	size := 1
	for size < slots {
		size <<= 1
	}
	return &history{arena: make([]byte, bytes), slots: make([]historySlot, size), mask: uint64(size - 1)}
}

// store copies a new packet in and reports whether it may be forwarded. A
// duplicate, or a packet older than its index slot, must not be sent again as
// primary RTP: SRTP rejects the replay before the receiver can report its TWCC
// number. A packet larger than the arena still forwards, but is not kept.
func (h *history) store(p *rtpPacket) bool {
	length := uint64(len(p.payload))
	capacity := uint64(len(h.arena))
	if length > capacity || length > maxPayloadBytes {
		return true
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	slot := &h.slots[p.extSeq&h.mask]
	if slot.used && int64(p.extSeq-slot.extSeq) <= 0 {
		return false
	}
	position := h.written
	if offset := position % capacity; offset+length > capacity {
		position += capacity - offset // a payload never straddles the arena's end
	}
	copy(h.arena[position%capacity:], p.payload)
	h.written = position + length
	*slot = historySlot{
		extSeq: p.extSeq, position: position, length: uint16(length), timestamp: p.timestamp,
		arrival: p.arrival, marker: p.marker, paddingSize: p.paddingSize, used: true,
	}
	return true
}

// load copies the packet with that extended sequence number into dst and
// returns it with dst's payload bytes. It reports false when the packet was
// never stored, has been overwritten, or is older than historyAge.
func (h *history) load(extSeq uint64, now int64, dst []byte) (rtpPacket, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	slot := h.slots[extSeq&h.mask]
	capacity := uint64(len(h.arena))
	switch {
	case !slot.used || slot.extSeq != extSeq,
		h.written > slot.position+capacity,
		now-slot.arrival > int64(historyAge),
		int(slot.length) > len(dst):
		return rtpPacket{}, false
	}
	start := slot.position % capacity
	n := copy(dst, h.arena[start:start+uint64(slot.length)])
	return rtpPacket{extSeq: extSeq, timestamp: slot.timestamp, arrival: slot.arrival, marker: slot.marker, paddingSize: slot.paddingSize, payload: dst[:n]}, true
}
