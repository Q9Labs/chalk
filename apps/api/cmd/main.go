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

	googleadapter "github.com/q9labs/chalk/apps/api/internal/adapters/google"
	passwordadapter "github.com/q9labs/chalk/apps/api/internal/adapters/password"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	postgressqlc "github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	redisadapter "github.com/q9labs/chalk/apps/api/internal/adapters/redis"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/memberships"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/users"
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

	diagnostics := observability.New(observability.Config{
		Environment:          cfg.Observability.Environment,
		LogFormat:            observability.LogFormat(cfg.Observability.LogFormat),
		LogLevel:             cfg.Observability.LogLevel,
		OperationLogs:        cfg.Observability.OperationLogs,
		Profiler:             cfg.Observability.Profiler,
		RequestLogs:          observability.RequestLogMode(cfg.Observability.RequestLogs),
		RequestSampleRate:    cfg.Observability.RequestSampleRate,
		Service:              cfg.Observability.Service,
		SlowRequestThreshold: cfg.Observability.SlowRequestThreshold,
		Version:              cfg.Observability.Version,
	}, os.Stdout)
	logger := diagnostics.Logger()
	logger.Info("api starting",
		"event", "api.starting",
		"address", cfg.API.Address,
		"log_format", cfg.Observability.LogFormat,
		"log_level", cfg.Observability.LogLevel,
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
	if cfg.GoogleOAuth.ClientID != "" || cfg.GoogleOAuth.ClientSecret != "" {
		provider, err := googleadapter.NewProvider(googleadapter.Config{
			ClientID:     cfg.GoogleOAuth.ClientID,
			ClientSecret: cfg.GoogleOAuth.ClientSecret,
			RedirectURL:  cfg.GoogleOAuth.RedirectURL,
		})
		if err != nil {
			return fmt.Errorf("configure google oauth: %w", err)
		}

		redisClient, err := redisadapter.Open(cfg.Redis.URL)
		if err != nil {
			return fmt.Errorf("open redis: %w", err)
		}
		defer redisClient.Close()
		logger.Info("redis connected", "event", "redis.connected")

		googleProvider = provider
		oauthStates = redisadapter.NewOAuthStateStore(redisClient)
	}
	authenticationService := authentication.NewService(authenticationRepository, passwords, googleProvider, oauthStates, authentication.Config{
		RequireEmailVerification: cfg.Auth.EmailVerificationRequired,
		OAuthStateTTL:            cfg.Auth.OAuthStateTTL,
		SessionTTL:               cfg.Auth.SessionTTL,
	})
	tenantRepository := postgres.NewTenantRepository(operationQueries)
	tenantService := tenants.NewService(tenantRepository)
	userRepository := postgres.NewUserRepository(operationQueries)
	userService := users.NewService(userRepository)
	membershipRepository := postgres.NewMembershipRepository(operationQueries)
	membershipService := memberships.NewService(membershipRepository)
	tenantAuthz := authorization.NewTenantPolicy(membershipRepository)
	routerOptions := httpapi.Options{
		CORS: httpapi.CORSOptions{
			AllowedOrigins: cfg.API.CORSAllowedOrigins,
		},
		Readiness:      postgres.Readiness{Pool: pool},
		Authentication: authenticationService,
		Memberships:    membershipService,
		SessionCookie: httpapi.SessionCookieOptions{
			Secure: cfg.Observability.Environment != "local",
		},
		TenantAuthz: tenantAuthz,
		Tenants:     tenantService,
		Users:       userService,
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

	select {
	case err := <-serverErr:
		return err
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

	logger.Info("api shutdown complete",
		"event", "api.shutdown_complete",
		"duration_ms", float64(time.Since(shutdownStartedAt).Microseconds())/1000,
	)
	return <-serverErr
}
