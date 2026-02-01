package http

import (
	"context"
	"log/slog"
	"time"

	"github.com/Q9Labs/chalk/internal/config"
	"github.com/Q9Labs/chalk/internal/domain/participant"
	"github.com/Q9Labs/chalk/internal/domain/recording"
	"github.com/Q9Labs/chalk/internal/domain/room"
	"github.com/Q9Labs/chalk/internal/domain/transcript"
	postmeetingtranscription "github.com/Q9Labs/chalk/internal/domain/transcription"
	"github.com/Q9Labs/chalk/internal/domain/webhook"
	"github.com/Q9Labs/chalk/internal/infrastructure/auth"
	"github.com/Q9Labs/chalk/internal/infrastructure/cloudflare"
	"github.com/Q9Labs/chalk/internal/infrastructure/github"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	"github.com/Q9Labs/chalk/internal/infrastructure/redis"
	"github.com/Q9Labs/chalk/internal/infrastructure/s3"
	"github.com/Q9Labs/chalk/internal/infrastructure/storage"
	// Import to trigger provider registration
	_ "github.com/Q9Labs/chalk/internal/infrastructure/transcription"
	"github.com/Q9Labs/chalk/internal/interfaces/http/handlers"
	"github.com/Q9Labs/chalk/internal/interfaces/http/middleware"
	"github.com/Q9Labs/chalk/internal/interfaces/websocket"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

type Router struct {
	engine             *gin.Engine
	pool               *postgres.Pool
	queries            *db.Queries
	jwtService         *auth.JWTService
	apiKeyService      *auth.APIKeyService
	cfClient           *cloudflare.Client
	redisClient        *redis.Client
	roomState          *redis.RoomState
	wsHub              *websocket.Hub
	storageR2          storage.StorageClient
	storageS3          storage.StorageClient
	githubClient       *github.Client
	appConfig          *config.Config
	corsOriginsService *s3.CORSOriginsService

	roomService                     *room.Service
	participantService              *participant.Service
	recordingService                *recording.Service
	transcriptService               *transcript.Service
	postMeetingTranscriptionService *postmeetingtranscription.Service
	postMeetingService              *webhook.PostMeetingService
}

type RouterConfig struct {
	Pool                            *postgres.Pool
	CFClient                        *cloudflare.Client
	RedisClient                     *redis.Client
	StorageR2                       storage.StorageClient
	StorageS3                       storage.StorageClient
	AppConfig                       *config.Config
	PostMeetingTranscriptionService *postmeetingtranscription.Service
	PostMeetingService              *webhook.PostMeetingService
}

func NewRouter(cfg RouterConfig) *Router {
	engine := gin.Default()

	engine.Use(middleware.CORS())
	engine.Use(middleware.RequestID())
	engine.Use(middleware.RequestLogger())

	queries := db.New(cfg.Pool)

	// Use JWT config from application config - fail fast handled in config.Load()
	jwtConfig := auth.JWTConfig{
		SecretKey:          cfg.AppConfig.JWT.SigningKey,
		AccessTokenExpiry:  time.Duration(cfg.AppConfig.JWT.ExpiryMinutes) * time.Minute,
		RefreshTokenExpiry: 7 * 24 * time.Hour,
		Issuer:             "chalk",
	}
	jwtService := auth.NewJWTService(jwtConfig)
	apiKeyService := auth.NewAPIKeyService()

	wsHub := websocket.NewHub(cfg.RedisClient, slog.Default())
	wsHub.SetWhiteboardStateStore(&whiteboardStateStoreAdapter{queries: queries})
	go wsHub.Run(context.Background())

	roomState := redis.NewRoomState(cfg.RedisClient)

	recordingService := recording.NewService(queries, cfg.CFClient, cfg.StorageR2, cfg.StorageS3, roomState, wsHub)
	roomService := room.NewService(queries, cfg.CFClient, roomState, wsHub, &recordingStopperAdapter{svc: recordingService})
	participantService := participant.NewService(queries, cfg.CFClient, roomState, jwtService, wsHub)
	transcriptService := transcript.NewService(queries)

	// GitHub client for What's New feature
	githubClient := github.NewClient(
		cfg.AppConfig.GitHub.Token,
		cfg.AppConfig.GitHub.Owner,
		cfg.AppConfig.GitHub.Repo,
	)

	// CORS origins S3 service for tenant-specific origins
	corsOriginsService, err := s3.NewCORSOriginsService(s3.CORSOriginsConfig{
		Region:          cfg.AppConfig.Storage.S3Region,
		AccessKeyID:     cfg.AppConfig.Storage.S3AccessKeyID,
		SecretAccessKey: cfg.AppConfig.Storage.S3SecretAccessKey,
		Bucket:          cfg.AppConfig.CORSOrigins.Bucket,
		Key:             cfg.AppConfig.CORSOrigins.Key,
		GitHubRepo:      cfg.AppConfig.GitHub.Owner + "/" + cfg.AppConfig.GitHub.Repo,
		GitHubToken:     cfg.AppConfig.GitHub.Token,
	}, queries, slog.Default())
	if err != nil {
		slog.Warn("failed to initialize CORS origins service", "error", err)
	}

	// Wire transcript service to WebSocket hub for real-time transcript persistence
	wsHub.SetTranscriptService(&transcriptServiceAdapter{svc: transcriptService})

	// Wire participant service to WebSocket hub for marking participants as left on disconnect
	wsHub.SetParticipantService(participantService)

	r := &Router{
		engine:                          engine,
		pool:                            cfg.Pool,
		queries:                         queries,
		jwtService:                      jwtService,
		apiKeyService:                   apiKeyService,
		cfClient:                        cfg.CFClient,
		redisClient:                     cfg.RedisClient,
		roomState:                       roomState,
		wsHub:                           wsHub,
		storageR2:                       cfg.StorageR2,
		storageS3:                       cfg.StorageS3,
		githubClient:                    githubClient,
		appConfig:                       cfg.AppConfig,
		corsOriginsService:              corsOriginsService,
		roomService:                     roomService,
		participantService:              participantService,
		recordingService:                recordingService,
		transcriptService:               transcriptService,
		postMeetingTranscriptionService: cfg.PostMeetingTranscriptionService,
		postMeetingService:              cfg.PostMeetingService,
	}

	r.setupRoutes()
	return r
}

// transcriptServiceAdapter adapts the domain transcript service to the websocket interface
type transcriptServiceAdapter struct {
	svc *transcript.Service
}

func (a *transcriptServiceAdapter) CreateTranscript(ctx context.Context, input websocket.TranscriptInput) error {
	_, err := a.svc.CreateTranscript(ctx, transcript.CreateTranscriptInput{
		RoomID:                  input.RoomID,
		ParticipantID:           input.ParticipantID,
		CloudflareParticipantID: input.CloudflareParticipantID,
		SpeakerName:             input.SpeakerName,
		Text:                    input.Text,
		Confidence:              input.Confidence,
		Language:                input.Language,
		ExternalID:              input.ExternalID,
		Timestamp:               input.Timestamp,
	})
	return err
}

type whiteboardStateStoreAdapter struct {
	queries *db.Queries
}

func (a *whiteboardStateStoreAdapter) Save(ctx context.Context, roomID uuid.UUID, state []byte) error {
	return a.queries.UpdateRoomWhiteboardState(ctx, roomID, state)
}

func (a *whiteboardStateStoreAdapter) Load(ctx context.Context, roomID uuid.UUID) ([]byte, error) {
	return a.queries.GetRoomWhiteboardState(ctx, roomID)
}

func (r *Router) setupRoutes() {
	health := handlers.NewHealthHandler(r.pool)
	r.engine.GET("/health", health.Check)

	wsHandler := handlers.NewWebSocketHandler(r.jwtService, r.wsHub, r.queries)
	r.engine.GET("/ws", wsHandler.HandleWebSocket)

	authMw := middleware.NewAuthMiddleware(r.jwtService)
	apiKeyMw := middleware.NewAPIKeyMiddleware(r.apiKeyService, r.queries)

	v1 := r.engine.Group("/api/v1")
	{
		authHandler := handlers.NewAuthHandler(r.queries, r.jwtService, r.apiKeyService)
		v1.POST("/auth/token", authHandler.Token)
		v1.POST("/auth/refresh", authHandler.Refresh)

		// What's New - public endpoints for release info
		whatsNew := handlers.NewWhatsNewHandler(r.githubClient, r.redisClient, r.storageR2, r.appConfig.GitHub.CacheTTL)
		v1.GET("/whats-new", whatsNew.Get)
		v1.GET("/whats-new/releases", whatsNew.GetReleases)

		tenants := handlers.NewTenantHandler(r.queries, r.apiKeyService, r.corsOriginsService)
		tenantsGroup := v1.Group("/tenants")
		{
			tenantsGroup.POST("", tenants.Create)

			tenantsGroup.Use(apiKeyMw.RequireAPIKey())
			tenantsGroup.GET("/:id", tenants.Get)
			tenantsGroup.PATCH("/:id", tenants.Update)
			tenantsGroup.DELETE("/:id", tenants.Delete)
			tenantsGroup.POST("/:id/rotate-key", tenants.RotateAPIKey)
			tenantsGroup.PATCH("/:id/config", tenants.UpdateConfig)
		}

		rooms := handlers.NewRoomHandler(r.roomService)
		roomsGroup := v1.Group("/rooms")
		roomsGroup.Use(authMw.RequireJWT())
		{
			roomsGroup.POST("", rooms.Create)
			roomsGroup.GET("", rooms.List)
			roomsGroup.GET("/:id", rooms.Get)
			roomsGroup.PATCH("/:id", rooms.Update)
			roomsGroup.DELETE("/:id", rooms.Delete)
			roomsGroup.POST("/:id/end", rooms.End)

			participants := handlers.NewParticipantHandler(r.participantService, r.roomService)
			roomsGroup.POST("/:id/participants", participants.Add)
			roomsGroup.POST("/:id/participants/bulk", participants.BulkAdd)
			roomsGroup.GET("/:id/participants", participants.List)
			roomsGroup.DELETE("/:id/participants/:pid", authMw.RequireHost(), participants.Remove)
			roomsGroup.POST("/:id/participants/:pid/token", participants.RefreshToken)

			// API-HIGH-05: Recording start/stop/archive require host role
			recordings := handlers.NewRecordingHandler(r.recordingService, r.roomService, r.cfClient)
			roomsGroup.POST("/:id/recordings/start", authMw.RequireHost(), recordings.Start)
			roomsGroup.POST("/:id/recordings/stop", authMw.RequireHost(), recordings.Stop)
			roomsGroup.POST("/:id/recordings/:rid/archive", authMw.RequireHost(), recordings.Archive)
			roomsGroup.POST("/:id/recordings/sync", recordings.SyncFromCloudflare)

			// Transcripts
			transcripts := handlers.NewTranscriptHandler(r.transcriptService, r.roomService)
			roomsGroup.GET("/:id/transcripts", transcripts.List)
		}

		recordingsGroup := v1.Group("/recordings")
		recordingsGroup.Use(authMw.RequireJWT())
		{
			recordings := handlers.NewRecordingHandler(r.recordingService, r.roomService, r.cfClient)
			recordingsGroup.GET("", recordings.List)
			recordingsGroup.GET("/:id", recordings.Get)
			recordingsGroup.GET("/:id/download", recordings.Download)
			recordingsGroup.POST("/:id/archive", recordings.Archive)
			recordingsGroup.POST("/:id/recover", recordings.Recover)
			recordingsGroup.DELETE("/:id", recordings.Delete)

			// Post-meeting transcription for recordings
			if r.postMeetingTranscriptionService != nil {
				pmTranscription := handlers.NewPostMeetingTranscriptionHandler(r.postMeetingTranscriptionService)
				recordingsGroup.GET("/:id/transcript", pmTranscription.GetTranscriptByRecording)
				recordingsGroup.POST("/:id/transcribe", pmTranscription.QueueTranscription)
			}
		}

		// Post-meeting transcription endpoints
		if r.postMeetingTranscriptionService != nil {
			transcriptionGroup := v1.Group("/transcription")
			{
				pmTranscription := handlers.NewPostMeetingTranscriptionHandler(r.postMeetingTranscriptionService)
				transcriptionGroup.GET("/providers", pmTranscription.GetProviders)

				transcriptionGroup.Use(authMw.RequireJWT())
				transcriptionGroup.GET("/:id", pmTranscription.GetTranscript)
			}
		}

		// Create post-meeting trigger adapter if service is configured
		var postMeetingTrigger handlers.PostMeetingTrigger
		if r.postMeetingService != nil {
			postMeetingTrigger = &postMeetingTriggerAdapter{svc: r.postMeetingService}
		}

		webhooks := handlers.NewWebhookHandler(r.recordingService, r.queries, postMeetingTrigger)
		v1.POST("/webhooks/cloudflare/recording", webhooks.HandleRecordingReady)

		localPostMeeting := handlers.NewLocalPostMeetingWebhookHandler(r.queries)
		v1.POST("/webhooks/local/post-meeting", localPostMeeting.Handle)
	}
}

func (r *Router) Run(addr string) error {
	return r.engine.Run(addr)
}

func (r *Router) Close() error {
	// Close WebSocket hub
	if r.wsHub != nil {
		r.wsHub.Close()
	}

	// Close Redis connection
	if r.redisClient != nil {
		return r.redisClient.Close()
	}

	return nil
}

func (r *Router) Engine() *gin.Engine {
	return r.engine
}

func (r *Router) JWTService() *auth.JWTService {
	return r.jwtService
}

func (r *Router) APIKeyService() *auth.APIKeyService {
	return r.apiKeyService
}

func (r *Router) RoomService() *room.Service {
	return r.roomService
}

func (r *Router) RecordingService() *recording.Service {
	return r.recordingService
}

func (r *Router) Queries() *db.Queries {
	return r.queries
}

func (r *Router) PostMeetingTranscriptionService() *postmeetingtranscription.Service {
	return r.postMeetingTranscriptionService
}

func (r *Router) PostMeetingService() *webhook.PostMeetingService {
	return r.postMeetingService
}

// recordingStopperAdapter adapts recording.Service to room.RecordingStopper interface
type recordingStopperAdapter struct {
	svc *recording.Service
}

func (a *recordingStopperAdapter) StopRecording(ctx context.Context, roomID uuid.UUID) error {
	_, err := a.svc.StopRecording(ctx, roomID)
	return err
}

// postMeetingTriggerAdapter adapts the webhook.PostMeetingService to the handlers.PostMeetingTrigger interface
type postMeetingTriggerAdapter struct {
	svc *webhook.PostMeetingService
}

func (a *postMeetingTriggerAdapter) TriggerPostMeetingProcessing(ctx context.Context, recordingID, roomID uuid.UUID) {
	a.svc.TriggerPostMeetingProcessing(ctx, recordingID, roomID)
}
