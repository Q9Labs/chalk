package media

// rtpPacket is one ingress packet as the forwarder sees it. payload aliases the
// reader's buffer, so nothing may keep it past the write that uses it.
type rtpPacket struct {
	extSeq      uint64 // sequence number extended across wraps by the ingress layer
	timestamp   uint32
	marker      bool
	paddingSize byte
	payload     []byte // media payload, padding removed
	arrival     int64  // monotonic nanoseconds
	vp8         vp8Descriptor
	hasVP8      bool
	// audioLevel is the publisher's RFC 6464 byte (voice flag and level), kept
	// so subscribers learn who speaks.
	audioLevel    byte
	hasAudioLevel bool
}

// switchPoint reports whether a subscriber can start on this packet: any audio
// packet, or the first packet of a video key frame.
func (p *rtpPacket) switchPoint(video bool) bool {
	if !video {
		return len(p.payload) > 0
	}
	return p.hasVP8 && p.vp8.keyframe
}

// segment maps one run of forwarded packets from one ingress layer into the
// subscriber's sequence space. Within a segment every field is a fixed offset
// from the ingress value, which keeps reordered packets in place.
type segment struct {
	layer           int
	outStart        uint64 // first outgoing extended sequence number
	seqOffset       uint64 // ingress = outgoing + seqOffset
	tsOffset        uint32 // ingress timestamp = outgoing + tsOffset
	pictureIDOffset uint16
	tl0Offset       uint8
	keyIdxOffset    uint8
}

// recentSegments bounds the sequence map. One second of history spans few
// switches, so eight segments cover every retransmission the history can serve.
const recentSegments = 8

// outgoing is what one subscriber sends for one ingress packet.
type outgoing struct {
	seq       uint16
	timestamp uint32
	vp8       vp8Rewrite
}

// translator is one subscriber's view of one publication: which ingress layer
// it forwards, and how that layer's sequence numbers, timestamps and VP8
// picture identifiers map onto the single stream the subscriber decodes. Its
// outgoing stream stays continuous across layer switches, pauses, sequence
// wraps and reordering. The caller serializes access.
type translator struct {
	clockRate uint32

	forwarding bool
	live       segment
	liveFrom   uint64 // first ingress extended sequence number of the live segment

	segments [recentSegments]segment // newest at segments[(next-1)%recentSegments]
	count    int
	next     int

	started     bool
	highestOut  uint64
	lastTS      uint32
	lastArrival int64

	pictureIDSent bool
	lastPictureID uint16
	tl0Sent       bool
	lastTL0       uint8
	keyIdxSent    bool
	lastKeyIdx    uint8
}

// continued is the translator of a stream that goes on after this one ends: it has sent what this
// one has and forwards nothing until its first switch point, which continues the outgoing sequence
// number, timestamp and VP8 identifiers.
func (t translator) continued() translator {
	t.forwarding, t.live, t.liveFrom = false, segment{}, 0
	t.segments, t.count, t.next = [recentSegments]segment{}, 0, 0
	return t
}

// layer is the forwarded layer, or -1.
func (t *translator) layer() int {
	if !t.forwarding {
		return -1
	}
	return t.live.layer
}

// begin starts a new segment on p, which must be a switch point of layer. The
// outgoing stream continues one sequence number after the newest one sent, its
// timestamp advances by the wall time since then, and VP8 identifiers continue
// by one.
func (t *translator) begin(layer int, p *rtpPacket) outgoing {
	next := segment{layer: layer, outStart: p.extSeq}
	if t.started {
		next.outStart = t.highestOut + 1
		next.seqOffset = p.extSeq - next.outStart
		next.tsOffset = p.timestamp - (t.lastTS + t.elapsedTicks(p.arrival))
	}
	if p.hasVP8 {
		d := &p.vp8
		if d.pictureIDBits != 0 && t.pictureIDSent {
			mask := pictureIDMask(d.pictureIDBits)
			next.pictureIDOffset = (d.pictureID - (t.lastPictureID + 1)) & mask
		}
		if d.hasTL0 && t.tl0Sent {
			next.tl0Offset = d.tl0 - (t.lastTL0 + 1)
		}
		if d.hasKeyIdx && t.keyIdxSent {
			next.keyIdxOffset = (d.keyIdx - (t.lastKeyIdx + 1)) & vp8KeyIdxMask
		}
	}
	t.live, t.liveFrom, t.forwarding = next, p.extSeq, true
	t.segments[t.next] = next
	t.next = (t.next + 1) % recentSegments
	t.count = min(t.count+1, recentSegments)
	return t.emit(p)
}

