package tests

import (
	"bufio"
	"bytes"
	"cmp"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"os"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
	"github.com/pion/webrtc/v4"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

const (
	liveTenant = "live-smoke"
	// liveChunk is the payload bytes per video packet, near a browser's MTU.
	liveChunk = 1100
	// liveScreenKbps is a detailed screen share; the SDK leaves its bitrate to the browser.
	liveScreenKbps = 1500
	// liveStall is the gap between frames, or between microphone packets, that a viewer sees as a freeze.
	liveStall = 500 * time.Millisecond
)

// liveLoad is the shape of a live run.
type liveLoad struct {
	classes, participants, cameras int
	cameraKbps                     [2]int // h and l
	shareDuty                      float64
	sharePeriod, hold, step, every time.Duration
	samples                        string
}

func liveLoadFromEnv(t *testing.T) liveLoad {
	t.Helper()
	load := liveLoad{classes: 2, participants: 3, cameras: 2, cameraKbps: [2]int{2500, 650}, shareDuty: 0.65,
		sharePeriod: 4 * time.Minute, hold: 5 * time.Minute, every: time.Minute, samples: os.Getenv("SFU_LIVE_SAMPLES")}
	settings := []struct {
		name   string
		target any
	}{
		{"SFU_LIVE_CLASSES", &load.classes}, {"SFU_LIVE_PARTICIPANTS", &load.participants}, {"SFU_LIVE_CAMERAS", &load.cameras},
		{"SFU_LIVE_CAMERA_KBPS", &load.cameraKbps}, {"SFU_LIVE_SHARE_DUTY", &load.shareDuty}, {"SFU_LIVE_SHARE_PERIOD", &load.sharePeriod},
		{"SFU_LIVE_HOLD", &load.hold}, {"SFU_LIVE_STEP", &load.step}, {"SFU_LIVE_SAMPLE", &load.every},
	}
	for _, setting := range settings {
		value := os.Getenv(setting.name)
		if value == "" {
			continue
		}
		var err error
		switch target := setting.target.(type) {
		case *int:
			_, err = fmt.Sscan(value, target)
		case *float64:
			_, err = fmt.Sscan(value, target)
		case *time.Duration:
			*target, err = time.ParseDuration(value)
		case *[2]int:
			_, err = fmt.Sscanf(value, "%d,%d", &target[0], &target[1])
		}
		if err != nil {
			t.Fatalf("%s=%q: %v", setting.name, value, err)
		}
	}
	return load
}

// frameBytes is one frame's size at a bitrate and the fixtures' 30 frames/s.
func frameBytes(kbps int) int { return kbps * 1000 / 8 / 30 }

// TestLiveSmokeClasses holds classes on a deployed node and samples what the
// node and the peers saw. Each Participant publishes simulcast cameras at the
// browser SDK's layer caps and a microphone, the first Participant of each
// class shares a screen in stretches, and everyone pulls everyone. It runs
// only against a live node:
//
//	SFU_LIVE_URL           the node's control URL, such as an SSH tunnel
//	SFU_LIVE_CA            the service CA
//	SFU_LIVE_CERT, _KEY    a client certificate with the API identity
//	SFU_LIVE_CLASSES       classes to hold (default 2)
//	SFU_LIVE_PARTICIPANTS  Participants per class (default 3)
//	SFU_LIVE_CAMERAS       cameras per Participant (default 2)
//	SFU_LIVE_CAMERA_KBPS   the cameras' h and l bitrates (default 2500,650)
//	SFU_LIVE_SHARE_DUTY    the part of the time each class shares (default 0.65)
//	SFU_LIVE_SHARE_PERIOD  one share stretch and one pause (default 4m)
//	SFU_LIVE_HOLD          how long to hold them (default 5m)
//	SFU_LIVE_STEP          add a class at this interval until the node refuses
//	                       one or a quality signal breaks (default off)
//	SFU_LIVE_SAMPLE        how often to sample (default 1m)
//	SFU_LIVE_SAMPLES       a file to append one JSON sample per line to
func TestLiveSmokeClasses(t *testing.T) {
	controlURL := os.Getenv("SFU_LIVE_URL")
	if controlURL == "" {
		t.Skip("SFU_LIVE_URL is not set")
	}
	load := liveLoadFromEnv(t)
	var out *json.Encoder
	if load.samples != "" {
		file, err := os.OpenFile(load.samples, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = file.Close() })
		out = json.NewEncoder(file)
	}
	svc := &service{baseURL: controlURL, client: liveClient(t)}
	// The node keeps operation IDs for idempotency, so each run needs its own.
	operations.Store(time.Now().UnixNano())
	run := time.Now().UnixNano()
	sharing, stopSharing := context.WithCancel(context.Background())
	t.Cleanup(stopSharing)

	var mu sync.Mutex
	var classes []*liveClass
	join := func() string {
		index := len(classes)
		class, refused := joinClass(t, svc, load, run, index)
		if refused != "" {
			return refused
		}
		go class.shareInStretches(sharing, load, time.Duration(index)*load.sharePeriod/5)
		mu.Lock()
		classes = append(classes, class)
		mu.Unlock()
		for deadline := time.Now().Add(30 * time.Second); !class.flowing(); time.Sleep(100 * time.Millisecond) {
			if time.Now().After(deadline) {
				return fmt.Sprintf("class %d: a Participant missed a microphone for 30 s: %s", index, class.describe(svc))
			}
		}
		return ""
	}
	// The API renews every standing grant every 5 s; without it a source's
	// 15-second lease lapses and the node stops forwarding it.
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-sharing.Done():
				return
			case <-ticker.C:
			}
			mu.Lock()
			live := classes
			mu.Unlock()
			for _, class := range live {
				class.renewGrants(svc)
			}
		}
	}()

	for range load.classes {
		if refused := join(); refused != "" {
			t.Fatalf("the node refused class %d: %s", len(classes), refused)
		}
	}
	var first, previous liveSample
	cpu := readHostCPU()
	started := time.Now()
	nextStep := started.Add(load.step)
	ticker := time.NewTicker(load.every)
	defer ticker.Stop()
	for count := 0; time.Since(started) < load.hold; count++ {
		<-ticker.C
		mu.Lock()
		live := classes
		mu.Unlock()
		sample := takeSample(svc, live, &cpu)
		sample.Elapsed = time.Since(started).Round(time.Second).String()
		if count == 0 {
			first = sample
		} else if load.step > 0 {
			sample.Broke = qualityBreak(previous, sample)
		}
		if load.step > 0 && sample.Broke == "" && !time.Now().Before(nextStep) {
			sample.Refused = join()
			nextStep = nextStep.Add(load.step)
		}
		if out != nil {
			if err := out.Encode(sample); err != nil {
				t.Fatal(err)
			}
		}
		t.Log(sample.line())
		previous = sample
		if sample.Broke != "" || sample.Refused != "" {
			t.Logf("step-up stopped at %d classes: %s%s", len(live), sample.Broke, sample.Refused)
			break
		}
	}
	mu.Lock()
	t.Logf("first class at the end:%s", classes[0].describe(svc))
	mu.Unlock()
	if previous.Ready == nil || first.Ready == nil || load.step > 0 {
		return
	}
	if drops := receiveErrors(previous) - receiveErrors(first); drops > 0 {
		t.Errorf("the node dropped %d datagrams for a full receive buffer", drops)
	}
	if stalls := previous.Peers.AudioStalls; stalls > 0 {
		t.Errorf("microphones stalled over %v %d times", liveStall, stalls)
	}
}

