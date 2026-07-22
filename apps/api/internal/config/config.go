package config

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	APIAddress            = "CHALK_API_ADDR"
	APICORSAllowedOrigins = "CHALK_API_CORS_ALLOWED_ORIGINS"
	APIEnvironment        = "CHALK_API_ENV"
	APITrustedProxyCIDRs  = "CHALK_API_TRUSTED_PROXY_CIDRS"
	APILogFormat          = "CHALK_API_LOG_FORMAT"
	APILogLevel           = "CHALK_API_LOG_LEVEL"
	APIOTLPEndpoint       = "CHALK_API_OTLP_ENDPOINT"
	APIOTLPInsecure       = "CHALK_API_OTLP_INSECURE"
	APIOperationLogs      = "CHALK_API_OPERATION_LOGS"
	APIProfiler           = "CHALK_API_PROFILER"
	APIRequestLogs        = "CHALK_API_REQUEST_LOGS"
	APIRequestSampleRate  = "CHALK_API_REQUEST_SAMPLE_RATE"
	APIService            = "CHALK_API_SERVICE"
	APISlowRequestMS      = "CHALK_API_SLOW_REQUEST_MS"
	APILocalSystemToken   = "CHALK_API_LOCAL_SYSTEM_TOKEN"
	APIVersion            = "CHALK_API_VERSION"

	AuthEmailVerificationRequired = "CHALK_AUTH_EMAIL_VERIFICATION_REQUIRED"
	AuthOAuthStateTTLMS           = "CHALK_AUTH_OAUTH_STATE_TTL_MS"
	AuthSessionTTLMS              = "CHALK_AUTH_SESSION_TTL_MS"
	SyncTokenAudience             = "CHALK_SYNC_TOKEN_AUDIENCE"
	SyncTokenIssuer               = "CHALK_SYNC_TOKEN_ISSUER"
	SyncTokenKeyID                = "CHALK_SYNC_TOKEN_KEY_ID"
	SyncTokenPrivateKey           = "CHALK_SYNC_TOKEN_PRIVATE_KEY"
	MediaTokenVerificationKeys    = "CHALK_MEDIA_TOKEN_VERIFICATION_KEYS"

	DatabaseURL                 = "CHALK_DATABASE_URL"
	DatabaseMaxConns            = "CHALK_DATABASE_MAX_CONNS"
	DatabaseMinConns            = "CHALK_DATABASE_MIN_CONNS"
	DeadlineSchedulerIntervalMS = "CHALK_DEADLINE_SCHEDULER_INTERVAL_MS"
	DeadlineSchedulerBatch      = "CHALK_DEADLINE_SCHEDULER_BATCH"

	GoogleOAuthClientID     = "CHALK_GOOGLE_OAUTH_CLIENT_ID"
	GoogleOAuthClientSecret = "CHALK_GOOGLE_OAUTH_CLIENT_SECRET"
	GoogleOAuthRedirectURL  = "CHALK_GOOGLE_OAUTH_REDIRECT_URL"

	RedisURL = "CHALK_REDIS_URL"

	CloudflareAccountID                = "CHALK_CLOUDFLARE_ACCOUNT_ID"
	CloudflareAPIToken                 = "CHALK_CLOUDFLARE_API_TOKEN"
	CloudflareRealtimeAppID            = "CHALK_CLOUDFLARE_REALTIME_APP_ID"
	CloudflareRealtimeAppSecret        = "CHALK_CLOUDFLARE_REALTIME_APP_SECRET"
	CloudflareRealtimeBaseURL          = "CHALK_CLOUDFLARE_REALTIME_BASE_URL"
	CloudflareRTKAppID                 = "CHALK_CLOUDFLARE_RTK_APP_ID"
	CloudflareRTKTokenOrgID            = "CHALK_CLOUDFLARE_RTK_TOKEN_ORG_ID"
	CloudflareRTKPresetFacilitator     = "CHALK_CLOUDFLARE_RTK_PRESET_FACILITATOR"
	CloudflareRTKPresetContributor     = "CHALK_CLOUDFLARE_RTK_PRESET_CONTRIBUTOR"
	CloudflareRealtimeRequestTimeoutMS = "CHALK_CLOUDFLARE_REALTIME_TIMEOUT_MS"

	ProviderBridgeAddress           = "CHALK_PROVIDER_BRIDGE_ADDRESS"
	ProviderBridgeServerCertFile    = "CHALK_PROVIDER_BRIDGE_SERVER_CERT_FILE"
	ProviderBridgeServerKeyFile     = "CHALK_PROVIDER_BRIDGE_SERVER_KEY_FILE"
	ProviderBridgeClientCAFile      = "CHALK_PROVIDER_BRIDGE_CLIENT_CA_FILE"
	ProviderBridgeSPIFFETrustDomain = "CHALK_PROVIDER_BRIDGE_SPIFFE_TRUST_DOMAIN"

	ComposioAPIKey        = "CHALK_COMPOSIO_API_KEY"
	ComposioBaseURL       = "CHALK_COMPOSIO_BASE_URL"
	ComposioTimeoutMS     = "CHALK_COMPOSIO_TIMEOUT_MS"
	ComposioWebhookSecret = "CHALK_COMPOSIO_WEBHOOK_SECRET"
	IntegrationsEnabled   = "CHALK_INTEGRATIONS_ENABLED"

	R2AccessKeyID                   = "CHALK_R2_ACCESS_KEY_ID"
	R2AccountID                     = "CHALK_R2_ACCOUNT_ID"
	R2Bucket                        = "CHALK_R2_BUCKET"
	R2Endpoint                      = "CHALK_R2_ENDPOINT"
	R2SecretAccessKey               = "CHALK_R2_SECRET_ACCESS_KEY"
	R2RequestTimeoutMS              = "CHALK_R2_REQUEST_TIMEOUT_MS"
	TranscriptionWorkloadAuthSecret = "CHALK_TRANSCRIPTION_WORKLOAD_AUTH_SECRET"
	TranscriptionControlAudience    = "CHALK_TRANSCRIPTION_CONTROL_AUDIENCE"
	TranscriptionDispatcherFunction = "CHALK_TRANSCRIPTION_DISPATCHER_FUNCTION_NAME"
	TranscriptionEnabled            = "CHALK_TRANSCRIPTION_ENABLED"

	ResendAPIKey                    = "CHALK_RESEND_API_KEY"
	ResendTimeoutMS                 = "CHALK_RESEND_TIMEOUT_MS"
	WebhookEncryptionKey            = "CHALK_WEBHOOK_ENCRYPTION_KEY"
	WebhookEncryptionKeyring        = "CHALK_WEBHOOK_ENCRYPTION_KEYRING"
	WebhookEncryptionCurrentVersion = "CHALK_WEBHOOK_ENCRYPTION_CURRENT_VERSION"

	DefaultAPIAddress                         = ":8080"
	DefaultDatabaseURL                        = "postgres://postgres:postgres@127.0.0.1:5432/chalk?sslmode=disable"
	DefaultDBMaxConns                         = int32(10)
	DefaultDBMinConns                         = int32(0)
	DefaultDeadlineSchedulerIntervalMS        = int64(1000)
	DefaultDeadlineSchedulerBatch             = int32(50)
	DefaultEnvironment                        = "local"
	DefaultGoogleRedirectURL                  = "http://127.0.0.1:8080/v1/auth/google/callback"
	DefaultLogFormat                          = "json"
	DefaultLogLevel                           = "info"
	DefaultOAuthStateTTLMS                    = int64(10 * 60 * 1000)
	DefaultCloudflareRealtimeRequestTimeoutMS = int64(10000)
	DefaultComposioBaseURL                    = "https://backend.composio.dev/api/v3.1"
	DefaultComposioTimeoutMS                  = int64(10000)
	DefaultCloudflareRTKPresetContributor     = "contributor"
	DefaultCloudflareRTKPresetFacilitator     = "facilitator"
	DefaultRequestLogs                        = "off"
	DefaultRequestSampleRate                  = 0.01
	DefaultR2RequestTimeoutMS                 = int64(10000)
	DefaultTranscriptionControlAudience       = "chalk-control-api"
	DefaultRedisURL                           = "redis://127.0.0.1:6379/0"
	DefaultResendTimeoutMS                    = int64(10000)
	DefaultSessionTTLMS                       = int64(30 * 24 * 60 * 60 * 1000)
	DefaultServiceName                        = "chalk-api"
	DefaultSlowRequestMS                      = int64(250)
	DefaultVersion                            = "dev"

	DefaultOAuthStateTTL             = time.Duration(DefaultOAuthStateTTLMS) * time.Millisecond
	DefaultCloudflareRealtimeTimeout = time.Duration(DefaultCloudflareRealtimeRequestTimeoutMS) * time.Millisecond
	DefaultComposioTimeout           = time.Duration(DefaultComposioTimeoutMS) * time.Millisecond
	DefaultR2Timeout                 = time.Duration(DefaultR2RequestTimeoutMS) * time.Millisecond
	DefaultResendTimeout             = time.Duration(DefaultResendTimeoutMS) * time.Millisecond
	DefaultSessionTTL                = time.Duration(DefaultSessionTTLMS) * time.Millisecond
)

