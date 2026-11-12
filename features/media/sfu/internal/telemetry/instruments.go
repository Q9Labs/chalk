package telemetry

import (
	"context"
	"errors"
	"fmt"
	"math"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"

	"github.com/q9labs/chalk/features/media/sfu/internal/media"
)

// Attribute keys. Their values are closed sets.
const (
	keyDirection = "chalk.sfu.direction"      // in (publishers to node) or out (node to subscribers)
	keyKind      = "chalk.sfu.media_kind"     // in: audio, video; out: audio, video, repair, probe
	keyReason    = "chalk.sfu.refusal_reason" // a media.Refused* constant
	keyAdmission = "chalk.sfu.admission_reason"
)

// Register creates the node's instruments on meter and the one callback that observes them.
func Register(meter metric.Meter, read Read) error {
	in := newInstruments(meter)
	if err := errors.Join(in.errs...); err != nil {
		return fmt.Errorf("create telemetry instruments: %w", err)
	}
	if _, err := meter.RegisterCallback(func(_ context.Context, o metric.Observer) error {
		in.observe(o, read())
		return nil
	}, in.all...); err != nil {
		return fmt.Errorf("register telemetry callback: %w", err)
	}
	return nil
}

// instruments are the node's metrics. Creating them records every instrument in all, and every
// creation error in errs, so one callback can observe them and one check can report failure.
type instruments struct {
	meter metric.Meter
	errs  []error
	all   []metric.Observable

	sessions, episodes, draining, admission, budget, reserved metric.Int64ObservableGauge
	paused, plannerPaused, capped, pausedCameras, rss         metric.Int64ObservableGauge
	packetRate, bitrate, queueDelay, scheduler, steal, busy   metric.Float64ObservableGauge
	cpu                                                       metric.Float64ObservableCounter

	packets, bytes, drops, cut, nacks, keyframes, rtx, switches, refusals metric.Int64ObservableCounter
	udpErrors, udpSendErrors, sendRefused, sendDropped, receiveTruncated  metric.Int64ObservableCounter
}

