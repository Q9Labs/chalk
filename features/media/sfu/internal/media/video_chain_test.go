package media

// The SFU hop of the video diagnose chains: the node's trail emitters write the journal records a
// relay exports to the ledger. Each scenario pins the counters the emitters carry and captures the
// exported record; CHALK_CHAIN_WRITE=1 rewrites the fixture files. The rows are the emit boundary's
// output: fields the trace fns produce, emitted through the same s.trail/n.trail path.

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"github.com/pion/webrtc/v4"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

var pubScope = protocol.Scope{TenantID: "c1000000-0000-4000-8000-000000000001", EpisodeID: "0f8fad5b-d9cb-469f-a165-70867728950e", ParticipantID: "a1000000-0000-4000-8000-000000000001", Generation: 1}
var viewScope = protocol.Scope{TenantID: "c1000000-0000-4000-8000-000000000001", EpisodeID: "0f8fad5b-d9cb-469f-a165-70867728950e", ParticipantID: "b2000000-0000-4000-8000-000000000002", Generation: 1}

const chainPublisher = "a1000000-0000-4000-8000-000000000001"

type chainCapture struct {
	t    *testing.T
	buf  bytes.Buffer
	node *Node
}

func newChainCapture(t *testing.T) *chainCapture {
	c := &chainCapture{t: t}
	c.node = &Node{log: slog.New(slog.NewJSONHandler(&c.buf, nil))}
	return c
}

func (c *chainCapture) session(scope protocol.Scope, id string) *Session {
	return &Session{node: c.node, kind: ParticipantSession, id: id, scope: scope}
}

// rows returns the exported journal records minus the journal-only level/message stamps.
func (c *chainCapture) rows() []map[string]any {
	var out []map[string]any
	for _, line := range bytes.Split(bytes.TrimSpace(c.buf.Bytes()), []byte("\n")) {
		if len(line) == 0 {
			continue
		}
		var record map[string]any
		if err := json.Unmarshal(line, &record); err != nil {
			c.t.Fatalf("decode journal record: %v", err)
		}
		delete(record, "level")
		delete(record, "msg")
		delete(record, "time")
		out = append(out, record)
	}
	return out
}

// cameraSub is a viewer's camera subscription to the fixture publisher; subscriptionAttrs is the
// emitter's own field shaper for the rows that name both ends.
func cameraSub(viewer *Session, mid string) *subscription {
	pub := &publication{
		session: viewer.node.sessionFor(pubScope),
		source:  "camera",
		kind:    webrtc.RTPCodecTypeVideo,
	}
	return &subscription{owner: viewer, pub: pub, mid: mid}
}

// sessionFor returns a session bound to the node for emitting publisher-side rows.
func (n *Node) sessionFor(scope protocol.Scope) *Session {
	return &Session{node: n, kind: ParticipantSession, id: "conn-" + scope.ParticipantID[len(scope.ParticipantID)-4:], scope: scope}
}