type APIConfig struct {
	Address            string
	CORSAllowedOrigins []string
	LocalSystemToken   string
	TrustedProxyCIDRs  []string
}

type CapabilityConfig struct {
	Integrations  bool
	Transcription bool
}

type DatabaseConfig struct {
	URL      string
	MaxConns int32
	MinConns int32
}

type RedisConfig struct {
	URL string
}

type CloudflareRealtimeConfig struct {
	AccountID            string
	APIToken             string
	RealtimeAppID        string
	RealtimeAppSecret    string
	RealtimeBaseURL      string
	RTKAppID             string
	RTKTokenOrgID        string
	RTKPresetFacilitator string
	RTKPresetContributor string
	RequestTimeout       time.Duration
}

type ProviderBridgeConfig struct {
	Address           string
	ServerCertFile    string
	ServerKeyFile     string
	ClientCAFile      string
	SPIFFETrustDomain string
	Enabled           bool
}

type ComposioConfig struct {
	APIKey         string
	BaseURL        string
	RequestTimeout time.Duration
	WebhookSecret  string
}

type R2Config struct {
	AccessKeyID     string
	AccountID       string
	Bucket          string
	Endpoint        string
	SecretAccessKey string
	RequestTimeout  time.Duration
}

type TranscriptionConfig struct {
	WorkloadAuthSecret string
	ControlAudience    string
	DispatcherFunction string
}