// liveClass is one Episode of the run.
type liveClass struct {
	episode   string
	people    []*participant
	receivers []*liveReceiver
	// shareEpoch rises at every share start and stop, so a viewer can tell a
	// pause from a stall.
	shareEpoch atomic.Int64
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
		receiver := receiveLive(p.peer, &class.shareEpoch)
		var created protocol.CreateSessionResponse
		if status, code := svc.call(t, "/v1/sessions", protocol.CreateSessionRequest{OperationID: op(), Scope: p.scope}, &created); status >= 300 {
			return class, fmt.Sprintf("class %d Participant %d: %d %s", index, person, status, code)
		}
		p.conn = created.ConnectionID
		svc.grantSources(t, p.scope)
		what.screen = person == 0
		p.publish(t, svc, what)
		class.people = append(class.people, p)
		class.receivers = append(class.receivers, receiver)
	}
	for _, person := range class.people {
		var tracks []protocol.Track
		for _, other := range class.people {
			if other == person {
				continue
			}
			tracks = append(tracks, remote(other, micName))
			for camera := range load.cameras {
				tracks = append(tracks, remote(other, cameraTrack(camera)))
			}
			if other.screen != nil {
				tracks = append(tracks, remote(other, screenName))
			}
		}
		for batch := range slices.Chunk(tracks, protocol.MaxTracksPerRequest) {
			person.pull(t, svc, batch)
		}
	}
	return class, ""
}

// shareInStretches turns the sharer's screen on and off so it is on for the
// duty share of every period, starting phase into its first stretch.
func (c *liveClass) shareInStretches(ctx context.Context, load liveLoad, phase time.Duration) {
	screen := c.people[0].screen
	on := time.Duration(load.shareDuty * float64(load.sharePeriod))
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
		c.shareEpoch.Add(1)
		screen.enable(0, live)
		wait = off
		if live {
			wait = on
		}
	}
}