// writeChain stores the captured rows next to the symptom's fixture when asked.
func writeChain(t *testing.T, code, run string, rows []map[string]any) {
	if os.Getenv("CHALK_CHAIN_WRITE") != "1" {
		return
	}
	path := filepath.Join("..", "..", "..", "..", "..", "observability", "fixtures", code, "chain", "sfu-rows."+run+".json")
	data, err := json.MarshalIndent(rows, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, append(data, '\n'), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

// subscriptionAttrs fields plus the fields each event's emit site appends; the emitters' shapes are
// copied 1:1 so the ledger reads exactly what the trail writes.
func subAttrs(sub *subscription, extra ...any) []any {
	return append(sub.owner.subscriptionAttrs(sub), extra...)
}

// The publisher's camera publication: never registered (positive) or registered and flowing
// (healthy). Ingress rows pin the counters traceIngress reads.
func publishRows(c *chainCapture, positive bool) {
	pub := c.session(pubScope, "conn-pub")
	pub.tracePublicationStarted("microphone", webrtc.RTPCodecTypeAudio)
	if !positive {
		pub.tracePublicationStarted("camera", webrtc.RTPCodecTypeVideo)
	}
	ingress := func(mid, source string, kind webrtc.RTPCodecType, packets, bytesN, lost, repaired int64, layers, layersActive int, held bool) {
		pub.trail(slog.LevelInfo, EventMediaIngress, "source", source, "media_kind", kind.String(), "mid", mid,
			"packets", packets, "bytes", bytesN, "lost", lost, "repaired", repaired,
			"nack_requested", int64(4), "keyframe_repairs", int64(1), "pli_sent", int64(3),
			"jitter_ms", 8.5, "bitrate_bps", packets*40, "layers", layers, "layers_active", layersActive,
			"held", held, "final", false)
	}
	if positive {
		// The camera publication never registers: its only ingress rows sit at zero while the
		// microphone flows beside it.
		ingress("4", "camera", webrtc.RTPCodecTypeVideo, 0, 0, 0, 0, 2, 0, false)
		ingress("4", "camera", webrtc.RTPCodecTypeVideo, 0, 0, 0, 0, 2, 0, false)
	} else {
		ingress("4", "camera", webrtc.RTPCodecTypeVideo, 0, 0, 0, 0, 2, 0, false)
		ingress("4", "camera", webrtc.RTPCodecTypeVideo, 1400, 420_000, 3, 3, 2, 2, false)
	}
	ingress("2", "microphone", webrtc.RTPCodecTypeAudio, 800, 96_000, 0, 0, 1, 1, false)
	ingress("2", "microphone", webrtc.RTPCodecTypeAudio, 1900, 228_000, 0, 0, 1, 1, false)
	// A newer allocation takes the camera lease after the window; a revoke would explain a
	// stopped publication, and this seat was never revoked.
	c.node.trail(slog.LevelInfo, EventSourceLeaseOpened, pubScope, "source", "camera", "revision", 1)
	c.node.trail(slog.LevelWarn, EventSourceLeaseLost, pubScope, "source", "camera", "cause", "newer_allocation", "revision", 2)
}

// The viewer's camera subscription lifecycle plus the forwarded counters traceSubscriptionForwarded
// reads. packets pins whether the viewer's forward grew.
func subscriptionRows(c *chainCapture, packets []int64, plan uint8, includeCongestion, pausedForward bool) {
	viewer := c.session(viewScope, "conn-view")
	sub := cameraSub(viewer, "4")
	viewer.traceSubscriptionStarted(sub)
	viewer.traceSubscriptionSelect(sub, "", 1, 1)
	if includeCongestion {
		viewer.traceSubscriptionPause(sub, "", "congestion")
		viewer.traceSubscriptionSelect(sub, "congestion", -1, 2)
		viewer.traceSubscriptionPause(sub, "congestion", "")
		viewer.traceSubscriptionSelect(sub, "", 1, 3)
	}
	forwarded := func(count int64, pauseReason string) {
		attrs := subAttrs(sub,
			"forwarded_packets", count, "forwarded_keyframes", count/30,
			"requested_layer", "high", "plan", planName(plan),
			"ingress_packets", 4*count, "ingress_lost", int64(4), "ingress_repaired", int64(4),
			"ingress_jitter_ms", 7.5, "ingress_bitrate_bps", 1_400_000,
			"ingress_layers_active", 2, "final", false)
		if pauseReason != "" {
			attrs = append(attrs, "pause_reason", pauseReason)
		} else {
			attrs = append(attrs, "layer", "high")
		}
		viewer.trail(slog.LevelInfo, EventVideoSubscriptionForwarded, attrs...)
	}
	for i, count := range packets {
		pauseReason := ""
		// While the subscription sits paused the forwarded row names the cause instead of a layer.
		if pausedForward && i == len(packets)-2 {
			pauseReason = "congestion"
		}
		forwarded(count, pauseReason)
	}
	viewer.traceSubscriptionStopped(sub)
}

// Downlink evidence for low_quality: the session's egress/transport rows and one congestion mark.
func downlinkRows(c *chainCapture, degraded bool) {
	viewer := c.session(viewScope, "conn-view")
	egress := func(sent int64, loss float64) {
		viewer.trail(slog.LevelInfo, EventMediaEgress, "media_kind", "video", "subscriptions", 2, "paused_subscriptions", 0,
			"pli_received", int64(5), "fir_received", int64(1), "nack_received", int64(12), "lost", int64(loss*1000),
			"jitter_ms", 9.0, "loss_share", loss, "rtt_ms", 22.0, "bitrate_bps", sent*40,
			"high_layer", 1, "low_layer", 1, "final", false)
	}
	transport := func(estimate, proven, dropped int64) {
		viewer.trail(slog.LevelInfo, EventMediaTransport, "estimate_bps", estimate, "proven_bps", proven, "queued_bytes", int64(1200),
			"probing", false, "sent_audio", int64(300), "sent_video", int64(2400), "sent_repair", int64(20), "sent_probe", int64(0),
			"dropped", dropped, "repairs_cut", int64(0), "feedback_age_ms", int64(400), "final", false)
	}
	if degraded {
		egress(900, 0.08)
		transport(600_000, 1_800_000, 140)
		// The node's own congestion mark for this subscription, as logCongestionPause writes it.
		sub := cameraSub(viewer, "4")
		viewer.trailAs(slog.LevelInfo, "subscription paused for congestion", EventSubscriptionCongestion,
			subAttrs(sub, "rid", "l", "layer", "low", "reason", "insufficient_bandwidth",
				"estimate_bps", 600_000.0, "proven_bps", 600_000.0, "delivered_share", 0.4,
				"probing", false, "host_pressure", false, "acked_bps", 300_000.0, "loss_share", 0.08,
				"lossy", true, "trend", "overuse", "decrease_cause", "loss",
				"decrease_ago_ms", int64(2_000), "decrease_from_bps", 1_800_000.0, "decrease_to_bps", 600_000.0,
				"decrease_acked_bps", 300_000.0)...)
	} else {
		egress(2400, 0.004)
		transport(3_000_000, 3_000_000, 0)
		// A healthy call still carries the node's congestion marks; this one recovered.
		sub := cameraSub(viewer, "4")
		viewer.trailAs(slog.LevelInfo, "subscription resumed after a congestion pause", EventSubscriptionCongestion,
			subAttrs(sub, "rid", "l", "layer", "low", "reason", "bandwidth_recovered",
				"estimate_bps", 3_000_000.0, "proven_bps", 3_000_000.0, "delivered_share", 1.0,
				"probing", false, "host_pressure", false, "acked_bps", 2_400_000.0, "loss_share", 0.004,
				"lossy", false, "trend", "normal", "decrease_cause", "",
				"decrease_ago_ms", int64(0), "decrease_from_bps", 0.0, "decrease_to_bps", 0.0,
				"decrease_acked_bps", 0.0)...)
	}
}

func TestVideoChainFixtures(t *testing.T) {
	// video.not_published: the publisher seat's SFU evidence.
	c := newChainCapture(t)
	publishRows(c, true)
	writeChain(t, "video.not_published", "positive", c.rows())
	c = newChainCapture(t)
	publishRows(c, false)
	writeChain(t, "video.not_published", "healthy", c.rows())

	// video.not_shown: the viewer seat's subscription evidence; the forward never grows.
	c = newChainCapture(t)
	subscriptionRows(c, []int64{0, 0, 0}, planOpen, true, true)
	writeChain(t, "video.not_shown", "positive", c.rows())
	c = newChainCapture(t)
	subscriptionRows(c, []int64{0, 1200, 2600}, planOpen, true, false)
	writeChain(t, "video.not_shown", "healthy", c.rows())

	// video.frozen: the same subscription shape; the forward grows — the freeze is downstream.
	c = newChainCapture(t)
	subscriptionRows(c, []int64{0, 1200, 2600}, planOpen, true, true)
	writeChain(t, "video.frozen", "positive", c.rows())
	c = newChainCapture(t)
	subscriptionRows(c, []int64{0, 1200, 2600}, planOpen, true, false)
	writeChain(t, "video.frozen", "healthy", c.rows())

	// video.low_quality: the forward flows at the lowest plan and the downlink marks the drop.
	c = newChainCapture(t)
	subscriptionRows(c, []int64{0, 1200, 2600}, planLowest, true, true)
	downlinkRows(c, true)
	writeChain(t, "video.low_quality", "positive", c.rows())
	c = newChainCapture(t)
	subscriptionRows(c, []int64{0, 1200, 2600}, planOpen, true, false)
	downlinkRows(c, false)
	writeChain(t, "video.low_quality", "healthy", c.rows())
}
