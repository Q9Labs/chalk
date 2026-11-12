package telemetry

import (
	"context"
	"testing"
	"time"

	"go.opentelemetry.io/otel/attribute"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"

	"github.com/q9labs/chalk/features/media/sfu/internal/media"
)

// allowedKeys are the only attribute keys a metric may carry: closed sets, never an identity.
var allowedKeys = map[string]bool{keyDirection: true, keyKind: true, keyReason: true, keyAdmission: true}

type point struct {
	value float64
	attrs map[string]string
}

func collect(t *testing.T, read Read) map[string][]point {
	t.Helper()
	reader := sdkmetric.NewManualReader()
	provider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	t.Cleanup(func() { _ = provider.Shutdown(context.Background()) })
	if err := Register(provider.Meter(scope), read); err != nil {
		t.Fatalf("register: %v", err)
	}
	var data metricdata.ResourceMetrics
	if err := reader.Collect(context.Background(), &data); err != nil {
		t.Fatalf("collect: %v", err)
	}
	points := map[string][]point{}
	for _, scopeMetrics := range data.ScopeMetrics {
		for _, m := range scopeMetrics.Metrics {
			points[m.Name] = append(points[m.Name], pointsOf(t, m)...)
		}
	}
	return points
}

// pointsOf reads one metric's data points; a counter must be cumulative and monotonic.
func pointsOf(t *testing.T, m metricdata.Metrics) []point {
	switch data := m.Data.(type) {
	case metricdata.Gauge[int64]:
		return numbers(data.DataPoints)
	case metricdata.Gauge[float64]:
		return numbers(data.DataPoints)
	case metricdata.Sum[int64]:
		if !data.IsMonotonic || data.Temporality != metricdata.CumulativeTemporality {
			t.Errorf("%s is not a cumulative counter", m.Name)
		}
		return numbers(data.DataPoints)
	case metricdata.Sum[float64]:
		return numbers(data.DataPoints)
	default:
		t.Fatalf("%s has unexpected data %T", m.Name, m.Data)
		return nil
	}
}

func numbers[N int64 | float64](dataPoints []metricdata.DataPoint[N]) []point {
	out := make([]point, 0, len(dataPoints))
	for _, p := range dataPoints {
		out = append(out, point{float64(p.Value), attrs(p.Attributes.ToSlice())})
	}
	return out
}