// flowing reports whether every Participant hears everyone else. Which
// cameras it sees is the allocator's call, so the samples report that.
func (c *liveClass) flowing() bool {
	for _, receiver := range c.receivers {
		if receiver.microphones() < len(c.people)-1 {
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
	shareEpoch *atomic.Int64
	mu         sync.Mutex
	tracks     map[string]*liveTrack
}

func receiveLive(p *peer, shareEpoch *atomic.Int64) *liveReceiver {
	r := &liveReceiver{shareEpoch: shareEpoch, tracks: map[string]*liveTrack{}}
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
				at, epoch := time.Now(), r.shareEpoch.Load()
				r.mu.Lock()
				stats.observe(packet, at, epoch)
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
	lastAt   time.Time // the latest frame start, or audio packet
	lastTS   uint32
	epoch    int64
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

func (s *liveTrack) observe(packet *rtp.Packet, at time.Time, epoch int64) {
	if s.kind == "screen" && epoch != s.epoch && s.started {
		s.closeRange()
	}
	if !s.sequence(packet.SequenceNumber) {
		return
	}
	if s.hasPrev {
		d := at.Sub(s.prevAt).Seconds() - float64(int32(packet.Timestamp-s.prevTS))/s.clock
		s.jitter += (math.Abs(d) - s.jitter) / 16
	}
	s.prevAt, s.prevTS, s.hasPrev = at, packet.Timestamp, true

	if s.kind == "audio" {
		s.gap(at, epoch)
		s.frames["audio"]++
		return
	}
	if s.lastAt.IsZero() || int32(packet.Timestamp-s.lastTS) > 0 {
		s.gap(at, epoch)
		s.lastTS = packet.Timestamp
	}
	var vp8 codecs.VP8Packet
	if data, err := vp8.Unmarshal(packet.Payload); err == nil && vp8.S == 1 && vp8.PID == 0 && len(data) >= 10 && data[0]&0x01 == 0 {
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
	if packet.Marker && s.layer != "" {
		s.frames[s.layer]++
	}
}

// gap counts a stall when media stopped for longer than liveStall while the
// source was meant to send.
func (s *liveTrack) gap(at time.Time, epoch int64) {
	if !s.lastAt.IsZero() && epoch == s.epoch {
		if gap := at.Sub(s.lastAt); gap > liveStall {
			s.stalls++
			s.longest = max(s.longest, gap)
		}
	}
	s.lastAt, s.epoch = at, epoch
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
	VideoStalls      int64            `json:"videoStalls"`
	AudioStalls      int64            `json:"audioStalls"`
	LongestStallMs   int64            `json:"longestStallMs"`
	Expected         int64            `json:"expected"`
	Received         int64            `json:"received"`
	AudioJitterMs    float64          `json:"audioJitterMs"` // mean over tracks
	MaxAudioJitterMs float64          `json:"maxAudioJitterMs"`
	VideoJitterMs    float64          `json:"videoJitterMs"`
}

func takeSample(svc *service, classes []*liveClass, cpu *hostCPU) liveSample {
	sample := liveSample{At: time.Now().UTC(), Classes: len(classes)}
	var ready protocol.ReadyResponse
	if err := get(svc, "/readyz", &ready); err != nil {
		sample.ReadyErr = err.Error()
	} else {
		sample.Ready = &ready
	}
	node := nodeTotals{Paused: map[string]int{}, Forwarded: map[string]int{}}
	peers := peerTotals{Frames: map[string]int64{}}
	var audioTracks, videoTracks int
	for _, class := range classes {
		for index, person := range class.people {
			var inspected protocol.InspectResponse
			if err := post(svc, "/v1/sessions/"+person.conn+"/inspect", protocol.InspectRequest{Scope: person.scope}, &inspected); err != nil {
				node.InspectErrors++
			} else {
				node.add(inspected)
			}
			receiver := class.receivers[index]
			receiver.mu.Lock()
			for _, track := range receiver.tracks {
				for layer, frames := range track.frames {
					peers.Frames[layer] += frames
				}
				peers.Switches += track.switches
				if track.kind == "audio" {
					peers.AudioStalls += track.stalls
					peers.AudioJitterMs += track.jitter * 1000
					peers.MaxAudioJitterMs = max(peers.MaxAudioJitterMs, track.jitter*1000)
					audioTracks++
				} else {
					peers.VideoStalls += track.stalls
					peers.VideoJitterMs += track.jitter * 1000
					videoTracks++
				}
				peers.LongestStallMs = max(peers.LongestStallMs, track.longest.Milliseconds())
				expected, received := track.totals()
				peers.Expected += expected
				peers.Received += received
			}
			receiver.mu.Unlock()
		}
	}
	if audioTracks > 0 {
		peers.AudioJitterMs /= float64(audioTracks)
	}
	if videoTracks > 0 {
		peers.VideoJitterMs /= float64(videoTracks)
	}
	sample.Node, sample.Peers = node, peers
	sample.Generator = cpu.sample()
	return sample
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
// drops or pacer drops since the previous sample.
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
	return fmt.Sprintf("%s classes %d sessions %d: %.0f pps, pacer p95 %.1f ms, steal %.1f%%, reserved %d/%d, admission %q; pacer drops %d, rcvbuf %d; peers h %d l %d screen %d, switches %d, stalls video %d audio %d (longest %d ms), loss %.3f%%; generator cpu %.0f%%",
		s.Elapsed, s.Classes, s.Ready.Sessions, s.Ready.Host.PacketsPerSecond, s.Ready.Host.QueueDelayP95Ms, steal, s.Ready.ReservedPackets, s.Ready.PacketBudget, s.Ready.Host.AdmissionReason,
		s.Node.PacerDropped, receiveErrors(s), s.Peers.Frames["h"], s.Peers.Frames["l"], s.Peers.Frames["screen"], s.Peers.Switches, s.Peers.VideoStalls, s.Peers.AudioStalls, s.Peers.LongestStallMs, loss, s.Generator.CPUPercent)
}

// hostSample is the generator host's own load, so a run can show the
// generator was not the bottleneck. It is empty where /proc is absent.
type hostSample struct {
	CPUPercent      float64 `json:"cpuPercent"`
	StealPercent    float64 `json:"stealPercent"`
	UDPRcvbufErrors uint64  `json:"udpRcvbufErrors"`
}

type hostCPU struct{ total, idle, steal uint64 }

func readHostCPU() hostCPU {
	file, err := os.Open("/proc/stat")
	if err != nil {
		return hostCPU{}
	}
	defer file.Close()
	line, _ := bufio.NewReader(file).ReadString('\n')
	var cpu hostCPU
	for index, field := range strings.Fields(line)[1:] {
		var value uint64
		_, _ = fmt.Sscan(field, &value)
		cpu.total += value
		switch index {
		case 3, 4: // idle, iowait
			cpu.idle += value
		case 7:
			cpu.steal = value
		}
	}
	return cpu
}

func (c *hostCPU) sample() hostSample {
	next := readHostCPU()
	var sample hostSample
	if total := float64(next.total - c.total); total > 0 {
		sample.CPUPercent = 100 * (total - float64(next.idle-c.idle)) / total
		sample.StealPercent = 100 * float64(next.steal-c.steal) / total
	}
	*c = next
	if raw, err := os.ReadFile("/proc/net/snmp"); err == nil {
		var header []string
		for line := range strings.Lines(string(raw)) {
			fields := strings.Fields(line)
			if len(fields) == 0 || fields[0] != "Udp:" {
				continue
			}
			if header == nil {
				header = fields
				continue
			}
			for index, name := range header {
				if name == "RcvbufErrors" && index < len(fields) {
					_, _ = fmt.Sscan(fields[index], &sample.UDPRcvbufErrors)
				}
			}
		}
	}
	return sample
}

// post and get call the node without failing the test, so one slow sample
// does not end an hour-long run.
func post(svc *service, path string, body, out any) error {
	encoded, err := json.Marshal(body)
	if err != nil {
		return err
	}
	response, err := svc.client.Post(svc.baseURL+path, "application/json", bytes.NewReader(encoded))
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 {
		return fmt.Errorf("POST %s: %s", path, response.Status)
	}
	if out == nil {
		return nil
	}
	return json.NewDecoder(response.Body).Decode(out)
}

func get(svc *service, path string, out any) error {
	response, err := svc.client.Get(svc.baseURL + path)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 {
		return fmt.Errorf("GET %s: %s", path, response.Status)
	}
	return json.NewDecoder(response.Body).Decode(out)
}

func liveClient(t *testing.T) *http.Client {
	t.Helper()
	pem, err := os.ReadFile(os.Getenv("SFU_LIVE_CA"))
	if err != nil {
		t.Fatal(err)
	}
	pool := x509.NewCertPool()
	pool.AppendCertsFromPEM(pem)
	pair, err := tls.LoadX509KeyPair(os.Getenv("SFU_LIVE_CERT"), os.Getenv("SFU_LIVE_KEY"))
	if err != nil {
		t.Fatal(err)
	}
	transport := &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS13, RootCAs: pool, ServerName: "chalk-sfu", Certificates: []tls.Certificate{pair}}}
	t.Cleanup(transport.CloseIdleConnections)
	return &http.Client{Transport: transport, Timeout: 20 * time.Second}
}
