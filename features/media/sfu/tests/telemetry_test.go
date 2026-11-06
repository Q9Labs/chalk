package tests

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	collector "go.opentelemetry.io/proto/otlp/collector/metrics/v1"
	common "go.opentelemetry.io/proto/otlp/common/v1"
	metrics "go.opentelemetry.io/proto/otlp/metrics/v1"
	"google.golang.org/protobuf/proto"

	"github.com/q9labs/chalk/features/media/sfu/internal/config"
	"github.com/q9labs/chalk/features/media/sfu/internal/media"
	"github.com/q9labs/chalk/features/media/sfu/internal/telemetry"
	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// otlpReceiver is a local OTLP/HTTP metrics endpoint that keeps every export.
type otlpReceiver struct {
	mu      sync.Mutex
	exports []*collector.ExportMetricsServiceRequest
}

func (r *otlpReceiver) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	body, err := io.ReadAll(req.Body)
	export := &collector.ExportMetricsServiceRequest{}
	if err != nil || req.URL.Path != "/v1/metrics" || proto.Unmarshal(body, export) != nil {
		http.Error(w, "bad export", http.StatusBadRequest)
		return
	}
	r.mu.Lock()
	r.exports = append(r.exports, export)
	r.mu.Unlock()
	w.Header().Set("Content-Type", "application/x-protobuf")
	_, _ = w.Write(nil)
}

// latest returns the newest exported data point of each metric and attribute set, keyed by
// "name{key=value,...}", and every resource attribute seen.
func (r *otlpReceiver) latest() (points map[string]float64, resource map[string]string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	points, resource = map[string]float64{}, map[string]string{}
	for _, export := range r.exports {
		for _, rm := range export.ResourceMetrics {
			for _, kv := range rm.Resource.GetAttributes() {
				resource[kv.Key] = kv.Value.GetStringValue()
			}
			for _, sm := range rm.ScopeMetrics {
				for _, m := range sm.Metrics {
					for _, point := range numberPoints(m) {
						points[m.Name+labels(point.Attributes)] = value(point)
					}
				}
			}
		}
	}
	return points, resource
}

func numberPoints(m *metrics.Metric) []*metrics.NumberDataPoint {
	if gauge := m.GetGauge(); gauge != nil {
		return gauge.DataPoints
	}
	return m.GetSum().GetDataPoints()
}

func value(point *metrics.NumberDataPoint) float64 {
	if _, ok := point.Value.(*metrics.NumberDataPoint_AsInt); ok {
		return float64(point.GetAsInt())
	}
	return point.GetAsDouble()
}

func labels(attributes []*common.KeyValue) string {
	if len(attributes) == 0 {
		return ""
	}
	parts := make([]string, 0, len(attributes))
	for _, kv := range attributes {
		parts = append(parts, kv.Key+"="+kv.Value.GetStringValue())
	}
	return "{" + strings.Join(parts, ",") + "}"
}

// mediaCounts are the counters inspect shows, summed over the call.
type mediaCounts struct {
	out                 [4]uint64 // audio, video, repair, probe
	dropped, repairsCut uint64
	requested, repaired uint64
}

func countMedia(t *testing.T, svc *service, publisher *participant, subscribers ...*participant) mediaCounts {
	t.Helper()
	var counts mediaCounts
	for _, track := range publisher.inspect(t, svc).Tracks {
		for _, layer := range track.Layers {
			counts.requested += layer.RequestedPackets
			counts.repaired += layer.RepairedPackets
		}
	}
	for _, subscriber := range subscribers {
		transport := subscriber.inspect(t, svc).Transport
		sent := [4]uint64{transport.Sent.Audio, transport.Sent.Video, transport.Sent.Repair, transport.Sent.Probe}
		for class := range counts.out {
			counts.out[class] += sent[class]
		}
		counts.dropped += transport.Dropped
		counts.repairsCut += transport.RepairsCut
	}
	return counts
}

func telemetryCounts(t media.Telemetry) mediaCounts {
	out := map[string]uint64{}
	for _, flow := range t.Out {
		out[flow.Kind] = flow.Packets
	}
	return mediaCounts{
		out:     [4]uint64{out["audio"], out["video"], out["repair"], out["probe"]},
		dropped: t.Totals.PacerDrops, repairsCut: t.Totals.RepairsCut,
		requested: t.Totals.NACKRequested, repaired: t.Totals.RTXReceived,
	}
}

// within reports whether every count of mid lies between before and after.
func within(before, mid, after mediaCounts) bool {
	pairs := [][3]uint64{
		{before.dropped, mid.dropped, after.dropped}, {before.repairsCut, mid.repairsCut, after.repairsCut},
		{before.requested, mid.requested, after.requested}, {before.repaired, mid.repaired, after.repaired},
	}
	for class := range before.out {
		pairs = append(pairs, [3]uint64{before.out[class], mid.out[class], after.out[class]})
	}
	for _, pair := range pairs {
		if pair[1] < pair[0] || pair[1] > pair[2] {
			return false
		}
	}
	return true
}

