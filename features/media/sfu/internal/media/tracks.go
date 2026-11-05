package media

import (
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/rtp"
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
	done   chan struct{}
	layers [maxLayers]atomic.Pointer[ingressLayer]
	// subscribers is copied on write, so readers never lock.
	subscribers atomic.Pointer[[]*subscription]

	mu         sync.Mutex // guards attaching layers and changing subscribers
	monitoring bool
}

func newPublication(session *Session, track protocol.Track, kind webrtc.RTPCodecType) (*publication, error) {
	authority, revision, revoked, err := session.node.authorityFor(session.scope, track.Source)
	if err != nil {
		return nil, err
	}
	return &publication{
		session: session, name: track.TrackName, source: track.Source, kind: kind, done: make(chan struct{}),
		authority: authority, revision: revision, revoked: revoked,
	}, nil
}

func (p *publication) video() bool { return p.kind == webrtc.RTPCodecTypeVideo }

// attach binds one incoming stream as a layer. It returns nil when the
// publication is closed, already has the RID, or has no free layer; the caller
// then drains the stream. The first layer starts the publication's monitor.
// audioLevelID is the microphone's negotiated audio level extension, or 0.
func (p *publication) attach(remote *webrtc.TrackRemote, audioLevelID uint8) (*ingressLayer, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed.Load() {
		return nil, false
	}
	free := -1
	for index := range p.layers {
		existing := p.layers[index].Load()
		if existing == nil {
			if free < 0 {
				free = index
			}
			continue
		}
		if existing.rid == remote.RID() {
			return nil, false
		}
	}
	if free < 0 {
		return nil, false
	}
	layer := newIngressLayer(free, remote, p.source, p.session.node.cfg.Memory)
	layer.audioLevelID = audioLevelID
	if layer.nack != nil {
		pc, ssrc := p.session.pc, layer.ssrc
		layer.nack.send = func(seqs []uint16) { _ = pc.WriteRTCP(nackPacket(ssrc, seqs)) }
		layer.nack.gaveUp = func() { p.requestKeyframe(layer.index) }
	}
	p.layers[free].Store(layer)
	startMonitor := !p.monitoring
	p.monitoring = true
	return layer, startMonitor
}

// read forwards one layer until its stream ends. After the publication closes
// it keeps reading and discards, so Pion's buffer for the stream stays empty.
func (p *publication) read(layer *ingressLayer) {
	buffer := make([]byte, maxPayloadBytes)
	writer := &packetWriter{}
	var header rtp.Header
	for {
		n, attributes, err := layer.remote.Read(buffer)
		if err != nil {
			return
		}
		if !p.closed.Load() {
			repaired := attributes.Get(webrtc.AttributeRtxSequenceNumber) != nil
			p.forward(layer, buffer[:n], repaired, &header, writer)
		}
	}
}

// forward keeps one packet of layer in its history and hands it to every
// subscription. repaired marks a packet that arrived as an RTX repair. The
// caller owns header and writer, so it allocates nothing.
func (p *publication) forward(layer *ingressLayer, raw []byte, repaired bool, header *rtp.Header, writer *packetWriter) {
	layer.meter.add(len(raw))
	packet, ok := parseRTP(header, raw, p.video())
	if !ok {
		return
	}
	if repaired {
		layer.repaired.Add(1)
	}
	newest := layer.newest()
	packet.extSeq = layer.extend(header.SequenceNumber)
	packet.arrival = monotonic()
	if layer.nack != nil {
		layer.nack.observe(packet.extSeq, newest, packet.arrival)
	}
	if layer.audioLevelID != 0 {
		p.readAudioLevel(layer, header, &packet)
	}
	resumed := !layer.active(packet.arrival)
	if resumed {
		// The monitor may have missed the gap, so end the live segments while
		// the layer still reads idle; the next reselect waits for a keyframe.
		p.reselect()
	}
	layer.lastRTP.Store(packet.arrival)
	if history := layer.history.Load(); history != nil {
		history.store(&packet)
	}
	if resumed {
		p.reselect()
	}
	subscribers := p.subscribers.Load()
	if subscribers == nil {
		return
	}
	for _, subscription := range *subscribers {
		subscription.deliver(layer, &packet, writer)
	}
}

// voicedLevel is the quietest RFC 6464 level, in -dBov, that counts as speech.
// Room noise sits near 70 and silence at 127.
const voicedLevel = 50

// readAudioLevel copies a microphone packet's audio level for subscribers and
// records the publisher as speaking when it is loud enough.
func (p *publication) readAudioLevel(layer *ingressLayer, header *rtp.Header, packet *rtpPacket) {
	extension := header.GetExtension(layer.audioLevelID)
	if len(extension) < 1 {
		return
	}
	packet.audioLevel, packet.hasAudioLevel = extension[0], true
	if extension[0]&0x7f <= voicedLevel {
		p.session.lastVoiced.Store(packet.arrival)
	}
}

// parseRTP reads the header into header, which the caller reuses so the
// steady state allocates nothing, and describes the payload.
func parseRTP(header *rtp.Header, raw []byte, video bool) (rtpPacket, bool) {
	headerSize, err := header.Unmarshal(raw)
	if err != nil {
		return rtpPacket{}, false
	}
	payload := raw[headerSize:]
	var padding byte
	if header.Padding {
		if len(payload) == 0 || int(payload[len(payload)-1]) > len(payload) || payload[len(payload)-1] == 0 {
			return rtpPacket{}, false
		}
		padding = payload[len(payload)-1]
		payload = payload[:len(payload)-int(padding)]
	}
	packet := rtpPacket{timestamp: header.Timestamp, marker: header.Marker, paddingSize: padding, payload: payload}
	if video && len(payload) > 0 {
		packet.vp8, packet.hasVP8 = parseVP8(payload)
	}
	return packet, true
}

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
		now := monotonic()
		changed := false
		for index := range p.layers {
			layer := p.layers[index].Load()
			active := layer != nil && layer.active(now)
			changed = changed || active != was[index]
			was[index] = active
		}
		if changed {
			p.reselect()
		}
		if subscribers := p.subscribers.Load(); subscribers != nil {
			for _, subscription := range *subscribers {
				if layer := subscription.pendingLayer(); layer >= 0 {
					p.requestKeyframe(layer)
				}
			}
		}
	}
}

// views reports every layer slot for the selection policy.
func (p *publication) views(now int64) [maxLayers]layerView {
	var views [maxLayers]layerView
	closed := p.closed.Load()
	for index := range p.layers {
		if layer := p.layers[index].Load(); layer != nil {
			views[index] = layerView{rid: layer.rid, active: !closed && layer.active(now)}
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
	if p.closed.Load() || !p.authority.allows(now, now) {
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

// inspectLayers lists a simulcast publication's layers in RID order.
func (p *publication) inspectLayers(now int64) []protocol.InspectedLayer {
	var layers []protocol.InspectedLayer
	for index := range p.layers {
		if layer := p.layers[index].Load(); layer != nil && layer.rid != "" {
			layers = append(layers, protocol.InspectedLayer{RID: layer.rid, Active: !p.closed.Load() && p.authority.allows(now, now) && layer.active(now)})
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

// drain reads a stream nobody forwards until it ends, so Pion never buffers it.
func drain(remote *webrtc.TrackRemote) {
	buffer := make([]byte, maxPayloadBytes)
	for {
		if _, _, err := remote.Read(buffer); err != nil {
			return
		}
	}
}
