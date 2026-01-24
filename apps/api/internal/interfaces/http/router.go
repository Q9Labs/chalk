package http

import (
	"context"
	"log"
	"time"

	"github.com/Q9Labs/chalk/internal/config"
	"github.com/Q9Labs/chalk/internal/domain/participant"
	"github.com/Q9Labs/chalk/internal/domain/recording"
	"github.com/Q9Labs/chalk/internal/domain/room"
	"github.com/Q9Labs/chalk/internal/domain/transcript"
	"github.com/Q9Labs/chalk/internal/infrastructure/auth"
	"github.com/Q9Labs/chalk/internal/infrastructure/cloudflare"
	"github.com/Q9Labs/chalk/internal/infrastructure/github"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	"github.com/Q9Labs/chalk/internal/infrastructure/redis"
	"github.com/Q9Labs/chalk/internal/infrastructure/s3"
	"github.com/Q9Labs/chalk/internal/infrastructure/storage"
	"github.com/Q9Labs/chalk/internal/interfaces/http/handlers"
	"github.com/Q9Labs/chalk/internal/interfaces/http/middleware"
	"github.com/Q9Labs/chalk/internal/interfaces/websocket"
	"github.com/gin-gonic/gin"
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

	roomService        *room.Service
	participantService *participant.Service
	recordingService   *recording.Service
	transcriptService  *transcript.Service
}

type RouterConfig struct {
	Pool        *postgres.Pool
	CFClient    *cloudflare.Client
	RedisClient *redis.Client
	StorageR2   storage.StorageClient
	StorageS3   storage.StorageClient
	AppConfig   *config.Config
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

	wsHub := websocket.NewHub(cfg.RedisClient)
	go wsHub.Run(context.Background())

	roomState := redis.NewRoomState(cfg.RedisClient)

	roomService := room.NewService(queries, cfg.CFClient, roomState, wsHub)
	participantService := participant.NewService(queries, cfg.CFClient, roomState, jwtService, wsHub)
	recordingService := recording.NewService(queries, cfg.CFClient, cfg.StorageR2, cfg.StorageS3, roomState, wsHub)
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
	}, queries)
	if err != nil {
		log.Printf("Warning: failed to initialize CORS origins service: %v", err)
	}

	// Wire transcript service to WebSocket hub for real-time transcript persistence
	wsHub.SetTranscriptService(&transcriptServiceAdapter{svc: transcriptService})

	r := &Router{
		engine:             engine,
		pool:               cfg.Pool,
		queries:            queries,
		jwtService:         jwtService,
		apiKeyService:      apiKeyService,
		cfClient:           cfg.CFClient,
		redisClient:        cfg.RedisClient,
		roomState:          roomState,
		wsHub:              wsHub,
		storageR2:          cfg.StorageR2,
		storageS3:          cfg.StorageS3,
		githubClient:       githubClient,
		appConfig:          cfg.AppConfig,
		corsOriginsService: corsOriginsService,
		roomService:        roomService,
		participantService: participantService,
		recordingService:   recordingService,
		transcriptService:  transcriptService,
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

		demoHandler := handlers.NewDemoHandler(r.queries, r.roomService, r.participantService)
		v1.POST("/demo/join", demoHandler.Join)

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
			roomsGroup.DELETE("/:id/participants/:pid", participants.Remove)
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
		}

		webhooks := handlers.NewWebhookHandler(r.recordingService)
		v1.POST("/webhooks/cloudflare/recording", webhooks.HandleRecordingReady)
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
