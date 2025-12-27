package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/Q9Labs/chalk/internal/config"
	"github.com/Q9Labs/chalk/internal/infrastructure/cloudflare"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres"
	"github.com/Q9Labs/chalk/internal/interfaces/http"
)

func main() {
	ctx := context.Background()

	// Load configuration
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("Failed to load configuration: %v", err)
	}

	log.Printf("Starting server in %s mode", cfg.Server.Env)

	// Database connection
	dbCfg := postgres.DefaultConfig()
	pool, err := postgres.NewPool(ctx, dbCfg)
	if err != nil {
		log.Fatalf("Failed to connect to database: %v", err)
	}
	defer pool.Close()

	log.Println("Connected to database")

	// Initialize Cloudflare RealtimeKit client
	cfClient := cloudflare.NewClient(cloudflare.Config{
		AccountID: cfg.Cloudflare.AccountID,
		AppID:     cfg.Cloudflare.AppID,
		APIToken:  cfg.Cloudflare.APIToken,
	})

	log.Println("Initialized Cloudflare RealtimeKit client")

	// Create router
	router := http.NewRouter(http.RouterConfig{
		Pool:     pool,
		CFClient: cfClient,
	})

	// Graceful shutdown
	go func() {
		quit := make(chan os.Signal, 1)
		signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
		<-quit
		log.Println("Shutting down server...")
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
