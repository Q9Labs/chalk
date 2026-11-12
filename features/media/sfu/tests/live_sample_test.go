package tests

import (
	"cmp"
	"fmt"
	"strings"
	"time"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// liveSample is one interval's view of the node, the peers and the generator.
// Counters are cumulative since the run started.
type liveSample struct {
	At        time.Time               `json:"at"`
	Elapsed   string                  `json:"elapsed"`
	Classes   int                     `json:"classes"`
	Ready     *protocol.ReadyResponse `json:"ready,omitempty"`
	ReadyErr  string                  `json:"readyError,omitempty"`
	Node      nodeTotals              `json:"node"`
	Peers     peerTotals              `json:"peers"`
	Generator hostSample              `json:"generator"`
	Broke     string                  `json:"broke,omitempty"`
	Refused   string                  `json:"refused,omitempty"`
}

// nodeTotals sums what the node's inspect reports over every session.
type nodeTotals struct {
	Sessions      int `json:"sessions"`
	InspectErrors int `json:"inspectErrors"`
	// PacerDropped is video the pacer dropped on a full queue, RepairsCut
	// retransmissions over the repair cap, RepairSent the RTX it sent.
	PacerDropped uint64 `json:"pacerDropped"`
	RepairsCut   uint64 `json:"repairsCut"`
	RepairSent   uint64 `json:"repairSent"`
	VideoSent    uint64 `json:"videoSent"`
	AudioSent    uint64 `json:"audioSent"`
	Probes       uint64 `json:"probes"`
	// NacksToPublishers counts lost packets the node asked publishers to
	// resend, and RepairedFromPublishers the resends that arrived.
	NacksToPublishers      uint64         `json:"nacksToPublishers"`
	RepairedFromPublishers uint64         `json:"repairedFromPublishers"`
	QueuedBytes            int            `json:"queuedBytes"`
	Paused                 map[string]int `json:"paused"`    // subscriptions by pause reason
	Forwarded              map[string]int `json:"forwarded"` // camera subscriptions by forwarded layer
}

// peerTotals sums every receiving peer.
type peerTotals struct {
	Frames           map[string]int64 `json:"frames"` // h, l and screen frames, audio packets
	Switches         int64            `json:"layerSwitches"`
	VideoStalls      int64            `json:"videoStalls"` // cameras, which may adapt
	ScreenStalls     int64            `json:"screenStalls"`
	AudioStalls      int64            `json:"audioStalls"`
	LongestStallMs   int64            `json:"longestStallMs"`
	Expected         int64            `json:"expected"`
	Received         int64            `json:"received"`
	AudioJitterMs    float64          `json:"audioJitterMs"` // mean over tracks
	MaxAudioJitterMs float64          `json:"maxAudioJitterMs"`
	VideoJitterMs    float64          `json:"videoJitterMs"`
}

func takeSample(svc *service, classes []*liveClass, cpu *hostCPU) liveSample {
	now := time.Now()
	sample := liveSample{At: now.UTC(), Classes: len(classes)}
	var ready protocol.ReadyResponse
	if err := get(svc, "/readyz", &ready); err != nil {
		sample.ReadyErr = err.Error()
	} else {
		sample.Ready = &ready
	}
	node := nodeTotals{Paused: map[string]int{}, Forwarded: map[string]int{}}
	peers := peerAccumulator{peerTotals: peerTotals{Frames: map[string]int64{}}}
	for _, class := range classes {
		for index, person := range class.people {
			var inspected protocol.InspectResponse
			if err := post(svc, "/v1/sessions/"+person.conn+"/inspect", protocol.InspectRequest{Scope: person.scope}, &inspected); err != nil {
				node.InspectErrors++
			} else {
				node.add(inspected)
			}
			peers.addReceiver(class.receivers[index], index > 0, now, class.sharingSince())
		}
	}
	sample.Node, sample.Peers = node, peers.totals()
	sample.Generator = cpu.sample()
	return sample
}

// peerAccumulator sums the viewers' tracks into peerTotals and counts the tracks the jitter means divide by.
type peerAccumulator struct {
	peerTotals
	audioTracks, videoTracks int
}

// addReceiver adds one viewer's tracks. A viewer other than the sharer is meant to have a screen
// track in each share stretch.
func (p *peerAccumulator) addReceiver(receiver *liveReceiver, watchesShare bool, now, since time.Time) {
	receiver.mu.Lock()
	defer receiver.mu.Unlock()
	if watchesShare {
		p.ScreenStalls += receiver.missedScreens
		if len(receiver.screens()) == 0 && !since.IsZero() && now.Sub(since) > liveShareStartup {
			p.ScreenStalls++
			p.LongestStallMs = max(p.LongestStallMs, now.Sub(since).Milliseconds())
		}
	}
	for _, track := range receiver.tracks {
		p.addTrack(track, now, since)
	}
}

func (p *peerAccumulator) addTrack(track *liveTrack, now, since time.Time) {
	stalls, longest := track.stallsAt(now, since)
	for layer, frames := range track.frames {
		p.Frames[layer] += frames
	}
	p.Switches += track.switches
	switch track.kind {
	case "audio":
		p.AudioStalls += stalls
		p.AudioJitterMs += track.jitter * 1000
		p.MaxAudioJitterMs = max(p.MaxAudioJitterMs, track.jitter*1000)
		p.audioTracks++
	case "screen":
		p.ScreenStalls += stalls
		p.VideoJitterMs += track.jitter * 1000
		p.videoTracks++
	default:
		p.VideoStalls += stalls
		p.VideoJitterMs += track.jitter * 1000
		p.videoTracks++
	}
	p.LongestStallMs = max(p.LongestStallMs, longest.Milliseconds())
	expected, received := track.totals()
	p.Expected += expected
	p.Received += received
}

// totals turns the jitter sums into means over the tracks.
func (p *peerAccumulator) totals() peerTotals {
	totals := p.peerTotals
	if p.audioTracks > 0 {
		totals.AudioJitterMs /= float64(p.audioTracks)
	}
	if p.videoTracks > 0 {
		totals.VideoJitterMs /= float64(p.videoTracks)
	}
	return totals
}

func (n *nodeTotals) add(inspected protocol.InspectResponse) {
	n.Sessions++
	transport := inspected.Transport
	n.PacerDropped += transport.Dropped
	n.RepairsCut += transport.RepairsCut
	n.RepairSent += transport.Sent.Repair
	n.VideoSent += transport.Sent.Video
	n.AudioSent += transport.Sent.Audio
	n.Probes += transport.Probes
	n.QueuedBytes += transport.QueuedBytes
	for _, track := range inspected.Tracks {
		for _, layer := range track.Layers {
			n.NacksToPublishers += layer.RequestedPackets
			n.RepairedFromPublishers += layer.RepairedPackets
		}
		subscription := track.Subscription
		if subscription == nil {
			continue
		}
		if subscription.State == protocol.SubscriptionPaused {
			n.Paused[subscription.Reason]++
		} else if strings.HasPrefix(track.TrackName, cameraName) {
			n.Forwarded[cmp.Or(subscription.EffectiveRID, "none")]++
		}
	}
}

// qualityBreak names the first signal past the step-up's limits: the pacer
// queue p95 over 20 ms, steal over 25%, closed admission, receive-buffer
// drops, pacer drops or a new microphone or screen stall since the previous sample. A
// camera stall is not a break, because the allocator may lower a camera.
func qualityBreak(previous, sample liveSample) string {
	ready := sample.Ready
	if ready == nil {
		return "readyz failed: " + sample.ReadyErr
	}
	switch {
	case ready.Host.QueueDelayP95Ms > 20:
		return fmt.Sprintf("pacer queue p95 %.1f ms", ready.Host.QueueDelayP95Ms)
	case ready.Host.StealPercent != nil && *ready.Host.StealPercent > 25:
		return fmt.Sprintf("steal %.1f%%", *ready.Host.StealPercent)
	case ready.Host.AdmissionReason != "":
		return "admission closed: " + ready.Host.AdmissionReason
	case previous.Ready != nil && receiveErrors(sample) > receiveErrors(previous):
		return fmt.Sprintf("%d receive-buffer drops", receiveErrors(sample)-receiveErrors(previous))
	case sample.Node.PacerDropped > previous.Node.PacerDropped:
		return fmt.Sprintf("%d pacer drops", sample.Node.PacerDropped-previous.Node.PacerDropped)
	case sample.Peers.AudioStalls > previous.Peers.AudioStalls:
		return fmt.Sprintf("%d microphone stalls", sample.Peers.AudioStalls-previous.Peers.AudioStalls)
	case sample.Peers.ScreenStalls > previous.Peers.ScreenStalls:
		return fmt.Sprintf("%d screen stalls", sample.Peers.ScreenStalls-previous.Peers.ScreenStalls)
	}
	return ""
}

func receiveErrors(sample liveSample) int64 {
	if sample.Ready == nil || sample.Ready.Host.UDPReceiveBufferErrors == nil {
		return 0
	}
	return int64(*sample.Ready.Host.UDPReceiveBufferErrors)
}

func (s liveSample) line() string {
	if s.Ready == nil {
		return fmt.Sprintf("%s classes %d: readyz failed: %s", s.Elapsed, s.Classes, s.ReadyErr)
	}
	steal := -1.0
	if s.Ready.Host.StealPercent != nil {
		steal = *s.Ready.Host.StealPercent
	}
	loss := 0.0
	if s.Peers.Expected > 0 {
		loss = 100 * float64(s.Peers.Expected-s.Peers.Received) / float64(s.Peers.Expected)
	}
	return fmt.Sprintf("%s classes %d sessions %d: %.0f pps, pacer p95 %.1f ms, steal %.1f%%, reserved %d/%d, admission %q; pacer drops %d, rcvbuf %d; peers h %d l %d screen %d, switches %d, stalls camera %d screen %d audio %d (longest %d ms), loss %.3f%%; generator cpu %.0f%%",
		s.Elapsed, s.Classes, s.Ready.Sessions, s.Ready.Host.PacketsPerSecond, s.Ready.Host.QueueDelayP95Ms, steal, s.Ready.ReservedPackets, s.Ready.PacketBudget, s.Ready.Host.AdmissionReason,
		s.Node.PacerDropped, receiveErrors(s), s.Peers.Frames["h"], s.Peers.Frames["l"], s.Peers.Frames["screen"], s.Peers.Switches, s.Peers.VideoStalls, s.Peers.ScreenStalls, s.Peers.AudioStalls, s.Peers.LongestStallMs, loss, s.Generator.CPUPercent)
}