func TestEveryNodeCounterIsExportedUnderClosedLabels(t *testing.T) {
	snapshot := media.Telemetry{
		Sessions: 3, Episodes: 1, Draining: true, PacketBudget: 16000, ReservedPackets: 2400,
		Health: media.HostHealth{
			AdmissionReason: media.RefusedCPUSteal, StealKnown: true, StealPercent: 30, BusyPercent: 40,
			QueueDelayP95: 20 * time.Millisecond, SchedulerLatencyP99: time.Millisecond,
		},
		UDPReceiveErrors: 7, UDPSendErrors: 3, UDPErrorsKnown: true, UDPDroppedAudio: 2, UDPDroppedVideo: 9,
		CongestionPaused: 2, PlannerPaused: 1, CappedCameras: 1, PausedCameras: 1,
		In:  []media.Flow{{Kind: "audio", PacketsPerSecond: 50, BitsPerSecond: 40000, Packets: 500, Bytes: 50000}},
		Out: []media.Flow{{Kind: "repair", PacketsPerSecond: 5, BitsPerSecond: 6000, Packets: 11, Bytes: 13000}},
		Totals: media.Totals{
			PacerDrops: 4, RepairsCut: 5, NACKRequested: 6, KeyframeRepairs: 8, RTXReceived: 9, LayerSwitches: 10,
		},
		Refusals: map[string]uint64{media.RefusedNodeFull: 2, media.RefusedCPUSteal: 1},
	}
	points := collect(t, func() media.Telemetry { return snapshot })

	want := map[string]float64{
		"chalk.sfu.sessions": 3, "chalk.sfu.episodes": 1, "chalk.sfu.draining": 1, "chalk.sfu.admission.closed": 1,
		"chalk.sfu.packet_budget": 16000, "chalk.sfu.packets.reserved": 2400,
		"chalk.sfu.pacer.queue_delay.p95": 0.02, "chalk.sfu.scheduler.latency.p99": 0.001,
		"chalk.sfu.host.cpu.steal": 0.3, "chalk.sfu.host.cpu.utilization": 0.4,
		"chalk.sfu.subscriptions.congestion_paused": 2, "chalk.sfu.subscriptions.planner_paused": 1, "chalk.sfu.cameras.capped": 1, "chalk.sfu.cameras.paused": 1,
		"chalk.sfu.pacer.drops": 4, "chalk.sfu.repairs.cut": 5, "chalk.sfu.nack.requested": 6,
		"chalk.sfu.keyframe_repairs": 8, "chalk.sfu.rtx.received": 9, "chalk.sfu.layer.switches": 10,
		"chalk.sfu.host.udp.receive_buffer_errors": 7, "chalk.sfu.host.udp.send_buffer_errors": 3,
	}
	for name, value := range want {
		got := points[name]
		if len(got) != 1 || got[0].value != value {
			t.Errorf("%s = %v, want one point of %v", name, got, value)
		}
	}
	if got := points["chalk.sfu.admission.closed"]; len(got) == 1 && got[0].attrs[keyAdmission] != "cpu_steal" {
		t.Errorf("admission reason %v, want cpu_steal", got[0].attrs)
	}
	checkFlows(t, points)
	checkByReason(t, points, "chalk.sfu.udp.send_dropped", map[string]float64{"audio_ring_full": 2, "video_ring_full": 9})
	checkByReason(t, points, "chalk.sfu.refusals", map[string]float64{"node_full": 2, "cpu_steal": 1})
	if len(points["process.cpu.time"]) != 1 {
		t.Error("process CPU time is missing")
	}
	for name, series := range points {
		for _, p := range series {
			for key := range p.attrs {
				if !allowedKeys[key] {
					t.Errorf("%s carries attribute %q outside the closed set", name, key)
				}
			}
		}
	}
}

// checkFlows checks the in/audio and out/repair flows of the snapshot, keyed by direction and kind.
func checkFlows(t *testing.T, points map[string][]point) {
	flows := map[string]float64{}
	for _, name := range []string{"chalk.sfu.packets", "chalk.sfu.bytes", "chalk.sfu.packet_rate", "chalk.sfu.bitrate"} {
		for _, p := range points[name] {
			flows[name+"/"+p.attrs[keyDirection]+"/"+p.attrs[keyKind]] = p.value
		}
	}
	for key, value := range map[string]float64{
		"chalk.sfu.packets/in/audio": 500, "chalk.sfu.bytes/in/audio": 50000, "chalk.sfu.packet_rate/in/audio": 50, "chalk.sfu.bitrate/in/audio": 40000,
		"chalk.sfu.packets/out/repair": 11, "chalk.sfu.bytes/out/repair": 13000, "chalk.sfu.packet_rate/out/repair": 5, "chalk.sfu.bitrate/out/repair": 6000,
	} {
		if flows[key] != value {
			t.Errorf("%s = %v, want %v", key, flows[key], value)
		}
	}
}

// checkByReason checks that a metric has exactly the wanted points, one per reason.
func checkByReason(t *testing.T, points map[string][]point, name string, want map[string]float64) {
	got := map[string]float64{}
	for _, p := range points[name] {
		got[p.attrs[keyReason]] = p.value
	}
	if len(got) != len(want) {
		t.Errorf("%s by reason %v, want %v", name, got, want)
		return
	}
	for reason, value := range want {
		if got[reason] != value {
			t.Errorf("%s by reason %v, want %v", name, got, want)
		}
	}
}

func attrs(kvs []attribute.KeyValue) map[string]string {
	out := map[string]string{}
	for _, kv := range kvs {
		out[string(kv.Key)] = kv.Value.Emit()
	}
	return out
}