type AuthConfig struct {
	EmailVerificationRequired bool
	OAuthStateTTL             time.Duration
	SessionTTL                time.Duration
}

type SyncTokenConfig struct {
	Audience         string
	Issuer           string
	KeyID            string
	PrivateKey       ed25519.PrivateKey
	VerificationKeys map[string]ed25519.PublicKey
}

type GoogleOAuthConfig struct {
	ClientID     string
	ClientSecret string
	RedirectURL  string
}

type ResendConfig struct {
	APIKey  string
	Timeout time.Duration
}

type ObservabilityConfig struct {
	Environment          string
	LogFormat            string
	LogLevel             string
	OTLPEndpoint         string
	OTLPInsecure         bool
	OperationLogs        bool
	Profiler             bool
	RequestLogs          string
	RequestSampleRate    float64
	Service              string
	SlowRequestThreshold time.Duration
	Version              string
}

type WebhookConfig struct {
	EncryptionKey     []byte
	EncryptionKeys    map[byte][]byte
	CurrentKeyVersion byte
}

type DeadlineSchedulerConfig struct {
	Interval time.Duration
	Batch    int32
}

type Config struct {
	API                APIConfig
	Auth               AuthConfig
	Capabilities       CapabilityConfig
	CloudflareRealtime CloudflareRealtimeConfig
	Composio           ComposioConfig
	Database           DatabaseConfig
	DeadlineScheduler  DeadlineSchedulerConfig
	GoogleOAuth        GoogleOAuthConfig
	Observability      ObservabilityConfig
	ProviderBridge     ProviderBridgeConfig
	R2                 R2Config
	Redis              RedisConfig
	Resend             ResendConfig
	SyncToken          SyncTokenConfig
	Transcription      TranscriptionConfig
	Webhooks           WebhookConfig
}

