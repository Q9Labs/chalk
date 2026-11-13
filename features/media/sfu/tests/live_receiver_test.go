package tests

import (
	"strings"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"
)

// liveReceiver keeps one peer's per-track delivery statistics.
type liveReceiver struct {
	class  *liveClass
	mu     sync.Mutex
	tracks map[string]*liveTrack
	// missedScreens counts share stretches that ended with no screen track at this viewer.
	missedScreens int64
}

func receiveLive(p *peer, class *liveClass) *liveReceiver {
	r := &liveReceiver{class: class, tracks: map[string]*liveTrack{}}
	p.pc.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		stats := &liveTrack{kind: "audio", clock: float64(track.Codec().ClockRate), frames: map[string]int64{}}
		switch {
		case strings.HasPrefix(track.ID(), cameraName):
			stats.kind = "camera"
		case track.ID() == screenName:
			stats.kind = "screen"
		}
		r.mu.Lock()
		r.tracks[track.StreamID()+"/"+track.ID()] = stats
		r.mu.Unlock()
		go func() {
			for {
				packet, _, err := track.ReadRTP()
				if err != nil {
					return
				}
				at, epoch, since := time.Now(), r.class.shareEpoch.Load(), r.class.sharingSince()
				r.mu.Lock()
				stats.observe(packet, at, epoch, since)
				r.mu.Unlock()
			}
		}()
	})
	return r
}

// microphones counts the microphones that delivered audio.
func (r *liveReceiver) microphones() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	count := 0
	for _, track := range r.tracks {
		if track.kind == "audio" && track.frames["audio"] > 0 {
			count++
		}
	}
	return count
}

// screens lists the screen tracks received. The caller holds r.mu.
func (r *liveReceiver) screens() []*liveTrack {
	var found []*liveTrack
	for _, track := range r.tracks {
		if track.kind == "screen" {
			found = append(found, track)
		}
	}
	return found
}

// sawScreen reports whether a screen frame arrived.
func (r *liveReceiver) sawScreen() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, track := range r.tracks {
		if track.kind == "screen" && track.frames["screen"] > 0 {
			return true
		}
	}
	return false
}