func newInstruments(meter metric.Meter) *instruments {
	in := &instruments{meter: meter}
	in.sessions = in.gauge("chalk.sfu.sessions", "{session}", "Live sessions on the node.")
	in.episodes = in.gauge("chalk.sfu.episodes", "{episode}", "Episodes with a live session on the node.")
	in.draining = in.gauge("chalk.sfu.draining", "1", "1 while the node drains and refuses new Episodes, else 0.")
	in.admission = in.gauge("chalk.sfu.admission.closed", "1", "1 while host health refuses new Episodes, else 0. The reason attribute says why.")
	in.budget = in.gauge("chalk.sfu.packet_budget", "{packet}/s", "The node's admission budget, ingress plus egress.")
	in.reserved = in.gauge("chalk.sfu.packets.reserved", "{packet}/s", "The part of the budget live Episodes reserve.")
	in.packetRate = in.ratio("chalk.sfu.packet_rate", "{packet}/s", "Media packets per second over the last second.")
	in.bitrate = in.ratio("chalk.sfu.bitrate", "bit/s", "Media bits per second over the last second.")
	in.queueDelay = in.ratio("chalk.sfu.pacer.queue_delay.p95", "s", "95th percentile of pacer queue delay over the guard window.")
	in.scheduler = in.ratio("chalk.sfu.scheduler.latency.p99", "s", "99th percentile of Go scheduler latency over the last 10 seconds.")
	in.steal = in.ratio("chalk.sfu.host.cpu.steal", "1", "Share of host CPU time stolen by the hypervisor over the guard window.")
	in.busy = in.ratio("chalk.sfu.host.cpu.utilization", "1", "Share of host CPU time spent working over the guard window, steal excluded.")
	in.paused = in.gauge("chalk.sfu.subscriptions.congestion_paused", "{subscription}", "Video subscriptions paused because their own downlink cannot carry the lowest layer.")
	in.plannerPaused = in.gauge("chalk.sfu.subscriptions.planner_paused", "{subscription}", "Video subscriptions an Episode plan pauses to hold its packet ceiling.")
	in.capped = in.gauge("chalk.sfu.cameras.capped", "{camera}", "Cameras an Episode ceiling lowers.")
	in.pausedCameras = in.gauge("chalk.sfu.cameras.paused", "{camera}", "Cameras an Episode ceiling pauses.")
	in.rss = in.gauge("process.memory.usage", "By", "Resident memory of the SFU process.")
	cpu, err := meter.Float64ObservableCounter("process.cpu.time", metric.WithUnit("s"), metric.WithDescription("CPU time the SFU process used."))
	in.cpu = cpu
	in.errs = append(in.errs, err)
	in.all = append(in.all, cpu)

	in.packets = in.counter("chalk.sfu.packets", "{packet}", "Media packets since start.")
	in.bytes = in.counter("chalk.sfu.bytes", "By", "Media bytes since start.")
	in.drops = in.counter("chalk.sfu.pacer.drops", "{packet}", "Video packets pacers dropped for a full queue.")
	in.cut = in.counter("chalk.sfu.repairs.cut", "{packet}", "Retransmissions refused over a subscriber's repair rate cap.")
	in.nacks = in.counter("chalk.sfu.nack.requested", "{packet}", "Sequence numbers the node asked publishers to resend, retries included.")
	in.keyframes = in.counter("chalk.sfu.keyframe_repairs", "{gap}", "Ingress gaps repaired with a keyframe instead of NACKs.")
	in.rtx = in.counter("chalk.sfu.rtx.received", "{packet}", "Packets publishers resent as RTX repairs.")
	in.switches = in.counter("chalk.sfu.layer.switches", "{switch}", "Simulcast layer switches subscriptions began.")
	in.refusals = in.counter("chalk.sfu.refusals", "{refusal}", "Joins and screen shares the node refused, by reason.")
	in.udpErrors = in.counter("chalk.sfu.host.udp.receive_buffer_errors", "{datagram}", "Host UDP datagrams dropped for a full receive buffer.")
	in.udpSendErrors = in.counter("chalk.sfu.host.udp.send_buffer_errors", "{datagram}", "Host UDP datagrams dropped for a full send buffer.")
	in.sendRefused = in.counter("chalk.sfu.udp.send_refused", "{datagram}", "Datagrams the kernel refused to send on the media socket.")
	in.sendDropped = in.counter("chalk.sfu.udp.send_dropped", "{datagram}", "Datagrams the media socket's send rings dropped for a stalled socket, by class.")
	in.receiveTruncated = in.counter("chalk.sfu.udp.receive_truncated", "{datagram}", "Datagrams cut short by the media socket's read buffer and dropped.")
	return in
}

func (in *instruments) gauge(name, unit, description string) metric.Int64ObservableGauge {
	instrument, err := in.meter.Int64ObservableGauge(name, metric.WithUnit(unit), metric.WithDescription(description))
	in.errs = append(in.errs, err)
	in.all = append(in.all, instrument)
	return instrument
}

func (in *instruments) ratio(name, unit, description string) metric.Float64ObservableGauge {
	instrument, err := in.meter.Float64ObservableGauge(name, metric.WithUnit(unit), metric.WithDescription(description))
	in.errs = append(in.errs, err)
	in.all = append(in.all, instrument)
	return instrument
}

func (in *instruments) counter(name, unit, description string) metric.Int64ObservableCounter {
	instrument, err := in.meter.Int64ObservableCounter(name, metric.WithUnit(unit), metric.WithDescription(description))
	in.errs = append(in.errs, err)
	in.all = append(in.all, instrument)
	return instrument
}

