package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/Q9Labs/chalk/internal/config"
	"github.com/Q9Labs/chalk/internal/infrastructure/cloudflare"
	"github.com/Q9Labs/chalk/internal/infrastructure/jobs"
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
	if err := godotenv.Load(); err != nil {
		log.Println("No .env file found, using environment variables")
	}

	// Load configuration
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("Failed to load configuration: %v", err)
	}

	log.Printf("Starting server in %s mode", cfg.Server.Env)

	// Database connection using config from environment
	dbCfg := postgres.Config{
		Host:              cfg.Database.Host,
		Port:              5432, // Default port, parse from cfg.Database.Port if needed
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
		log.Fatalf("Failed to connect to database: %v", err)
	}
	defer pool.Close()

	log.Println("Connected to database")

	// Run database migrations
	if err := pool.RunMigrations(ctx); err != nil {
		log.Fatalf("Failed to run database migrations: %v", err)
	}
	log.Println("Database migrations completed")

	// Initialize Redis client
	redisClient, err := redis.NewClient(ctx, cfg.Redis.URL)
	if err != nil {
		log.Fatalf("Failed to connect to Redis: %v", err)
	}
	defer redisClient.Close()

	log.Println("Connected to Redis")

	// Initialize Cloudflare RealtimeKit client
	cfClient := cloudflare.NewClient(cloudflare.Config{
		AccountID: cfg.Cloudflare.AccountID,
		AppID:     cfg.Cloudflare.AppID,
		APIToken:  cfg.Cloudflare.APIToken,
	})

	log.Println("Initialized Cloudflare RealtimeKit client")

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
			log.Printf("Warning: Failed to initialize R2 client: %v", err)
		} else {
			storageR2 = r2Client
			log.Println("Initialized R2 storage client")
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
			log.Printf("Warning: Failed to initialize S3 client: %v", err)
		} else {
			storageS3 = s3Client
			log.Println("Initialized S3 storage client")
		}
	}

	// Create router
	router := http.NewRouter(http.RouterConfig{
		Pool:        pool,
		CFClient:    cfClient,
		RedisClient: redisClient,
		StorageR2:   storageR2,
		StorageS3:   storageS3,
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
		log.Println("Started recording lifecycle manager")
	}

	// Start background jobs
	recChecker := jobs.NewRecordingChecker(router.Queries(), cfClient)
	go recChecker.Run(ctx, 30*time.Minute)
	log.Println("Started recording checker (30min interval)")

	roomCleanup := jobs.NewRoomCleanup(router.Queries(), router.RoomService())
	go roomCleanup.Run(ctx, 10*time.Minute, 30) // Check every 10min, cleanup rooms empty for 30min
	log.Println("Started room cleanup (10min interval, 30min timeout)")

	// Graceful shutdown
	go func() {
		quit := make(chan os.Signal, 1)
		signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
		<-quit
		log.Println("Shutting down server...")
		router.Close()
		pool.Close()
		os.Exit(0)
	}()

	// Start server
	addr := ":" + cfg.Server.Port
	log.Printf("Starting server on %s", addr)
	if err := router.Run(addr); err != nil {
		log.Fatalf("Failed to start server: %v", err)
	}
}
