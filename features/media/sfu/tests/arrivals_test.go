package tests

import (
	"sync"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
	"github.com/pion/webrtc/v4"
)

// timedArrivals records when media reached the viewer, so a test can find the longest stretch with
// none. Audio counts every packet. Video counts a frame only once all of its packets have arrived
// and its RTP timestamp is newer than the last frame counted, so a stream of packets that never
// completes a frame is a freeze. It sees frame boundaries, not whether a decoder could show the
// frame: the padded fixtures do not decode, and a frame that completes but is undecodable still counts.
type timedArrivals struct {
	mu     sync.Mutex
	times  map[webrtc.RTPCodecType][]time.Time
	frames frameAssembler
}

func timeArrivals(p *peer) *timedArrivals {
	a := &timedArrivals{times: map[webrtc.RTPCodecType][]time.Time{}}
	p.pc.OnTrack(func(remote *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		go func() {
			for {
				packet, _, err := remote.ReadRTP()
				if err != nil {
					return
				}
				a.mu.Lock()
				if remote.Kind() == webrtc.RTPCodecTypeVideo {
					if a.frames.add(packet) {
						a.times[webrtc.RTPCodecTypeVideo] = append(a.times[webrtc.RTPCodecTypeVideo], time.Now())
					}
				} else {
					a.times[remote.Kind()] = append(a.times[remote.Kind()], time.Now())
				}
				a.mu.Unlock()
			}
		}()
	})
	return a
}

// frameAssembler tells when a video frame is complete: the packet that starts the frame (VP8
// start-of-partition, partition 0), the marker packet, and every sequence number between them have
// arrived. Packets may come in any order, and a frame whose start never arrives is never complete.
type frameAssembler struct {
	parts    map[uint32]*frameParts
	lastDone uint32
	any      bool
}

type frameParts struct {
	seqs         map[uint16]struct{}
	start, high  uint16
	started, end bool
}

// add takes one packet and reports whether it completed a frame newer than every frame counted before.
func (f *frameAssembler) add(packet *rtp.Packet) bool {
	ts := packet.Timestamp
	if f.any && int32(ts-f.lastDone) <= 0 {
		return false
	}
	if f.parts == nil {
		f.parts = map[uint32]*frameParts{}
	}
	frame := f.parts[ts]
	if frame == nil {
		frame = &frameParts{seqs: map[uint16]struct{}{}}
		f.parts[ts] = frame
	}
	var vp8 codecs.VP8Packet
	if _, err := vp8.Unmarshal(packet.Payload); err == nil && vp8.S == 1 && vp8.PID == 0 {
		frame.start, frame.started = packet.SequenceNumber, true
	}
	if packet.Marker {
		frame.high, frame.end = packet.SequenceNumber, true
	}
	frame.seqs[packet.SequenceNumber] = struct{}{}
	if !frame.started || !frame.end || len(frame.seqs) != int(frame.high-frame.start)+1 {
		return false
	}
	f.lastDone, f.any = ts, true
	for pending := range f.parts {
		if int32(pending-ts) <= 0 {
			delete(f.parts, pending)
		}
	}
	return true
}

// longestGap is the longest time inside [from, to] with no packet of kind.
func (a *timedArrivals) longestGap(kind webrtc.RTPCodecType, from, to time.Time) time.Duration {
	a.mu.Lock()
	defer a.mu.Unlock()
	longest, last := time.Duration(0), from
	for _, at := range a.times[kind] {
		if at.Before(from) {
			continue
		}
		if at.After(to) {
			break
		}
		longest, last = max(longest, at.Sub(last)), at
	}
	return max(longest, to.Sub(last))
}
