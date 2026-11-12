package tests

import (
	"encoding/binary"
	"math"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
)

// liveTrack is one received track: frames per layer, stalls, loss and jitter.
type liveTrack struct {
	kind  string // audio, camera or screen
	clock float64
	// layer is the latest keyframe's layer, told apart by the fixtures' widths.
	layer    string
	frames   map[string]int64 // video frames by layer; audio packets under "audio"
	switches int64
	stalls   int64
	longest  time.Duration
	// longestAt is when the longest stall ended.
	longestAt time.Time
	lastAt    time.Time // the latest frame start, or audio packet
	lastTS    uint32
	epoch     int64
	// Loss counts unique sequence numbers against the extended range; a share
	// pause starts a new range, because the sender's counters run on through it.
	started            bool
	first, highest     int64
	seen               [4096]int64 // extended sequence number + 1, by slot
	received, expected int64       // of closed ranges
	unique             int64       // in the open range
	// jitter is RFC 3550 interarrival jitter, in seconds.
	jitter  float64
	prevAt  time.Time
	prevTS  uint32
	hasPrev bool
}

func (s *liveTrack) observe(packet *rtp.Packet, at time.Time, epoch int64, since time.Time) {
	if s.kind == "screen" && epoch != s.epoch && s.started {
		s.closeRange()
	}
	if !s.sequence(packet.SequenceNumber) {
		return
	}
	s.updateJitter(packet, at)

	if s.kind == "audio" {
		s.gap(at, epoch, since)
		s.frames["audio"]++
		return
	}
	if s.lastAt.IsZero() || int32(packet.Timestamp-s.lastTS) > 0 {
		s.gap(at, epoch, since)
		s.lastTS = packet.Timestamp
	}
	s.noteLayer(packet.Payload)
	if packet.Marker && s.layer != "" {
		s.frames[s.layer]++
	}
}

// updateJitter folds the packet's transit variation into the RFC 3550 jitter estimate.
func (s *liveTrack) updateJitter(packet *rtp.Packet, at time.Time) {
	if s.hasPrev {
		d := at.Sub(s.prevAt).Seconds() - float64(int32(packet.Timestamp-s.prevTS))/s.clock
		s.jitter += (math.Abs(d) - s.jitter) / 16
	}
	s.prevAt, s.prevTS, s.hasPrev = at, packet.Timestamp, true
}

// noteLayer reads the layer from the width of a VP8 keyframe and counts a switch.
func (s *liveTrack) noteLayer(payload []byte) {
	var vp8 codecs.VP8Packet
	data, err := vp8.Unmarshal(payload)
	if err != nil || vp8.S != 1 || vp8.PID != 0 || len(data) < 10 || data[0]&0x01 != 0 {
		return
	}
	layer := "l"
	if binary.LittleEndian.Uint16(data[6:8])&0x3FFF >= 320 {
		layer = "h"
	}
	if s.kind == "screen" {
		layer = "screen"
	}
	if s.layer != "" && layer != s.layer {
		s.switches++
	}
	s.layer = layer
}

// gap counts a stall when media stopped for longer than liveStall while the
// source was meant to send. The first frame of a share stretch has liveShareStartup
// instead, counted when it arrives, so a late start stays in the count.
func (s *liveTrack) gap(at time.Time, epoch int64, since time.Time) {
	var quiet time.Duration
	switch {
	case s.kind == "screen" && !since.IsZero() && s.lastAt.Before(since):
		if delay := at.Sub(since); delay > liveShareStartup {
			quiet = delay
		}
	case !s.lastAt.IsZero() && epoch == s.epoch:
		if gap := at.Sub(s.lastAt); gap > liveStall {
			quiet = gap
		}
	}
	if quiet > 0 {
		s.stalls++
		if quiet > s.longest {
			s.longest, s.longestAt = quiet, at
		}
	}
	s.lastAt, s.epoch = at, epoch
}

// silence is how long the track has been quiet at now when that is a stall, or zero. A
// microphone or camera is meant to send from its first packet on. A screen is meant to send
// from since, the start of its share stretch, and not at all while since is zero.
func (s *liveTrack) silence(now, since time.Time) time.Duration {
	if s.kind != "screen" {
		since = time.Time{}
	} else if since.IsZero() {
		return 0
	}
	from, limit := s.lastAt, liveStall
	if from.Before(since) {
		from, limit = since, liveShareStartup
	}
	if from.IsZero() {
		return 0
	}
	if quiet := now.Sub(from); quiet > limit {
		return quiet
	}
	return 0
}

// stallsAt is the stalls so far plus the one in progress, which no packet has ended yet.
func (s *liveTrack) stallsAt(now, since time.Time) (stalls int64, longest time.Duration) {
	stalls, longest = s.stalls, s.longest
	if quiet := s.silence(now, since); quiet > 0 {
		stalls++
		longest = max(longest, quiet)
	}
	return stalls, longest
}

// closeStretch counts the end of a share stretch as a stall when the screen had gone quiet.
func (s *liveTrack) closeStretch(now, since time.Time) {
	if quiet := s.silence(now, since); quiet > 0 {
		s.stalls++
		if quiet > s.longest {
			s.longest, s.longestAt = quiet, now
		}
	}
}

// sequence records a sequence number and reports whether it is new.
func (s *liveTrack) sequence(seq uint16) bool {
	if !s.started {
		s.started, s.first, s.highest, s.unique = true, int64(seq), int64(seq), 0
		clear(s.seen[:])
	}
	extended := s.highest + int64(int16(seq-uint16(s.highest)))
	slot := extended & int64(len(s.seen)-1)
	if s.seen[slot] == extended+1 {
		return false
	}
	s.seen[slot] = extended + 1
	s.unique++
	s.highest = max(s.highest, extended)
	s.first = min(s.first, extended)
	return true
}

func (s *liveTrack) closeRange() {
	s.expected += s.highest - s.first + 1
	s.received += s.unique
	s.started = false
}

func (s *liveTrack) totals() (expected, received int64) {
	expected, received = s.expected, s.received
	if s.started {
		expected += s.highest - s.first + 1
		received += s.unique
	}
	return expected, received
}
