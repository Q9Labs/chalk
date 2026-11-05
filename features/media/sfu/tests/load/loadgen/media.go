package main

import (
	"context"
	"encoding/binary"
	"math"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

const (
	videoClock = 90000
	audioClock = 48000
	opusPT     = 111
	vp8PT      = 96
	// vp8StartOfPartition is the first byte of a VP8 payload descriptor with S=1.
	vp8StartOfPartition = 0x10
	tickEvery           = 10 * time.Millisecond
	framesPerSecond     = 25
)

// epoch anchors RTP timestamps. Sender and receiver share one process, so a
// packet's timestamp is its true send time and the interarrival jitter measures
// only what the network and the SFU added.
var epoch = time.Now()

// stream is one received RTP stream (one subscribed track).
type stream struct {
	video bool
	clock float64

	mu       sync.Mutex
	packets  uint64
	bytes    uint64
	started  bool
	highest  int64 // highest extended sequence number
	lastTS   uint32
	lastAt   float64 // arrival time in clock units since epoch
	jitter   float64 // RFC 3550 interarrival jitter, clock units
	haveLast bool
}

// record folds one received RTP packet into the stream's counters.
func (s *stream) record(packet []byte, now time.Time) {
	if len(packet) < 12 {
		return
	}
	seq := binary.BigEndian.Uint16(packet[2:4])
	ts := binary.BigEndian.Uint32(packet[4:8])
	arrival := now.Sub(epoch).Seconds() * s.clock

	s.mu.Lock()
	defer s.mu.Unlock()
	s.packets++
	s.bytes += uint64(len(packet))
	if !s.started {
		s.started = true
		s.highest = int64(seq)
	} else if ahead := int16(seq - uint16(s.highest)); ahead > 0 {
		s.highest += int64(ahead)
	}
	if s.haveLast {
		transit := (arrival - s.lastAt) - float64(int32(ts-s.lastTS))
		s.jitter += (math.Abs(transit) - s.jitter) / 16
	}
	s.lastTS, s.lastAt, s.haveLast = ts, arrival, true
}

type streamSnapshot struct {
	packets, bytes uint64
	highest        int64
	started        bool
}

func (s *stream) snapshot() streamSnapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	return streamSnapshot{packets: s.packets, bytes: s.bytes, highest: s.highest, started: s.started}
}

func (s *stream) jitterMs() float64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.jitter / s.clock * 1000
}

// streamSet collects the streams one process receives.
type streamSet struct {
	mu      sync.Mutex
	streams []*stream
}

func (set *streamSet) add(video bool) *stream {
	clock := float64(audioClock)
	if video {
		clock = videoClock
	}
	s := &stream{video: video, clock: clock}
	set.mu.Lock()
	set.streams = append(set.streams, s)
	set.mu.Unlock()
	return s
}

func (set *streamSet) all() []*stream {
	set.mu.Lock()
	defer set.mu.Unlock()
	return append([]*stream(nil), set.streams...)
}

// readTrack reads a received track until it ends, counting what arrives. It also
// drains the track's RTCP, which Pion needs to run its receiver interceptors.
func readTrack(remote *webrtc.TrackRemote, receiver *webrtc.RTPReceiver, set *streamSet) {
	s := set.add(remote.Kind() == webrtc.RTPCodecTypeVideo)
	go func() {
		for {
			if _, _, err := receiver.ReadRTCP(); err != nil {
				return
			}
		}
	}()
	buffer := make([]byte, 1500)
	for {
		n, _, err := remote.Read(buffer)
		if err != nil {
			return
		}
		s.record(buffer[:n], time.Now())
	}
}

// source writes synthetic RTP at a fixed packet rate.
type source struct {
	track    *webrtc.TrackLocalStaticRTP
	pt       uint8
	clock    float64
	pps      float64
	payload  []byte
	perFrame int // packets per frame; the last carries the marker bit (video only)
	delay    time.Duration

	// Simulcast layers carry their MID and RID in header extensions.
	rid          string
	mid          []byte
	midID, ridID uint8

	sent  int64
	seq   uint16
	bytes atomic.Uint64
	count atomic.Uint64
}

func newSource(track *webrtc.TrackLocalStaticRTP, pt uint8, clock, pps float64, payloadBytes int, video bool, delay time.Duration) *source {
	s := &source{track: track, pt: pt, clock: clock, pps: pps, payload: make([]byte, payloadBytes), delay: delay}
	if video {
		s.perFrame = max(1, int(math.Round(pps/framesPerSecond)))
	}
	return s
}

func (s *source) withRID(rid string) *source {
	s.rid = rid
	return s
}

// setExtensions turns on the MID and RID header extensions for a layer that has a RID.
func (s *source) setExtensions(mid string, midID, ridID uint8) {
	if s.rid == "" {
		return
	}
	s.mid, s.midID, s.ridID = []byte(mid), midID, ridID
}

// run writes packets on a fixed tick until ctx ends. Packets due since the last
// tick go out back to back, as a paced sender does.
func (s *source) run(ctx context.Context, done *sync.WaitGroup) {
	done.Go(func() {
		begin := time.Now().Add(s.delay)
		ticker := time.NewTicker(tickEvery)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case now := <-ticker.C:
				if now.Before(begin) {
					continue
				}
				due := int64(now.Sub(begin).Seconds() * s.pps)
				timestamp := uint32(now.Sub(epoch).Seconds() * s.clock)
				for ; s.sent < due; s.sent++ {
					if !s.write(timestamp) {
						return
					}
				}
			}
		}
	})
}

func (s *source) write(timestamp uint32) bool {
	first := s.perFrame == 0 || s.sent%int64(s.perFrame) == 0
	if s.perFrame > 0 {
		s.payload[0] = 0
		if first {
			s.payload[0] = vp8StartOfPartition
		}
	}
	packet := &rtp.Packet{
		Header: rtp.Header{
			Version: 2, PayloadType: s.pt, SequenceNumber: s.seq, Timestamp: timestamp,
			Marker: s.perFrame > 0 && s.sent%int64(s.perFrame) == int64(s.perFrame-1),
		},
		Payload: s.payload,
	}
	s.seq++
	if s.ridID != 0 {
		if err := packet.SetExtension(s.midID, s.mid); err != nil {
			return false
		}
		if err := packet.SetExtension(s.ridID, []byte(s.rid)); err != nil {
			return false
		}
	}
	if err := s.track.WriteRTP(packet); err != nil {
		return false
	}
	s.count.Add(1)
	s.bytes.Add(uint64(packet.MarshalSize()))
	return true
}
