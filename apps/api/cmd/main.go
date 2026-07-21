package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	lambdawaker "github.com/q9labs/chalk/apps/api/internal/adapters/aws/lambdawaker"
	r2adapter "github.com/q9labs/chalk/apps/api/internal/adapters/cloudflare/r2"
	rtkadapter "github.com/q9labs/chalk/apps/api/internal/adapters/cloudflare/rtk"
	sfuadapter "github.com/q9labs/chalk/apps/api/internal/adapters/cloudflare/sfu"
	composioadapter "github.com/q9labs/chalk/apps/api/internal/adapters/composio"
	googleadapter "github.com/q9labs/chalk/apps/api/internal/adapters/google"
	passwordadapter "github.com/q9labs/chalk/apps/api/internal/adapters/password"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	postgressqlc "github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	redisadapter "github.com/q9labs/chalk/apps/api/internal/adapters/redis"
	"github.com/q9labs/chalk/apps/api/internal/apikeys"
	"github.com/q9labs/chalk/apps/api/internal/auditlogs"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/integrations"
	"github.com/q9labs/chalk/apps/api/internal/journeys"
	"github.com/q9labs/chalk/apps/api/internal/mediaplaneproviders"
	"github.com/q9labs/chalk/apps/api/internal/mediapublications"
	"github.com/q9labs/chalk/apps/api/internal/memberships"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/participantaccess"
	"github.com/q9labs/chalk/apps/api/internal/providerbridge"
	"github.com/q9labs/chalk/apps/api/internal/providerbridgeserver"
	"github.com/q9labs/chalk/apps/api/internal/recorderhealth"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/recordings"
	"github.com/q9labs/chalk/apps/api/internal/rooms"
	"github.com/q9labs/chalk/apps/api/internal/sessionlifecycle"
	"github.com/q9labs/chalk/apps/api/internal/syncidentity"
	"github.com/q9labs/chalk/apps/api/internal/synctokens"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"github.com/q9labs/chalk/apps/api/internal/users"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/webhooks"
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
	)

	pool, err := postgres.Open(context.Background(), cfg.Database)
	if err != nil {
		return fmt.Errorf("open postgres: %w", err)
	}
	defer pool.Close()
	logger.Info("postgres connected", "event", "postgres.connected")

	queries := postgressqlc.New(pool)
	operationQueries := diagnostics.Queries(queries)
	authenticationRepository := postgres.NewAuthenticationRepository(operationQueries)
	passwords := passwordadapter.NewBcryptHasher()
	var googleProvider authentication.GoogleProvider
	var oauthStates authentication.OAuthStateStore
	var redisClient *goredis.Client
	needsRedis := cfg.GoogleOAuth.ClientID != "" || cfg.GoogleOAuth.ClientSecret != "" || cfg.Transcription.WorkloadAuthSecret != "" || cfg.Observability.Environment != config.DefaultEnvironment
	if needsRedis {
		redisClient, err = redisadapter.Open(cfg.Redis.URL)
		if err != nil {
			return fmt.Errorf("open redis: %w", err)
		}
		defer redisClient.Close()
		logger.Info("redis connected", "event", "redis.connected")
	}
	if cfg.GoogleOAuth.ClientID != "" || cfg.GoogleOAuth.ClientSecret != "" {
		provider, err := googleadapter.NewProvider(googleadapter.Config{
			ClientID:     cfg.GoogleOAuth.ClientID,
			ClientSecret: cfg.GoogleOAuth.ClientSecret,
			RedirectURL:  cfg.GoogleOAuth.RedirectURL,
		})
		if err != nil {
			return fmt.Errorf("configure google oauth: %w", err)
		}

		googleProvider = provider
		oauthStates = redisadapter.NewOAuthStateStore(redisClient)
	}
	authenticationService := authentication.NewService(authenticationRepository, passwords, googleProvider, oauthStates, authentication.Config{
		RequireEmailVerification: cfg.Auth.EmailVerificationRequired,
		OAuthStateTTL:            cfg.Auth.OAuthStateTTL,
		SessionTTL:               cfg.Auth.SessionTTL,
	})
	apiKeyRepository := postgres.NewAPIKeyRepository(operationQueries, pool, diagnostics.Queries)
	apiKeyService := apikeys.NewService(apiKeyRepository, apikeys.Config{Telemetry: launchTelemetry})
	tenantRepository := postgres.NewTenantRepository(operationQueries)
	tenantService := tenants.NewService(tenantRepository)
	userRepository := postgres.NewUserRepository(operationQueries)
	userService := users.NewService(userRepository)
	membershipRepository := postgres.NewMembershipRepository(operationQueries)
	membershipService := memberships.NewService(membershipRepository)
	roomRepository := postgres.NewRoomRepository(operationQueries, pool)
	roomService := rooms.NewService(roomRepository)
	sessionLifecycleRepository := postgres.NewSessionLifecycleRepository(pool)
	sessionLifecycleService := sessionlifecycle.NewService(sessionLifecycleRepository)
	var syncTokenService httpapi.SyncTokenIssuer
	var syncTokenRefresh httpapi.SyncTokenRefreshIssuer
	var participantMediaIssuer httpapi.ParticipantMediaIssuer
	var participantMediaVerifier httpapi.ParticipantMediaVerifier
	participantActiveAuthorizer := participantaccess.NewActiveAuthorizer(sessionLifecycleRepository)
	if len(cfg.SyncToken.PrivateKey) > 0 {
		service, err := synctokens.NewService(synctokens.Config{
			Issuer: cfg.SyncToken.Issuer, Audience: cfg.SyncToken.Audience,
			KeyID: cfg.SyncToken.KeyID, PrivateKey: cfg.SyncToken.PrivateKey,
		})
		if err != nil {
			return fmt.Errorf("configure sync token issuer: %w", err)
		}
		broker := synctokens.NewBroker(sessionLifecycleRepository, service)
		syncTokenService = broker
		syncTokenRefresh = broker
		mediaIssuer, err := participantaccess.NewIssuer(participantaccess.IssuerConfig{
			Issuer: cfg.SyncToken.Issuer, KeyID: cfg.SyncToken.KeyID, PrivateKey: cfg.SyncToken.PrivateKey,
		})
		if err != nil {
			return fmt.Errorf("configure participant media issuer: %w", err)
		}
		mediaVerifier, err := participantaccess.NewVerifier(participantaccess.VerifierConfig{
			Issuer: cfg.SyncToken.Issuer, VerificationKeys: cfg.SyncToken.VerificationKeys,
		})
		if err != nil {
			return fmt.Errorf("configure participant media verifier: %w", err)
		}
		participantMediaIssuer = observability.InstrumentParticipantAccessIssuer(mediaIssuer, launchTelemetry)
		participantMediaVerifier = observability.InstrumentParticipantMediaVerifier(mediaVerifier, launchTelemetry)
	}
	recordingRepository := postgres.NewRecordingRepository(operationQueries)
	recordingService := recordings.NewService(recordingRepository)
	recordingPipelineRepository := postgres.NewRecordingPipelineRepositoryWithQueriesAndTransactor(operationQueries, pool, diagnostics.Queries)
	recordingPipelineService := recordingpipeline.NewService(recordingPipelineRepository)
	recorderHealthService := recorderhealth.NewService(recordingPipelineRepository, 2*time.Minute)
	transcriptRepository := postgres.NewTranscriptRepositoryWithPool(operationQueries, pool)
	transcriptService := transcripts.NewService(transcriptRepository)
	auditLogRepository := postgres.NewAuditLogRepository(operationQueries)
	auditLogService := auditlogs.NewService(auditLogRepository)
	journeyRepository := postgres.NewJourneyRepository(pool)
	journeyService := journeys.NewService(journeyRepository)
	var meetingCredentials httpapi.MeetingCredentialVerifier
	if cfg.CloudflareRealtime.RTKTokenOrgID != "" {
		verifier, err := rtkadapter.NewCredentialVerifier(cfg.CloudflareRealtime)
		if err != nil {
			return fmt.Errorf("configure realtimekit meeting credential verifier: %w", err)
		}
		meetingCredentials = verifier
	}
	mediaPlaneRegistry := mediaplaneproviders.NewRegistry(cfg.CloudflareRealtime)
	providerOperationRepository := postgres.NewProviderOperationRepositoryWithPool(pool)
	mediaPublicationService := mediapublications.NewService(providerOperationRepository)
	var providerBridgeServer *providerbridgeserver.Server
	if cfg.ProviderBridge.Enabled {
		sfu, err := sfuadapter.NewAdapter(cfg.CloudflareRealtime)
		if err != nil {
			return fmt.Errorf("configure provider bridge Cloudflare SFU executor: %w", err)
		}
		executor := providerbridge.NewSFUExecutor(mediaPublicationService, sfu)
		providerBridgeService := providerbridge.NewService(providerOperationRepository, executor)
		verifier, err := syncidentity.NewVerifier(cfg.ProviderBridge.SPIFFETrustDomain, cfg.Observability.Environment)
		if err != nil {
			return fmt.Errorf("configure provider bridge Sync identity: %w", err)
		}
		handler := diagnostics.WrapHTTP(httpapi.NewProviderBridgeHandler(providerBridgeService, verifier))
		providerBridgeServer, err = providerbridgeserver.New(cfg.ProviderBridge, handler)
		if err != nil {
			return fmt.Errorf("configure provider bridge listener: %w", err)
		}
	}
	var recordingDownloads httpapi.RecordingDownloadService
	var recordingObjects httpapi.RecordingObjectService
	var transcriptionStorage *objectstorage.Service
	if r2Configured(cfg.R2) {
		store, err := r2adapter.NewStore(cfg.R2)
		if err != nil {
			return fmt.Errorf("configure r2 object storage: %w", err)
		}
		recordingStorage := objectstorage.NewService(store)
		recordingDownloads = recordingStorage
		recordingObjects = recordingStorage
		transcriptionStorage = &recordingStorage
	}
	integrationCatalog, err := integrations.DefaultCatalog()
	if err != nil {
		return fmt.Errorf("configure integration catalog: %w", err)
	}
	integrationRepository := postgres.NewIntegrationRepository(operationQueries, pool)
	var integrationProvider integrations.Provider
	if cfg.Composio.APIKey != "" {
		provider, err := composioadapter.NewAdapter(composioadapter.Config{
			APIKey:         cfg.Composio.APIKey,
			BaseURL:        cfg.Composio.BaseURL,
			RequestTimeout: cfg.Composio.RequestTimeout,
			WebhookSecret:  cfg.Composio.WebhookSecret,
		})
		if err != nil {
			return fmt.Errorf("configure composio: %w", err)
		}
		integrationProvider = provider
	}
	integrationService := integrations.NewService(integrationRepository, integrationProvider, integrationCatalog)
	webhookProtector, err := webhooks.NewAESGCMKeyring(cfg.Webhooks.CurrentKeyVersion, cfg.Webhooks.EncryptionKeys)
	if err != nil {
		return fmt.Errorf("configure webhook encryption: %w", err)
	}
	webhookRepository := postgres.NewWebhookRepository(pool, webhookProtector)
	webhookService := webhooks.NewService(webhookRepository, webhookProtector)
	tenantAuthz := authorization.NewTenantPolicy(membershipRepository)
	rateLimitOptions := httpapi.DefaultRateLimitOptions()
	rateLimitOptions.ClientIP.TrustedProxyCIDRs = cfg.API.TrustedProxyCIDRs
	if cfg.Observability.Environment != config.DefaultEnvironment {
		rateLimitOptions.Limiter = redisadapter.NewRateLimiter(redisClient)
	}
	var transcriptArtifacts httpapi.TranscriptArtifactService
	var transcriptWorker httpapi.TranscriptWorkerService
	var workloadAuthorizer httpapi.WorkloadAuthorizer
	var transcriptionAuthority *transcriptionObjectAuthority
	if cfg.Transcription.WorkloadAuthSecret != "" {
		if len(cfg.Transcription.WorkloadAuthSecret) < 32 {
			return fmt.Errorf("%s must contain at least 32 bytes", config.TranscriptionWorkloadAuthSecret)
		}
		if redisClient == nil || transcriptionStorage == nil {
			return errors.New("transcription workload auth requires Redis and R2")
		}
		if cfg.Transcription.DispatcherFunction == "" {
			return fmt.Errorf("%s must be set with %s", config.TranscriptionDispatcherFunction, config.TranscriptionWorkloadAuthSecret)
		}
		waker, err := lambdawaker.New(context.Background(), cfg.Transcription.DispatcherFunction, logger)
		if err != nil {
			return fmt.Errorf("configure transcription dispatcher wake: %w", err)
		}
		transcriptService = transcriptService.WithDispatcherWaker(waker)
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
	} else if cfg.Observability.Environment != config.DefaultEnvironment {
		return fmt.Errorf("%s must be set outside local environments", config.TranscriptionWorkloadAuthSecret)
	}
	routerOptions := httpapi.Options{
		CORS: httpapi.CORSOptions{
			AllowedOrigins: cfg.API.CORSAllowedOrigins,
		},
		LocalSystemToken:       cfg.API.LocalSystemToken,
		RateLimit:              rateLimitOptions,
		Readiness:              postgres.Readiness{Pool: pool},
		Authentication:         authenticationService,
		APIKeys:                apiKeyService,
		APIKeyAuthentication:   apiKeyService,
		APIKeyAudits:           auditLogService,
		Integrations:           integrationService,
		Journeys:               journeyService,
		LocalTelemetry:         cfg.Observability.Environment == config.DefaultEnvironment,
		MeetingCredentials:     meetingCredentials,
		MediaPlane:             mediaPlaneRegistry,
		MediaPublications:      mediaPublicationService,
		ParticipantMediaIssuer: participantMediaIssuer,
		ParticipantMediaVerify: participantMediaVerifier,
		ParticipantMediaActive: participantActiveAuthorizer,
		ParticipantGeneration:  participantActiveAuthorizer,
		Memberships:            membershipService,
		AuditLogs:              auditLogService,
		RecordingDownloads:     recordingDownloads,
		RecordingObjects:       recordingObjects,
		RecordingPipeline:      recordingPipelineService,
		RecorderHealth:         recorderHealthService,
		Recordings:             recordingService,
		Rooms:                  roomService,
		SessionLifecycle:       sessionLifecycleService,
		SyncTokens:             syncTokenService,
		SyncTokenRefresh:       syncTokenRefresh,
		SessionCookie: httpapi.SessionCookieOptions{
			Secure: cfg.Observability.Environment != "local",
		},
		TenantAuthz: tenantAuthz,
		Tenants:     tenantService,
		// Synchronous application-node provider calls are intentionally absent.
		// Transcription work is claimed and fenced through the internal worker
		// boundary after the request transaction commits.
		AITranscriptions:       nil,
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
		Users:                  userService,
		Webhooks:               webhookService,
	}
	diagnostics.ApplyHTTP(&routerOptions)

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
	deadlineScheduler := sessionlifecycle.NewDeadlineScheduler(sessionLifecycleRepository, cfg.DeadlineScheduler.Interval, cfg.DeadlineScheduler.Batch)
	deadlineSchedulerErr := make(chan error, 1)
	go func() { deadlineSchedulerErr <- deadlineScheduler.Run(signalCtx) }()
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
	case <-signalCtx.Done():
		stop()
	}

	shutdownStartedAt := time.Now()
	logger.Info("api shutdown requested", "event", "api.shutdown_requested")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
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
	return runErr
}

func r2Configured(cfg config.R2Config) bool {
	return cfg.Bucket != "" || cfg.AccountID != "" || cfg.Endpoint != "" || cfg.AccessKeyID != "" || cfg.SecretAccessKey != ""
}
