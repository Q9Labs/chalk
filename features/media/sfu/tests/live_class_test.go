package tests

import (
	"cmp"
	"context"
	"fmt"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// liveClass is one Episode of the run.
type liveClass struct {
	episode   string
	people    []*participant
	receivers []*liveReceiver
	// shareEpoch rises at every share start and stop, so a viewer can tell a
	// pause from a stall.
	shareEpoch atomic.Int64
	// shareStart is when the screen's current share stretch began, in Unix nanoseconds, or 0
	// while it is paused.
	shareStart atomic.Int64
	// stop ends the class's share goroutine.
	stop context.CancelFunc
}

// shutdown ends the class's share goroutine and closes its peers, so its publishers stop
// writing: a write on a closed peer fails and ends its loop.
func (c *liveClass) shutdown() {
	c.stop()
	for _, person := range c.people {
		_ = person.peer.pc.Close()
	}
}

// sharingSince is when the current share stretch began, or the zero time while the screen is paused.
func (c *liveClass) sharingSince() time.Time {
	if start := c.shareStart.Load(); start != 0 {
		return time.Unix(0, start)
	}
	return time.Time{}
}

// endStretch checks every viewer's screen at the end of a share stretch, so a viewer that
// got nothing or went quiet before the end shows a stall even though no later packet exposes it.
func (c *liveClass) endStretch(now time.Time) {
	since := c.sharingSince()
	for index, receiver := range c.receivers {
		if index == 0 {
			continue
		}
		receiver.mu.Lock()
		if screens := receiver.screens(); len(screens) == 0 {
			receiver.missedScreens++
		} else {
			for _, track := range screens {
				track.closeStretch(now, since)
			}
		}
		receiver.mu.Unlock()
	}
}

// joinClass joins one class and pulls everyone's media to everyone. It
// returns the node's refusal when admission turns a Participant away.
func joinClass(t *testing.T, svc *service, load liveLoad, run int64, index int) (*liveClass, string) {
	t.Helper()
	class := &liveClass{episode: fmt.Sprintf("live-smoke-%d-%d", run, index)}
	t.Cleanup(func() {
		_, _ = svc.call(t, "/v1/episodes/end", protocol.EndEpisodeRequest{TenantID: liveTenant, EpisodeID: class.episode}, nil)
	})
	what := publishing{cameras: load.cameras, chunks: [2]int{liveChunk, liveChunk}, screenChunk: liveChunk,
		frameBytes: [3]int{frameBytes(load.cameraKbps[0]), frameBytes(load.cameraKbps[1]), frameBytes(liveScreenKbps)}}
	for person := range load.participants {
		through := newLinkOn(t, "0.0.0.0:0")
		p := &participant{name: fmt.Sprintf("c%dp%d", index, person), link: through,
			scope: protocol.Scope{TenantID: liveTenant, EpisodeID: class.episode, ParticipantID: fmt.Sprintf("p%d", person), Generation: 1}}
		p.peer = newMediaPeer(t, through, true)
		receiver := receiveLive(p.peer, class)
		var created protocol.CreateSessionResponse
		if status, code := svc.call(t, "/v1/sessions", protocol.CreateSessionRequest{OperationID: op(), Scope: p.scope}, &created); status >= 300 {
			return class, refusalOf(t, svc, class, index, person, status, code)
		}
		p.conn = created.ConnectionID
		svc.grantSources(t, p.scope)
		what.screen = person == 0
		p.publish(t, svc, what)
		class.people = append(class.people, p)
		class.receivers = append(class.receivers, receiver)
	}
	for index, person := range class.people {
		tracks := wantedTracks(load, class.people, index)
		for batch := range slices.Chunk(tracks, protocol.MaxTracksPerRequest) {
			person.pull(t, svc, batch)
		}
	}
	return class, ""
}

// refusalOf ends the class's Episode after the node refused a Participant and describes the
// refusal with the node's admission state.
func refusalOf(t *testing.T, svc *service, class *liveClass, index, person, status int, code string) string {
	_, _ = svc.call(t, "/v1/episodes/end", protocol.EndEpisodeRequest{TenantID: liveTenant, EpisodeID: class.episode}, nil)
	var ready protocol.ReadyResponse
	_ = get(svc, "/readyz", &ready)
	return fmt.Sprintf("class %d Participant %d: %d %s (admission %q, steal %.1f%%, queue p95 %.1f ms)",
		index, person, status, code, ready.Host.AdmissionReason, *cmp.Or(ready.Host.StealPercent, new(float64)), ready.Host.QueueDelayP95Ms)
}

// wantedTracks lists what the index-th Participant pulls: every other Participant's microphone,
// cameras and screen. In a class past the small-tile size every camera but the featured
// Participant's asks for the low layer, as the SDK does for small tiles.
func wantedTracks(load liveLoad, people []*participant, index int) []protocol.Track {
	var tracks []protocol.Track
	featured := people[(index+1)%len(people)]
	for _, other := range people {
		if other == people[index] {
			continue
		}
		tracks = append(tracks, remote(other, micName))
		small := load.smallTiles > 0 && load.participants > load.smallTiles && other != featured
		for camera := range load.cameras {
			track := remote(other, cameraTrack(camera))
			if small {
				track.Simulcast.PreferredRID = "l"
			}
			tracks = append(tracks, track)
		}
		if other.screen != nil {
			tracks = append(tracks, remote(other, screenName))
		}
	}
	return tracks
}

// shareInStretches turns the sharer's screen on and off so it is on for the
// duty share of every period, starting phase into its first stretch.
func (c *liveClass) shareInStretches(ctx context.Context, load liveLoad, phase time.Duration) {
	screen := c.people[0].screen
	on := load.shareOn()
	off := load.sharePeriod - on
	if on <= 0 {
		c.shareEpoch.Add(1)
		screen.enable(0, false)
		return
	}
	if off <= 0 {
		return
	}
	wait, live := on-phase%on, true
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		live = !live
		if !live {
			c.endStretch(time.Now())
			c.shareStart.Store(0)
		}
		c.shareEpoch.Add(1)
		screen.enable(0, live)
		wait = off
		if live {
			c.shareStart.Store(time.Now().UnixNano())
			wait = on
		}
	}
}

