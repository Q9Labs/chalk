package media

import (
	"strings"
	"sync/atomic"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/q9labs/chalk/features/media/sfu/internal/config"
)

const (
	// maxLayers is the most simulcast layers one publication forwards. A
	// publisher offering more has the extra layers read and discarded.
	maxLayers = 3
	// layerIdleAfter is how long a layer may go without RTP before the forwarder
	// treats it as paused and falls back. A camera sends many packets a second,
	// so a second of silence means its encoder stopped the layer.
	layerIdleAfter = time.Second
	// maxPayloadBytes bounds one RTP payload, the most a UDP read can return.
	maxPayloadBytes = 1500
)

// epoch anchors monotonic packet times, so wall-clock steps never reorder them.
var epoch = time.Now()

func monotonic() int64 { return int64(time.Since(epoch)) }

// historySlots bounds the packets one layer's history holds.
const historySlots = 1024

// historyBytes is the history budget of one layer, or 0 for none. Audio keeps
// none, because Opus negotiates no retransmission.
func historyBytes(memory config.Memory, kind webrtc.RTPCodecType, source, rid string) int {
	switch {
	case kind != webrtc.RTPCodecTypeVideo:
		return 0
	case source == sourceScreen:
		return memory.HistoryScreenBytes
	case rid == "" || rid == "h":
		return memory.HistoryHighBytes
	}
	return memory.HistoryLowBytes
}

// ingressLayer is one RTP stream a publisher sends: the only stream of a
// track without simulcast, or one RID of a simulcast camera.
type ingressLayer struct {
	index   int
	rid     string
	ssrc    uint32
	remote  *webrtc.TrackRemote
	history atomic.Pointer[history] // nil for audio and after the publication closes

	lastRTP   atomic.Int64 // monotonic; 0 before the first packet
	lastAsked atomic.Int64 // monotonic time of the last keyframe request

	meter    rateMeter     // every packet the publisher sent on the layer, repairs included
	repaired atomic.Uint64 // packets that arrived as RTX repairs
	nack     *nackTracker  // nil for audio
	tallied  layerTallies  // the control loop's
	// audioLevelID is the negotiated RFC 6464 extension ID of a microphone, or 0.
	audioLevelID uint8

	// Owned by the layer's reader.
	extStarted bool
	highest    uint64
}

func newIngressLayer(index int, remote *webrtc.TrackRemote, source string, memory config.Memory) *ingressLayer {
	layer := &ingressLayer{index: index, rid: remote.RID(), ssrc: uint32(remote.SSRC()), remote: remote}
	if bytes := historyBytes(memory, remote.Kind(), source, layer.rid); bytes > 0 {
		layer.history.Store(newHistory(bytes, historySlots))
	}
	if remote.Kind() == webrtc.RTPCodecTypeVideo {
		layer.nack = &nackTracker{}
	}
	return layer
}

// newest is the highest extended sequence number so far, or 0 before the first packet.
func (l *ingressLayer) newest() uint64 {
	if !l.extStarted {
		return 0
	}
	return l.highest
}

// extend turns a 16-bit sequence number into one that keeps counting across
// wraps. A reordered packet maps to its place behind the newest one.
func (l *ingressLayer) extend(seq uint16) uint64 {
	if !l.extStarted {
		// Start one cycle up, so a packet reordered from before the first stays positive.
		l.extStarted, l.highest = true, 1<<16|uint64(seq)
		return l.highest
	}
	ext := l.highest + uint64(int64(int16(seq-uint16(l.highest))))
	if int64(ext-l.highest) > 0 {
		l.highest = ext
	}
	return ext
}

func (l *ingressLayer) active(now int64) bool {
	last := l.lastRTP.Load()
	return last != 0 && now-last < int64(layerIdleAfter)
}

// layerView is one layer as the selection policy sees it.
type layerView struct {
	rid    string
	active bool
}

// layerRequest is what a subscriber asked for. Ceiling is the preferred RID;
// start, when set, is the RID to forward instead, never above the ceiling.
// With fallback ("ridNotAvailable": "asciibetical") the forwarder takes the
// first active RID in ASCII order when the wanted one is inactive, so camera
// "h" falls back to "l". Without it an inactive wanted layer pauses delivery.
type layerRequest struct {
	ceiling  string
	start    string
	fallback bool
	paused   bool
}

// wanted is the RID the subscriber should receive while it is available.
// RIDs sort by quality: "h" before "l", so a start RID that sorts before the
// ceiling would exceed it and is ignored.
func (r layerRequest) wanted() string {
	if r.start != "" && strings.Compare(r.start, r.ceiling) >= 0 {
		return r.start
	}
	return r.ceiling
}

// lowestLayer sorts after every RID, so as a server limit it holds a
// subscription to its lowest active layer.
const lowestLayer = "\x7f"

// pickLayer chooses the layer to forward, or -1 for none. A track without
// simulcast has one layer with an empty RID, and it always serves. limit, when
// set, is the best RID the node lets this subscriber have: a better choice is
// lowered to the best active layer at or below it, or else the lowest active
// layer. Lowering is the node's own decision, so it ignores the request's
// fallback rule, which only governs a missing layer.
func pickLayer(request layerRequest, limit string, layers []layerView) int {
	chosen := pickRequested(request, layers)
	if limit == "" || chosen < 0 || layers[chosen].rid >= limit {
		return chosen
	}
	best, lowest := -1, -1
	for index, layer := range layers {
		if !layer.active {
			continue
		}
		if layer.rid >= limit && (best < 0 || layer.rid < layers[best].rid) {
			best = index
		}
		if lowest < 0 || layer.rid > layers[lowest].rid {
			lowest = index
		}
	}
	if best >= 0 {
		return best
	}
	return lowest
}

// pickRequested applies the subscriber's request alone.
func pickRequested(request layerRequest, layers []layerView) int {
	fallback := -1
	for index, layer := range layers {
		switch {
		case !layer.active:
			continue
		case layer.rid == "" || layer.rid == request.wanted():
			return index
		case request.fallback && (fallback < 0 || layer.rid < layers[fallback].rid):
			fallback = index
		}
	}
	return fallback
}
