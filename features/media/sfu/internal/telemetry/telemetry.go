// Package telemetry exports the node's metrics over OTLP/HTTP, the pipeline the API uses. Every
// instrument is asynchronous: one callback reads the node's latest control-loop tick at export
// time, so the packet path pays nothing for export. No metric carries a Tenant, Episode,
// Participant, session or address; attributes come from closed sets.
package telemetry

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/url"
	"strings"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	"go.opentelemetry.io/otel/metric"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	semconv "go.opentelemetry.io/otel/semconv/v1.37.0"

	"github.com/q9labs/chalk/features/media/sfu/internal/config"
	"github.com/q9labs/chalk/features/media/sfu/internal/media"
)

// scope names the meter, as the API names its meters by package path.
const scope = "github.com/q9labs/chalk/features/media/sfu/internal/telemetry"

// Read returns the node's telemetry at one moment.
type Read func() media.Telemetry

// Exporter sends the node's metrics on an interval until it shuts down.
type Exporter struct {
	provider *sdkmetric.MeterProvider
}

// Start exports the node's metrics when an endpoint is configured, and returns a no-op exporter
// otherwise. instance names this process boot, the node's incarnation.
func Start(ctx context.Context, cfg config.Telemetry, instance string, read Read, log *slog.Logger) (*Exporter, error) {
	if cfg.OTLPEndpoint == "" {
		log.Info("telemetry export off: SFU_OTLP_ENDPOINT is not set")
		return &Exporter{}, nil
	}
	options := []otlpmetrichttp.Option{otlpmetrichttp.WithEndpointURL(metricsURL(cfg.OTLPEndpoint))}
	if cfg.OTLPInsecure {
		options = append(options, otlpmetrichttp.WithInsecure())
	}
	exporter, err := otlpmetrichttp.New(ctx, options...)
	if err != nil {
		return nil, fmt.Errorf("create OTLP metric exporter: %w", err)
	}
	attributes, err := fixedResource(ctx,
		semconv.ServiceName("chalk-sfu"),
		semconv.ServiceVersion(cfg.Version),
		semconv.ServiceInstanceID(instance),
		semconv.DeploymentEnvironmentName(cfg.Environment),
	)
	if err != nil {
		return nil, fmt.Errorf("create telemetry resource: %w", err)
	}
	provider := sdkmetric.NewMeterProvider(
		sdkmetric.WithResource(attributes),
		sdkmetric.WithReader(sdkmetric.NewPeriodicReader(exporter, sdkmetric.WithInterval(cfg.Interval))),
	)
	// A failed export retries on the next interval; the log names it so an operator sees a gap.
	otel.SetErrorHandler(otel.ErrorHandlerFunc(func(err error) { log.Warn("telemetry export failed", "error", err) }))
	if err := Register(provider.Meter(scope), read); err != nil {
		return nil, errors.Join(err, provider.Shutdown(ctx))
	}
	log.Info("telemetry export on", "interval", cfg.Interval.String())
	return &Exporter{provider: provider}, nil
}

// Shutdown sends the last metrics and stops the exporter.
func (e *Exporter) Shutdown(ctx context.Context) error {
	if e.provider == nil {
		return nil
	}
	return e.provider.Shutdown(ctx)
}

func metricsURL(endpoint string) string {
	parsed, err := url.Parse(strings.TrimRight(endpoint, "/"))
	if err != nil {
		return endpoint
	}
	parsed.Path = "/v1/metrics"
	return parsed.String()
}

// Attribute keys. Their values are closed sets.
const (
	keyDirection = "chalk.sfu.direction"      // in (publishers to node) or out (node to subscribers)
	keyKind      = "chalk.sfu.media_kind"     // in: audio, video; out: audio, video, repair, probe
	keyReason    = "chalk.sfu.refusal_reason" // a media.Refused* constant
	keyAdmission = "chalk.sfu.admission_reason"
)