func Load() (Config, error) {
	maxConns, err := envInt32(DatabaseMaxConns, DefaultDBMaxConns)
	if err != nil {
		return Config{}, err
	}

	minConns, err := envInt32(DatabaseMinConns, DefaultDBMinConns)
	if err != nil {
		return Config{}, err
	}

	if maxConns <= 0 {
		return Config{}, fmt.Errorf("%s must be greater than zero", DatabaseMaxConns)
	}
	if minConns < 0 {
		return Config{}, fmt.Errorf("%s must be non-negative", DatabaseMinConns)
	}
	if minConns > maxConns {
		return Config{}, fmt.Errorf("%s cannot be greater than %s", DatabaseMinConns, DatabaseMaxConns)
	}
	deadlineSchedulerInterval, err := envMilliseconds(DeadlineSchedulerIntervalMS, DefaultDeadlineSchedulerIntervalMS)
	if err != nil {
		return Config{}, err
	}
	deadlineSchedulerBatch, err := envInt32(DeadlineSchedulerBatch, DefaultDeadlineSchedulerBatch)
	if err != nil {
		return Config{}, err
	}
	if deadlineSchedulerInterval <= 0 || deadlineSchedulerBatch <= 0 {
		return Config{}, fmt.Errorf("deadline scheduler interval and batch must be greater than zero")
	}
	environment := envOrDefault(APIEnvironment, DefaultEnvironment)
	capabilities, err := loadCapabilityConfig(environment)
	if err != nil {
		return Config{}, err
	}
	databaseURL := envOrDefault(DatabaseURL, DefaultDatabaseURL)
	if err := validateDatabaseURL(environment, databaseURL); err != nil {
		return Config{}, err
	}

	sessionTTL, err := envMilliseconds(AuthSessionTTLMS, DefaultSessionTTLMS)
	if err != nil {
		return Config{}, err
	}
	if sessionTTL <= 0 {
		return Config{}, fmt.Errorf("%s must be greater than zero", AuthSessionTTLMS)
	}
	oauthStateTTL, err := envMilliseconds(AuthOAuthStateTTLMS, DefaultOAuthStateTTLMS)
	if err != nil {
		return Config{}, err
	}
	if oauthStateTTL <= 0 {
		return Config{}, fmt.Errorf("%s must be greater than zero", AuthOAuthStateTTLMS)
	}

	logFormat, err := envEnum(APILogFormat, DefaultLogFormat, "json", "text")
	if err != nil {
		return Config{}, err
	}
	logLevel, err := envEnum(APILogLevel, DefaultLogLevel, "debug", "info", "warn", "error")
	if err != nil {
		return Config{}, err
	}
	otlpEndpoint := strings.TrimSpace(envOrDefault(APIOTLPEndpoint, ""))
	otlpInsecure := envBool(APIOTLPInsecure)
	if err := validateOTLPEndpoint(environment, otlpEndpoint, otlpInsecure); err != nil {
		return Config{}, err
	}
	operationLogs := envBool(APIOperationLogs)
	requestLogs, err := envRequestLogs(operationLogs)
	if err != nil {
		return Config{}, err
	}
	requestSampleRate, err := envFloat64(APIRequestSampleRate, DefaultRequestSampleRate)
	if err != nil {
		return Config{}, err
	}
	if requestSampleRate < 0 || requestSampleRate > 1 {
		return Config{}, fmt.Errorf("%s must be between 0 and 1", APIRequestSampleRate)
	}
	slowRequestThreshold, err := envMilliseconds(APISlowRequestMS, DefaultSlowRequestMS)
	if err != nil {
		return Config{}, err
	}
	if slowRequestThreshold < 0 {
		return Config{}, fmt.Errorf("%s must be non-negative", APISlowRequestMS)
	}
	resendTimeout, err := envMilliseconds(ResendTimeoutMS, DefaultResendTimeoutMS)
	if err != nil {
		return Config{}, err
	}
	if resendTimeout <= 0 {
		return Config{}, fmt.Errorf("%s must be greater than zero", ResendTimeoutMS)
	}
	r2RequestTimeout, err := envMilliseconds(R2RequestTimeoutMS, DefaultR2RequestTimeoutMS)
	if err != nil {
		return Config{}, err
	}
	if r2RequestTimeout <= 0 {
		return Config{}, fmt.Errorf("%s must be greater than zero", R2RequestTimeoutMS)
	}
	cloudflareRealtimeRequestTimeout, err := envMilliseconds(CloudflareRealtimeRequestTimeoutMS, DefaultCloudflareRealtimeRequestTimeoutMS)
	if err != nil {
		return Config{}, err
	}
	if cloudflareRealtimeRequestTimeout <= 0 {
		return Config{}, fmt.Errorf("%s must be greater than zero", CloudflareRealtimeRequestTimeoutMS)
	}
	composioTimeout, err := envMilliseconds(ComposioTimeoutMS, DefaultComposioTimeoutMS)
	if err != nil {
		return Config{}, err
	}
	if composioTimeout <= 0 {
		return Config{}, fmt.Errorf("%s must be greater than zero", ComposioTimeoutMS)
	}
	composioAPIKey := envOrDefault(ComposioAPIKey, "")
	if capabilities.Integrations && strings.TrimSpace(composioAPIKey) == "" {
		return Config{}, fmt.Errorf("%s must be set when %s=true", ComposioAPIKey, IntegrationsEnabled)
	}
	localSystemToken := strings.TrimSpace(envOrDefault(APILocalSystemToken, ""))
	if environment != DefaultEnvironment && localSystemToken != "" {
		return Config{}, fmt.Errorf("%s is only supported in local environments", APILocalSystemToken)
	}
	syncToken, err := loadSyncTokenConfig(environment)
	if err != nil {
		return Config{}, err
	}
	webhookConfig, err := loadWebhookEncryptionConfig(environment)
	if err != nil {
		return Config{}, err
	}
	providerBridge, err := loadProviderBridgeConfig(environment)
	if err != nil {
		return Config{}, err
	}
	realtimeBaseURL := strings.TrimRight(strings.TrimSpace(envOrDefault(CloudflareRealtimeBaseURL, "")), "/")
	if realtimeBaseURL != "" {
		if environment != DefaultEnvironment {
			return Config{}, fmt.Errorf("%s is only supported in local environments", CloudflareRealtimeBaseURL)
		}
		parsed, parseErr := url.Parse(realtimeBaseURL)
		host := parsed.Hostname()
		ip := net.ParseIP(host)
		if parseErr != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.RawQuery != "" || parsed.Fragment != "" || (host != "localhost" && (ip == nil || !ip.IsLoopback())) {
			return Config{}, fmt.Errorf("%s must be an absolute localhost URL without query or fragment", CloudflareRealtimeBaseURL)
		}
	}
	r2Config := R2Config{
		AccessKeyID:     envOrDefault(R2AccessKeyID, ""),
		AccountID:       envOrDefault(R2AccountID, ""),
		Bucket:          envOrDefault(R2Bucket, ""),
		Endpoint:        envOrDefault(R2Endpoint, ""),
		SecretAccessKey: envOrDefault(R2SecretAccessKey, ""),
		RequestTimeout:  r2RequestTimeout,
	}
	transcriptionConfig := TranscriptionConfig{
		WorkloadAuthSecret: envOrDefault(TranscriptionWorkloadAuthSecret, ""),
		ControlAudience:    envOrDefault(TranscriptionControlAudience, DefaultTranscriptionControlAudience),
		DispatcherFunction: envOrDefault(TranscriptionDispatcherFunction, ""),
	}
	if capabilities.Transcription {
		if err := validateTranscriptionConfig(transcriptionConfig, r2Config); err != nil {
			return Config{}, err
		}
	}

	return Config{
		API: APIConfig{
			Address:            envOrDefault(APIAddress, DefaultAPIAddress),
			CORSAllowedOrigins: envList(APICORSAllowedOrigins),
			LocalSystemToken:   localSystemToken,
			TrustedProxyCIDRs:  envList(APITrustedProxyCIDRs),
		},
		Auth: AuthConfig{
			EmailVerificationRequired: envBool(AuthEmailVerificationRequired),
			OAuthStateTTL:             oauthStateTTL,
			SessionTTL:                sessionTTL,
		},
		Capabilities: capabilities,
		CloudflareRealtime: CloudflareRealtimeConfig{
			AccountID:            envOrDefault(CloudflareAccountID, ""),
			APIToken:             envOrDefault(CloudflareAPIToken, ""),
			RealtimeAppID:        envOrDefault(CloudflareRealtimeAppID, ""),
			RealtimeAppSecret:    envOrDefault(CloudflareRealtimeAppSecret, ""),
			RealtimeBaseURL:      realtimeBaseURL,
			RTKAppID:             envOrDefault(CloudflareRTKAppID, ""),
			RTKTokenOrgID:        envOrDefault(CloudflareRTKTokenOrgID, ""),
			RTKPresetFacilitator: envOrDefault(CloudflareRTKPresetFacilitator, DefaultCloudflareRTKPresetFacilitator),
			RTKPresetContributor: envOrDefault(CloudflareRTKPresetContributor, DefaultCloudflareRTKPresetContributor),
			RequestTimeout:       cloudflareRealtimeRequestTimeout,
		},
		Composio: ComposioConfig{
			APIKey:         composioAPIKey,
			BaseURL:        envOrDefault(ComposioBaseURL, DefaultComposioBaseURL),
			RequestTimeout: composioTimeout,
			WebhookSecret:  envOrDefault(ComposioWebhookSecret, ""),
		},
		Database: DatabaseConfig{
			URL:      databaseURL,
			MaxConns: maxConns,
			MinConns: minConns,
		},
		DeadlineScheduler: DeadlineSchedulerConfig{Interval: deadlineSchedulerInterval, Batch: deadlineSchedulerBatch},
		GoogleOAuth: GoogleOAuthConfig{
			ClientID:     envOrDefault(GoogleOAuthClientID, ""),
			ClientSecret: envOrDefault(GoogleOAuthClientSecret, ""),
			RedirectURL:  envOrDefault(GoogleOAuthRedirectURL, DefaultGoogleRedirectURL),
		},
		Observability: ObservabilityConfig{
			Environment:          environment,
			LogFormat:            logFormat,
			LogLevel:             logLevel,
			OTLPEndpoint:         otlpEndpoint,
			OTLPInsecure:         otlpInsecure,
			OperationLogs:        operationLogs,
			Profiler:             envBool(APIProfiler),
			RequestLogs:          requestLogs,
			RequestSampleRate:    requestSampleRate,
			Service:              envOrDefault(APIService, DefaultServiceName),
			SlowRequestThreshold: slowRequestThreshold,
			Version:              envOrDefault(APIVersion, DefaultVersion),
		},
		ProviderBridge: providerBridge,
		R2:             r2Config,
		Redis: RedisConfig{
			URL: envOrDefault(RedisURL, DefaultRedisURL),
		},
		Resend: ResendConfig{
			APIKey:  envOrDefault(ResendAPIKey, ""),
			Timeout: resendTimeout,
		},
		SyncToken:     syncToken,
		Transcription: transcriptionConfig,
		Webhooks:      webhookConfig,
	}, nil
}