// observe reports one reading of the node to o.
func (in *instruments) observe(o metric.Observer, t media.Telemetry) {
	o.ObserveInt64(in.sessions, int64(t.Sessions))
	o.ObserveInt64(in.episodes, int64(t.Episodes))
	o.ObserveInt64(in.draining, flag(t.Draining))
	reason := t.Health.AdmissionReason
	if reason == "" {
		reason = "none"
	}
	o.ObserveInt64(in.admission, flag(t.Health.AdmissionReason != ""), metric.WithAttributes(attribute.String(keyAdmission, reason)))
	o.ObserveInt64(in.budget, int64(t.PacketBudget))
	o.ObserveInt64(in.reserved, int64(t.ReservedPackets))
	observeFlows(o, "in", t.In, in.packetRate, in.bitrate, in.packets, in.bytes)
	observeFlows(o, "out", t.Out, in.packetRate, in.bitrate, in.packets, in.bytes)
	o.ObserveFloat64(in.queueDelay, t.Health.QueueDelayP95.Seconds())
	o.ObserveFloat64(in.scheduler, t.Health.SchedulerLatencyP99.Seconds())
	if t.Health.StealKnown {
		o.ObserveFloat64(in.steal, t.Health.StealPercent/100)
		o.ObserveFloat64(in.busy, t.Health.BusyPercent/100)
	}
	o.ObserveInt64(in.paused, int64(t.CongestionPaused))
	o.ObserveInt64(in.plannerPaused, int64(t.PlannerPaused))
	o.ObserveInt64(in.capped, int64(t.CappedCameras))
	o.ObserveInt64(in.pausedCameras, int64(t.PausedCameras))
	in.observeCounts(o, t)
	if seconds, ok := processCPUSeconds(); ok {
		o.ObserveFloat64(in.cpu, seconds)
	}
	if resident, ok := media.ResidentBytes(); ok {
		o.ObserveInt64(in.rss, count(resident))
	}
}

// observeCounts reports the node's cumulative counts.
func (in *instruments) observeCounts(o metric.Observer, t media.Telemetry) {
	o.ObserveInt64(in.drops, count(t.Totals.PacerDrops))
	o.ObserveInt64(in.cut, count(t.Totals.RepairsCut))
	o.ObserveInt64(in.nacks, count(t.Totals.NACKRequested))
	o.ObserveInt64(in.keyframes, count(t.Totals.KeyframeRepairs))
	o.ObserveInt64(in.rtx, count(t.Totals.RTXReceived))
	o.ObserveInt64(in.switches, count(t.Totals.LayerSwitches))
	for reason, refused := range t.Refusals {
		o.ObserveInt64(in.refusals, count(refused), metric.WithAttributes(attribute.String(keyReason, reason)))
	}
	o.ObserveInt64(in.sendRefused, count(t.UDPSendRefused))
	o.ObserveInt64(in.sendDropped, count(t.UDPDroppedAudio), metric.WithAttributes(attribute.String(keyReason, "audio_ring_full")))
	o.ObserveInt64(in.sendDropped, count(t.UDPDroppedVideo), metric.WithAttributes(attribute.String(keyReason, "video_ring_full")))
	o.ObserveInt64(in.receiveTruncated, count(t.UDPReceiveTruncated))
	if t.UDPErrorsKnown {
		o.ObserveInt64(in.udpErrors, count(t.UDPReceiveErrors))
		o.ObserveInt64(in.udpSendErrors, count(t.UDPSendErrors))
	}
}

func observeFlows(o metric.Observer, direction string, flows []media.Flow, packetRate, bitrate metric.Float64Observable, packets, bytes metric.Int64Observable) {
	for _, flow := range flows {
		attributes := metric.WithAttributes(attribute.String(keyDirection, direction), attribute.String(keyKind, flow.Kind))
		o.ObserveFloat64(packetRate, flow.PacketsPerSecond, attributes)
		o.ObserveFloat64(bitrate, flow.BitsPerSecond, attributes)
		o.ObserveInt64(packets, count(flow.Packets), attributes)
		o.ObserveInt64(bytes, count(flow.Bytes), attributes)
	}
}

func flag(on bool) int64 {
	if on {
		return 1
	}
	return 0
}

// count converts a cumulative count to the int64 OTLP carries.
func count(value uint64) int64 { return int64(min(value, math.MaxInt64)) }
