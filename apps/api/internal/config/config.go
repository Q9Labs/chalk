package config

import (
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenantlimits"
)

type APIConfig struct {
	DisableAuthenticatedRateLimits bool
	Address                        string
	CORSAllowedOrigins             []string
	LocalSystemToken               string
	ServicePrincipal               authentication.ServiceCredential
	OAuth                          OAuthConfig

	TrustedProxyCIDRs []string
}

type DeadlineSchedulerConfig struct {
	Interval time.Duration
	Batch    int32
}

type Config struct {
	ProblemReportsDiscordWebhookURL string
	TenantLimits                    tenantlimits.Config
	API                             APIConfig

	Capabilities       CapabilityConfig
	CloudflareRealtime CloudflareRealtimeConfig
	ChalkSFU           ChalkSFUConfig
	DefaultMediaPlane  spaces.MediaPlaneProvider
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
	Webhooks      WebhookConfig
}

// Load reads the process environment into one validated Config. Each section
// loads and validates itself; cross-section rules run last.
func Load() (Config, error) {
	environment := envOrDefault(APIEnvironment, DefaultEnvironment)
	cfg := Config{
		ProblemReportsDiscordWebhookURL: strings.TrimSpace(os.Getenv("CHALK_PROBLEM_REPORTS_DISCORD_WEBHOOK_URL")),
		RecordingBundleV2Enabled:        envBool(RecordingBundleV2Enabled),
		Redis:                           RedisConfig{URL: envOrDefault(RedisURL, DefaultRedisURL)},
	}
	for _, load := range []func(*Config, string) error{
		loadLimits,
		loadDatabase,
		loadAPI,
		loadCapabilities,
		loadObservability,
		loadIdentity,
		loadMediaPlane,
		loadRecordingStorage,
		loadTranscription,
	} {
		if err := load(&cfg, environment); err != nil {
			return Config{}, err
		}
	}
	if err := cfg.validateCapabilityDependencies(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func loadLimits(cfg *Config, _ string) error {
	admission, err := loadRecordingAdmission()
	if err != nil {
		return err
	}
	cfg.RecordingAdmission = admission
	for _, setting := range []struct {
		name   string
		target *int32
	}{
		{TenantMaxConcurrentRecordings, &cfg.TenantLimits.MaxConcurrentRecordings},
		{TenantDailyRecordingMinutes, &cfg.TenantLimits.DailyRecordingMinutes},
		{TenantMaxLiveEpisodes, &cfg.TenantLimits.MaxLiveEpisodes},
	} {
		value, err := envInt32(setting.name, 0)
		if err != nil {
			return err
		}
		if value < 0 {
			return fmt.Errorf("%s must be non-negative", setting.name)
		}
		*setting.target = value
	}
	return nil
}

func loadDatabase(cfg *Config, environment string) error {
	maxConns, err := envInt32(DatabaseMaxConns, DefaultDBMaxConns)
	if err != nil {
		return err
	}
	minConns, err := envInt32(DatabaseMinConns, DefaultDBMinConns)
	if err != nil {
		return err
	}
	if maxConns <= 0 {
		return fmt.Errorf("%s must be greater than zero", DatabaseMaxConns)
	}
	if minConns < 0 {
		return fmt.Errorf("%s must be non-negative", DatabaseMinConns)
	}
	if minConns > maxConns {
		return fmt.Errorf("%s cannot be greater than %s", DatabaseMinConns, DatabaseMaxConns)
	}
	interval, err := envMilliseconds(DeadlineSchedulerIntervalMS, DefaultDeadlineSchedulerIntervalMS)
	if err != nil {
		return err
	}
	batch, err := envInt32(DeadlineSchedulerBatch, DefaultDeadlineSchedulerBatch)
	if err != nil {
		return err
	}
	if interval <= 0 || batch <= 0 {
		return fmt.Errorf("deadline scheduler interval and batch must be greater than zero")
	}
	databaseURL := envOrDefault(DatabaseURL, DefaultDatabaseURL)
	if err := validateDatabaseURL(environment, databaseURL); err != nil {
		return err
	}
	cfg.Database = DatabaseConfig{URL: databaseURL, MaxConns: maxConns, MinConns: minConns}
	cfg.DeadlineScheduler = DeadlineSchedulerConfig{Interval: interval, Batch: batch}
	return nil
}

func loadAPI(cfg *Config, environment string) error {
	rateLimits, err := envEnum(APIRateLimits, "on", "on", "off")
	if err != nil {
		return err
	}
	if rateLimits == "off" && environment != DefaultEnvironment {
		return fmt.Errorf("%s=off is only allowed when %s=local", APIRateLimits, APIEnvironment)
	}
	localSystemToken := strings.TrimSpace(envOrDefault(APILocalSystemToken, ""))
	if environment != DefaultEnvironment && localSystemToken != "" {
		return fmt.Errorf("%s is only supported in local environments", APILocalSystemToken)
	}
	servicePrincipal, err := loadServicePrincipal(localSystemToken)
	if err != nil {
		return err
	}
	oauth, err := loadOAuthConfig(environment)
	if err != nil {
		return err
	}
	cfg.API = APIConfig{
		DisableAuthenticatedRateLimits: rateLimits == "off",
		Address:                        envOrDefault(APIAddress, DefaultAPIAddress),
		CORSAllowedOrigins:             envList(APICORSAllowedOrigins),
		LocalSystemToken:               localSystemToken,
		ServicePrincipal:               servicePrincipal,
		OAuth:                          oauth,
		TrustedProxyCIDRs:              envList(APITrustedProxyCIDRs),
	}
	return nil
}

func loadCapabilities(cfg *Config, environment string) error {
	capabilities, err := loadCapabilityConfig(environment)
	cfg.Capabilities = capabilities
	return err
}

// loadIdentity reads the credentials that identify callers and workers.
func loadIdentity(cfg *Config, environment string) error {
	var err error
	if cfg.SyncToken, err = loadSyncTokenConfig(environment); err != nil {
		return err
	}
	if cfg.Webhooks, err = loadWebhookEncryptionConfig(environment); err != nil {
		return err
	}
	if cfg.ProviderBridge, err = loadProviderBridgeConfig(environment); err != nil {
		return err
	}
	cfg.PublicInvite, err = loadPublicInviteConfig(environment)
	return err
}

// loadMediaPlane reads the media plane providers and checks them against each other.
func loadMediaPlane(cfg *Config, environment string) error {
	var err error
	if cfg.CloudflareRealtime, err = loadCloudflareRealtimeConfig(environment); err != nil {
		return err
	}
	if cfg.DefaultMediaPlane, err = loadDefaultMediaPlane(); err != nil {
		return err
	}
	if cfg.ChalkSFU, err = loadChalkSFUConfig(); err != nil {
		return err
	}
	if cfg.NewSpace, err = loadNewSpaceDefaults(cfg.ChalkSFU); err != nil {
		return err
	}
	if err := validateTurnProcessConfig(cfg.CloudflareRealtime); err != nil {
		return err
	}
	if err := validateMediaPlaneProcessConfig(cfg.DefaultMediaPlane, cfg.CloudflareRealtime, cfg.ChalkSFU); err != nil {
		return err
	}
	return validateProviderBridgeMediaPlaneProcessConfig(cfg.ProviderBridge, cfg.CloudflareRealtime)
}

func loadRecordingStorage(cfg *Config, _ string) error {
	var err error
	if cfg.R2, err = loadR2Config(); err != nil {
		return err
	}
	if cfg.RecordingKMS, err = loadRecordingKMSConfig(); err != nil {
		return err
	}
	cfg.RecorderFleetIssuer, err = loadRecorderFleetIssuerConfig()
	return err
}

func loadTranscription(cfg *Config, _ string) error {
	cfg.Transcription = TranscriptionConfig{
		WorkloadAuthSecret: envOrDefault(TranscriptionWorkloadAuthSecret, ""),
		ControlAudience:    envOrDefault(TranscriptionControlAudience, DefaultTranscriptionControlAudience),
		DispatcherFunction: envOrDefault(TranscriptionDispatcherFunction, ""),
	}
	return nil
}

// validateCapabilityDependencies checks that each enabled capability has the
// storage and credentials it needs.
func (cfg Config) validateCapabilityDependencies() error {
	if cfg.Capabilities.Recording {
		if err := validateR2Config(cfg.R2, RecordingEnabled); err != nil {
			return err
		}
		if cfg.RecordingKMS.KeyID == "" || cfg.RecordingKMS.Region == "" {
			return fmt.Errorf("%s and %s must be set when %s=true", RecordingKMSKeyID, RecordingKMSRegion, RecordingEnabled)
		}
	}
	if cfg.Capabilities.Transcription {
		if err := validateTranscriptionConfig(cfg.Transcription, cfg.R2); err != nil {
			return err
		}
	}
	if cfg.Capabilities.WhiteboardFiles {
		return validateWhiteboardFilesConfig(cfg.SyncToken, cfg.R2)
	}
	return nil
}