func loadCapabilityConfig(environment string) (CapabilityConfig, error) {
	defaultEnabled := environment != DefaultEnvironment
	integrations, err := envStrictBool(IntegrationsEnabled, defaultEnabled)
	if err != nil {
		return CapabilityConfig{}, err
	}
	transcription, err := envStrictBool(TranscriptionEnabled, defaultEnabled)
	if err != nil {
		return CapabilityConfig{}, err
	}
	return CapabilityConfig{Integrations: integrations, Transcription: transcription}, nil
}

func validateTranscriptionConfig(transcription TranscriptionConfig, r2 R2Config) error {
	if len(transcription.WorkloadAuthSecret) < 32 {
		return fmt.Errorf("%s must contain at least 32 bytes when %s=true", TranscriptionWorkloadAuthSecret, TranscriptionEnabled)
	}
	if strings.TrimSpace(transcription.DispatcherFunction) == "" {
		return fmt.Errorf("%s must be set when %s=true", TranscriptionDispatcherFunction, TranscriptionEnabled)
	}
	if strings.TrimSpace(r2.Bucket) == "" || (strings.TrimSpace(r2.AccountID) == "" && strings.TrimSpace(r2.Endpoint) == "") || strings.TrimSpace(r2.AccessKeyID) == "" || strings.TrimSpace(r2.SecretAccessKey) == "" {
		return fmt.Errorf("%s, either %s or %s, %s, and %s must be set when %s=true", R2Bucket, R2AccountID, R2Endpoint, R2AccessKeyID, R2SecretAccessKey, TranscriptionEnabled)
	}
	return nil
}

