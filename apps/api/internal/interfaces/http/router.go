package http

import (
	"context"

	"github.com/Q9Labs/chalk/internal/domain/participant"
	"github.com/Q9Labs/chalk/internal/domain/recording"
	"github.com/Q9Labs/chalk/internal/domain/room"
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
	roomState     *redis.RoomState
	wsHub         *websocket.Hub
	storageR2     storage.StorageClient
	storageS3     storage.StorageClient

	roomService        *room.Service
	participantService *participant.Service
	recordingService   *recording.Service
}

type RouterConfig struct {
	Pool        *postgres.Pool
	CFClient    *cloudflare.Client
	RedisClient *redis.Client
	StorageR2   storage.StorageClient
	StorageS3   storage.StorageClient
}

func NewRouter(cfg RouterConfig) *Router {
	engine := gin.Default()

	engine.Use(middleware.CORS())

	queries := db.New(cfg.Pool)

	jwtService := auth.NewJWTService(auth.DefaultJWTConfig())
	apiKeyService := auth.NewAPIKeyService()

	wsHub := websocket.NewHub(cfg.RedisClient)
	go wsHub.Run(context.Background())

	roomState := redis.NewRoomState(cfg.RedisClient)

	roomService := room.NewService(queries, cfg.CFClient, roomState, wsHub)
	participantService := participant.NewService(queries, cfg.CFClient, roomState, jwtService, wsHub)
	recordingService := recording.NewService(queries, cfg.CFClient, cfg.StorageR2, cfg.StorageS3, roomState, wsHub)

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
		roomService:        roomService,
		participantService: participantService,
		recordingService:   recordingService,
	}

	r.setupRoutes()
	return r
}

func (r *Router) setupRoutes() {
	health := handlers.NewHealthHandler(r.pool)
	r.engine.GET("/health", health.Check)

	wsHandler := handlers.NewWebSocketHandler(r.jwtService, r.wsHub)
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

		tenants := handlers.NewTenantHandler(r.queries, r.apiKeyService)
		tenantsGroup := v1.Group("/tenants")
		{
			tenantsGroup.POST("", tenants.Create)

			tenantsGroup.Use(apiKeyMw.RequireAPIKey())
			tenantsGroup.GET("/:id", tenants.Get)
			tenantsGroup.PATCH("/:id", tenants.Update)
			tenantsGroup.DELETE("/:id", tenants.Delete)
			tenantsGroup.POST("/:id/rotate-key", tenants.RotateAPIKey)
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

			participants := handlers.NewParticipantHandler(r.participantService)
			roomsGroup.POST("/:id/participants", participants.Add)
			roomsGroup.GET("/:id/participants", participants.List)
			roomsGroup.DELETE("/:id/participants/:pid", participants.Remove)
			roomsGroup.POST("/:id/participants/:pid/token", participants.RefreshToken)

			recordings := handlers.NewRecordingHandler(r.recordingService)
			roomsGroup.POST("/:id/recordings/start", recordings.Start)
			roomsGroup.POST("/:id/recordings/stop", recordings.Stop)
			roomsGroup.POST("/:id/recordings/:rid/archive", recordings.Archive)
		}

		recordingsGroup := v1.Group("/recordings")
		recordingsGroup.Use(authMw.RequireJWT())
		{
			recordings := handlers.NewRecordingHandler(r.recordingService)
			recordingsGroup.GET("", recordings.List)
			recordingsGroup.GET("/:id", recordings.Get)
			recordingsGroup.GET("/:id/download", recordings.Download)
			recordingsGroup.POST("/:id/archive", recordings.Archive)
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
