package observability

import (
	"context"
	"log/slog"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/mediaplaneproviders"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	otelmetric "go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"
)

const mediaPlaneInstrumentationScope = "github.com/q9labs/chalk/apps/api/internal/observability/media_plane"

var mediaPlaneTracer = otel.Tracer(mediaPlaneInstrumentationScope)

type MediaPlaneResolutionTelemetry struct {
	logger   *slog.Logger
	requests otelmetric.Int64Counter
	duration otelmetric.Float64Histogram
	// placements counts placement decisions, not committed Episodes: a decision whose
	// enclosing transaction later rolls back is still counted.
	placements otelmetric.Int64Counter
}

func NewMediaPlaneResolutionTelemetry(logger *slog.Logger) MediaPlaneResolutionTelemetry {
	if logger == nil {
		logger = slog.Default()
	}
	meter := otel.Meter(mediaPlaneInstrumentationScope)
	requests, _ := meter.Int64Counter(
		"chalk.api.media_plane.resolutions",
		otelmetric.WithDescription("MediaPlane resolution outcomes"),
		otelmetric.WithUnit("{resolution}"),
	)
	duration, _ := meter.Float64Histogram(
		"chalk.api.media_plane.resolution.duration",
		otelmetric.WithDescription("MediaPlane resolution latency"),
		otelmetric.WithUnit("s"),
	)
	placements, _ := meter.Int64Counter(
		"chalk.api.media_plane.placement_decisions",
		otelmetric.WithDescription("Chalk SFU placement decisions for new Episodes, including ones whose creation later rolls back"),
		otelmetric.WithUnit("{decision}"),
	)
	return MediaPlaneResolutionTelemetry{logger: logger, requests: requests, duration: duration, placements: placements}
}

// RecordPlacement counts one placement decision. The resolver runs inside the
// Episode-creation transaction, so a rolled-back creation still counts. Labels are bounded: the node
// role comes from the reason, never from a node name, and no Tenant, Episode or
// Participant identity is attached.
func (t MediaPlaneResolutionTelemetry) RecordPlacement(ctx context.Context, provider mediaplane.Provider, reason mediaplane.PlacementReason) {
	role, bounded := boundedPlacement(reason)
	t.placements.Add(ctx, 1, otelmetric.WithAttributes(
		attribute.String("chalk.media_plane.provider", boundedMediaPlaneProvider(provider)),
		attribute.String("chalk.media_plane.node_role", role),
		attribute.String("chalk.media_plane.placement_reason", bounded),
	))
	if role == "overflow" {
		// The Chalk SFU had no room, so the Episode moved to Cloudflare, or was refused
		// when the provider here is still chalk_sfu. A log line is what Axiom monitors read.
		t.logger.WarnContext(ctx, "new Episode overflowed from the Chalk SFU",
			"event", "chalk_sfu.overflow",
			"provider", boundedMediaPlaneProvider(provider),
			"placement_reason", bounded,
		)
	}
}

// boundedPlacement maps a placement reason to its node role and a known reason.
// A no-capacity Episode stays on the primary. A refused Episode, with overflow off,
// counts under its overflow reason on the Chalk SFU provider; one that moved to
// Cloudflare counts the same reason under the Cloudflare provider.
func boundedPlacement(reason mediaplane.PlacementReason) (role, bounded string) {
	switch reason {
	case mediaplane.PlacementPrimary, mediaplane.PlacementNoCapacity:
		return "primary", string(reason)
	case mediaplane.PlacementStandby:
		return "standby", string(reason)
	case mediaplane.PlacementOverflowNoRoom, mediaplane.PlacementOverflowHostGuard, mediaplane.PlacementOverflowDraining, mediaplane.PlacementOverflowNodeUnavailable, mediaplane.PlacementOverflowNodeProtocol:
		return "overflow", string(reason)
	default:
		return "unknown", "unknown"
	}
}

