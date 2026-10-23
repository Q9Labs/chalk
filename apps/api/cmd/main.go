package main

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"

	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/q9labs/chalk/apps/api/db/migrations"
	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	lambdawaker "github.com/q9labs/chalk/apps/api/internal/adapters/aws/lambdawaker"
	recordingkms "github.com/q9labs/chalk/apps/api/internal/adapters/aws/recordingkms"
	r2adapter "github.com/q9labs/chalk/apps/api/internal/adapters/cloudflare/r2"
	sfuadapter "github.com/q9labs/chalk/apps/api/internal/adapters/cloudflare/sfu"
	"github.com/q9labs/chalk/apps/api/internal/adapters/discordreports"
	mediaplaneprovideradapter "github.com/q9labs/chalk/apps/api/internal/adapters/mediaplaneproviders"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	postgressqlc "github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	redisadapter "github.com/q9labs/chalk/apps/api/internal/adapters/redis"
	"github.com/q9labs/chalk/apps/api/internal/apikeys"

	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/captureproviders"
	"github.com/q9labs/chalk/apps/api/internal/capturesignaling"
	"github.com/q9labs/chalk/apps/api/internal/chatattachments"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/mediaplaneproviders"
	"github.com/q9labs/chalk/apps/api/internal/mediapublications"
	"github.com/q9labs/chalk/apps/api/internal/memberships"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/problemreports"
	"github.com/q9labs/chalk/apps/api/internal/providerbridge"
	"github.com/q9labs/chalk/apps/api/internal/providerbridgeserver"
	"github.com/q9labs/chalk/apps/api/internal/publicinviteapp"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/recorderhealth"
	"github.com/q9labs/chalk/apps/api/internal/recordingkeys"
	"github.com/q9labs/chalk/apps/api/internal/recordinglifecycle"
	"github.com/q9labs/chalk/apps/api/internal/recordingobjects"
	"github.com/q9labs/chalk/apps/api/internal/recordingorchestrator"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/recordingpreparation"
	"github.com/q9labs/chalk/apps/api/internal/recordingpresentation"
	"github.com/q9labs/chalk/apps/api/internal/recordingrender"
	"github.com/q9labs/chalk/apps/api/internal/recordings"
	"github.com/q9labs/chalk/apps/api/internal/spaces"

	"github.com/q9labs/chalk/apps/api/internal/syncidentity"
	"github.com/q9labs/chalk/apps/api/internal/synctokens"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/webhooks"
	"github.com/q9labs/chalk/apps/api/internal/whiteboardfiles"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
	goredis "github.com/redis/go-redis/v9"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "api: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}
	reportAdapter, err := discordreports.NewAdapter(cfg.ProblemReportsDiscordWebhookURL)
	if err != nil {
		return fmt.Errorf("configure CHALK_PROBLEM_REPORTS_DISCORD_WEBHOOK_URL: %w", err)
	}
	telemetry, err := observability.Start(context.Background(), observability.Config{
		Environment:  cfg.Observability.Environment,
		OTLPEndpoint: cfg.Observability.OTLPEndpoint,
		OTLPInsecure: cfg.Observability.OTLPInsecure,
		Service:      cfg.Observability.Service,
		Version:      cfg.Observability.Version,
	})
	if err != nil {
		return fmt.Errorf("start telemetry: %w", err)
	}
	defer func() {
		shutdownCtx, cancel := observability.TelemetryShutdownContext()
		defer cancel()
		if err := telemetry.Shutdown(shutdownCtx); err != nil {
			fmt.Fprintf(os.Stderr, "api: shutdown telemetry: %v\n", err)
		}
	}()

	diagnostics := observability.New(observability.Config{
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
	logger := diagnostics.Logger()
	slog.SetDefault(logger)
	launchTelemetry := observability.NewLaunchTelemetry(logger)
	logger.Info("api starting",
		"event", "api.starting",
		"address", cfg.API.Address,
		"log_format", cfg.Observability.LogFormat,
		"log_level", cfg.Observability.LogLevel,
		"otlp_endpoint_configured", cfg.Observability.OTLPEndpoint != "",
		"operation_logs", cfg.Observability.OperationLogs,
		"profiler", cfg.Observability.Profiler,
		"request_logs", cfg.Observability.RequestLogs,
		"recording_enabled", cfg.Capabilities.Recording,
		"transcription_enabled", cfg.Capabilities.Transcription,
	)

	pool, err := postgres.Open(context.Background(), cfg.Database)
	if err != nil {
		return fmt.Errorf("open postgres: %w", err)
	}
	defer pool.Close()
	logger.Info("postgres connected", "event", "postgres.connected")

	queries := postgressqlc.New(pool)
	operationQueries := diagnostics.Queries(queries)
	var redisClient *goredis.Client
	needsRedis := cfg.Transcription.WorkloadAuthSecret != "" || cfg.Observability.Environment != config.DefaultEnvironment
	if needsRedis {
		redisClient, err = redisadapter.Open(cfg.Redis.URL)
		if err != nil {
			return fmt.Errorf("open redis: %w", err)
		}
		defer redisClient.Close()
		logger.Info("redis connected", "event", "redis.connected")
	}
	apiKeyRepository := postgres.NewAPIKeyRepository(operationQueries, pool, diagnostics.Queries)
	apiKeyService := apikeys.NewService(apiKeyRepository, apikeys.Config{Telemetry: launchTelemetry})
	tenantRepository := postgres.NewTenantRepository(operationQueries)
	tenantService := tenants.NewService(tenantRepository)
	publicInviteConfig, err := resolvePublicInviteConfig(context.Background(), cfg, tenantService)
	if err != nil {
		return fmt.Errorf("configure public invite defaults: %w", err)
	}
	if publicInviteConfig.Enabled {
		managedTenantID, err := utilities.ParseID(publicInviteConfig.ManagedTenantID)
		if err != nil {
			return fmt.Errorf("configure managed public Tenant limits exemption: %w", err)
		}
		cfg.TenantLimits.ManagedPublicTenantID = managedTenantID
	}
	membershipRepository := postgres.NewMembershipRepository(operationQueries, pool, diagnostics.Queries)
	membershipService := memberships.NewService(membershipRepository)
	if cfg.Observability.OperationLogs {

	}

	spaceRepository := postgres.NewSpaceRepository(operationQueries, pool)
	spaceService := spaces.NewServiceWithDefaultProvider(spaceRepository, cfg.DefaultMediaPlane)
	episodeMediaBindingResolver := mediaplaneprovideradapter.NewRegistry(mediaplaneprovideradapter.Config{ProcessConfig: cfg.CloudflareRealtime, DefaultProvider: cfg.DefaultMediaPlane})
	episodeRepository := postgres.NewEpisodeLifecycleRepositoryWithMediaBinding(pool, episodeMediaBindingResolver).WithTenantLimits(cfg.TenantLimits)
	episodeService := episodes.NewService(episodeRepository)
	var syncTokenService httpapi.SyncTokenIssuer
	var syncTokenRefresh httpapi.SyncTokenRefreshIssuer
	var participantMediaIssuer httpapi.ParticipantMediaIssuer

	var participantMediaVerifier httpapi.ParticipantMediaVerifier
	var participantMediaRecoveryVerifier publicinviteapp.MediaProofRecoveryVerifier
	var syncParticipantVerifier synctokens.Verifier
	var syncParticipantVerifierConfigured bool
	participantActiveAuthorizer := accessgrants.NewActiveAuthorizer(episodeRepository)
	if len(cfg.SyncToken.PrivateKey) > 0 {
		service, err := synctokens.NewService(synctokens.Config{
			Issuer: cfg.SyncToken.Issuer, Audience: cfg.SyncToken.Audience,
			KeyID: cfg.SyncToken.KeyID, PrivateKey: cfg.SyncToken.PrivateKey,
		})
		if err != nil {
			return fmt.Errorf("configure sync token issuer: %w", err)
		}
		broker := synctokens.NewBroker(episodeRepository, service)
		syncTokenService = broker
		syncTokenRefresh = broker
		syncParticipantVerifier, err = synctokens.NewVerifier(synctokens.VerifierConfig{
			Issuer: cfg.SyncToken.Issuer, Audience: cfg.SyncToken.Audience,
			VerificationKeys: cfg.SyncToken.VerificationKeys,
		})
		if err != nil {
			return fmt.Errorf("configure Sync participant verifier: %w", err)
		}
		syncParticipantVerifierConfigured = true
		mediaIssuer, err := accessgrants.NewIssuer(accessgrants.IssuerConfig{
			Issuer: cfg.SyncToken.Issuer, KeyID: cfg.SyncToken.KeyID, PrivateKey: cfg.SyncToken.PrivateKey,
		})
		if err != nil {
			return fmt.Errorf("configure participant media issuer: %w", err)
		}
		mediaVerifier, err := accessgrants.NewVerifier(accessgrants.VerifierConfig{
			Issuer: cfg.SyncToken.Issuer, VerificationKeys: cfg.SyncToken.VerificationKeys,
		})
		if err != nil {
			return fmt.Errorf("configure participant media verifier: %w", err)
		}
		participantMediaIssuer = observability.InstrumentAccessGrantIssuer(mediaIssuer, launchTelemetry)
		instrumentedMediaVerifier := observability.InstrumentParticipantMediaVerifier(mediaVerifier, launchTelemetry)
		participantMediaVerifier = instrumentedMediaVerifier
		participantMediaRecoveryVerifier = instrumentedMediaVerifier
	}
	recordingRepository := postgres.NewRecordingRepository(operationQueries)
	recordingService := recordings.NewService(recordingRepository)
	recordingPipelineRepository := postgres.NewRecordingPipelineRepositoryWithQueriesAndTransactor(operationQueries, pool, diagnostics.Queries).WithTenantLimits(cfg.TenantLimits)
	recordingPipelineRepository = recordingPipelineRepository.WithTranscriptionEnabled(cfg.Capabilities.Transcription)
	recordingPipelineRepository = recordingPipelineRepository.WithRecordingBundleV2Enabled(cfg.RecordingBundleV2Enabled)
	if cfg.Capabilities.Recording {
		profile, err := recordingpresentation.NewComposite720PProfile()
		if err != nil {
			return fmt.Errorf("configure recording presentation profile: %w", err)
		}
		recordingPipelineRepository, err = recordingPipelineRepository.WithRecordingPresentationProfile(profile)
		if err != nil {
			return fmt.Errorf("configure recording presentation profile: %w", err)
		}
	}
	recordingCapturePlanRepository := postgres.NewRecordingCapturePlanRepositoryWithTransactor(pool, diagnostics.Queries)
	recordingCapturePlanService := captureplan.NewService(recordingCapturePlanRepository)
	var managedSFU sfuadapter.Adapter
	if cfg.DefaultMediaPlane == spaces.MediaPlaneProviderCloudflareSFU || cfg.ProviderBridge.Enabled {
		managedSFU, err = sfuadapter.NewAdapter(cfg.CloudflareRealtime)
		if err != nil {
			return fmt.Errorf("configure Cloudflare SFU adapter: %w", err)
		}
	}
	var recorderWorkerVerifier httpapi.RecorderWorkerVerifier
	var recorderFleetController httpapi.RecorderFleetControllerService
	var recorderFleetWorker httpapi.RecorderFleetWorkerService
	var recorderFleetVerifier httpapi.RecorderFleetControllerVerifier
	var recorderCaptureSignaling httpapi.RecorderCaptureSignalingService
	var recorderRecordingKeys httpapi.RecorderRecordingKeyService
	var recorderRecordingObjects httpapi.RecorderRecordingObjectService
	var recorderRecordingLifecycle httpapi.RecorderRecordingLifecycleService
	var recorderRenderAuthority httpapi.RecorderRenderAuthorityService
	var recordingKMS recordingkeys.KMS
	var recordingDispatcherWake recordingrender.DispatcherWake
	if cfg.Capabilities.Recording {
		if !cfg.ProviderBridge.Enabled {
			return errors.New("recording worker boundary requires the private provider bridge configuration")
		}
		verifier, err := workeridentity.NewVerifier(cfg.ProviderBridge.SPIFFETrustDomain, cfg.Observability.Environment)
		if err != nil {
			return fmt.Errorf("configure recorder worker identity: %w", err)
		}
		fleet, err := newRecorderFleetComponents(cfg, operationQueries, verifier)
		if err != nil {
			return err
		}
		recorderWorkerVerifier = fleet.workerVerifier
		recorderFleetController = fleet.service
		recorderFleetWorker = fleet.service
		recorderFleetVerifier = fleet.controllerVerifier
		managedBinding, err := mediaplane.NewBinding(string(spaces.MediaPlaneProviderCloudflareSFU), mediaplane.BindingSourceDeploymentDefault, cfg.CloudflareRealtime.RealtimeAppID)
		if err != nil {
			return fmt.Errorf("configure recording application identity: %w", err)
		}
		captureProviderRegistry, err := captureproviders.NewRegistry(postgres.NewRecordingCaptureBindingSource(operationQueries), captureproviders.Registration{
			Provider: managedBinding.Provider, AdapterFingerprint: managedBinding.AdapterFingerprint, Plane: managedSFU,
		})
		if err != nil {
			return fmt.Errorf("configure recording provider registry: %w", err)
		}
		captureSignalingRepository := postgres.NewRecordingCaptureSignalingRepositoryWithTransactor(pool, diagnostics.Queries)
		captureSignalingService, err := capturesignaling.NewService(captureSignalingRepository, captureProviderRegistry, capturesignaling.Options{
			Retirer: recordingCapturePlanRepository,
			OnRetired: func(ctx context.Context, command capturesignaling.Command, count int) {
				logger.InfoContext(ctx, "capture publications retired", "event", "recording.capture_publications_retired", "tenant_id", command.Authority.TenantID.String(),
					"episode_id", command.Authority.EpisodeID.String(), "recording_id", command.Authority.RecordingID.String(),
					"capture_epoch", command.Authority.CaptureEpoch, "plan_revision", command.Identity.PlanRevision,
					"publication_count", count)
			},
		})
		if err != nil {
			return fmt.Errorf("configure recorder capture signaling: %w", err)
		}
		recorderCaptureSignaling = observability.NewObservedCaptureSignalingExecutor(captureSignalingService)
	}
	var transcriptService transcripts.Service

	mediaPlaneRegistry := mediaplaneprovideradapter.NewRegistry(mediaplaneprovideradapter.Config{
		ProcessConfig:   cfg.CloudflareRealtime,
		DefaultProvider: cfg.DefaultMediaPlane,
		Telemetry:       observability.NewMediaPlaneResolutionTelemetry(logger),
	})
	providerOperationRepository := postgres.NewProviderOperationRepositoryWithPool(pool)
	mediaPublicationService := mediapublications.NewService(providerOperationRepository)
	var providerBridgeServer *providerbridgeserver.Server
	var recordingDownloads httpapi.RecordingDownloadService
	var recordingObjects httpapi.RecordingObjectService
	var recordingStorage *objectstorage.Service
	var transcriptionStorage *objectstorage.Service
	var chatAttachmentService httpapi.ChatAttachmentService
	var chatParticipantVerifier httpapi.ChatParticipantVerifier
	var chatCleanupScheduler *chatattachments.CleanupScheduler
	var recordingSourceCleanupScheduler *transcripts.LocalCleanupScheduler
	var whiteboardFileService httpapi.WhiteboardFileService
	var whiteboardParticipantVerifier httpapi.WhiteboardParticipantVerifier
	var whiteboardCleanupScheduler *whiteboardfiles.CleanupScheduler
	if r2Configured(cfg.R2) {
		store, err := r2adapter.NewStore(cfg.R2)
		if err != nil {
			return fmt.Errorf("configure r2 object storage: %w", err)
		}
		storage := objectstorage.NewService(store)
		recordingStorage = &storage
		recordingDownloads = storage
		recordingObjects = storage
		transcriptionStorage = &storage
		chatRepository := postgres.NewChatAttachmentRepository(pool)
		chatCleanupWorker := chatattachments.NewCleanupWorker(chatRepository, storage)
		chatCleanupScheduler = chatattachments.NewCleanupScheduler(chatCleanupWorker, 0, logger)
		if syncParticipantVerifierConfigured {
			chatService := chatattachments.NewService(chatRepository, storage)
			chatVerifier := chatattachments.NewParticipantVerifier(syncParticipantVerifier)
			chatAttachmentService = chatService
			chatParticipantVerifier = chatVerifier
		}
		if cfg.Capabilities.WhiteboardFiles {
			whiteboardRepository := postgres.NewWhiteboardFileRepository(pool)
			whiteboardCleanupWorker := whiteboardfiles.NewCleanupWorker(whiteboardRepository, storage)
			whiteboardCleanupScheduler = whiteboardfiles.NewCleanupScheduler(whiteboardCleanupWorker, 0, logger)
			if syncParticipantVerifierConfigured {
				service := whiteboardfiles.NewService(whiteboardRepository, storage)
				verifier := whiteboardfiles.NewParticipantVerifier(syncParticipantVerifier)
				whiteboardFileService = service
				whiteboardParticipantVerifier = verifier
			}
		}
	}
	if cfg.Capabilities.Recording {
		if recordingStorage == nil {
			return errors.New("recording authority requires configured R2 object storage")
		}
		presentationFreezer, err := recordingpresentation.NewFreezer(postgres.NewRecordingPresentationCompletionSourceRepository(operationQueries), *recordingStorage)
		if err != nil {
			return fmt.Errorf("configure recording presentation freezer: %w", err)
		}
		recordingPipelineRepository = recordingPipelineRepository.WithRecordingPresentationFreezer(presentationFreezer)
		kmsStore, err := recordingkms.NewStore(context.Background(), recordingkms.Config{KeyID: cfg.RecordingKMS.KeyID, Region: cfg.RecordingKMS.Region, RequestTimeout: cfg.RecordingKMS.RequestTimeout})
		if err != nil {
			return fmt.Errorf("configure recording KMS: %w", err)
		}
		recordingKMS = kmsStore
		keyService, err := recordingkeys.NewService(kmsStore, postgres.NewRecordingKeyRepository(operationQueries), recordingkeys.Config{Environment: cfg.Observability.Environment, KeyID: cfg.RecordingKMS.KeyID})
		if err != nil {
			return fmt.Errorf("configure recording key authority: %w", err)
		}
		objectService, err := recordingobjects.NewService(*recordingStorage, postgres.NewRecordingObjectRepository(operationQueries), recordingobjects.Config{})
		if err != nil {
			return fmt.Errorf("configure recording object authority: %w", err)
		}
		recorderRecordingKeys = keyService
		recorderRecordingObjects = objectService
		lifecycleService, err := recordinglifecycle.NewService(postgres.NewRecordingLifecycleRepository(pool), time.Now)
		if err != nil {
			return fmt.Errorf("configure recording capture lifecycle authority: %w", err)
		}
		recorderRecordingLifecycle = lifecycleService
	}
	recordingPipelineService := recordingpipeline.NewService(recordingPipelineRepository)
	var recordingPreparationService httpapi.RecordingPreparationService
	var recordingEntrance httpapi.RecordingEntrancePreparer
	if cfg.Capabilities.Recording {
		recordingEntrance = postgres.NewRecordingPreparationRepository(pool)
		recordingPreparationService = recordingpreparation.NewService(postgres.NewRecordingPreparationRepository(pool), spaceService)
	}
	recorderHealthService := recorderhealth.NewService(recordingPipelineRepository, 2*time.Minute)
	webhookProtector, err := webhooks.NewAESGCMKeyring(cfg.Webhooks.CurrentKeyVersion, cfg.Webhooks.EncryptionKeys)
	if err != nil {
		return fmt.Errorf("configure webhook encryption: %w", err)
	}
	webhookRepository := postgres.NewWebhookRepository(pool, webhookProtector)
	webhookService := webhooks.NewService(webhookRepository, webhookProtector)
	tenantAuthz := authorization.NewTenantPolicy(membershipRepository, tenantRepository)
	rateLimitOptions := httpapi.DefaultRateLimitOptions()
	rateLimitOptions.DisableAuthenticated = cfg.API.DisableAuthenticatedRateLimits
	rateLimitOptions.ClientIP.TrustedProxyCIDRs = cfg.API.TrustedProxyCIDRs
	if cfg.Observability.Environment != config.DefaultEnvironment {
		rateLimitOptions.Limiter = redisadapter.NewRateLimiter(redisClient)
	}

	// The durable cleanup queue also owns Recording source expiry. Construct it
	// for Recording-only deployments so turning ASR off cannot strand capture
	// inputs past their immutable retention deadline.
	if cfg.Capabilities.Recording || cfg.Capabilities.Transcription {
		transcriptRepository := postgres.NewTranscriptRepositoryWithPool(operationQueries, pool)
		transcriptService = transcripts.NewService(transcriptRepository)
	}
	var transcriptArtifacts httpapi.TranscriptArtifactService
	var transcriptWorker httpapi.TranscriptWorkerService
	var workloadAuthorizer httpapi.WorkloadAuthorizer
	var transcriptionAuthority *transcriptionObjectAuthority
	if cfg.Capabilities.Transcription {
		if redisClient == nil || transcriptionStorage == nil {
			return errors.New("transcription workload auth requires Redis and R2")
		}
		waker, err := lambdawaker.New(context.Background(), cfg.Transcription.DispatcherFunction, cfg.RecordingKMS.Region, logger)
		if err != nil {
			return fmt.Errorf("configure transcription dispatcher wake (%s): %w", config.RecordingKMSRegion, err)
		}
		transcriptService = transcriptService.WithDispatcherWaker(waker)
		recordingDispatcherWake = func(ctx context.Context, jobID utilities.ID) {
			waker.Wake(ctx, transcripts.DispatcherWakeInput{JobID: jobID})
		}
		authority := transcriptionObjectAuthority{storage: *transcriptionStorage}
		transcriptionAuthority = &authority
		nonces := redisadapter.NewWorkloadNonceStore(redisClient)
		authorizer := httpapi.NewHMACWorkloadAuthorizer(httpapi.HMACWorkloadAuthorizerConfig{
			Secret:      []byte(cfg.Transcription.WorkloadAuthSecret),
			Environment: cfg.Observability.Environment,
			ReleaseID:   cfg.Observability.Version,
			Audience:    cfg.Transcription.ControlAudience,
			Nonces:      nonces,
		})
		transcriptArtifacts = transcriptService
		transcriptWorker = transcriptService
		workloadAuthorizer = authorizer
	}
	if cfg.Capabilities.Recording && !cfg.Capabilities.Transcription {
		if recordingStorage == nil {
			return errors.New("recording source cleanup requires configured R2 object storage")
		}
		worker := transcripts.NewLocalCleanupWorker(transcriptService, *recordingStorage)
		recordingSourceCleanupScheduler = transcripts.NewLocalCleanupScheduler(worker, 0, logger)
	}
	if cfg.Capabilities.Recording {
		renderService, err := recordingrender.NewService(*recordingStorage, recordingKMS, postgres.NewRecordingRenderRepositoryWithPool(pool, cfg.Capabilities.Transcription), recordingrender.Config{
			KeyID: cfg.RecordingKMS.KeyID, Wake: recordingDispatcherWake,
		})
		if err != nil {
			return fmt.Errorf("configure recording render authority: %w", err)
		}
		recorderRenderAuthority = renderService
	}
	if publicInviteConfig.Enabled && (syncTokenRefresh == nil || participantMediaIssuer == nil) {
		if cfg.Observability.Environment != config.DefaultEnvironment {
			return errors.New("public invite credentials are required outside local environments")
		}
		publicInviteConfig.Enabled = false
		logger.Info("public invite routes disabled because local media credentials are not configured", "event", "public_invite.disabled", "reason", "local_credentials_unavailable")
	}
	var publicInviteService httpapi.PublicInviteService
	var reportCredentials problemreports.CredentialSource
	var entranceInvites httpapi.EntranceInviteResolver
	var publicInviteLifecycleScheduler *publicinvites.LifecycleScheduler
	if publicInviteConfig.Enabled {
		managedTenantID, err := utilities.ParseID(publicInviteConfig.ManagedTenantID)
		if err != nil {
			return fmt.Errorf("parse public invite managed Tenant ID: %w", err)
		}
		signer, err := publicinvites.NewSigner(publicinvites.Keyring{
			CurrentKeyID: publicInviteConfig.KeyID,
			Signer:       publicInviteConfig.PrivateKey,
			Verifiers:    publicInviteConfig.VerificationKeys,
		})
		if err != nil {
			return fmt.Errorf("configure cspi1 public invite keyring: %w", err)
		}
		publicInviteRepository := postgres.NewPublicInviteRepositoryWithPool(pool).WithEpisodeLifecycle(episodeRepository)
		service, err := publicinvites.NewServiceWithLifecycle(publicInviteRepository, publicInviteRepository, signer)
		if err != nil {
			return fmt.Errorf("configure public invite service: %w", err)
		}
		entranceInvites = service
		spacePort, err := publicinviteapp.NewSpacePort(spaceService, tenantService, publicinviteapp.SpaceConfig{
			ManagedTenantID:   managedTenantID,
			DefaultMediaPlane: publicInviteConfig.DefaultMediaPlane,
		})
		if err != nil {
			return fmt.Errorf("configure public invite Space port: %w", err)
		}
		accessPort, err := publicinviteapp.NewAccessPort(publicinviteapp.AccessConfig{
			Episodes:           episodeService,
			Spaces:             spaceService,
			Tenants:            tenantService,
			MediaResolver:      mediaPlaneRegistry,
			SyncTokens:         syncTokenRefresh,
			MediaTokens:        participantMediaIssuer,
			MediaProof:         participantMediaVerifier,
			MediaProofRecovery: participantMediaRecoveryVerifier,
		})
		if err != nil {
			return fmt.Errorf("configure public invite access port: %w", err)
		}
		accountsPort, err := publicinviteapp.NewAccountsPort(tenantAuthz)
		if err != nil {
			return fmt.Errorf("configure public invite Accounts port: %w", err)
		}
		linksPort, err := publicinviteapp.NewLinkPort(publicInviteConfig.WebOrigin)
		if err != nil {
			return fmt.Errorf("configure public invite link port: %w", err)
		}
		runtime, err := publicinvites.NewRuntimeWithConfig(service, spacePort, publicInviteRepository, accessPort, accountsPort, linksPort, publicinvites.RuntimeConfig{
			AutoLifecycleLifetime: publicInviteConfig.AutoLifecycleLifetime,
		})
		if err != nil {
			return fmt.Errorf("configure public invite runtime: %w", err)
		}
		publicInviteService = runtime
		reportCredentials = publicinviteapp.ReportCredentials{Service: service}
		lifecycleActions, err := publicinviteapp.NewLifecycleActions(episodeService, spaceService)
		if err != nil {
			return fmt.Errorf("configure public invite lifecycle actions: %w", err)
		}
		lifecycleWorker, err := publicinvites.NewLifecycleWorkerWithBatch(publicInviteRepository, lifecycleActions, publicInviteConfig.SchedulerBatch)
		if err != nil {
			return fmt.Errorf("configure public invite lifecycle worker: %w", err)
		}
		publicInviteLifecycleScheduler = publicinvites.NewLifecycleScheduler(lifecycleWorker, publicInviteConfig.SchedulerInterval, logger)
	}
	var reportSender problemreports.Sender
	if reportAdapter != nil {
		reportSender = reportAdapter
	}
	routerOptions := httpapi.Options{
		RecorderWorkerLogger: logger,
		Capabilities: httpapi.CapabilityStatus{
			Recording:     cfg.Capabilities.Recording,
			Transcription: cfg.Capabilities.Transcription,
		},
		CORS: httpapi.CORSOptions{
			AllowedOrigins: cfg.API.CORSAllowedOrigins,
			TenantOrigins:  tenantService,
		},
		LocalSystemToken: cfg.API.LocalSystemToken,
		ServicePrincipal: cfg.API.ServicePrincipal,

		RateLimit:            rateLimitOptions,
		Readiness:            postgres.Readiness{Pool: pool, RequiredMigration: migrations.LatestVersion},
		APIKeys:              apiKeyService,
		APIKeyAuthentication: apiKeyService,

		MediaPlane:             mediaPlaneRegistry,
		MediaPublications:      mediaPublicationService,
		ParticipantMediaIssuer: participantMediaIssuer,

		ProblemReports:         problemreports.NewService(postgres.NewProblemReportRepository(pool), reportSender).WithCredentials(reportCredentials),
		ParticipantMediaVerify: participantMediaVerifier,
		ParticipantMediaActive: participantActiveAuthorizer,
		ParticipantGeneration:  participantActiveAuthorizer,
		Memberships:            membershipService,

		RecordingDownloads:         recordingDownloads,
		RecordingObjects:           recordingObjects,
		RecorderHealth:             recorderHealthService,
		RecorderWorker:             recordingPipelineService,
		RecorderCapturePlans:       recordingCapturePlanService,
		RecorderCaptureSignaling:   recorderCaptureSignaling,
		RecorderRecordingKeys:      recorderRecordingKeys,
		RecorderRecordingObjects:   recorderRecordingObjects,
		RecorderRecordingLifecycle: recorderRecordingLifecycle,
		RecorderRenderAuthority:    recorderRenderAuthority,
		RecorderFleetController:    recorderFleetController,
		RecorderFleetWorker:        recorderFleetWorker,
		RecorderFleetVerifier:      recorderFleetVerifier,
		RecorderFleetEnvironment:   cfg.Observability.Environment,
		RecorderWorkerVerifier:     recorderWorkerVerifier,
		Recordings:                 recordingService,
		RecordingExports:           recordingPipelineService,
		RecordingPreparations:      recordingPreparationService,
		RecordingEntrance:          recordingEntrance,
		EntranceInvites:            entranceInvites,
		Spaces:                     spaceService,
		Episodes:                   episodeService,
		SyncTokens:                 syncTokenService,
		SyncTokenRefresh:           syncTokenRefresh,
		TenantAuthz:                tenantAuthz,
		Tenants:                    tenantService,
		// Synchronous application-node provider calls are intentionally absent.
		// Transcription work is claimed and fenced through the internal worker
		// boundary after the request transaction commits.
		Transcripts:            transcriptService,
		TranscriptArtifacts:    transcriptArtifacts,
		TranscriptWorker:       transcriptWorker,
		WorkloadAuthorizer:     workloadAuthorizer,
		ChunkAuthority:         transcriptionAuthority,
		ManifestAuthority:      transcriptionAuthority,
		ResultAuthority:        transcriptionAuthority,
		CleanupWorker:          transcriptService,
		CleanupDeleteAuthority: transcriptionAuthority,
		FinalizerWorker:        transcriptService,
		FinalizerAuthority:     transcriptionAuthority,

		Webhooks:               webhookService,
		ChatAttachments:        chatAttachmentService,
		ChatParticipants:       chatParticipantVerifier,
		WhiteboardFiles:        whiteboardFileService,
		WhiteboardParticipants: whiteboardParticipantVerifier,
		PublicInvites:          publicInviteService,
	}
	applyCapabilityProfile(&routerOptions, cfg.Capabilities)
	routerOptions.ApplyDiagnostics(diagnostics)

	if cfg.ProviderBridge.Enabled {
		recordingController := recordingorchestrator.NewController(recordingPipelineService)
		executor := providerbridge.NewSFUExecutor(mediaPublicationService, managedSFU, recordingController)
		providerBridgeService := providerbridge.NewService(providerOperationRepository, executor)
		verifier, err := syncidentity.NewVerifier(cfg.ProviderBridge.SPIFFETrustDomain, cfg.Observability.Environment)
		if err != nil {
			return fmt.Errorf("configure provider bridge Sync identity: %w", err)
		}
		providerBridgeHandler := httpapi.NewProviderBridgeHandler(providerBridgeService, verifier)
		privateWorkerHandler := diagnostics.WrapHTTP(httpapi.NewPrivateWorkerRouter(providerBridgeHandler, routerOptions))
		providerBridgeServer, err = providerbridgeserver.New(cfg.ProviderBridge, privateWorkerHandler)
		if err != nil {
			return fmt.Errorf("configure provider bridge listener: %w", err)
		}
	}

	handler := httpapi.NewRouter(routerOptions)

	server := &http.Server{
		Addr:              cfg.API.Address,
		Handler:           handler,
		ReadTimeout:       15 * time.Second,
		ReadHeaderTimeout: 5 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}

	signalCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	dispatcherOwner, err := utilities.NewID()
	if err != nil {
		return fmt.Errorf("create webhook dispatcher owner: %w", err)
	}
	dispatcher := webhooks.NewDispatcher(postgres.NewWebhookDispatchRepository(pool), webhookProtector, webhooks.NewDeliveryClient(nil), dispatcherOwner.String(), logger)
	dispatcherErr := make(chan error, 1)
	go func() { dispatcherErr <- dispatcher.Run(signalCtx) }()
	deadlineScheduler := episodes.NewDeadlineScheduler(episodeRepository, cfg.DeadlineScheduler.Interval, cfg.DeadlineScheduler.Batch)
	deadlineSchedulerErr := make(chan error, 1)
	go func() { deadlineSchedulerErr <- deadlineScheduler.Run(signalCtx) }()
	var recordingMaintenanceErr <-chan error
	if cfg.Capabilities.Recording {
		maintenanceErr := make(chan error, 1)
		recordingMaintenanceErr = maintenanceErr
		go func() {
			maintenanceErr <- recordingPipelineService.RunMaintenance(signalCtx, recordingpipeline.DefaultMaintenanceInterval)
		}()
	}

	var whiteboardCleanupErr <-chan error
	if whiteboardCleanupScheduler != nil {
		cleanupErr := make(chan error, 1)
		whiteboardCleanupErr = cleanupErr
		go func() { cleanupErr <- whiteboardCleanupScheduler.Run(signalCtx) }()
	}
	var chatCleanupErr <-chan error
	if chatCleanupScheduler != nil {
		cleanupErr := make(chan error, 1)
		chatCleanupErr = cleanupErr
		go func() { cleanupErr <- chatCleanupScheduler.Run(signalCtx) }()
	}
	var recordingSourceCleanupErr <-chan error
	if recordingSourceCleanupScheduler != nil {
		cleanupErr := make(chan error, 1)
		recordingSourceCleanupErr = cleanupErr
		go func() { cleanupErr <- recordingSourceCleanupScheduler.Run(signalCtx) }()
	}
	var publicInviteLifecycleErr <-chan error
	if publicInviteLifecycleScheduler != nil {
		lifecycleErr := make(chan error, 1)
		publicInviteLifecycleErr = lifecycleErr
		go func() { lifecycleErr <- publicInviteLifecycleScheduler.Run(signalCtx) }()
	}
	var providerBridgeErr <-chan error
	if providerBridgeServer != nil {
		providerBridgeErr, err = providerBridgeServer.Start()
		if err != nil {
			return fmt.Errorf("start provider bridge listener: %w", err)
		}
		logger.Info("provider bridge listening", "event", "provider_bridge.listening", "address", providerBridgeServer.Address())
	}

	serverErr := make(chan error, 1)
	go func() {
		logger.Info("api listening", "event", "api.listening", "address", cfg.API.Address)

		err := server.ListenAndServe()
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("api listen failed", "event", "api.listen_failed", "error", err.Error())
			serverErr <- err
			return
		}

		serverErr <- nil
	}()

	var runErr error
	serverResultReceived := false
	providerBridgeResultReceived := false
	chatCleanupResultReceived := false
	recordingSourceCleanupResultReceived := false
	publicInviteLifecycleResultReceived := false

	whiteboardCleanupResultReceived := false
	recordingMaintenanceResultReceived := false
	select {
	case err := <-serverErr:
		runErr = err
		serverResultReceived = true
		stop()
	case err := <-providerBridgeErr:
		runErr = err
		providerBridgeResultReceived = true
		if err != nil {
			logger.Error("provider bridge listen failed", "event", "provider_bridge.listen_failed", "error", err.Error())
		}
		stop()
	case err := <-dispatcherErr:
		runErr = err
		stop()
	case err := <-deadlineSchedulerErr:
		runErr = err
		stop()
	case err := <-recordingMaintenanceErr:
		runErr = err
		recordingMaintenanceResultReceived = true
		stop()

	case err := <-whiteboardCleanupErr:
		runErr = err
		whiteboardCleanupResultReceived = true
		stop()
	case err := <-chatCleanupErr:
		runErr = err
		chatCleanupResultReceived = true
		stop()
	case err := <-recordingSourceCleanupErr:
		runErr = err
		recordingSourceCleanupResultReceived = true
		stop()
	case err := <-publicInviteLifecycleErr:
		runErr = err
		publicInviteLifecycleResultReceived = true
		stop()
	case <-signalCtx.Done():
		stop()
	}

	shutdownStartedAt := time.Now()
	logger.Info("api shutdown requested", "event", "api.shutdown_requested")
	// Allow in-flight synchronous email delivery and its uniform response window
	// to finish before releasing the API dependencies.
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := server.Shutdown(shutdownCtx); err != nil {
		logger.Error("api shutdown failed", "event", "api.shutdown_failed", "error", err.Error())
		return fmt.Errorf("shutdown server: %w", err)
	}
	if providerBridgeServer != nil {
		if err := providerBridgeServer.Shutdown(shutdownCtx); err != nil {
			logger.Error("provider bridge shutdown failed", "event", "provider_bridge.shutdown_failed", "error", err.Error())
			return fmt.Errorf("shutdown provider bridge server: %w", err)
		}
		logger.Info("provider bridge shutdown complete", "event", "provider_bridge.shutdown_complete")
	}

	logger.Info("api shutdown complete",
		"event", "api.shutdown_complete",
		"duration_ms", float64(time.Since(shutdownStartedAt).Microseconds())/1000,
	)
	if !serverResultReceived {
		if err := <-serverErr; runErr == nil {
			runErr = err
		}
	}
	if providerBridgeErr != nil && !providerBridgeResultReceived {
		if err := <-providerBridgeErr; runErr == nil {
			runErr = err
		}
	}
	if whiteboardCleanupErr != nil && !whiteboardCleanupResultReceived {
		if err := <-whiteboardCleanupErr; runErr == nil {
			runErr = err
		}
	}
	if chatCleanupErr != nil && !chatCleanupResultReceived {
		if err := <-chatCleanupErr; runErr == nil {
			runErr = err
		}
	}
	if recordingSourceCleanupErr != nil && !recordingSourceCleanupResultReceived {
		if err := <-recordingSourceCleanupErr; runErr == nil {
			runErr = err
		}
	}
	if publicInviteLifecycleErr != nil && !publicInviteLifecycleResultReceived {
		if err := <-publicInviteLifecycleErr; runErr == nil {
			runErr = err
		}
	}

	if recordingMaintenanceErr != nil && !recordingMaintenanceResultReceived {
		if err := <-recordingMaintenanceErr; runErr == nil {
			runErr = err
		}
	}
	return runErr
}

