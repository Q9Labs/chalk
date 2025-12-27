package http

import (
	"github.com/Q9Labs/chalk/internal/infrastructure/auth"
	"github.com/Q9Labs/chalk/internal/infrastructure/cloudflare"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	"github.com/Q9Labs/chalk/internal/interfaces/http/handlers"
	"github.com/Q9Labs/chalk/internal/interfaces/http/middleware"
	"github.com/gin-gonic/gin"
)

type Router struct {
	engine        *gin.Engine
	pool          *postgres.Pool
	queries       *db.Queries
	jwtService    *auth.JWTService
	apiKeyService *auth.APIKeyService
	cfClient      *cloudflare.Client
}

type RouterConfig struct {
	Pool     *postgres.Pool
	CFClient *cloudflare.Client
}

func NewRouter(cfg RouterConfig) *Router {
	engine := gin.Default()
	queries := db.New(cfg.Pool)

	// Initialize auth services
	jwtService := auth.NewJWTService(auth.DefaultJWTConfig())
	apiKeyService := auth.NewAPIKeyService()

	r := &Router{
		engine:        engine,
		pool:          cfg.Pool,
		queries:       queries,
		jwtService:    jwtService,
		apiKeyService: apiKeyService,
		cfClient:      cfg.CFClient,
	}

	r.setupRoutes()
	return r
}

func (r *Router) setupRoutes() {
	// Health check (no auth)
	health := handlers.NewHealthHandler(r.pool)
	r.engine.GET("/health", health.Check)

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
			recordings := handlers.NewRecordingHandler(r.queries, r.cfClient)
			roomsGroup.POST("/:id/recordings/start", recordings.Start)
			roomsGroup.POST("/:id/recordings/stop", recordings.Stop)
		}

		// Recording list/get routes
		recordingsGroup := v1.Group("/recordings")
		recordingsGroup.Use(authMw.RequireJWT())
		{
			recordings := handlers.NewRecordingHandler(r.queries, r.cfClient)
			recordingsGroup.GET("", recordings.List)
			recordingsGroup.GET("/:id", recordings.Get)
			recordingsGroup.GET("/:id/download", recordings.Download)
			recordingsGroup.DELETE("/:id", recordings.Delete)
		}
	}
}

func (r *Router) Run(addr string) error {
	return r.engine.Run(addr)
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