func (t MediaPlaneResolutionTelemetry) RecordResolution(ctx context.Context, resolution mediaplaneproviders.Resolution) {
	provider := boundedMediaPlaneProvider(resolution.Provider)
	source := boundedMediaPlaneConfigurationSource(resolution.ConfigurationSource)
	mode := boundedMediaPlaneMode(resolution.Mode)
	outcome := boundedMediaPlaneOutcome(resolution.Outcome)
	failureClass := boundedMediaPlaneFailureClass(resolution.FailureClass)
	duration := nonNegative(resolution.Duration)
	attributes := []attribute.KeyValue{
		attribute.String("chalk.media_plane.provider", provider),
		attribute.String("chalk.media_plane.configuration_source", source),
		attribute.String("chalk.media_plane.mode", mode),
		attribute.String("chalk.media_plane.outcome", outcome),
		attribute.String("chalk.media_plane.failure_class", failureClass),
	}
	metricAttributes := otelmetric.WithAttributes(attributes...)
	t.requests.Add(ctx, 1, metricAttributes)
	t.duration.Record(ctx, duration.Seconds(), metricAttributes)

	finishedAt := time.Now()
	_, span := mediaPlaneTracer.Start(
		ctx,
		"media_plane.resolve",
		trace.WithTimestamp(finishedAt.Add(-duration)),
		trace.WithAttributes(attributes...),
	)
	if outcome == mediaplaneproviders.ResolutionOutcomeError {
		span.SetStatus(codes.Error, failureClass)
	}
	span.End(trace.WithTimestamp(finishedAt))

	level := slog.LevelDebug
	if source == mediaplaneproviders.ConfigurationSourceDeploymentDefault || outcome == mediaplaneproviders.ResolutionOutcomeDisabled {
		level = slog.LevelInfo
	}
	if outcome == mediaplaneproviders.ResolutionOutcomeError {
		level = slog.LevelWarn
	}
	t.logger.Log(ctx, level, "MediaPlane resolution",
		"event", "media_plane.resolution",
		"provider", provider,
		"configuration_source", source,
		"mode", mode,
		"outcome", outcome,
		"failure_class", failureClass,
		"duration_ms", milliseconds(duration),
	)
}

func boundedMediaPlaneProvider(provider mediaplane.Provider) string {
	switch provider {
	case mediaplane.ProviderCloudflareSFU, mediaplane.ProviderChalkSFU:
		return provider.SettingName()
	default:
		return "unknown"
	}
}

func boundedMediaPlaneConfigurationSource(source string) string {
	switch source {
	case mediaplaneproviders.ConfigurationSourceDeploymentDefault,
		mediaplaneproviders.ConfigurationSourceTenantChalkManaged,
		mediaplaneproviders.ConfigurationSourceTenantManaged,
		mediaplaneproviders.ConfigurationSourceDisabled,
		mediaplaneproviders.ConfigurationSourceTenantConfiguration,
		mediaplaneproviders.ConfigurationSourceNone:
		return source
	default:
		return "unknown"
	}
}

func boundedMediaPlaneMode(mode string) string {
	switch mode {
	case mediaplane.ModeChalkManaged,
		mediaplane.ModeTenantManaged,
		mediaplane.ModeDisabled,
		mediaplane.ModeUnknown:
		return mode
	default:
		return "unknown"
	}
}

func boundedMediaPlaneOutcome(outcome string) string {
	switch outcome {
	case mediaplaneproviders.ResolutionOutcomeResolved,
		mediaplaneproviders.ResolutionOutcomeDisabled,
		mediaplaneproviders.ResolutionOutcomeUnconfigured,
		mediaplaneproviders.ResolutionOutcomeError:
		return outcome
	default:
		return "error"
	}
}

func boundedMediaPlaneFailureClass(failureClass string) string {
	switch failureClass {
	case "none", "unknown_provider", "invalid_mode", "missing_provider_config", "invalid_provider_config", "adapter_unavailable", "unknown":
		return failureClass
	default:
		return "unknown"
	}
}