func r2Configured(cfg config.R2Config) bool {
	return cfg.Bucket != "" || cfg.AccountID != "" || cfg.Endpoint != "" || cfg.AccessKeyID != "" || cfg.SecretAccessKey != ""
}

const (
	localPublicInviteTenantName = "Chalk local public Spaces"
	localPublicInviteKeyID      = "local-cspi1"
	localPublicInviteSeedLabel  = "chalk.local.public_invites.cspi1.v1"
	localPublicInviteWebDefault = "http://127.0.0.1:3070"
)

var errHostedPublicInviteConfigRequired = errors.New("public invite configuration is required outside local environments")

type localPublicInviteTenantService interface {
	CreateTenant(context.Context, tenants.CreateTenantInput) (tenants.Tenant, error)
	ListTenants(context.Context, pagination.PageRequest) (tenants.TenantList, error)
}

func resolvePublicInviteConfig(ctx context.Context, cfg config.Config, tenantService localPublicInviteTenantService) (config.PublicInviteConfig, error) {
	if cfg.Observability.Environment != config.DefaultEnvironment {
		if !cfg.PublicInvite.Enabled {
			return config.PublicInviteConfig{}, errHostedPublicInviteConfigRequired
		}
		return cfg.PublicInvite, nil
	}
	if cfg.PublicInvite.Enabled {
		return cfg.PublicInvite, nil
	}
	if tenantService == nil {
		return config.PublicInviteConfig{}, errors.New("local public invite Tenant service unavailable")
	}
	webOrigin := localPublicInviteWebOrigin(cfg.API.CORSAllowedOrigins)
	managedTenant, err := ensureLocalPublicInviteTenant(ctx, tenantService)
	if err != nil {
		return config.PublicInviteConfig{}, err
	}
	privateKey := localPublicInvitePrivateKey(managedTenant.ID)
	publicKey, ok := privateKey.Public().(ed25519.PublicKey)
	if !ok {
		return config.PublicInviteConfig{}, errors.New("derive local public invite verification key")
	}
	return config.PublicInviteConfig{
		Enabled:               true,
		ManagedTenantID:       managedTenant.ID.String(),
		DefaultMediaPlane:     mediaplaneproviders.SpaceProviderCloudflareSFU,
		WebOrigin:             webOrigin,
		KeyID:                 localPublicInviteKeyID,
		PrivateKey:            privateKey,
		VerificationKeys:      map[string]ed25519.PublicKey{localPublicInviteKeyID: append(ed25519.PublicKey(nil), publicKey...)},
		AutoLifecycleLifetime: time.Duration(config.DefaultPublicInviteAutoLifecycleSeconds) * time.Second,
		SchedulerInterval:     time.Duration(config.DefaultPublicInviteSchedulerIntervalMS) * time.Millisecond,
		SchedulerBatch:        config.DefaultPublicInviteSchedulerBatch,
	}, nil
}