func loadProviderBridgeConfig(environment string) (ProviderBridgeConfig, error) {
	config := ProviderBridgeConfig{
		Address:           strings.TrimSpace(envOrDefault(ProviderBridgeAddress, "")),
		ServerCertFile:    strings.TrimSpace(envOrDefault(ProviderBridgeServerCertFile, "")),
		ServerKeyFile:     strings.TrimSpace(envOrDefault(ProviderBridgeServerKeyFile, "")),
		ClientCAFile:      strings.TrimSpace(envOrDefault(ProviderBridgeClientCAFile, "")),
		SPIFFETrustDomain: strings.TrimSpace(envOrDefault(ProviderBridgeSPIFFETrustDomain, "")),
	}
	configured := 0
	for _, value := range []string{config.Address, config.ServerCertFile, config.ServerKeyFile, config.ClientCAFile, config.SPIFFETrustDomain} {
		if value != "" {
			configured++
		}
	}
	if configured == 0 {
		if environment == DefaultEnvironment {
			return config, nil
		}
		return ProviderBridgeConfig{}, fmt.Errorf("%s, %s, %s, %s, and %s must be set outside local environments", ProviderBridgeAddress, ProviderBridgeServerCertFile, ProviderBridgeServerKeyFile, ProviderBridgeClientCAFile, ProviderBridgeSPIFFETrustDomain)
	}
	if configured != 5 {
		return ProviderBridgeConfig{}, fmt.Errorf("%s, %s, %s, %s, and %s must be set together", ProviderBridgeAddress, ProviderBridgeServerCertFile, ProviderBridgeServerKeyFile, ProviderBridgeClientCAFile, ProviderBridgeSPIFFETrustDomain)
	}
	if _, _, err := net.SplitHostPort(config.Address); err != nil {
		return ProviderBridgeConfig{}, fmt.Errorf("%s must be a host:port listener address", ProviderBridgeAddress)
	}
	if !validSPIFFETrustDomain(config.SPIFFETrustDomain) {
		return ProviderBridgeConfig{}, fmt.Errorf("%s must be a SPIFFE trust domain", ProviderBridgeSPIFFETrustDomain)
	}
	config.Enabled = true
	return config, nil
}

func validSPIFFETrustDomain(value string) bool {
	if len(value) == 0 || len(value) > 255 || value != strings.ToLower(value) || strings.HasPrefix(value, ".") || strings.HasSuffix(value, ".") {
		return false
	}
	for _, label := range strings.Split(value, ".") {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, character := range label {
			if (character < 'a' || character > 'z') && (character < '0' || character > '9') && character != '-' {
				return false
			}
		}
	}
	return true
}

func loadWebhookEncryptionKey(environment string) ([]byte, error) {
	encoded := strings.TrimSpace(envOrDefault(WebhookEncryptionKey, ""))
	if encoded != "" {
		decoded, err := base64.StdEncoding.DecodeString(encoded)
		if err == nil && len(decoded) == 32 {
			return decoded, nil
		}
		return nil, fmt.Errorf("%s must be base64-encoded 32 bytes", WebhookEncryptionKey)
	}
	if environment == DefaultEnvironment {
		return []byte("chalk-local-webhook-key-32-bytes"), nil
	}
	return nil, fmt.Errorf("%s must be set outside local environments", WebhookEncryptionKey)
}