// Register creates the node's instruments on meter and the one callback that observes them.
func Register(meter metric.Meter, read Read) error {
	var errs []error
	gauge := func(name, unit, description string) metric.Int64ObservableGauge {
		instrument, err := meter.Int64ObservableGauge(name, metric.WithUnit(unit), metric.WithDescription(description))
		errs = append(errs, err)
		return instrument
	}
	ratio := func(name, unit, description string) metric.Float64ObservableGauge {
		instrument, err := meter.Float64ObservableGauge(name, metric.WithUnit(unit), metric.WithDescription(description))
		errs = append(errs, err)
		return instrument
	}
	counter := func(name, unit, description string) metric.Int64ObservableCounter {
		instrument, err := meter.Int64ObservableCounter(name, metric.WithUnit(unit), metric.WithDescription(description))
		errs = append(errs, err)
		return instrument
	}

	sessions := gauge("chalk.sfu.sessions", "{session}", "Live sessions on the node.")
	episodes := gauge("chalk.sfu.episodes", "{episode}", "Episodes with a live session on the node.")
	draining := gauge("chalk.sfu.draining", "1", "1 while the node drains and refuses new Episodes, else 0.")
	admission := gauge("chalk.sfu.admission.closed", "1", "1 while host health refuses new Episodes, else 0. The reason attribute says why.")
	budget := gauge("chalk.sfu.packet_budget", "{packet}/s", "The node's admission budget, ingress plus egress.")
	reserved := gauge("chalk.sfu.packets.reserved", "{packet}/s", "The part of the budget live Episodes reserve.")
	packetRate := ratio("chalk.sfu.packet_rate", "{packet}/s", "Media packets per second over the last second.")
	bitrate := ratio("chalk.sfu.bitrate", "bit/s", "Media bits per second over the last second.")
	queueDelay := ratio("chalk.sfu.pacer.queue_delay.p95", "s", "95th percentile of pacer queue delay over the guard window.")
	scheduler := ratio("chalk.sfu.scheduler.latency.p99", "s", "99th percentile of Go scheduler latency over the last 10 seconds.")
	steal := ratio("chalk.sfu.host.cpu.steal", "1", "Share of host CPU time stolen by the hypervisor over the guard window.")
	busy := ratio("chalk.sfu.host.cpu.utilization", "1", "Share of host CPU time spent working over the guard window, steal excluded.")
	paused := gauge("chalk.sfu.subscriptions.congestion_paused", "{subscription}", "Video subscriptions paused because their own downlink cannot carry the lowest layer.")
	plannerPaused := gauge("chalk.sfu.subscriptions.planner_paused", "{subscription}", "Video subscriptions an Episode plan pauses to hold its packet ceiling.")
	capped := gauge("chalk.sfu.cameras.capped", "{camera}", "Cameras an Episode ceiling lowers.")
	pausedCameras := gauge("chalk.sfu.cameras.paused", "{camera}", "Cameras an Episode ceiling pauses.")
	rss := gauge("process.memory.usage", "By", "Resident memory of the SFU process.")
	cpu, err := meter.Float64ObservableCounter("process.cpu.time", metric.WithUnit("s"), metric.WithDescription("CPU time the SFU process used."))
	errs = append(errs, err)

	packets := counter("chalk.sfu.packets", "{packet}", "Media packets since start.")
	bytes := counter("chalk.sfu.bytes", "By", "Media bytes since start.")
	drops := counter("chalk.sfu.pacer.drops", "{packet}", "Video packets pacers dropped for a full queue.")
	cut := counter("chalk.sfu.repairs.cut", "{packet}", "Retransmissions refused over a subscriber's repair rate cap.")
	nacks := counter("chalk.sfu.nack.requested", "{packet}", "Sequence numbers the node asked publishers to resend, retries included.")
	keyframes := counter("chalk.sfu.keyframe_repairs", "{gap}", "Ingress gaps repaired with a keyframe instead of NACKs.")
	rtx := counter("chalk.sfu.rtx.received", "{packet}", "Packets publishers resent as RTX repairs.")
	switches := counter("chalk.sfu.layer.switches", "{switch}", "Simulcast layer switches subscriptions began.")
	refusals := counter("chalk.sfu.refusals", "{refusal}", "Joins and screen shares the node refused, by reason.")
	udpErrors := counter("chalk.sfu.host.udp.receive_buffer_errors", "{datagram}", "Host UDP datagrams dropped for a full receive buffer.")
	udpSendErrors := counter("chalk.sfu.host.udp.send_buffer_errors", "{datagram}", "Host UDP datagrams dropped for a full send buffer.")
	sendRefused := counter("chalk.sfu.udp.send_refused", "{datagram}", "Datagrams the kernel refused to send on the media socket.")
	sendDropped := counter("chalk.sfu.udp.send_dropped", "{datagram}", "Datagrams the media socket's send rings dropped for a stalled socket, by class.")
	receiveTruncated := counter("chalk.sfu.udp.receive_truncated", "{datagram}", "Datagrams cut short by the media socket's read buffer and dropped.")
	if err := errors.Join(errs...); err != nil {
		return fmt.Errorf("create telemetry instruments: %w", err)
	}

	_, err = meter.RegisterCallback(func(_ context.Context, o metric.Observer) error {
		t := read()
		o.ObserveInt64(sessions, int64(t.Sessions))
		o.ObserveInt64(episodes, int64(t.Episodes))
		o.ObserveInt64(draining, flag(t.Draining))
		reason := t.Health.AdmissionReason
		if reason == "" {
			reason = "none"
		}
		o.ObserveInt64(admission, flag(t.Health.AdmissionReason != ""), metric.WithAttributes(attribute.String(keyAdmission, reason)))
		o.ObserveInt64(budget, int64(t.PacketBudget))
		o.ObserveInt64(reserved, int64(t.ReservedPackets))
		observeFlows(o, "in", t.In, packetRate, bitrate, packets, bytes)
		observeFlows(o, "out", t.Out, packetRate, bitrate, packets, bytes)
		o.ObserveFloat64(queueDelay, t.Health.QueueDelayP95.Seconds())
		o.ObserveFloat64(scheduler, t.Health.SchedulerLatencyP99.Seconds())
		if t.Health.StealKnown {
			o.ObserveFloat64(steal, t.Health.StealPercent/100)
			o.ObserveFloat64(busy, t.Health.BusyPercent/100)
		}
		o.ObserveInt64(paused, int64(t.CongestionPaused))
		o.ObserveInt64(plannerPaused, int64(t.PlannerPaused))
		o.ObserveInt64(capped, int64(t.CappedCameras))
		o.ObserveInt64(pausedCameras, int64(t.PausedCameras))
		o.ObserveInt64(drops, count(t.Totals.PacerDrops))
		o.ObserveInt64(cut, count(t.Totals.RepairsCut))
		o.ObserveInt64(nacks, count(t.Totals.NACKRequested))
		o.ObserveInt64(keyframes, count(t.Totals.KeyframeRepairs))
		o.ObserveInt64(rtx, count(t.Totals.RTXReceived))
		o.ObserveInt64(switches, count(t.Totals.LayerSwitches))
		for reason, refused := range t.Refusals {
			o.ObserveInt64(refusals, count(refused), metric.WithAttributes(attribute.String(keyReason, reason)))
		}
		o.ObserveInt64(sendRefused, count(t.UDPSendRefused))
		o.ObserveInt64(sendDropped, count(t.UDPDroppedAudio), metric.WithAttributes(attribute.String(keyReason, "audio_ring_full")))
		o.ObserveInt64(sendDropped, count(t.UDPDroppedVideo), metric.WithAttributes(attribute.String(keyReason, "video_ring_full")))
		o.ObserveInt64(receiveTruncated, count(t.UDPReceiveTruncated))
		if t.UDPErrorsKnown {
			o.ObserveInt64(udpErrors, count(t.UDPReceiveErrors))
			o.ObserveInt64(udpSendErrors, count(t.UDPSendErrors))
		}
		if seconds, ok := processCPUSeconds(); ok {
			o.ObserveFloat64(cpu, seconds)
		}
		if resident, ok := media.ResidentBytes(); ok {
			o.ObserveInt64(rss, count(resident))
		}
		return nil
	}, sessions, episodes, draining, admission, budget, reserved, packetRate, bitrate, queueDelay, scheduler,
		steal, busy, paused, plannerPaused, capped, pausedCameras, rss, cpu, packets, bytes, drops, cut, nacks, keyframes, rtx,
		switches, refusals, udpErrors, udpSendErrors, sendRefused, sendDropped, receiveTruncated)
	if err != nil {
		return fmt.Errorf("register telemetry callback: %w", err)
	}
	return nil
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