// TestTelemetryExportsTheCountersTheNodeTracks runs a call with loss on the publisher's uplink,
// loss on one subscriber's downlink and a slow link for another, then checks that the node's
// telemetry totals match the counters inspect reports for the same sessions, and that the OTLP
// export carries them with no Tenant, Episode, Participant or session in any attribute.
func TestTelemetryExportsTheCountersTheNodeTracks(t *testing.T) {
	ca := newAuthority(t, "chalk test CA")
	svc := startService(t, ca, func(cfg *config.Config) { cfg.Memory.PacerQueueBytes = 16 << 10 })
	receiver := &otlpReceiver{}
	endpoint := httptest.NewServer(receiver)
	t.Cleanup(endpoint.Close)
	exporter, err := telemetry.Start(context.Background(), config.Telemetry{
		OTLPEndpoint: endpoint.URL, OTLPInsecure: true, Environment: "local", Version: "test", Interval: time.Second,
	}, svc.server.Incarnation(), svc.server.Telemetry, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("start telemetry: %v", err)
	}

	alice := joinEpisode(t, svc, "episode-telemetry", "alice", false)
	alice.publish(t, svc, publishing{camera: true})
	bob := joinEpisode(t, svc, "episode-telemetry", "bob", true)
	carol := joinEpisode(t, svc, "episode-telemetry", "carol", true)
	tracks := []protocol.Track{remote(alice, cameraName), remote(alice, micName)}
	bob.pull(t, svc, tracks)
	carol.pull(t, svc, tracks)
	camera := trackKey(alice, cameraName)
	eventually(t, "both subscribers receive video", 10*time.Second, func() bool {
		return bob.media.videoCount(camera) > 100 && carol.media.videoCount(camera) > 100
	})
	alice.link.shape(0, 0, 0, 0, 0.03)
	bob.link.shape(0, 0, 10*time.Millisecond, 0.03, 0)
	carol.link.shape(300_000, 16_000, 20*time.Millisecond, 0, 0)
	time.Sleep(5 * time.Second)

	// Media keeps flowing, so the check brackets the node's totals between two inspections. The
	// control loop adds every stream's growth each 100 ms tick, so totals read 150 ms after the
	// first inspection hold at least what it saw.
	var before, mid, after mediaCounts
	var node media.Telemetry
	eventually(t, "telemetry totals between two inspections", 10*time.Second, func() bool {
		before = countMedia(t, svc, alice, bob, carol)
		time.Sleep(150 * time.Millisecond)
		node = svc.server.Telemetry()
		mid = telemetryCounts(node)
		after = countMedia(t, svc, alice, bob, carol)
		return within(before, mid, after)
	})
	t.Logf("node totals: out audio/video/repair/probe %v, pacer drops %d, repairs cut %d, NACK requested %d, RTX received %d, layer switches %d, keyframe repairs %d",
		mid.out, mid.dropped, mid.repairsCut, mid.requested, mid.repaired, node.Totals.LayerSwitches, node.Totals.KeyframeRepairs)
	if mid.out[0] == 0 || mid.out[1] == 0 || mid.out[2] == 0 || mid.requested == 0 || mid.repaired == 0 || node.Totals.LayerSwitches == 0 {
		t.Fatalf("an impaired call left a counter at zero: %+v, %d layer switches", mid, node.Totals.LayerSwitches)
	}
	if node.Sessions != 3 || node.Episodes != 1 {
		t.Fatalf("telemetry shows %d sessions in %d Episodes, want 3 in 1", node.Sessions, node.Episodes)
	}

	// Shutdown sends the last export, with every total at least what inspect showed before.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := exporter.Shutdown(ctx); err != nil {
		t.Fatalf("shutdown telemetry: %v", err)
	}
	points, resource := receiver.latest()
	if resource["service.name"] != "chalk-sfu" || resource["service.instance.id"] != svc.server.Incarnation() || resource["deployment.environment.name"] != "local" {
		t.Fatalf("resource %v, want chalk-sfu, this incarnation and local", resource)
	}
	atLeast := map[string]uint64{
		"chalk.sfu.packets{chalk.sfu.direction=out,chalk.sfu.media_kind=audio}":  before.out[0],
		"chalk.sfu.packets{chalk.sfu.direction=out,chalk.sfu.media_kind=video}":  before.out[1],
		"chalk.sfu.packets{chalk.sfu.direction=out,chalk.sfu.media_kind=repair}": before.out[2],
		"chalk.sfu.pacer.drops":    before.dropped,
		"chalk.sfu.repairs.cut":    before.repairsCut,
		"chalk.sfu.nack.requested": before.requested,
		"chalk.sfu.rtx.received":   before.repaired,
		"chalk.sfu.layer.switches": 1,
	}
	for name, least := range atLeast {
		got, ok := points[name]
		if !ok || got < float64(least) {
			t.Errorf("export %s = %v (present %v), want at least %d", name, got, ok, least)
		}
	}
	for _, name := range []string{
		"chalk.sfu.sessions", "chalk.sfu.episodes", "chalk.sfu.draining", "chalk.sfu.packet_budget", "chalk.sfu.packets.reserved",
		"chalk.sfu.admission.closed{chalk.sfu.admission_reason=none}", "chalk.sfu.pacer.queue_delay.p95", "chalk.sfu.scheduler.latency.p99",
		"chalk.sfu.packet_rate{chalk.sfu.direction=in,chalk.sfu.media_kind=video}", "chalk.sfu.bitrate{chalk.sfu.direction=out,chalk.sfu.media_kind=video}",
		"chalk.sfu.bytes{chalk.sfu.direction=in,chalk.sfu.media_kind=audio}", "process.cpu.time",
	} {
		if _, ok := points[name]; !ok {
			t.Errorf("export has no %s", name)
		}
	}
	identities := []string{"episode-telemetry", alice.scope.ParticipantID, bob.scope.ParticipantID, alice.scope.TenantID, alice.conn, bob.conn, carol.conn}
	for key := range points {
		for _, identity := range identities {
			if identity != "" && strings.Contains(key, identity) {
				t.Fatalf("exported series %s names %q", key, identity)
			}
		}
	}
}