func loadWebhookEncryptionConfig(environment string) (WebhookConfig, error) {
	keyring := strings.TrimSpace(envOrDefault(WebhookEncryptionKeyring, ""))
	if keyring == "" {
		key, err := loadWebhookEncryptionKey(environment)
		return WebhookConfig{EncryptionKey: key, EncryptionKeys: map[byte][]byte{1: key}, CurrentKeyVersion: 1}, err
	}
	current, err := strconv.Atoi(strings.TrimSpace(envOrDefault(WebhookEncryptionCurrentVersion, "")))
	if err != nil || current < 1 || current > 255 {
		return WebhookConfig{}, fmt.Errorf("%s must be an integer from 1 through 255", WebhookEncryptionCurrentVersion)
	}
	keys := make(map[byte][]byte)
	for _, entry := range strings.Split(keyring, ",") {
		versionAndKey := strings.SplitN(strings.TrimSpace(entry), ":", 2)
		version, versionErr := strconv.Atoi(versionAndKey[0])
		if len(versionAndKey) != 2 || versionErr != nil || version < 1 || version > 255 {
			return WebhookConfig{}, fmt.Errorf("%s entries must use version:base64-key", WebhookEncryptionKeyring)
		}
		decoded, decodeErr := base64.StdEncoding.DecodeString(versionAndKey[1])
		if decodeErr != nil || len(decoded) != 32 {
			return WebhookConfig{}, fmt.Errorf("%s keys must be base64-encoded 32 bytes", WebhookEncryptionKeyring)
		}
		if _, duplicate := keys[byte(version)]; duplicate {
			return WebhookConfig{}, fmt.Errorf("%s contains duplicate version %d", WebhookEncryptionKeyring, version)
		}
		keys[byte(version)] = decoded
	}
	if keys[byte(current)] == nil {
		return WebhookConfig{}, fmt.Errorf("%s is absent from %s", WebhookEncryptionCurrentVersion, WebhookEncryptionKeyring)
	}
	return WebhookConfig{EncryptionKey: keys[byte(current)], EncryptionKeys: keys, CurrentKeyVersion: byte(current)}, nil
}

func loadSyncTokenConfig(environment string) (SyncTokenConfig, error) {
	config := SyncTokenConfig{
		Audience: strings.TrimSpace(envOrDefault(SyncTokenAudience, "")),
		Issuer:   strings.TrimSpace(envOrDefault(SyncTokenIssuer, "")),
		KeyID:    strings.TrimSpace(envOrDefault(SyncTokenKeyID, "")),
	}
	encodedKey := strings.TrimSpace(envOrDefault(SyncTokenPrivateKey, ""))
	if config.Audience == "" && config.Issuer == "" && config.KeyID == "" && encodedKey == "" && environment != "production" {
		return config, nil
	}
	if config.Audience == "" || config.Issuer == "" || config.KeyID == "" || encodedKey == "" {
		return SyncTokenConfig{}, fmt.Errorf("%s, %s, %s, and %s must be set together", SyncTokenAudience, SyncTokenIssuer, SyncTokenKeyID, SyncTokenPrivateKey)
	}
	if config.Audience == "chalk-media" {
		return SyncTokenConfig{}, fmt.Errorf("%s must differ from the participant media audience", SyncTokenAudience)
	}
	key, err := base64.RawURLEncoding.DecodeString(encodedKey)
	if err != nil || len(key) != ed25519.PrivateKeySize {
		return SyncTokenConfig{}, fmt.Errorf("%s must be an unpadded base64url Ed25519 private key", SyncTokenPrivateKey)
	}
	config.PrivateKey = ed25519.PrivateKey(key)
	currentPublicKey := append(ed25519.PublicKey(nil), config.PrivateKey.Public().(ed25519.PublicKey)...)
	config.VerificationKeys = map[string]ed25519.PublicKey{config.KeyID: currentPublicKey}
	encodedVerificationKeys := strings.TrimSpace(envOrDefault(MediaTokenVerificationKeys, ""))
	if encodedVerificationKeys == "" {
		return config, nil
	}
	var keyring map[string]string
	if err := json.Unmarshal([]byte(encodedVerificationKeys), &keyring); err != nil || len(keyring) == 0 {
		return SyncTokenConfig{}, fmt.Errorf("%s must be a non-empty JSON object of key IDs to unpadded base64url Ed25519 public keys", MediaTokenVerificationKeys)
	}
	for keyID, encoded := range keyring {
		keyID = strings.TrimSpace(keyID)
		publicKey, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(encoded))
		if keyID == "" || err != nil || len(publicKey) != ed25519.PublicKeySize {
			return SyncTokenConfig{}, fmt.Errorf("%s contains an invalid Ed25519 public key", MediaTokenVerificationKeys)
		}
		config.VerificationKeys[keyID] = ed25519.PublicKey(publicKey)
	}
	configuredCurrent, ok := config.VerificationKeys[config.KeyID]
	if !ok || !configuredCurrent.Equal(currentPublicKey) {
		return SyncTokenConfig{}, fmt.Errorf("%s must contain the current %s public key", MediaTokenVerificationKeys, SyncTokenKeyID)
	}
	return config, nil
}

