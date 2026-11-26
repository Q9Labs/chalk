package config

import (
	"fmt"
	"os"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenantlimits"
)

type Config struct {
	ProblemReportsDiscordWebhookURL string
	TenantLimits                    tenantlimits.Config
	API                             APIConfig

	Capabilities CapabilityConfig
	TURN         CloudflareTURNConfig
	ChalkSFU     ChalkSFUConfig
	// NewSpace holds what a Create Space request gets for the fields it omits.
	// Each field is empty when new Spaces keep the existing default.
	NewSpace          spaces.NewSpaceDefaults
	Database          DatabaseConfig
	DeadlineScheduler DeadlineSchedulerConfig

	Observability            ObservabilityConfig
	PublicInvite             PublicInviteConfig
	ProviderBridge           ProviderBridgeConfig
	R2                       R2Config
	RecordingKMS             RecordingKMSConfig
	RecordingBundleV2Enabled bool
	RecorderFleetIssuer      RecorderFleetIssuerConfig
	RecordingAdmission       recordingpipeline.AdmissionLimits
	Redis                    RedisConfig

	SyncToken     SyncTokenConfig
	Transcription TranscriptionConfig
	Presenting    PresentingConfig
	Webhooks      WebhookConfig
}

func Load() (Config, error) {
	var cfg Config
	environment := envOrDefault(APIEnvironment, DefaultEnvironment)
	if err := cfg.loadBase(environment); err != nil {
		return Config{}, err
	}
	if err := cfg.loadTimeouts(); err != nil {
		return Config{}, err
	}
	if err := cfg.loadCredentials(environment); err != nil {
		return Config{}, err
	}
	if err := cfg.loadMedia(); err != nil {
		return Config{}, err
	}
	if err := cfg.loadStorage(); err != nil {
		return Config{}, err
	}

	cfg.API.Address = envOrDefault(APIAddress, DefaultAPIAddress)
	cfg.API.CORSAllowedOrigins = envList(APICORSAllowedOrigins)
	cfg.API.TrustedProxyCIDRs = envList(APITrustedProxyCIDRs)
	cfg.ProblemReportsDiscordWebhookURL = strings.TrimSpace(os.Getenv("CHALK_PROBLEM_REPORTS_DISCORD_WEBHOOK_URL"))
	cfg.RecordingBundleV2Enabled = envBool(RecordingBundleV2Enabled)
	cfg.Redis.URL = envOrDefault(RedisURL, DefaultRedisURL)
	return cfg, nil
}

func (cfg *Config) loadBase(environment string) error {
	var err error
	cfg.RecordingAdmission, err = loadRecordingAdmission()
	if err != nil {
		return err
	}
	cfg.TenantLimits, err = loadTenantLimits()
	if err != nil {
		return err
	}
	cfg.Database, cfg.DeadlineScheduler, err = loadDatabaseSettings()
	if err != nil {
		return err
	}
	rateLimits, err := envEnum(APIRateLimits, "on", "on", "off")
	if err != nil {
		return err
	}
	if rateLimits == "off" && environment != DefaultEnvironment {
		return fmt.Errorf("%s=off is only allowed when %s=local", APIRateLimits, APIEnvironment)
	}
	cfg.API.DisableAuthenticatedRateLimits = rateLimits == "off"
	cfg.Database.URL = envOrDefault(DatabaseURL, DefaultDatabaseURL)
	if err := validateDatabaseURL(environment, cfg.Database.URL); err != nil {
		return err
	}
	cfg.Capabilities, err = loadCapabilityConfig(environment)
	if err != nil {
		return err
	}
	cfg.Observability, err = loadObservability(environment)
	if err != nil {
		return err
	}
	return nil
}

func (cfg *Config) loadCredentials(environment string) error {
	var err error
	cfg.API.LocalSystemToken = strings.TrimSpace(envOrDefault(APILocalSystemToken, ""))
	if environment != DefaultEnvironment && cfg.API.LocalSystemToken != "" {
		return fmt.Errorf("%s is only supported in local environments", APILocalSystemToken)
	}
	cfg.API.ServicePrincipal, err = loadServicePrincipal(cfg.API.LocalSystemToken)
	if err != nil {
		return err
	}
	cfg.API.OAuth, err = loadOAuthConfig(environment)
	if err != nil {
		return err
	}
	cfg.SyncToken, err = loadSyncTokenConfig(environment)
	if err != nil {
		return err
	}
	cfg.Webhooks, err = loadWebhookEncryptionConfig(environment)
	if err != nil {
		return err
	}
	cfg.ProviderBridge, err = loadProviderBridgeConfig(environment)
	if err != nil {
		return err
	}
	cfg.PublicInvite, err = loadPublicInviteConfig(environment)
	if err != nil {
		return err
	}
	return nil
}
