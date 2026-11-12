package config

import "time"

const (
	APIAddress            = "CHALK_API_ADDR"
	APICORSAllowedOrigins = "CHALK_API_CORS_ALLOWED_ORIGINS"
	APIEnvironment        = "CHALK_API_ENV"
	APIRateLimits         = "CHALK_API_RATE_LIMITS"
	APITrustedProxyCIDRs  = "CHALK_API_TRUSTED_PROXY_CIDRS"
	APIDirectURL          = "CHALK_API_DIRECT_URL"
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
	APIServiceID          = "CHALK_API_SERVICE_ID"
	APIServiceSecrets     = "CHALK_API_SERVICE_SECRETS"
	APIServiceScopes      = "CHALK_API_SERVICE_SCOPES"

	OAuthIssuer            = "CHALK_OAUTH_ISSUER"
	OAuthConsentURL        = "CHALK_OAUTH_CONSENT_URL"
	OAuthExtraRedirectURIs = "CHALK_OAUTH_EXTRA_REDIRECT_URIS"

	APIVersion                       = "CHALK_API_VERSION"
	SyncTokenAudience                = "CHALK_SYNC_TOKEN_AUDIENCE"
	SyncTokenIssuer                  = "CHALK_SYNC_TOKEN_ISSUER"
	SyncTokenKeyID                   = "CHALK_SYNC_TOKEN_KEY_ID"
	SyncTokenPrivateKey              = "CHALK_SYNC_TOKEN_PRIVATE_KEY"
	MediaTokenVerificationKeys       = "CHALK_MEDIA_TOKEN_VERIFICATION_KEYS"
	PublicInviteManagedTenantID      = "CHALK_PUBLIC_INVITE_MANAGED_TENANT_ID"
	PublicInviteDefaultMediaPlane    = "CHALK_PUBLIC_INVITE_DEFAULT_MEDIA_PLANE"
	PublicInviteWebOrigin            = "CHALK_PUBLIC_INVITE_WEB_ORIGIN"
	PublicInviteKeyID                = "CHALK_PUBLIC_INVITE_KEY_ID"
	PublicInvitePrivateKey           = "CHALK_PUBLIC_INVITE_PRIVATE_KEY"
	PublicInviteVerificationKeys     = "CHALK_PUBLIC_INVITE_VERIFICATION_KEYS"
	PublicInviteAutoLifecycleSeconds = "CHALK_PUBLIC_INVITE_AUTO_LIFECYCLE_SECONDS"
	PublicInviteSchedulerIntervalMS  = "CHALK_PUBLIC_INVITE_SCHEDULER_INTERVAL_MS"
	PublicInviteSchedulerBatch       = "CHALK_PUBLIC_INVITE_SCHEDULER_BATCH"

	DatabaseURL                 = "CHALK_DATABASE_URL"
	DatabaseMaxConns            = "CHALK_DATABASE_MAX_CONNS"
	DatabaseMinConns            = "CHALK_DATABASE_MIN_CONNS"
	DeadlineSchedulerIntervalMS = "CHALK_DEADLINE_SCHEDULER_INTERVAL_MS"
	DeadlineSchedulerBatch      = "CHALK_DEADLINE_SCHEDULER_BATCH"

	// Short aliases keep pool names concise at call sites while preserving the
	// explicit Database wording in the canonical constants above.

	RedisURL = "CHALK_REDIS_URL"

	CloudflareAccountID         = "CHALK_CLOUDFLARE_ACCOUNT_ID"
	CloudflareRealtimeAppID     = "CHALK_CLOUDFLARE_REALTIME_APP_ID"
	CloudflareRealtimeAppSecret = "CHALK_CLOUDFLARE_REALTIME_APP_SECRET"
	CloudflareRealtimeBaseURL   = "CHALK_CLOUDFLARE_REALTIME_BASE_URL"
	CloudflareTurnKeyID         = "CHALK_CLOUDFLARE_TURN_KEY_ID"
	CloudflareTurnAPIToken      = "CHALK_CLOUDFLARE_TURN_API_TOKEN"

	CloudflareRealtimeRequestTimeoutMS = "CHALK_CLOUDFLARE_REALTIME_TIMEOUT_MS"

	ChalkSFUEnabled             = "CHALK_SFU_ENABLED"
	ChalkSFUCaptureEnabled      = "CHALK_SFU_CAPTURE_ENABLED"
	ChalkSFUColocatedCapture    = "CHALK_SFU_COLOCATED_CAPTURE"
	ChalkSFUColocatedGraceSecs  = "CHALK_SFU_COLOCATED_CAPTURE_GRACE_SECONDS"
	ChalkSFUNodes               = "CHALK_SFU_NODES"
	ChalkSFUApplicationID       = "CHALK_SFU_APPLICATION_ID"
	ChalkSFUServerName          = "CHALK_SFU_SERVER_NAME"
	ChalkSFUCAFile              = "CHALK_SFU_CA_FILE"
	ChalkSFUClientCertFile      = "CHALK_SFU_CLIENT_CERT_FILE"
	ChalkSFUClientKeyFile       = "CHALK_SFU_CLIENT_KEY_FILE"
	ChalkSFUTimeoutMS           = "CHALK_SFU_TIMEOUT_MS"
	ChalkSFUSTUNURLs            = "CHALK_SFU_STUN_URLS"
	ChalkSFUCloudflareOverflow  = "CHALK_SFU_CLOUDFLARE_OVERFLOW"
	ChalkSFUStandbyBudget       = "CHALK_SFU_STANDBY_PACKET_BUDGET"
	ChalkSFUAllowedSpaces       = "CHALK_SFU_ALLOWED_SPACES"
	ChalkSFUClientSunset        = "CHALK_SFU_CLIENT_SUNSET"
	ChalkSFUUnifiedSignaling    = "CHALK_SFU_UNIFIED_SIGNALING"
	ChalkSFUNewEpisodes         = "CHALK_SFU_NEW_EPISODES"
	DefaultMediaPlane           = "CHALK_DEFAULT_MEDIA_PLANE"
	NewSpaceMediaPlane          = "CHALK_NEW_SPACE_MEDIA_PLANE"
	NewSpaceRecordingPolicy     = "CHALK_NEW_SPACE_RECORDING_POLICY"
	NewSpaceTranscriptionPolicy = "CHALK_NEW_SPACE_TRANSCRIPTION_POLICY"

	ProviderBridgeAddress           = "CHALK_PROVIDER_BRIDGE_ADDRESS"
	ProviderBridgeServerCertFile    = "CHALK_PROVIDER_BRIDGE_SERVER_CERT_FILE"
	ProviderBridgeServerKeyFile     = "CHALK_PROVIDER_BRIDGE_SERVER_KEY_FILE"
	ProviderBridgeClientCAFile      = "CHALK_PROVIDER_BRIDGE_CLIENT_CA_FILE"
	ProviderBridgeSPIFFETrustDomain = "CHALK_PROVIDER_BRIDGE_SPIFFE_TRUST_DOMAIN"

	R2AccessKeyID                   = "CHALK_R2_ACCESS_KEY_ID"
	R2AccountID                     = "CHALK_R2_ACCOUNT_ID"
	R2Bucket                        = "CHALK_R2_BUCKET"
	R2Endpoint                      = "CHALK_R2_ENDPOINT"
	R2SecretAccessKey               = "CHALK_R2_SECRET_ACCESS_KEY"
	R2RequestTimeoutMS              = "CHALK_R2_REQUEST_TIMEOUT_MS"
	TranscriptionWorkloadAuthSecret = "CHALK_TRANSCRIPTION_WORKLOAD_AUTH_SECRET"
	TranscriptionControlAudience    = "CHALK_TRANSCRIPTION_CONTROL_AUDIENCE"
	TranscriptionDispatcherFunction = "CHALK_TRANSCRIPTION_DISPATCHER_FUNCTION_NAME"
	RecordingEnabled                = "CHALK_RECORDING_ENABLED"
	RecordingBundleV2Enabled        = "CHALK_RECORDING_BUNDLE_V2_ENABLED"
	RecordingKMSKeyID               = "CHALK_RECORDING_KMS_KEY_ID"
	RecordingKMSRegion              = "CHALK_RECORDING_KMS_REGION"
	RecordingKMSRequestTimeoutMS    = "CHALK_RECORDING_KMS_REQUEST_TIMEOUT_MS"
	TranscriptionEnabled            = "CHALK_TRANSCRIPTION_ENABLED"
	WhiteboardFilesEnabled          = "CHALK_WHITEBOARD_FILES_ENABLED"
	WebhookEncryptionKey            = "CHALK_WEBHOOK_ENCRYPTION_KEY"
	WebhookEncryptionKeyring        = "CHALK_WEBHOOK_ENCRYPTION_KEYRING"
	WebhookEncryptionCurrentVersion = "CHALK_WEBHOOK_ENCRYPTION_CURRENT_VERSION"

	DefaultAPIAddress                       = ":8080"
	DefaultDatabaseURL                      = "postgres://postgres:postgres@127.0.0.1:5432/chalk?sslmode=disable"
	DefaultDBMaxConns                       = int32(10)
	DefaultDBMinConns                       = int32(0)
	DefaultDeadlineSchedulerIntervalMS      = int64(1000)
	DefaultDeadlineSchedulerBatch           = int32(50)
	DefaultPublicInviteSchedulerIntervalMS  = int64(60 * 1000)
	DefaultPublicInviteSchedulerBatch       = int32(50)
	DefaultPublicInviteAutoLifecycleSeconds = int32(60 * 60)

	DefaultEnvironment                        = "local"
	DefaultLogFormat                          = "json"
	DefaultLogLevel                           = "info"
	DefaultCloudflareRealtimeRequestTimeoutMS = int64(6000)
	DefaultChalkSFUTimeoutMS                  = int64(6000)
	// DefaultChalkSFUColocatedGraceSeconds is how long a capture waits for the healthy worker
	// beside its SFU node before an on-demand fleet worker may take it.
	DefaultChalkSFUColocatedGraceSeconds = int32(20)
	// DefaultChalkSFUStandbyBudget is the packets/s a standby admits for new
	// Episodes: half the primary's 32,000, because a standby is a smaller node.
	DefaultChalkSFUStandbyBudget = 16000

	DefaultRequestLogs                  = "off"
	DefaultRequestSampleRate            = 0.01
	DefaultR2RequestTimeoutMS           = int64(10000)
	DefaultRecordingKMSRequestTimeoutMS = int64(10000)
	DefaultTranscriptionControlAudience = "chalk-control-api"
	DefaultRedisURL                     = "redis://127.0.0.1:6379/0"
	DefaultServiceName                  = "chalk-api"
	DefaultSlowRequestMS                = int64(250)
	DefaultVersion                      = "dev"
	DefaultCloudflareRealtimeTimeout    = time.Duration(DefaultCloudflareRealtimeRequestTimeoutMS) * time.Millisecond
	DefaultR2Timeout                    = time.Duration(DefaultR2RequestTimeoutMS) * time.Millisecond
	DefaultRecordingKMSTimeout          = time.Duration(DefaultRecordingKMSRequestTimeoutMS) * time.Millisecond
)

const (
	TenantMaxConcurrentRecordings = "CHALK_TENANT_MAX_CONCURRENT_RECORDINGS"
	TenantDailyRecordingMinutes   = "CHALK_TENANT_DAILY_RECORDING_MINUTES"
	TenantMaxLiveEpisodes         = "CHALK_TENANT_MAX_LIVE_EPISODES"
)
