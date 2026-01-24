package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/Q9Labs/chalk/internal/config"
	"github.com/Q9Labs/chalk/internal/infrastructure/cloudflare"
	"github.com/Q9Labs/chalk/internal/infrastructure/jobs"
	"github.com/Q9Labs/chalk/internal/infrastructure/logging"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	"github.com/Q9Labs/chalk/internal/infrastructure/redis"
	"github.com/Q9Labs/chalk/internal/infrastructure/storage"
	"github.com/Q9Labs/chalk/internal/interfaces/http"
	"github.com/joho/godotenv"
)

func main() {
	ctx := context.Background()

	// Load .env file (ignore error if not found - production uses real env vars)
	_ = godotenv.Load()

	// Initialize structured logging (Axiom if configured, stdout otherwise)
	logging.Init()
	defer logging.Close()

	// Load configuration
	cfg, err := config.Load()
	if err != nil {
		slog.Error("failed to load configuration", "error", err)
		os.Exit(1)
	}

	slog.Info("starting server", "env", cfg.Server.Env)

	// API-MED-03: Database connection using config from environment (including port)
	dbPort := 5432
	if cfg.Database.Port != "" {
		if p, err := strconv.Atoi(cfg.Database.Port); err == nil {
			dbPort = p
		}
	}

	dbCfg := postgres.Config{
		Host:              cfg.Database.Host,
		Port:              dbPort,
		User:              cfg.Database.User,
		Password:          cfg.Database.Password,
		Database:          cfg.Database.Name,
		SSLMode:           cfg.Database.SSLMode,
		MaxConns:          25,
		MinConns:          5,
		MaxConnLifetime:   time.Hour,
		MaxConnIdleTime:   30 * time.Minute,
		HealthCheckPeriod: time.Minute,
	}
	pool, err := postgres.NewPool(ctx, dbCfg)
	if err != nil {
		slog.Error("failed to connect to database", "error", err)
		os.Exit(1)
	}
	defer pool.Close()

	slog.Info("connected to database")

	// Run database migrations
	if err := pool.RunMigrations(ctx); err != nil {
		slog.Error("failed to run database migrations", "error", err)
		os.Exit(1)
	}
	slog.Info("database migrations completed")

	// Initialize Redis client
	redisClient, err := redis.NewClient(ctx, cfg.Redis.URL)
	if err != nil {
		slog.Error("failed to connect to Redis", "error", err)
		os.Exit(1)
	}
	defer redisClient.Close()

	slog.Info("connected to Redis")

	// Initialize Cloudflare RealtimeKit client
	cfClient := cloudflare.NewClient(cloudflare.Config{
		AccountID: cfg.Cloudflare.AccountID,
		AppID:     cfg.Cloudflare.AppID,
		APIToken:  cfg.Cloudflare.APIToken,
	})

	slog.Info("initialized Cloudflare RealtimeKit client")

	// Initialize R2 storage client (optional)
	var storageR2 storage.StorageClient
	if cfg.Storage.R2AccessKeyID != "" && cfg.Storage.R2SecretAccessKey != "" {
		r2Client, err := storage.NewR2Client(storage.R2Config{
			AccountID:       cfg.Storage.R2AccountID,
			AccessKeyID:     cfg.Storage.R2AccessKeyID,
			SecretAccessKey: cfg.Storage.R2SecretAccessKey,
			BucketName:      cfg.Storage.R2BucketName,
			PublicURL:       cfg.Storage.R2PublicURL,
		})
		if err != nil {
			slog.Warn("failed to initialize R2 client", "error", err)
		} else {
			storageR2 = r2Client
			slog.Info("initialized R2 storage client")
		}
	}

	// Initialize S3 storage client (optional)
	var storageS3 storage.StorageClient
	if cfg.Storage.S3AccessKeyID != "" && cfg.Storage.S3SecretAccessKey != "" {
		s3Client, err := storage.NewS3Client(storage.S3Config{
			Region:          cfg.Storage.S3Region,
			AccessKeyID:     cfg.Storage.S3AccessKeyID,
			SecretAccessKey: cfg.Storage.S3SecretAccessKey,
			BucketName:      cfg.Storage.S3BucketName,
		})
		if err != nil {
			slog.Warn("failed to initialize S3 client", "error", err)
		} else {
			storageS3 = s3Client
			slog.Info("initialized S3 storage client")
		}
	}

	// Create router
	router := http.NewRouter(http.RouterConfig{
		Pool:        pool,
		CFClient:    cfClient,
		RedisClient: redisClient,
		StorageR2:   storageR2,
		StorageS3:   storageS3,
		AppConfig:   cfg,
	})

	if storageR2 != nil && storageS3 != nil {
		queries := db.New(pool)
		lifecycleMgr := storage.NewRecordingLifecycleManager(
			storageR2,
			storageS3,
			queries,
			storage.DefaultLifecycleConfig(),
		)
		go lifecycleMgr.Start(ctx)
		slog.Info("started recording lifecycle manager")
	}

	// Start background jobs
	recChecker := jobs.NewRecordingChecker(router.Queries(), cfClient, router.RecordingService())
	go recChecker.Run(ctx, 30*time.Minute)
	slog.Info("started recording checker", "interval", "30m")

	roomCleanup := jobs.NewRoomCleanup(router.Queries(), router.RoomService())
	go roomCleanup.Run(ctx, 10*time.Minute, 30) // Check every 10min, cleanup rooms empty for 30min
	slog.Info("started room cleanup", "interval", "10m", "timeout", "30m")

	// Graceful shutdown
	go func() {
		quit := make(chan os.Signal, 1)
		signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
		<-quit
		slog.Info("shutting down server")
		router.Close()
		pool.Close()
		os.Exit(0)
	}()

	// Start server
	addr := ":" + cfg.Server.Port
	slog.Info("starting server", "addr", addr)
	if err := router.Run(addr); err != nil {
		slog.Error("failed to start server", "error", err)
		os.Exit(1)
	}
}
