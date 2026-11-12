package media

import (
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

const (
	sourceScreen     = "screen"
	sourceMicrophone = "microphone"
)

const (
	// activeWindow is how recently RTP must have arrived for a track to count as active.
	activeWindow = 5 * time.Second
	// keyframeInterval is the least time between two keyframe requests to one layer.
	keyframeInterval = 500 * time.Millisecond
	// monitorInterval is how often a publication rechecks layer activity and
	// repeats keyframe requests for subscribers waiting to switch.
	monitorInterval = 250 * time.Millisecond
)

// publication is a track a session publishes. Each of its layers has one
// reader that keeps the layer's history and hands every packet to the
// subscriptions that forward it.
type publication struct {
	session *Session
	name    string
	source  string
	kind    webrtc.RTPCodecType
	// authority decides whether the source may forward; a revoke or a lapsed lease stops it.
	authority *sourceAuthority
	// revision and revoked are the authority's control when the publication was
	// admitted, so a revoke closes only what was published before it applied.
	revision int64
	revoked  bool

	closed atomic.Bool
	// held parks the publication for its owner's mute: it stays open and keeps its MID,
	// and its subscriptions, but forwards nothing until the owner resumes it.
	held atomic.Bool
	// resumes counts resumes: a packet queued before one carries the older count and is dropped,
	// so a quick unmute never sends what the mute had already fenced.
	resumes atomic.Uint64
	done    chan struct{}
	layers  [maxLayers]atomic.Pointer[ingressLayer]
	// subscribers is copied on write, so readers never lock.
	subscribers atomic.Pointer[[]*subscription]

	mu         sync.Mutex // guards attaching layers and changing subscribers
	monitoring bool

	// Owned by the node's control loop.
	order uint64
	plan  uint8 // the Episode plan level of a camera
}

func newPublication(session *Session, track protocol.Track, kind webrtc.RTPCodecType) (*publication, error) {
	authority, revision, revoked, err := session.node.authorityFor(session.scope, session.allocation, track.Source)
	if err != nil {
		return nil, err
	}
	session.tracePublicationStarted(track.Source, kind)
	return &publication{
		session: session, name: track.TrackName, source: track.Source, kind: kind, done: make(chan struct{}),
		authority: authority, revision: revision, revoked: revoked, order: serials.Add(1),
	}, nil
}

func (p *publication) video() bool { return p.kind == webrtc.RTPCodecTypeVideo }

// monitor rechecks layer activity, so a subscriber whose layer went idle falls
// back, and repeats keyframe requests for subscribers still waiting to switch.
func (p *publication) monitor() {
	ticker := time.NewTicker(monitorInterval)
	defer ticker.Stop()
	var was [maxLayers]bool
	for {
		select {
		case <-p.done:
			return
		case <-ticker.C:
		}
		if p.layersChanged(&was, monotonic()) {
			p.reselect()
		}
		p.requestPendingKeyframes()
	}
}

// layersChanged records which layers carry media at now in was and reports whether any changed.
func (p *publication) layersChanged(was *[maxLayers]bool, now int64) bool {
	changed := false
	for index := range p.layers {
		layer := p.layers[index].Load()
		active := layer != nil && layer.active(now)
		changed = changed || active != was[index]
		was[index] = active
	}
	return changed
}

// requestPendingKeyframes asks the publisher for the keyframe each subscriber waits on.
func (p *publication) requestPendingKeyframes() {
	subscribers := p.subscribers.Load()
	if subscribers == nil {
		return
	}
	for _, subscription := range *subscribers {
		if layer := subscription.pendingLayer(); layer >= 0 {
			p.requestKeyframe(layer)
		}
	}
}

// views reports every layer slot for the selection policy.
func (p *publication) views(now int64) [maxLayers]layerView {
	var views [maxLayers]layerView
	idle := p.closed.Load() || p.held.Load()
	for index := range p.layers {
		if layer := p.layers[index].Load(); layer != nil {
			views[index] = layerView{rid: layer.rid, active: !idle && layer.active(now)}
		}
	}
	return views
}

// reselect recomputes every subscription's layer after layer activity changed.
func (p *publication) reselect() {
	subscribers := p.subscribers.Load()
	if subscribers == nil {
		return
	}
	views := p.views(monotonic())
	for _, subscription := range *subscribers {
		if layer := subscription.reselect(views[:]); layer >= 0 {
			p.requestKeyframe(layer)
		}
	}
}

// setHeld parks or resumes the publication and reports whether that changed it. A parked
// publication forwards nothing, and egress drops what was queued for its subscriptions, but the
// subscriptions stay: a viewer that never saw the mute has the same subscription when media
// returns. Each transition reselects layers, which advances every subscription's revision, so
// a receiver that polls sees the change, and a resume asks for keyframes so viewers decode
// without waiting for the periodic one.
func (p *publication) setHeld(held bool) bool {
	p.mu.Lock()
	if p.held.Load() == held {
		p.mu.Unlock()
		return false
	}
	// The count rises before the flag clears, so no queued packet sees an unparked publication
	// and its own count together.
	if !held {
		p.resumes.Add(1)
	}
	p.held.Store(held)
	p.mu.Unlock()
	// Layer selection follows the hold: parking idles every subscription, including one that
	// subscribes during the mute, and resuming selects a layer for each and asks for its keyframe.
	p.reselect()
	return true
}

// requestKeyframes asks the publisher for a keyframe on every layer it sends.
func (p *publication) requestKeyframes() {
	for index := range p.layers {
		if p.layer(index) != nil {
			p.requestKeyframe(index)
		}
	}
}

func (p *publication) addSubscriber(added *subscription) {
	p.mu.Lock()
	defer p.mu.Unlock()
	next := []*subscription{added}
	if current := p.subscribers.Load(); current != nil {
		next = append(slices.Clone(*current), added)
	}
	p.subscribers.Store(&next)
}

func (p *publication) removeSubscriber(removed *subscription) {
	p.mu.Lock()
	defer p.mu.Unlock()
	current := p.subscribers.Load()
	if current == nil {
		return
	}
	next := slices.DeleteFunc(slices.Clone(*current), func(existing *subscription) bool { return existing == removed })
	p.subscribers.Store(&next)
}

// close stops forwarding. Subscribers keep their senders but receive nothing
// more and report the source inactive. The layers' readers drain until the
// session closes, so their histories are released now.
func (p *publication) close() {
	p.mu.Lock()
	if p.closed.Swap(true) {
		p.mu.Unlock()
		return
	}
	close(p.done)
	p.mu.Unlock()
	p.session.tracePublicationStopped(p)
	if p.source == sourceScreen {
		p.session.node.releaseScreen(p.session)
	}
	for index := range p.layers {
		if layer := p.layers[index].Load(); layer != nil {
			layer.history.Store(nil)
			if layer.nack != nil {
				layer.nack.stop()
			}
		}
	}
	p.reselect()
}

// active reports whether any layer carried RTP within the activity window.
// active reports whether the publication is delivering: it is open, its source's
// lease allows forwarding, and RTP arrived recently.
func (p *publication) active(now int64) bool {
	if p.closed.Load() || p.held.Load() || !p.authority.allows(now, now) {
		return false
	}
	for index := range p.layers {
		if layer := p.layers[index].Load(); layer != nil {
			if last := layer.lastRTP.Load(); last != 0 && now-last < int64(activeWindow) {
				return true
			}
		}
	}
	return false
}

// inspectLayers lists a video publication's ingress layers in RID order; a
// single encoding is one layer with an empty RID.
func (p *publication) inspectLayers(now int64) []protocol.InspectedLayer {
	if !p.video() {
		return nil
	}
	var layers []protocol.InspectedLayer
	for index := range p.layers {
		if layer := p.layers[index].Load(); layer != nil {
			inspected := protocol.InspectedLayer{RID: layer.rid, Active: !p.closed.Load() && !p.held.Load() && p.authority.allows(now, now) && layer.active(now), RepairedPackets: layer.repaired.Load()}
			if layer.nack != nil {
				inspected.RequestedPackets = layer.nack.requested.Load()
			}
			layers = append(layers, inspected)
		}
	}
	slices.SortFunc(layers, func(a, b protocol.InspectedLayer) int { return strings.Compare(a.RID, b.RID) })
	return layers
}

func (p *publication) layer(index int) *ingressLayer {
	if index < 0 || index >= maxLayers {
		return nil
	}
	return p.layers[index].Load()
}

// requestKeyframe asks the publisher for a keyframe on one layer, at most once per interval.
func (p *publication) requestKeyframe(index int) {
	layer := p.layer(index)
	if layer == nil || p.closed.Load() || !p.video() {
		return
	}
	now := monotonic()
	last := layer.lastAsked.Load()
	if (last != 0 && now-last < int64(keyframeInterval)) || !layer.lastAsked.CompareAndSwap(last, now) {
		return
	}
	_ = p.session.pc.WriteRTCP([]rtcp.Packet{&rtcp.PictureLossIndication{MediaSSRC: layer.ssrc}})
}