func localPublicInviteWebOrigin(origins []string) string {
	for _, origin := range origins {
		origin = strings.TrimSpace(origin)
		if origin != "" && origin != "*" {
			return origin
		}
	}
	return localPublicInviteWebDefault
}

func ensureLocalPublicInviteTenant(ctx context.Context, tenantService localPublicInviteTenantService) (tenants.Tenant, error) {
	var cursor *pagination.Cursor
	for {
		page, err := pagination.NewPageRequest(pagination.MaxPageSize, cursor)
		if err != nil {
			return tenants.Tenant{}, fmt.Errorf("create local public invite Tenant page: %w", err)
		}
		list, err := tenantService.ListTenants(ctx, page)
		if err != nil {
			return tenants.Tenant{}, fmt.Errorf("list local public invite Tenants: %w", err)
		}
		for _, tenant := range list.Tenants {
			if tenant.Name == localPublicInviteTenantName {
				return tenant, nil
			}
		}
		if !list.Page.HasMore || list.Page.NextCursor == nil {
			break
		}
		cursor = list.Page.NextCursor
	}

	defaultMediaPlane := mediaplaneproviders.SpaceProviderCloudflareSFU
	created, err := tenantService.CreateTenant(ctx, tenants.CreateTenantInput{
		Name:                     localPublicInviteTenantName,
		DefaultMediaPlane:        &defaultMediaPlane,
		MediaPlaneProviderConfig: json.RawMessage(`{"enabled":true,"provider":"cf_sfu","mode":"chalk_managed"}`),
	})
	if err != nil {
		return tenants.Tenant{}, fmt.Errorf("create local public invite Tenant: %w", err)
	}
	return created, nil
}