func validateOTLPEndpoint(environment string, endpoint string, insecure bool) error {
	if endpoint == "" {
		if insecure {
			return fmt.Errorf("%s requires %s", APIOTLPInsecure, APIOTLPEndpoint)
		}
		return nil
	}
	if insecure && environment != DefaultEnvironment {
		return fmt.Errorf("%s is only supported in local environments", APIOTLPInsecure)
	}

	parsed, err := url.Parse(endpoint)
	if err != nil {
		return fmt.Errorf("%s must be a valid URL: %w", APIOTLPEndpoint, err)
	}
	if parsed.Scheme == "" || parsed.Host == "" || parsed.Path != "" && parsed.Path != "/" {
		return fmt.Errorf("%s must be an absolute base URL without a path", APIOTLPEndpoint)
	}
	if insecure {
		if parsed.Scheme != "http" {
			return fmt.Errorf("%s must use http when %s is enabled", APIOTLPEndpoint, APIOTLPInsecure)
		}
		return nil
	}
	if parsed.Scheme != "https" {
		return fmt.Errorf("%s must use https unless %s is enabled locally", APIOTLPEndpoint, APIOTLPInsecure)
	}
	return nil
}

func validateDatabaseURL(environment string, databaseURL string) error {
	if environment == DefaultEnvironment {
		return nil
	}
	if strings.TrimSpace(databaseURL) == "" || databaseURL == DefaultDatabaseURL {
		return fmt.Errorf("%s must be set outside local environments", DatabaseURL)
	}

	parsed, err := url.Parse(databaseURL)
	if err != nil {
		return fmt.Errorf("%s must be a valid URL: %w", DatabaseURL, err)
	}

	switch strings.ToLower(parsed.Query().Get("sslmode")) {
	case "require", "verify-ca", "verify-full":
		return nil
	default:
		return fmt.Errorf("%s must set sslmode=require, verify-ca, or verify-full outside local environments", DatabaseURL)
	}
}

func envList(name string) []string {
	value, ok := os.LookupEnv(name)
	if !ok || value == "" {
		return nil
	}

	parts := strings.Split(value, ",")
	values := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part != "" {
			values = append(values, part)
		}
	}

	return values
}

func envOrDefault(name string, fallback string) string {
	value, ok := os.LookupEnv(name)
	if !ok || value == "" {
		return fallback
	}

	return value
}

func envInt32(name string, fallback int32) (int32, error) {
	value, ok := os.LookupEnv(name)
	if !ok || value == "" {
		return fallback, nil
	}

	parsed, err := strconv.ParseInt(value, 10, 32)
	if err != nil {
		return 0, fmt.Errorf("%s must be an integer: %w", name, err)
	}

	return int32(parsed), nil
}

func envFloat64(name string, fallback float64) (float64, error) {
	value, ok := os.LookupEnv(name)
	if !ok || value == "" {
		return fallback, nil
	}

	parsed, err := strconv.ParseFloat(value, 64)
	if err != nil {
		return 0, fmt.Errorf("%s must be a number: %w", name, err)
	}

	return parsed, nil
}

func envMilliseconds(name string, fallback int64) (time.Duration, error) {
	value, ok := os.LookupEnv(name)
	if !ok || value == "" {
		return time.Duration(fallback) * time.Millisecond, nil
	}

	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("%s must be an integer number of milliseconds: %w", name, err)
	}

	return time.Duration(parsed) * time.Millisecond, nil
}

func envEnum(name string, fallback string, allowed ...string) (string, error) {
	value := strings.ToLower(strings.TrimSpace(envOrDefault(name, fallback)))
	for _, option := range allowed {
		if value == option {
			return value, nil
		}
	}

	return "", fmt.Errorf("%s must be one of: %s", name, strings.Join(allowed, ", "))
}

func envRequestLogs(operationLogs bool) (string, error) {
	value, ok := os.LookupEnv(APIRequestLogs)
	if !ok || value == "" {
		if operationLogs {
			return "all", nil
		}
		return DefaultRequestLogs, nil
	}

	return envEnum(APIRequestLogs, DefaultRequestLogs, "off", "errors", "slow", "sampled", "all")
}

func envBool(name string) bool {
	value, ok := os.LookupEnv(name)
	if !ok || value == "" {
		return false
	}

	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

func envStrictBool(name string, fallback bool) (bool, error) {
	value, ok := os.LookupEnv(name)
	if !ok || strings.TrimSpace(value) == "" {
		return fallback, nil
	}

	switch strings.ToLower(strings.TrimSpace(value)) {
	case "true":
		return true, nil
	case "false":
		return false, nil
	default:
		return false, fmt.Errorf("%s must be true or false", name)
	}
}