// flowing reports whether every Participant hears everyone else and, while the
// screen is shared, every other viewer sees it. Which cameras it sees is the
// allocator's call, so the samples report that.
func (c *liveClass) flowing() bool {
	sharing := !c.sharingSince().IsZero()
	for index, receiver := range c.receivers {
		if receiver.microphones() < len(c.people)-1 {
			return false
		}
		if sharing && index > 0 && !receiver.sawScreen() {
			return false
		}
	}
	return true
}

// describe lists what each Participant receives and how the node delivers it.
func (c *liveClass) describe(svc *service) string {
	var out strings.Builder
	for index, person := range c.people {
		receiver := c.receivers[index]
		receiver.mu.Lock()
		fmt.Fprintf(&out, "\n%s receives:", person.name)
		for key, track := range receiver.tracks {
			fmt.Fprintf(&out, " %s(%s layer %q frames %v unique %d)", key, track.kind, track.layer, track.frames, track.unique)
		}
		receiver.mu.Unlock()
		var inspected protocol.InspectResponse
		if err := post(svc, "/v1/sessions/"+person.conn+"/inspect", protocol.InspectRequest{Scope: person.scope}, &inspected); err != nil {
			fmt.Fprintf(&out, "; inspect: %v", err)
			continue
		}
		transport := inspected.Transport
		fmt.Fprintf(&out, "; transport estimate %d proven %d feedback age %v queued %d probing %v sent %+v dropped %d probes %d/%d; episode %+v",
			transport.EstimateBps, transport.ProvenBps, transport.FeedbackAgeMs, transport.QueuedBytes, transport.Probing, transport.Sent, transport.Dropped, transport.ProvedProbe, transport.Probes, inspected.Episode)
		for _, track := range inspected.Tracks {
			if track.Subscription != nil {
				fmt.Fprintf(&out, "; %s/%s %+v", track.SessionID, track.TrackName, *track.Subscription)
			}
		}
	}
	return out.String()
}

// renewGrants renews every Participant's sources in one request, as the API does.
func (c *liveClass) renewGrants(svc *service) {
	var controls []protocol.SourceControl
	for _, person := range c.people {
		for _, source := range []string{"microphone", "camera", "screen", "screen_audio"} {
			controls = append(controls, protocol.SourceControl{ParticipantID: person.scope.ParticipantID, Source: source, Action: protocol.SourceGrant, Revision: 1})
		}
	}
	_ = post(svc, "/v1/episodes/sources", protocol.SourceControlRequest{TenantID: liveTenant, EpisodeID: c.episode, Controls: controls}, nil)
}

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