// elapsedTicks converts the wall time since the newest packet sent into RTP
// ticks, at least one so timestamps strictly advance across a switch.
func (t *translator) elapsedTicks(arrival int64) uint32 {
	elapsed := max(arrival-t.lastArrival, 0)
	ticks := uint32(elapsed / 1000 * int64(t.clockRate) / 1_000_000)
	return max(ticks, 1)
}

// forward translates a packet of the live segment's layer. It reports false
// for a packet older than the segment's switch point: that packet belongs to
// the stream before the key frame, and its outgoing sequence number would
// collide with the previous segment.
func (t *translator) forward(p *rtpPacket) (outgoing, bool) {
	if int64(p.extSeq-t.liveFrom) < 0 {
		return outgoing{}, false
	}
	return t.emit(p), true
}

// emit maps p through the live segment and advances the newest-sent state.
func (t *translator) emit(p *rtpPacket) outgoing {
	out := t.live.translate(p)
	outExt := p.extSeq - t.live.seqOffset
	if !t.started || int64(outExt-t.highestOut) > 0 {
		t.started, t.highestOut, t.lastTS, t.lastArrival = true, outExt, out.timestamp, p.arrival
	}
	if p.hasVP8 {
		d := &p.vp8
		if d.pictureIDBits != 0 {
			mask := pictureIDMask(d.pictureIDBits)
			if !t.pictureIDSent || newerModulo(out.vp8.pictureID, t.lastPictureID, mask) {
				t.pictureIDSent, t.lastPictureID = true, out.vp8.pictureID
			}
		}
		if d.hasTL0 && (!t.tl0Sent || int8(out.vp8.tl0-t.lastTL0) > 0) {
			t.tl0Sent, t.lastTL0 = true, out.vp8.tl0
		}
		if d.hasKeyIdx && (!t.keyIdxSent || newerModulo(uint16(out.vp8.keyIdx), uint16(t.lastKeyIdx), vp8KeyIdxMask)) {
			t.keyIdxSent, t.lastKeyIdx = true, out.vp8.keyIdx
		}
	}
	return out
}

// translate maps p through the segment. Retransmissions use it with the segment
// the packet was first sent in.
func (seg *segment) translate(p *rtpPacket) outgoing {
	out := outgoing{seq: uint16(p.extSeq - seg.seqOffset), timestamp: p.timestamp - seg.tsOffset}
	if p.hasVP8 {
		d := &p.vp8
		out.vp8 = vp8Rewrite{
			pictureID: (d.pictureID - seg.pictureIDOffset) & pictureIDMask(d.pictureIDBits),
			tl0:       d.tl0 - seg.tl0Offset,
			keyIdx:    (d.keyIdx - seg.keyIdxOffset) & vp8KeyIdxMask,
		}
	}
	return out
}

// stop ends forwarding, as for a pause. The next segment continues the
// outgoing stream where this one ended.
func (t *translator) stop() { t.forwarding = false }

// lookup finds the segment and ingress extended sequence number behind an
// outgoing sequence number the subscriber reports lost.
func (t *translator) lookup(seq uint16) (segment, uint64, bool) {
	if !t.started {
		return segment{}, 0, false
	}
	behind := uint16(t.highestOut) - seq
	if behind >= 1<<15 {
		return segment{}, 0, false
	}
	outExt := t.highestOut - uint64(behind)
	for i := 1; i <= t.count; i++ {
		seg := t.segments[(t.next-i+recentSegments)%recentSegments]
		if int64(outExt-seg.outStart) >= 0 {
			return seg, outExt + seg.seqOffset, true
		}
	}
	return segment{}, 0, false
}

// newerModulo reports whether a is ahead of b in a sequence space of mask+1 values.
func newerModulo(a, b, mask uint16) bool {
	diff := (a - b) & mask
	return diff != 0 && diff <= mask/2
}
