package http

import (
	"context"

	"github.com/Q9Labs/chalk/internal/infrastructure/auth"
	"github.com/Q9Labs/chalk/internal/infrastructure/cloudflare"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	"github.com/Q9Labs/chalk/internal/infrastructure/redis"
	"github.com/Q9Labs/chalk/internal/infrastructure/storage"
	"github.com/Q9Labs/chalk/internal/interfaces/http/handlers"
	"github.com/Q9Labs/chalk/internal/interfaces/http/middleware"
	"github.com/Q9Labs/chalk/internal/interfaces/websocket"
	"github.com/gin-gonic/gin"
)

type Router struct {
	engine        *gin.Engine
	pool          *postgres.Pool
	queries       *db.Queries
	jwtService    *auth.JWTService
	apiKeyService *auth.APIKeyService
	cfClient      *cloudflare.Client
	redisClient   *redis.Client
	wsHub         *websocket.Hub
	storageR2     storage.StorageClient
	storageS3     storage.StorageClient
}

type RouterConfig struct {
	Pool       *postgres.Pool
	CFClient   *cloudflare.Client
	RedisClient *redis.Client
	StorageR2  storage.StorageClient
	StorageS3  storage.StorageClient
}

func NewRouter(cfg RouterConfig) *Router {
	engine := gin.Default()

	// Add CORS middleware
	engine.Use(middleware.CORS())

	queries := db.New(cfg.Pool)

	// Initialize auth services
	jwtService := auth.NewJWTService(auth.DefaultJWTConfig())
	apiKeyService := auth.NewAPIKeyService()

	// Initialize WebSocket hub
	wsHub := websocket.NewHub(cfg.RedisClient)

	// Start hub in background
	go wsHub.Run(context.Background())

	r := &Router{
		engine:        engine,
		pool:          cfg.Pool,
		queries:       queries,
		jwtService:    jwtService,
		apiKeyService: apiKeyService,
		cfClient:      cfg.CFClient,
		redisClient:   cfg.RedisClient,
		wsHub:         wsHub,
		storageR2:     cfg.StorageR2,
		storageS3:     cfg.StorageS3,
	}

	r.setupRoutes()
	return r
}

func (r *Router) setupRoutes() {
	// Health check (no auth)
	health := handlers.NewHealthHandler(r.pool)
	r.engine.GET("/health", health.Check)

	// WebSocket upgrade route (JWT required)
	wsHandler := handlers.NewWebSocketHandler(r.jwtService, r.wsHub)
	r.engine.GET("/ws", wsHandler.HandleWebSocket)

	// Initialize middleware
	authMw := middleware.NewAuthMiddleware(r.jwtService)
	apiKeyMw := middleware.NewAPIKeyMiddleware(r.apiKeyService, r.queries)

	// API v1 routes
	v1 := r.engine.Group("/api/v1")
	{
		// Auth routes (no auth required)
		authHandler := handlers.NewAuthHandler(r.queries, r.jwtService, r.apiKeyService)
		v1.POST("/auth/token", authHandler.Token)
		v1.POST("/auth/refresh", authHandler.Refresh)

		// Demo routes (no auth required - for testing only)
		demoHandler := handlers.NewDemoHandler(r.queries, r.cfClient, authHandler)
		v1.POST("/demo/join", demoHandler.Join)

		// Tenant routes - requires API key auth
		tenants := handlers.NewTenantHandler(r.queries, r.apiKeyService)
		tenantsGroup := v1.Group("/tenants")
		{
			// Public route to create tenant (returns API key)
			tenantsGroup.POST("", tenants.Create)

			// Protected routes
			tenantsGroup.Use(apiKeyMw.RequireAPIKey())
			tenantsGroup.GET("/:id", tenants.Get)
			tenantsGroup.PATCH("/:id", tenants.Update)
			tenantsGroup.DELETE("/:id", tenants.Delete)
			tenantsGroup.POST("/:id/rotate-key", tenants.RotateAPIKey)
		}

		// Room routes - requires JWT auth
		rooms := handlers.NewRoomHandler(r.queries, r.cfClient)
		roomsGroup := v1.Group("/rooms")
		roomsGroup.Use(authMw.RequireJWT())
		{
			roomsGroup.POST("", rooms.Create)
			roomsGroup.GET("", rooms.List)
			roomsGroup.GET("/:id", rooms.Get)
			roomsGroup.PATCH("/:id", rooms.Update)
			roomsGroup.DELETE("/:id", rooms.Delete)
			roomsGroup.POST("/:id/end", rooms.End)

			// Participant routes
			participants := handlers.NewParticipantHandler(r.queries, r.cfClient, authHandler)
			roomsGroup.POST("/:id/participants", participants.Add)
			roomsGroup.GET("/:id/participants", participants.List)
			roomsGroup.DELETE("/:id/participants/:pid", participants.Remove)
			roomsGroup.POST("/:id/participants/:pid/token", participants.RefreshToken)

			// Recording routes
			recordings := handlers.NewRecordingHandler(r.queries, r.cfClient, r.storageR2, r.storageS3)
			roomsGroup.POST("/:id/recordings/start", recordings.Start)
			roomsGroup.POST("/:id/recordings/stop", recordings.Stop)
			roomsGroup.POST("/:id/recordings/:rid/archive", recordings.Archive)
		}

		// Recording list/get routes
		recordingsGroup := v1.Group("/recordings")
		recordingsGroup.Use(authMw.RequireJWT())
		{
			recordings := handlers.NewRecordingHandler(r.queries, r.cfClient, r.storageR2, r.storageS3)
			recordingsGroup.GET("", recordings.List)
			recordingsGroup.GET("/:id", recordings.Get)
			recordingsGroup.GET("/:id/download", recordings.Download)
			recordingsGroup.POST("/:id/archive", recordings.Archive)
			recordingsGroup.DELETE("/:id", recordings.Delete)
		}

		// Webhook routes (no auth required)
		webhooks := handlers.NewWebhookHandler(r.queries, r.storageR2)
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
