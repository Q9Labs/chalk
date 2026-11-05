package media

import (
	"strings"
	"sync/atomic"
	"time"

	"github.com/pion/webrtc/v4"
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

// Per-stream history budgets from the design's memory budget: one second at
// each stream's maximum rate. Audio has no history, because Opus negotiates no
// retransmission.
const (
	historyHighBytes   = 400 << 10
	historyLowBytes    = 128 << 10
	historyScreenBytes = 320 << 10
	historySlots       = 1024
)

// historyBytes is the history budget of one layer, or 0 for none.
func historyBytes(kind webrtc.RTPCodecType, source, rid string) int {
	switch {
	case kind != webrtc.RTPCodecTypeVideo:
		return 0
	case source == "screen":
		return historyScreenBytes
	case rid == "" || rid == "h":
		return historyHighBytes
	}
	return historyLowBytes
}

// ingressLayer is one RTP stream a publisher sends: the only stream of a
// track without simulcast, or one RID of a simulcast camera.
type ingressLayer struct {
	index   int
	rid     string
	ssrc    uint32
	remote  *webrtc.TrackRemote
	history *history

	lastRTP   atomic.Int64 // monotonic; 0 before the first packet
	lastAsked atomic.Int64 // monotonic time of the last keyframe request

	// Owned by the layer's reader.
	extStarted bool
	highest    uint64
}

func newIngressLayer(index int, remote *webrtc.TrackRemote, source string) *ingressLayer {
	layer := &ingressLayer{index: index, rid: remote.RID(), ssrc: uint32(remote.SSRC()), remote: remote}
	if bytes := historyBytes(remote.Kind(), source, layer.rid); bytes > 0 {
		layer.history = newHistory(bytes, historySlots)
	}
	return layer
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

// pickLayer chooses the layer to forward, or -1 for none. A track without
// simulcast has one layer with an empty RID, and it always serves.
func pickLayer(request layerRequest, layers []layerView) int {
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
