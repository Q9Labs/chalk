package main

import (
	"fmt"
	"log/slog"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/chalksfu"
	mediaplaneprovideradapter "github.com/q9labs/chalk/apps/api/internal/adapters/mediaplaneproviders"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	postgressqlc "github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	redisadapter "github.com/q9labs/chalk/apps/api/internal/adapters/redis"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/mediapublications"
	"github.com/q9labs/chalk/apps/api/internal/objectcleanup"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/providerbridge"
	"github.com/q9labs/chalk/apps/api/internal/providerbridgeserver"
	"github.com/q9labs/chalk/apps/api/internal/publicinviteapp"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/recordingkeys"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/recordingrender"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/synctokens"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"github.com/q9labs/chalk/apps/api/internal/webhooks"
	goredis "github.com/redis/go-redis/v9"
)

func newDiagnostics(cfg config.Config) observability.Diagnostics {
	return observability.New(observability.Config{
		Environment:          cfg.Observability.Environment,
		LogFormat:            observability.LogFormat(cfg.Observability.LogFormat),
		LogLevel:             cfg.Observability.LogLevel,
		OTLPEndpoint:         cfg.Observability.OTLPEndpoint,
		OTLPInsecure:         cfg.Observability.OTLPInsecure,
		OperationLogs:        cfg.Observability.OperationLogs,
		Profiler:             cfg.Observability.Profiler,
		RequestLogs:          observability.RequestLogMode(cfg.Observability.RequestLogs),
		RequestSampleRate:    cfg.Observability.RequestSampleRate,
		Service:              cfg.Observability.Service,
		SlowRequestThreshold: cfg.Observability.SlowRequestThreshold,
		Version:              cfg.Observability.Version,
	}, os.Stdout)
}

func logStartup(logger *slog.Logger, cfg config.Config) {
	if cfg.PresentingConfigError != "" {
		logger.Error("presenting configuration incomplete", "event", "presenting.config_incomplete", "reason", cfg.PresentingConfigError)
	}
	logger.Info("api starting",
		"event", "api.starting",
		"previous_boot_end", previousBootEnd(os.Getenv("CHALK_PREVIOUS_BOOT_END")),
		"host_boot_id", os.Getenv("CHALK_HOST_BOOT_ID"),
		"address", cfg.API.Address,
		"log_format", cfg.Observability.LogFormat,
		"log_level", cfg.Observability.LogLevel,
		"otlp_endpoint_configured", cfg.Observability.OTLPEndpoint != "",
		"operation_logs", cfg.Observability.OperationLogs,
		"profiler", cfg.Observability.Profiler,
		"request_logs", cfg.Observability.RequestLogs,
		"recording_enabled", cfg.Capabilities.Recording,
		"transcription_enabled", cfg.Capabilities.Transcription,
		"presenting_enabled", cfg.Capabilities.Presenting,
	)
}

func (w *apiWiring) openRedis() error {
	var err error
	needsRedis := w.cfg.Transcription.WorkloadAuthSecret != "" || w.cfg.Observability.Environment != config.DefaultEnvironment
	if needsRedis {
		w.redisClient, err = redisadapter.Open(w.cfg.Redis.URL)
		if err != nil {
			return fmt.Errorf("open redis: %w", err)
		}
		w.logger.Info("redis connected", "event", "redis.connected")
	}
	return nil
}

func (w *apiWiring) wireServices() error {
	if err := w.wireAccountsAndSpaces(); err != nil {
		return err
	}
	if err := w.wireParticipantAccess(); err != nil {
		return err
	}
	if err := w.wireRecordingPipeline(); err != nil {
		return err
	}
	if err := w.wireMediaPlane(); err != nil {
		return err
	}
	if err := w.wireCaptureWorkers(); err != nil {
		return err
	}
	w.providerOperationRepository = postgres.NewProviderOperationRepositoryWithPool(w.pool)
	w.mediaPublicationService = mediapublications.NewService(w.providerOperationRepository)
	if err := w.wireStorage(); err != nil {
		return err
	}
	if err := w.wireRecordingAuthorities(); err != nil {
		return err
	}
	w.wireRecordingServices()
	if err := w.wireWebhookService(); err != nil {
		return err
	}
	w.wireRateLimits()
	if err := w.wireTranscription(); err != nil {
		return err
	}
	if err := w.wireRenderAuthority(); err != nil {
		return err
	}
	return w.wirePublicInvites()
}

// apiWiring holds dependencies shared between startup phases and the server lifetime.
type apiWiring struct {
	cfg             config.Config
	pool            *pgxpool.Pool
	queries         postgressqlc.Querier
	redisClient     *goredis.Client
	diagnostics     observability.Diagnostics
	logger          *slog.Logger
	launchTelemetry *observability.LaunchTelemetry
	evidenceSink    observability.AxiomEvidence
	telemetryLedger postgres.TelemetryLedger

	tenantService                  tenants.Service
	spaceService                   spaces.Service
	episodeService                 episodes.Service
	episodeRepository              postgres.EpisodeLifecycleRepository
	publicInviteConfig             config.PublicInviteConfig
	publicInviteLifecycleScheduler *publicinvites.LifecycleScheduler

	chalkSFU                    *chalksfu.Fleet
	ownCapture                  bool
	chalkNodes                  providerbridge.ChalkNodes
	mediaPlaneTelemetry         observability.MediaPlaneResolutionTelemetry
	episodeMediaBindingResolver mediaplaneprovideradapter.Registry
	mediaPlaneRegistry          mediaplaneprovideradapter.Registry
	providerOperationRepository postgres.ProviderOperationRepository
	mediaPublicationService     mediapublications.Service
	providerBridgeServer        *providerbridgeserver.Server

	participantMediaRecoveryVerifier  publicinviteapp.MediaProofRecoveryVerifier
	syncParticipantVerifier           synctokens.Verifier
	syncParticipantVerifierConfigured bool

	recordingPipelineRepository     postgres.RecordingPipelineRepository
	recordingPipelineService        recordingpipeline.Service
	recordingCapturePlanRepository  postgres.RecordingCapturePlanRepository
	colocatedGrace                  time.Duration
	recordingStorage                *objectstorage.Service
	recordingKMS                    recordingkeys.KMS
	recordingDispatcherWake         recordingrender.DispatcherWake
	recordingSourceCleanupScheduler *transcripts.LocalCleanupScheduler

	chatCleanupScheduler         *objectcleanup.Scheduler
	whiteboardCleanupScheduler   *objectcleanup.Scheduler
	presentingCleanupScheduler   *objectcleanup.Scheduler
	presentingReconcileScheduler *objectcleanup.Scheduler
	webhookProtector             *webhooks.AESGCMProtector
	options                      httpapi.Options
}
