package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/Q9Labs/chalk/internal/config"
	"github.com/Q9Labs/chalk/internal/domain/ai"
	"github.com/Q9Labs/chalk/internal/domain/transcription"
	"github.com/Q9Labs/chalk/internal/domain/webhook"
	infraai "github.com/Q9Labs/chalk/internal/infrastructure/ai"
	"github.com/Q9Labs/chalk/internal/infrastructure/cloudflare"
	"github.com/Q9Labs/chalk/internal/infrastructure/jobs"
	"github.com/Q9Labs/chalk/internal/infrastructure/logging"
	infratel "github.com/Q9Labs/chalk/internal/infrastructure/otel"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	"github.com/Q9Labs/chalk/internal/infrastructure/redis"
	"github.com/Q9Labs/chalk/internal/infrastructure/storage"

	// Import to trigger provider registration
	_ "github.com/Q9Labs/chalk/internal/infrastructure/transcription"
	"github.com/Q9Labs/chalk/internal/interfaces/http"
	"github.com/google/uuid"
	"github.com/joho/godotenv"
)

func main() {
	ctx := context.Background()

	// Load .env file (ignore error if not found - production uses real env vars)
	err := godotenv.Load()
	if err != nil {
		fmt.Print("No .env found, continuing...")
	}

	logging.Init()
	defer logging.Close()

	infratel.Init(ctx)
	defer infratel.Shutdown(ctx)

	cfg, err := config.Load()
	if err != nil {
		slog.Error("failed to load configuration", "error", err)
		os.Exit(1)
	}

	missingR2 := []string{}
	if cfg.Storage.R2AccountID == "" {
		missingR2 = append(missingR2, "R2_ACCOUNT_ID")
	}
	if cfg.Storage.R2AccessKeyID == "" {
		missingR2 = append(missingR2, "R2_ACCESS_KEY_ID")
	}
	if cfg.Storage.R2SecretAccessKey == "" {
		missingR2 = append(missingR2, "R2_SECRET_ACCESS_KEY")
	}
	if cfg.Storage.R2BucketName == "" {
		missingR2 = append(missingR2, "R2_BUCKET_NAME")
	}
	if len(missingR2) > 0 {
		slog.Warn("r2 storage not fully configured", "missing", missingR2)
	} else {
		slog.Info("r2 storage configuration detected")
	}

	slog.Info("starting server", "env", cfg.Server.Env)

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

	if err := pool.RunMigrations(ctx); err != nil {
		slog.Error("failed to run database migrations", "error", err)
		os.Exit(1)
	}
	slog.Info("database migrations completed")

	redisClient, err := redis.NewClient(ctx, cfg.Redis.URL)
	if err != nil {
		slog.Error("failed to connect to Redis", "error", err)
		os.Exit(1)
	}
	defer redisClient.Close()

	slog.Info("connected to Redis")

	cfClient := cloudflare.NewClient(cloudflare.Config{
		AccountID: cfg.Cloudflare.AccountID,
		AppID:     cfg.Cloudflare.AppID,
		APIToken:  cfg.Cloudflare.APIToken,
		Mock:      cfg.Cloudflare.Mock,
	})

	slog.Info("initialized Cloudflare RealtimeKit client")

	if cfg.Cloudflare.Mock {
		slog.Warn("cloudflare mock enabled; skipping webhook setup")
	} else {
		configured, err := cloudflare.InitCloudflareWebhook(ctx, cfClient)
		if !configured && err != nil {
			slog.Warn("cloudflare webhook is not configured or failed", "error", err)
		} else {
			slog.Info("cloudflare webhook configured")
		}
	}

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

	queries := db.New(pool)
	transcriptionRegistry := transcription.NewProviderRegistry(transcription.RegistryConfig{
		GroqAPIKey:     cfg.PostMeeting.GroqAPIKey,
		WhisperEnabled: cfg.PostMeeting.WhisperEnabled,
		WhisperQueue:   cfg.PostMeeting.WhisperRedisQueue,
	}, redisClient.GetClient())

	var transcriptionService *transcription.Service
	if storageR2 != nil {
		transcriptionService = transcription.NewService(queries, transcriptionRegistry, storageR2)
		slog.Info("initialized post-meeting transcription service",
			"default_provider", transcriptionRegistry.GetDefaultProvider())
	} else {
		slog.Warn("post-meeting transcription service not initialized: R2 storage not configured")
	}

	var aiService *ai.Service
	if cfg.PostMeeting.OpenRouterAPIKey != "" {
		openRouterProvider := infraai.NewOpenRouterProvider(
			cfg.PostMeeting.OpenRouterAPIKey,
			cfg.PostMeeting.OpenRouterDefaultModel,
		)
		aiService = ai.NewService(openRouterProvider, queries)
		slog.Info("initialized AI service",
			"provider", "openrouter",
			"model", cfg.PostMeeting.OpenRouterDefaultModel)
	} else {
		slog.Warn("AI service not initialized: OpenRouter API key not configured")
	}

	webhookService := webhook.NewService(queries)

	var webhookStorageAdapter webhook.StorageService
	if storageR2 != nil {
		webhookStorageAdapter = storageR2
	}

	var webhookTranscriptionAdapter webhook.TranscriptionService
	if transcriptionService != nil {
		webhookTranscriptionAdapter = &transcriptionServiceAdapter{svc: transcriptionService}
	}

	postMeetingService := webhook.NewPostMeetingService(
		queries,
		webhookService,
		webhookTranscriptionAdapter,
		webhookStorageAdapter,
		slog.Default(),
	)

	router := http.NewRouter(http.RouterConfig{
		Pool:                            pool,
		CFClient:                        cfClient,
		RedisClient:                     redisClient,
		StorageR2:                       storageR2,
		StorageS3:                       storageS3,
		AppConfig:                       cfg,
		PostMeetingTranscriptionService: transcriptionService,
		PostMeetingService:              postMeetingService,
	})

	if transcriptionService != nil {
		tenantGetter := jobs.NewDBTenantGetter(queries)
		transcriptionWorker := jobs.NewTranscriptionWorker(
			transcriptionService,
			aiService,
			postMeetingService,
			queries,
			tenantGetter,
			slog.Default(),
		)
		go transcriptionWorker.Run(ctx)
		slog.Info("started transcription worker")
	}

	webhookWorker := jobs.NewWebhookWorker(queries, slog.Default())
	go webhookWorker.Run(ctx)
	slog.Info("started webhook worker")

	if storageR2 != nil && storageS3 != nil {
		queries := db.New(pool)
		lifecycleMgr := storage.NewRecordingLifecycleManager(
			storageR2,
			storageS3,
			queries,
			storage.DefaultLifecycleConfig(),
			slog.Default(),
		)
		go lifecycleMgr.Start(ctx)
		slog.Info("started recording lifecycle manager")
	}

	recChecker := jobs.NewRecordingChecker(router.Queries(), cfClient, router.RecordingService(), slog.Default())
	go recChecker.Run(ctx, 30*time.Minute)
	slog.Info("started recording checker", "interval", "30m")

	roomCleanup := jobs.NewRoomCleanup(router.Queries(), router.RoomService(), slog.Default())
	go roomCleanup.Run(ctx, 10*time.Minute, 30) // Check every 10min, cleanup rooms empty for 30min
	slog.Info("started room cleanup", "interval", "10m", "timeout", "30m")

	go func() {
		quit := make(chan os.Signal, 1)
		signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
		<-quit
		slog.Info("shutting down server")
		router.Close()
		pool.Close()
		os.Exit(0)
	}()

	addr := ":" + cfg.Server.Port
	slog.Info("starting server", "addr", addr)
	if err := router.Run(addr); err != nil {
		slog.Error("failed to start server", "error", err)
		os.Exit(1)
	}
}

type transcriptionServiceAdapter struct {
	svc *transcription.Service
}

func (a *transcriptionServiceAdapter) QueueTranscription(ctx context.Context, recordingID, roomID uuid.UUID, provider string) (uuid.UUID, error) {
	return a.svc.QueueTranscription(ctx, recordingID, roomID, provider)
}