func localPublicInvitePrivateKey(tenantID utilities.ID) ed25519.PrivateKey {
	bytes := tenantID.Bytes()
	material := make([]byte, 0, len(localPublicInviteSeedLabel)+len(bytes))
	material = append(material, localPublicInviteSeedLabel...)
	material = append(material, bytes[:]...)
	seed := sha256.Sum256(material)
	return ed25519.NewKeyFromSeed(seed[:])
}

func applyCapabilityProfile(options *httpapi.Options, capabilities config.CapabilityConfig) {
	options.Capabilities = httpapi.CapabilityStatus{
		Recording:       capabilities.Recording,
		Transcription:   capabilities.Transcription,
		WhiteboardFiles: capabilities.WhiteboardFiles,
	}
	if !capabilities.Recording {
		options.RecordingDownloads = nil
		options.RecordingObjects = nil
		options.Recordings = nil
		options.RecorderHealth = nil
		options.RecorderWorker = nil
		options.RecorderCapturePlans = nil
		options.RecorderCaptureSignaling = nil
		options.RecorderRecordingKeys = nil
		options.RecorderRecordingObjects = nil
		options.RecorderRecordingLifecycle = nil
		options.RecorderRenderAuthority = nil
		options.RecorderFleetController = nil
		options.RecorderFleetWorker = nil
		options.RecorderFleetVerifier = nil
		options.RecorderFleetEnvironment = ""
		options.RecorderWorkerVerifier = nil
	}
	if !capabilities.WhiteboardFiles {
		options.WhiteboardFiles = nil
		options.WhiteboardParticipants = nil
	}
	if capabilities.Transcription {
		return
	}
	options.Transcripts = nil
	options.TranscriptArtifacts = nil
	options.TranscriptWorker = nil
	options.WorkloadAuthorizer = nil
	options.ChunkAuthority = nil
	options.ManifestAuthority = nil
	options.ResultAuthority = nil
	options.CleanupWorker = nil
	options.CleanupDeleteAuthority = nil
	options.FinalizerWorker = nil
	options.FinalizerAuthority = nil
}
