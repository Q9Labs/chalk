package config_test

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/config"
)

func TestLoadRequiresSyncTokenSigningConfigInProduction(t *testing.T) {
	t.Setenv(config.APIEnvironment, "production")
	t.Setenv(config.DatabaseURL, "postgres://db.internal/chalk?sslmode=verify-full")
	t.Setenv(config.ComposioAPIKey, "composio-key")

	_, err := config.Load()
	if err == nil || !strings.Contains(err.Error(), config.SyncTokenAudience) {
		t.Fatalf("error = %v, want missing sync token config", err)
	}
}

func TestLoadAcceptsEd25519SyncTokenSigningConfig(t *testing.T) {
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv(config.SyncTokenAudience, "chalk-sync")
	t.Setenv(config.SyncTokenIssuer, "https://api.chalk.test")
	t.Setenv(config.SyncTokenKeyID, "launch-1")
	t.Setenv(config.SyncTokenPrivateKey, base64.RawURLEncoding.EncodeToString(privateKey))

	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.SyncToken.KeyID != "launch-1" || len(cfg.SyncToken.PrivateKey) != ed25519.PrivateKeySize {
		t.Fatalf("sync token config = %#v", cfg.SyncToken)
	}
	if key := cfg.SyncToken.VerificationKeys["launch-1"]; !key.Equal(privateKey.Public()) {
		t.Fatalf("current verification key = %#v", key)
	}
}

func TestLoadAcceptsPreviousMediaVerificationKey(t *testing.T) {
	currentPublic, currentPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	previousPublic, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv(config.SyncTokenAudience, "chalk-sync")
	t.Setenv(config.SyncTokenIssuer, "https://api.chalk.test")
	t.Setenv(config.SyncTokenKeyID, "launch-2")
	t.Setenv(config.SyncTokenPrivateKey, base64.RawURLEncoding.EncodeToString(currentPrivate))
	t.Setenv(config.MediaTokenVerificationKeys, `{"launch-2":"`+base64.RawURLEncoding.EncodeToString(currentPublic)+`","launch-1":"`+base64.RawURLEncoding.EncodeToString(previousPublic)+`"}`)

	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.SyncToken.VerificationKeys) != 2 || !cfg.SyncToken.VerificationKeys["launch-1"].Equal(previousPublic) {
		t.Fatalf("verification keys = %#v", cfg.SyncToken.VerificationKeys)
	}
}

func TestLoadRejectsMediaAudienceForSyncCredentials(t *testing.T) {
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv(config.SyncTokenAudience, "chalk-media")
	t.Setenv(config.SyncTokenIssuer, "https://api.chalk.test")
	t.Setenv(config.SyncTokenKeyID, "launch-1")
	t.Setenv(config.SyncTokenPrivateKey, base64.RawURLEncoding.EncodeToString(privateKey))

	_, err = config.Load()
	if err == nil || !strings.Contains(err.Error(), "participant media audience") {
		t.Fatalf("error = %v", err)
	}
}

func TestLoadDefaults(t *testing.T) {
	t.Setenv(config.DatabaseURL, "")
	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}

	if cfg.API.Address != config.DefaultAPIAddress {
		t.Fatalf("api address = %q, want %q", cfg.API.Address, config.DefaultAPIAddress)
	}
	if len(cfg.API.CORSAllowedOrigins) != 0 {
		t.Fatalf("cors allowed origins = %#v, want empty", cfg.API.CORSAllowedOrigins)
	}
	if len(cfg.API.TrustedProxyCIDRs) != 0 {
		t.Fatalf("trusted proxy cidrs = %#v, want empty", cfg.API.TrustedProxyCIDRs)
	}
	if cfg.Auth.EmailVerificationRequired {
		t.Fatal("email verification required = true, want false")
	}
	if cfg.Auth.OAuthStateTTL != config.DefaultOAuthStateTTL {
		t.Fatalf("oauth state ttl = %s, want %s", cfg.Auth.OAuthStateTTL, config.DefaultOAuthStateTTL)
	}
	if cfg.Auth.SessionTTL != config.DefaultSessionTTL {
		t.Fatalf("session ttl = %s, want %s", cfg.Auth.SessionTTL, config.DefaultSessionTTL)
	}
	if cfg.Capabilities.Integrations || cfg.Capabilities.Transcription {
		t.Fatalf("local capabilities = %#v, want disabled", cfg.Capabilities)
	}
	if cfg.Database.URL != config.DefaultDatabaseURL {
		t.Fatalf("database url = %q, want %q", cfg.Database.URL, config.DefaultDatabaseURL)
	}
	if cfg.Database.MaxConns != config.DefaultDBMaxConns {
		t.Fatalf("database max conns = %d, want %d", cfg.Database.MaxConns, config.DefaultDBMaxConns)
	}
	if cfg.Database.MinConns != config.DefaultDBMinConns {
		t.Fatalf("database min conns = %d, want %d", cfg.Database.MinConns, config.DefaultDBMinConns)
	}
	if cfg.GoogleOAuth.ClientID != "" {
		t.Fatalf("google oauth client id = %q, want empty", cfg.GoogleOAuth.ClientID)
	}
	if cfg.GoogleOAuth.ClientSecret != "" {
		t.Fatalf("google oauth client secret = %q, want empty", cfg.GoogleOAuth.ClientSecret)
	}
	if cfg.GoogleOAuth.RedirectURL != config.DefaultGoogleRedirectURL {
		t.Fatalf("google oauth redirect url = %q, want %q", cfg.GoogleOAuth.RedirectURL, config.DefaultGoogleRedirectURL)
	}
	if cfg.Redis.URL != config.DefaultRedisURL {
		t.Fatalf("redis url = %q, want %q", cfg.Redis.URL, config.DefaultRedisURL)
	}
	if cfg.CloudflareRealtime.AccountID != "" {
		t.Fatalf("cloudflare account id = %q, want empty", cfg.CloudflareRealtime.AccountID)
	}
	if cfg.CloudflareRealtime.APIToken != "" {
		t.Fatalf("cloudflare api token = %q, want empty", cfg.CloudflareRealtime.APIToken)
	}
	if cfg.CloudflareRealtime.RealtimeAppID != "" {
		t.Fatalf("cloudflare realtime app id = %q, want empty", cfg.CloudflareRealtime.RealtimeAppID)
	}
	if cfg.CloudflareRealtime.RealtimeAppSecret != "" {
		t.Fatalf("cloudflare realtime app secret = %q, want empty", cfg.CloudflareRealtime.RealtimeAppSecret)
	}
	if cfg.CloudflareRealtime.RealtimeBaseURL != "" {
		t.Fatalf("cloudflare realtime base url = %q, want empty", cfg.CloudflareRealtime.RealtimeBaseURL)
	}
	if cfg.ProviderBridge.Enabled {
		t.Fatal("provider bridge enabled = true, want false")
	}
	if cfg.CloudflareRealtime.RTKAppID != "" {
		t.Fatalf("cloudflare rtk app id = %q, want empty", cfg.CloudflareRealtime.RTKAppID)
	}
	if cfg.CloudflareRealtime.RTKTokenOrgID != "" {
		t.Fatalf("cloudflare rtk token org id = %q, want empty", cfg.CloudflareRealtime.RTKTokenOrgID)
	}
	if cfg.CloudflareRealtime.RTKPresetFacilitator != config.DefaultCloudflareRTKPresetFacilitator {
		t.Fatalf("cloudflare rtk facilitator preset = %q, want %q", cfg.CloudflareRealtime.RTKPresetFacilitator, config.DefaultCloudflareRTKPresetFacilitator)
	}
	if cfg.CloudflareRealtime.RTKPresetContributor != config.DefaultCloudflareRTKPresetContributor {
		t.Fatalf("cloudflare rtk contributor preset = %q, want %q", cfg.CloudflareRealtime.RTKPresetContributor, config.DefaultCloudflareRTKPresetContributor)
	}
	if cfg.CloudflareRealtime.RequestTimeout != config.DefaultCloudflareRealtimeTimeout {
		t.Fatalf("cloudflare realtime request timeout = %s, want %s", cfg.CloudflareRealtime.RequestTimeout, config.DefaultCloudflareRealtimeTimeout)
	}
	if cfg.Composio.APIKey != "" {
		t.Fatalf("composio api key = %q, want empty", cfg.Composio.APIKey)
	}
	if cfg.Composio.BaseURL != config.DefaultComposioBaseURL {
		t.Fatalf("composio base url = %q, want %q", cfg.Composio.BaseURL, config.DefaultComposioBaseURL)
	}
	if cfg.Composio.RequestTimeout != config.DefaultComposioTimeout {
		t.Fatalf("composio timeout = %s, want %s", cfg.Composio.RequestTimeout, config.DefaultComposioTimeout)
	}
	if cfg.Composio.WebhookSecret != "" {
		t.Fatalf("composio webhook secret = %q, want empty", cfg.Composio.WebhookSecret)
	}
	if cfg.R2.AccessKeyID != "" {
		t.Fatalf("r2 access key id = %q, want empty", cfg.R2.AccessKeyID)
	}
	if cfg.R2.AccountID != "" {
		t.Fatalf("r2 account id = %q, want empty", cfg.R2.AccountID)
	}
	if cfg.R2.Bucket != "" {
		t.Fatalf("r2 bucket = %q, want empty", cfg.R2.Bucket)
	}
	if cfg.R2.Endpoint != "" {
		t.Fatalf("r2 endpoint = %q, want empty", cfg.R2.Endpoint)
	}
	if cfg.R2.SecretAccessKey != "" {
		t.Fatalf("r2 secret access key = %q, want empty", cfg.R2.SecretAccessKey)
	}
	if cfg.R2.RequestTimeout != config.DefaultR2Timeout {
		t.Fatalf("r2 request timeout = %s, want %s", cfg.R2.RequestTimeout, config.DefaultR2Timeout)
	}
	if cfg.Resend.APIKey != "" {
		t.Fatalf("resend api key = %q, want empty", cfg.Resend.APIKey)
	}
	if cfg.Resend.Timeout != config.DefaultResendTimeout {
		t.Fatalf("resend timeout = %s, want %s", cfg.Resend.Timeout, config.DefaultResendTimeout)
	}
	if cfg.Observability.Profiler {
		t.Fatal("profiler = true, want false")
	}
	if cfg.Observability.OperationLogs {
		t.Fatal("operation logs = true, want false")
	}
	if cfg.Observability.Service != config.DefaultServiceName {
		t.Fatalf("service = %q, want %q", cfg.Observability.Service, config.DefaultServiceName)
	}
	if cfg.Observability.Environment != config.DefaultEnvironment {
		t.Fatalf("environment = %q, want %q", cfg.Observability.Environment, config.DefaultEnvironment)
	}
	if cfg.Observability.Version != config.DefaultVersion {
		t.Fatalf("version = %q, want %q", cfg.Observability.Version, config.DefaultVersion)
	}
	if cfg.Observability.LogFormat != config.DefaultLogFormat {
		t.Fatalf("log format = %q, want %q", cfg.Observability.LogFormat, config.DefaultLogFormat)
	}
	if cfg.Observability.LogLevel != config.DefaultLogLevel {
		t.Fatalf("log level = %q, want %q", cfg.Observability.LogLevel, config.DefaultLogLevel)
	}
	if cfg.Observability.RequestLogs != config.DefaultRequestLogs {
		t.Fatalf("request logs = %q, want %q", cfg.Observability.RequestLogs, config.DefaultRequestLogs)
	}
	if cfg.Observability.RequestSampleRate != config.DefaultRequestSampleRate {
		t.Fatalf("request sample rate = %f, want %f", cfg.Observability.RequestSampleRate, config.DefaultRequestSampleRate)
	}
	if cfg.Observability.SlowRequestThreshold != time.Duration(config.DefaultSlowRequestMS)*time.Millisecond {
		t.Fatalf("slow request threshold = %s, want %dms", cfg.Observability.SlowRequestThreshold, config.DefaultSlowRequestMS)
	}
}

func TestLoadAPICORSAllowedOrigins(t *testing.T) {
	t.Setenv(config.APICORSAllowedOrigins, "https://app.chalk.test, http://localhost:3000 ,,")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}

	want := []string{"https://app.chalk.test", "http://localhost:3000"}
	if len(cfg.API.CORSAllowedOrigins) != len(want) {
		t.Fatalf("cors allowed origins = %#v, want %#v", cfg.API.CORSAllowedOrigins, want)
	}
	for i := range want {
		if cfg.API.CORSAllowedOrigins[i] != want[i] {
			t.Fatalf("cors allowed origins = %#v, want %#v", cfg.API.CORSAllowedOrigins, want)
		}
	}
}

func TestLoadAPITrustedProxyCIDRs(t *testing.T) {
	t.Setenv(config.APITrustedProxyCIDRs, "203.0.113.0/24, 2001:db8::/32 ,,")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}

	want := []string{"203.0.113.0/24", "2001:db8::/32"}
	if len(cfg.API.TrustedProxyCIDRs) != len(want) {
		t.Fatalf("trusted proxy cidrs = %#v, want %#v", cfg.API.TrustedProxyCIDRs, want)
	}
	for i := range want {
		if cfg.API.TrustedProxyCIDRs[i] != want[i] {
			t.Fatalf("trusted proxy cidrs = %#v, want %#v", cfg.API.TrustedProxyCIDRs, want)
		}
	}
}

func TestLoadAPIAddress(t *testing.T) {
	t.Setenv(config.APIAddress, "127.0.0.1:9000")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}

	if cfg.API.Address != "127.0.0.1:9000" {
		t.Fatalf("api address = %q, want 127.0.0.1:9000", cfg.API.Address)
	}
}

func TestLoadDatabaseURL(t *testing.T) {
	t.Setenv(config.DatabaseURL, "postgres://example")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}

	if cfg.Database.URL != "postgres://example" {
		t.Fatalf("database url = %q, want postgres://example", cfg.Database.URL)
	}
}

func TestLoadDatabasePoolSettings(t *testing.T) {
	t.Setenv(config.DatabaseMaxConns, "25")
	t.Setenv(config.DatabaseMinConns, "5")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}

	if cfg.Database.MaxConns != 25 {
		t.Fatalf("database max conns = %d, want 25", cfg.Database.MaxConns)
	}
	if cfg.Database.MinConns != 5 {
		t.Fatalf("database min conns = %d, want 5", cfg.Database.MinConns)
	}
}

func TestLoadAuth(t *testing.T) {
	t.Setenv(config.AuthEmailVerificationRequired, "true")
	t.Setenv(config.AuthOAuthStateTTLMS, "120000")
	t.Setenv(config.AuthSessionTTLMS, "3600000")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}

	if !cfg.Auth.EmailVerificationRequired {
		t.Fatal("email verification required = false, want true")
	}
	if cfg.Auth.OAuthStateTTL != 2*time.Minute {
		t.Fatalf("oauth state ttl = %s, want 2m", cfg.Auth.OAuthStateTTL)
	}
	if cfg.Auth.SessionTTL != time.Hour {
		t.Fatalf("session ttl = %s, want 1h", cfg.Auth.SessionTTL)
	}
}

func TestLoadGoogleOAuth(t *testing.T) {
	t.Setenv(config.GoogleOAuthClientID, "client-id.apps.googleusercontent.com")
	t.Setenv(config.GoogleOAuthClientSecret, "client-secret")
	t.Setenv(config.GoogleOAuthRedirectURL, "https://api.chalk.test/v1/auth/google/callback")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}

	if cfg.GoogleOAuth.ClientID != "client-id.apps.googleusercontent.com" {
		t.Fatalf("google oauth client id = %q, want configured client id", cfg.GoogleOAuth.ClientID)
	}
	if cfg.GoogleOAuth.ClientSecret != "client-secret" {
		t.Fatalf("google oauth client secret = %q, want configured secret", cfg.GoogleOAuth.ClientSecret)
	}
	if cfg.GoogleOAuth.RedirectURL != "https://api.chalk.test/v1/auth/google/callback" {
		t.Fatalf("google oauth redirect url = %q, want configured redirect url", cfg.GoogleOAuth.RedirectURL)
	}
}

func TestLoadRedisURL(t *testing.T) {
	t.Setenv(config.RedisURL, "redis://redis.internal:6379/2")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}

	if cfg.Redis.URL != "redis://redis.internal:6379/2" {
		t.Fatalf("redis url = %q, want redis://redis.internal:6379/2", cfg.Redis.URL)
	}
}

func TestLoadCloudflareRealtime(t *testing.T) {
	t.Setenv(config.CloudflareAccountID, "account-id")
	t.Setenv(config.CloudflareAPIToken, "api-token")
	t.Setenv(config.CloudflareRealtimeAppID, "sfu-app-id")
	t.Setenv(config.CloudflareRealtimeAppSecret, "sfu-app-secret")
	t.Setenv(config.CloudflareRTKAppID, "rtk-app-id")
	t.Setenv(config.CloudflareRTKTokenOrgID, "rtk-token-org-id")
	t.Setenv(config.CloudflareRTKPresetFacilitator, "host-preset")
	t.Setenv(config.CloudflareRTKPresetContributor, "participant-preset")
	t.Setenv(config.CloudflareRealtimeRequestTimeoutMS, "2500")
	t.Setenv(config.CloudflareRealtimeBaseURL, "http://127.0.0.1:9090/")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}

	if cfg.CloudflareRealtime.AccountID != "account-id" {
		t.Fatalf("cloudflare account id = %q, want account-id", cfg.CloudflareRealtime.AccountID)
	}
	if cfg.CloudflareRealtime.APIToken != "api-token" {
		t.Fatalf("cloudflare api token = %q, want api-token", cfg.CloudflareRealtime.APIToken)
	}
	if cfg.CloudflareRealtime.RealtimeAppID != "sfu-app-id" {
		t.Fatalf("cloudflare realtime app id = %q, want sfu-app-id", cfg.CloudflareRealtime.RealtimeAppID)
	}
	if cfg.CloudflareRealtime.RealtimeAppSecret != "sfu-app-secret" {
		t.Fatalf("cloudflare realtime app secret = %q, want sfu-app-secret", cfg.CloudflareRealtime.RealtimeAppSecret)
	}
	if cfg.CloudflareRealtime.RealtimeBaseURL != "http://127.0.0.1:9090" {
		t.Fatalf("cloudflare realtime base url = %q, want local endpoint", cfg.CloudflareRealtime.RealtimeBaseURL)
	}
	if cfg.CloudflareRealtime.RTKAppID != "rtk-app-id" {
		t.Fatalf("cloudflare rtk app id = %q, want rtk-app-id", cfg.CloudflareRealtime.RTKAppID)
	}
	if cfg.CloudflareRealtime.RTKTokenOrgID != "rtk-token-org-id" {
		t.Fatalf("cloudflare rtk token org id = %q, want rtk-token-org-id", cfg.CloudflareRealtime.RTKTokenOrgID)
	}
	if cfg.CloudflareRealtime.RTKPresetFacilitator != "host-preset" {
		t.Fatalf("cloudflare rtk facilitator preset = %q, want host-preset", cfg.CloudflareRealtime.RTKPresetFacilitator)
	}
	if cfg.CloudflareRealtime.RTKPresetContributor != "participant-preset" {
		t.Fatalf("cloudflare rtk contributor preset = %q, want participant-preset", cfg.CloudflareRealtime.RTKPresetContributor)
	}
	if cfg.CloudflareRealtime.RequestTimeout != 2500*time.Millisecond {
		t.Fatalf("cloudflare realtime request timeout = %s, want 2500ms", cfg.CloudflareRealtime.RequestTimeout)
	}
}

func TestLoadProviderBridgeRequiresCompleteConfig(t *testing.T) {
	t.Setenv(config.ProviderBridgeAddress, "127.0.0.1:8444")

	_, err := config.Load()
	if err == nil || !strings.Contains(err.Error(), config.ProviderBridgeServerCertFile) {
		t.Fatalf("error = %v, want incomplete provider bridge config", err)
	}
}

func TestLoadProviderBridgeConfig(t *testing.T) {
	setProviderBridgeConfig(t)

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	if !cfg.ProviderBridge.Enabled || cfg.ProviderBridge.Address != "127.0.0.1:8444" || cfg.ProviderBridge.SPIFFETrustDomain != "chalk.test" {
		t.Fatalf("provider bridge config = %#v", cfg.ProviderBridge)
	}
}

func TestLoadRejectsInvalidProviderBridgeIdentityAndAddress(t *testing.T) {
	for _, test := range []struct {
		name        string
		address     string
		trustDomain string
	}{
		{name: "invalid address", address: "private-listener", trustDomain: "chalk.test"},
		{name: "invalid trust domain", address: "127.0.0.1:8444", trustDomain: "Chalk Test"},
	} {
		t.Run(test.name, func(t *testing.T) {
			setProviderBridgeConfig(t)
			t.Setenv(config.ProviderBridgeAddress, test.address)
			t.Setenv(config.ProviderBridgeSPIFFETrustDomain, test.trustDomain)
			if _, err := config.Load(); err == nil {
				t.Fatal("invalid provider bridge config accepted")
			}
		})
	}
}

func TestLoadRequiresProviderBridgeOutsideLocal(t *testing.T) {
	t.Setenv(config.APIEnvironment, "staging")
	t.Setenv(config.DatabaseURL, "postgres://db.internal/chalk?sslmode=require")
	t.Setenv(config.ComposioAPIKey, "composio-key")
	t.Setenv(config.WebhookEncryptionKey, base64.StdEncoding.EncodeToString(make([]byte, 32)))

	_, err := config.Load()
	if err == nil || !strings.Contains(err.Error(), config.ProviderBridgeAddress) {
		t.Fatalf("error = %v, want missing provider bridge config", err)
	}
}

func TestLoadRejectsLocalCloudflareBaseURLOutsideLocal(t *testing.T) {
	t.Setenv(config.APIEnvironment, "staging")
	t.Setenv(config.DatabaseURL, "postgres://db.internal/chalk?sslmode=require")
	t.Setenv(config.ComposioAPIKey, "composio-key")
	t.Setenv(config.WebhookEncryptionKey, base64.StdEncoding.EncodeToString(make([]byte, 32)))
	setProviderBridgeConfig(t)
	t.Setenv(config.CloudflareRealtimeBaseURL, "http://127.0.0.1:9090")

	_, err := config.Load()
	if err == nil || !strings.Contains(err.Error(), "only supported in local") {
		t.Fatalf("error = %v, want local-only Cloudflare endpoint rejection", err)
	}
}

func TestLoadRejectsRemoteCloudflareBaseURLInLocal(t *testing.T) {
	t.Setenv(config.CloudflareRealtimeBaseURL, "https://example.com")

	_, err := config.Load()
	if err == nil || !strings.Contains(err.Error(), "localhost") {
		t.Fatalf("error = %v, want localhost Cloudflare endpoint rejection", err)
	}
}

func TestLoadR2(t *testing.T) {
	t.Setenv(config.R2AccessKeyID, "access-key")
	t.Setenv(config.R2AccountID, "account-id")
	t.Setenv(config.R2Bucket, "chalk-media")
	t.Setenv(config.R2Endpoint, "https://storage.chalk.test")
	t.Setenv(config.R2SecretAccessKey, "secret-key")
	t.Setenv(config.R2RequestTimeoutMS, "2500")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}

	if cfg.R2.AccessKeyID != "access-key" {
		t.Fatalf("r2 access key id = %q, want access-key", cfg.R2.AccessKeyID)
	}
	if cfg.R2.AccountID != "account-id" {
		t.Fatalf("r2 account id = %q, want account-id", cfg.R2.AccountID)
	}
	if cfg.R2.Bucket != "chalk-media" {
		t.Fatalf("r2 bucket = %q, want chalk-media", cfg.R2.Bucket)
	}
	if cfg.R2.Endpoint != "https://storage.chalk.test" {
		t.Fatalf("r2 endpoint = %q, want configured endpoint", cfg.R2.Endpoint)
	}
	if cfg.R2.SecretAccessKey != "secret-key" {
		t.Fatalf("r2 secret access key = %q, want secret-key", cfg.R2.SecretAccessKey)
	}
	if cfg.R2.RequestTimeout != 2500*time.Millisecond {
		t.Fatalf("r2 request timeout = %s, want 2500ms", cfg.R2.RequestTimeout)
	}
}

func TestLoadResend(t *testing.T) {
	t.Setenv(config.ResendAPIKey, "re_123")
	t.Setenv(config.ResendTimeoutMS, "2500")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}

	if cfg.Resend.APIKey != "re_123" {
		t.Fatalf("resend api key = %q, want re_123", cfg.Resend.APIKey)
	}
	if cfg.Resend.Timeout != 2500*time.Millisecond {
		t.Fatalf("resend timeout = %s, want 2500ms", cfg.Resend.Timeout)
	}
}

func TestLoadComposio(t *testing.T) {
	t.Setenv(config.IntegrationsEnabled, "true")
	t.Setenv(config.ComposioAPIKey, "composio-key")
	t.Setenv(config.ComposioBaseURL, "https://composio.test/api/v3.1")
	t.Setenv(config.ComposioTimeoutMS, "2500")
	t.Setenv(config.ComposioWebhookSecret, "webhook-secret")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}

	if cfg.Composio.APIKey != "composio-key" {
		t.Fatalf("composio api key = %q, want configured key", cfg.Composio.APIKey)
	}
	if cfg.Composio.BaseURL != "https://composio.test/api/v3.1" {
		t.Fatalf("composio base url = %q, want configured url", cfg.Composio.BaseURL)
	}
	if cfg.Composio.RequestTimeout != 2500*time.Millisecond {
		t.Fatalf("composio timeout = %s, want 2500ms", cfg.Composio.RequestTimeout)
	}
	if cfg.Composio.WebhookSecret != "webhook-secret" {
		t.Fatalf("composio webhook secret = %q, want configured secret", cfg.Composio.WebhookSecret)
	}
}

func TestLoadObservability(t *testing.T) {
	t.Setenv(config.APIEnvironment, "staging")
	t.Setenv(config.TranscriptionEnabled, "false")
	t.Setenv(config.DatabaseURL, "postgres://db.internal/chalk?sslmode=require")
	t.Setenv(config.ComposioAPIKey, "composio-key")
	t.Setenv(config.WebhookEncryptionKey, base64.StdEncoding.EncodeToString(make([]byte, 32)))
	t.Setenv(config.APILogFormat, "text")
	t.Setenv(config.APILogLevel, "debug")
	t.Setenv(config.APIOTLPEndpoint, "https://otel.chalk.test:4318")
	t.Setenv(config.APIProfiler, "true")
	t.Setenv(config.APIOperationLogs, "1")
	t.Setenv(config.APIRequestLogs, "sampled")
	t.Setenv(config.APIRequestSampleRate, "0.25")
	t.Setenv(config.APIService, "chalk-api-test")
	t.Setenv(config.APISlowRequestMS, "75")
	t.Setenv(config.APIVersion, "2026.07.01")
	setProviderBridgeConfig(t)

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}

	if !cfg.Observability.Profiler {
		t.Fatal("profiler = false, want true")
	}
	if !cfg.Observability.OperationLogs {
		t.Fatal("operation logs = false, want true")
	}
	if cfg.Observability.Service != "chalk-api-test" {
		t.Fatalf("service = %q, want chalk-api-test", cfg.Observability.Service)
	}
	if cfg.Observability.Environment != "staging" {
		t.Fatalf("environment = %q, want staging", cfg.Observability.Environment)
	}
	if cfg.Observability.Version != "2026.07.01" {
		t.Fatalf("version = %q, want 2026.07.01", cfg.Observability.Version)
	}
	if cfg.Observability.LogFormat != "text" {
		t.Fatalf("log format = %q, want text", cfg.Observability.LogFormat)
	}
	if cfg.Observability.LogLevel != "debug" {
		t.Fatalf("log level = %q, want debug", cfg.Observability.LogLevel)
	}
	if cfg.Observability.OTLPEndpoint != "https://otel.chalk.test:4318" || cfg.Observability.OTLPInsecure {
		t.Fatalf("OTLP config = %#v", cfg.Observability)
	}
	if cfg.Observability.RequestLogs != "sampled" {
		t.Fatalf("request logs = %q, want sampled", cfg.Observability.RequestLogs)
	}
	if cfg.Observability.RequestSampleRate != 0.25 {
		t.Fatalf("request sample rate = %f, want 0.25", cfg.Observability.RequestSampleRate)
	}
	if cfg.Observability.SlowRequestThreshold != 75*time.Millisecond {
		t.Fatalf("slow request threshold = %s, want 75ms", cfg.Observability.SlowRequestThreshold)
	}
}

func TestLoadLocalSystemToken(t *testing.T) {
	t.Setenv(config.APILocalSystemToken, "local-token")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}

	if cfg.API.LocalSystemToken != "local-token" {
		t.Fatalf("local system token = %q, want configured token", cfg.API.LocalSystemToken)
	}
}

func TestLoadRejectsDefaultDatabaseURLOutsideLocal(t *testing.T) {
	t.Setenv(config.APIEnvironment, "production")
	t.Setenv(config.ComposioAPIKey, "composio-key")

	_, err := config.Load()
	if err == nil {
		t.Fatal("load config succeeded, want error")
	}
}

func TestLoadRejectsLocalSystemTokenOutsideLocal(t *testing.T) {
	t.Setenv(config.APIEnvironment, "staging")
	t.Setenv(config.DatabaseURL, "postgres://db.internal/chalk?sslmode=require")
	t.Setenv(config.ComposioAPIKey, "composio-key")
	t.Setenv(config.APILocalSystemToken, "local-token")

	_, err := config.Load()
	if err == nil {
		t.Fatal("load config succeeded, want error")
	}
}

func TestLoadRejectsInsecureDatabaseURLOutsideLocal(t *testing.T) {
	t.Setenv(config.APIEnvironment, "staging")
	t.Setenv(config.DatabaseURL, "postgres://db.internal/chalk?sslmode=disable")
	t.Setenv(config.ComposioAPIKey, "composio-key")

	_, err := config.Load()
	if err == nil {
		t.Fatal("load config succeeded, want error")
	}
}

func TestLoadAcceptsTLSDatabaseURLOutsideLocal(t *testing.T) {
	t.Setenv(config.APIEnvironment, "staging")
	t.Setenv(config.TranscriptionEnabled, "false")
	t.Setenv(config.DatabaseURL, "postgres://db.internal/chalk?sslmode=verify-full")
	t.Setenv(config.ComposioAPIKey, "composio-key")
	t.Setenv(config.WebhookEncryptionKey, base64.StdEncoding.EncodeToString(make([]byte, 32)))
	setProviderBridgeConfig(t)

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	if cfg.Database.URL != "postgres://db.internal/chalk?sslmode=verify-full" {
		t.Fatalf("database url = %q, want configured tls url", cfg.Database.URL)
	}
}

func TestLoadRejectsMissingWebhookEncryptionKeyOutsideLocal(t *testing.T) {
	t.Setenv(config.APIEnvironment, "staging")
	t.Setenv(config.DatabaseURL, "postgres://db.internal/chalk?sslmode=verify-full")
	t.Setenv(config.ComposioAPIKey, "composio-key")
	t.Setenv(config.WebhookEncryptionKey, "")
	t.Setenv(config.WebhookEncryptionKeyring, "")
	t.Setenv(config.WebhookEncryptionCurrentVersion, "")

	_, err := config.Load()
	if err == nil || !strings.Contains(err.Error(), config.WebhookEncryptionKey) {
		t.Fatalf("error = %v, want missing webhook encryption key", err)
	}
}

func TestLoadWebhookEncryptionKeyring(t *testing.T) {
	first := make([]byte, 32)
	second := make([]byte, 32)
	second[0] = 1
	t.Setenv(config.WebhookEncryptionKeyring, "1:"+base64.StdEncoding.EncodeToString(first)+",2:"+base64.StdEncoding.EncodeToString(second))
	t.Setenv(config.WebhookEncryptionCurrentVersion, "2")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	if cfg.Webhooks.CurrentKeyVersion != 2 {
		t.Fatalf("current key version = %d, want 2", cfg.Webhooks.CurrentKeyVersion)
	}
	if len(cfg.Webhooks.EncryptionKeys) != 2 || cfg.Webhooks.EncryptionKeys[1][0] != 0 || cfg.Webhooks.EncryptionKeys[2][0] != 1 {
		t.Fatalf("encryption keys = %#v", cfg.Webhooks.EncryptionKeys)
	}
	if cfg.Webhooks.EncryptionKey[0] != 1 {
		t.Fatal("legacy current key alias does not point to current key")
	}
}

func TestLoadRejectsInvalidWebhookEncryptionKeyrings(t *testing.T) {
	key := base64.StdEncoding.EncodeToString(make([]byte, 32))
	tests := []struct {
		name    string
		keyring string
		current string
	}{
		{name: "missing current", keyring: "1:" + key, current: "2"},
		{name: "duplicate version", keyring: "1:" + key + ",1:" + key, current: "1"},
		{name: "zero version", keyring: "0:" + key, current: "1"},
		{name: "malformed key", keyring: "1:not-base64", current: "1"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv(config.WebhookEncryptionKeyring, test.keyring)
			t.Setenv(config.WebhookEncryptionCurrentVersion, test.current)
			if _, err := config.Load(); err == nil {
				t.Fatal("load config succeeded, want error")
			}
		})
	}
}

func TestLoadRejectsMissingComposioAPIKeyOutsideLocal(t *testing.T) {
	t.Setenv(config.APIEnvironment, "staging")
	t.Setenv(config.DatabaseURL, "postgres://db.internal/chalk?sslmode=verify-full")

	_, err := config.Load()
	if err == nil {
		t.Fatal("load config succeeded, want error")
	}
}

func TestLoadDefaultsCapabilitiesToEnabledOutsideLocal(t *testing.T) {
	t.Setenv(config.APIEnvironment, "staging")
	t.Setenv(config.DatabaseURL, "postgres://db.internal/chalk?sslmode=verify-full")
	t.Setenv(config.ComposioAPIKey, "composio-key")
	t.Setenv(config.WebhookEncryptionKey, base64.StdEncoding.EncodeToString(make([]byte, 32)))
	setProviderBridgeConfig(t)
	setTranscriptionConfig(t)

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	if !cfg.Capabilities.Integrations || !cfg.Capabilities.Transcription {
		t.Fatalf("non-local capabilities = %#v, want enabled", cfg.Capabilities)
	}
}

func TestLoadAcceptsExplicitMeetingOnlyCapabilitiesOutsideLocal(t *testing.T) {
	t.Setenv(config.APIEnvironment, "staging")
	t.Setenv(config.DatabaseURL, "postgres://db.internal/chalk?sslmode=verify-full")
	t.Setenv(config.IntegrationsEnabled, "false")
	t.Setenv(config.TranscriptionEnabled, "false")
	t.Setenv(config.WebhookEncryptionKey, base64.StdEncoding.EncodeToString(make([]byte, 32)))
	setProviderBridgeConfig(t)

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	if cfg.Capabilities.Integrations || cfg.Capabilities.Transcription {
		t.Fatalf("meeting-only capabilities = %#v, want disabled", cfg.Capabilities)
	}
}

func TestLoadRejectsIncompleteEnabledTranscription(t *testing.T) {
	tests := []struct {
		name string
		env  map[string]string
		want string
	}{
		{
			name: "missing workload secret",
			want: config.TranscriptionWorkloadAuthSecret,
		},
		{
			name: "short workload secret",
			env:  map[string]string{config.TranscriptionWorkloadAuthSecret: "short"},
			want: config.TranscriptionWorkloadAuthSecret,
		},
		{
			name: "missing dispatcher",
			env:  map[string]string{config.TranscriptionWorkloadAuthSecret: strings.Repeat("s", 32)},
			want: config.TranscriptionDispatcherFunction,
		},
		{
			name: "missing object storage",
			env: map[string]string{
				config.TranscriptionWorkloadAuthSecret: strings.Repeat("s", 32),
				config.TranscriptionDispatcherFunction: "chalk-transcription-dispatcher",
			},
			want: config.R2Bucket,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv(config.TranscriptionEnabled, "true")
			for name, value := range test.env {
				t.Setenv(name, value)
			}
			_, err := config.Load()
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("error = %v, want %s rejection", err, test.want)
			}
		})
	}
}

func TestLoadRejectsInvalidCapabilityFlags(t *testing.T) {
	for _, name := range []string{config.IntegrationsEnabled, config.TranscriptionEnabled} {
		t.Run(name, func(t *testing.T) {
			t.Setenv(name, "sometimes")
			_, err := config.Load()
			if err == nil || !strings.Contains(err.Error(), name+" must be true or false") {
				t.Fatalf("error = %v, want strict boolean rejection", err)
			}
		})
	}
}

func TestLoadOperationLogsDefaultToAllRequestLogs(t *testing.T) {
	t.Setenv(config.APIOperationLogs, "1")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}

	if cfg.Observability.RequestLogs != "all" {
		t.Fatalf("request logs = %q, want all", cfg.Observability.RequestLogs)
	}
}

func setProviderBridgeConfig(t *testing.T) {
	t.Helper()
	t.Setenv(config.ProviderBridgeAddress, "127.0.0.1:8444")
	t.Setenv(config.ProviderBridgeServerCertFile, "/run/secrets/provider-bridge-server.crt")
	t.Setenv(config.ProviderBridgeServerKeyFile, "/run/secrets/provider-bridge-server.key")
	t.Setenv(config.ProviderBridgeClientCAFile, "/run/secrets/provider-bridge-client-ca.crt")
	t.Setenv(config.ProviderBridgeSPIFFETrustDomain, "chalk.test")
}

func setTranscriptionConfig(t *testing.T) {
	t.Helper()
	t.Setenv(config.TranscriptionWorkloadAuthSecret, strings.Repeat("s", 32))
	t.Setenv(config.TranscriptionDispatcherFunction, "chalk-transcription-dispatcher")
	t.Setenv(config.R2Bucket, "chalk-transcription")
	t.Setenv(config.R2Endpoint, "https://storage.chalk.test")
	t.Setenv(config.R2AccessKeyID, "access-key")
	t.Setenv(config.R2SecretAccessKey, "secret-key")
}

func TestLoadRejectsInvalidDatabasePoolSettings(t *testing.T) {
	tests := []struct {
		name string
		env  map[string]string
	}{
		{
			name: "bad max conns",
			env: map[string]string{
				config.DatabaseMaxConns: "many",
			},
		},
		{
			name: "zero max conns",
			env: map[string]string{
				config.DatabaseMaxConns: "0",
			},
		},
		{
			name: "negative min conns",
			env: map[string]string{
				config.DatabaseMinConns: "-1",
			},
		},
		{
			name: "min greater than max",
			env: map[string]string{
				config.DatabaseMaxConns: "2",
				config.DatabaseMinConns: "3",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			for key, value := range tt.env {
				t.Setenv(key, value)
			}

			_, err := config.Load()
			if err == nil {
				t.Fatal("expected error")
			}
		})
	}
}

func TestLoadRejectsInvalidAuthSettings(t *testing.T) {
	tests := []struct {
		name string
		env  map[string]string
	}{
		{
			name: "bad session ttl",
			env: map[string]string{
				config.AuthSessionTTLMS: "soon",
			},
		},
		{
			name: "zero session ttl",
			env: map[string]string{
				config.AuthSessionTTLMS: "0",
			},
		},
		{
			name: "bad oauth state ttl",
			env: map[string]string{
				config.AuthOAuthStateTTLMS: "soon",
			},
		},
		{
			name: "zero oauth state ttl",
			env: map[string]string{
				config.AuthOAuthStateTTLMS: "0",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			for key, value := range tt.env {
				t.Setenv(key, value)
			}

			_, err := config.Load()
			if err == nil {
				t.Fatal("expected error")
			}
		})
	}
}

func TestLoadRejectsInvalidObservabilitySettings(t *testing.T) {
	tests := []struct {
		name string
		env  map[string]string
	}{
		{
			name: "bad log format",
			env: map[string]string{
				config.APILogFormat: "xml",
			},
		},
		{
			name: "bad log level",
			env: map[string]string{
				config.APILogLevel: "verbose",
			},
		},
		{
			name: "bad request logs",
			env: map[string]string{
				config.APIRequestLogs: "everything",
			},
		},
		{
			name: "bad sample rate",
			env: map[string]string{
				config.APIRequestSampleRate: "many",
			},
		},
		{
			name: "sample rate too high",
			env: map[string]string{
				config.APIRequestSampleRate: "1.5",
			},
		},
		{
			name: "bad slow request threshold",
			env: map[string]string{
				config.APISlowRequestMS: "soon",
			},
		},
		{
			name: "negative slow request threshold",
			env: map[string]string{
				config.APISlowRequestMS: "-1",
			},
		},
		{
			name: "insecure OTLP outside local",
			env: map[string]string{
				config.APIEnvironment:  "staging",
				config.DatabaseURL:     "postgres://db.internal/chalk?sslmode=require",
				config.ComposioAPIKey:  "composio-key",
				config.APIOTLPEndpoint: "http://otel.test:4318",
				config.APIOTLPInsecure: "true",
			},
		},
		{
			name: "OTLP endpoint without TLS",
			env: map[string]string{
				config.APIOTLPEndpoint: "http://otel.test:4318",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			for key, value := range tt.env {
				t.Setenv(key, value)
			}

			_, err := config.Load()
			if err == nil {
				t.Fatal("expected error")
			}
		})
	}
}

func TestLoadRejectsInvalidResendSettings(t *testing.T) {
	tests := []struct {
		name string
		env  map[string]string
	}{
		{
			name: "bad timeout",
			env: map[string]string{
				config.ResendTimeoutMS: "soon",
			},
		},
		{
			name: "zero timeout",
			env: map[string]string{
				config.ResendTimeoutMS: "0",
			},
		},
		{
			name: "negative timeout",
			env: map[string]string{
				config.ResendTimeoutMS: "-1",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			for key, value := range tt.env {
				t.Setenv(key, value)
			}

			_, err := config.Load()
			if err == nil {
				t.Fatal("expected error")
			}
		})
	}
}

func TestLoadRejectsInvalidCloudflareRealtimeSettings(t *testing.T) {
	tests := []struct {
		name string
		env  map[string]string
	}{
		{
			name: "bad timeout",
			env: map[string]string{
				config.CloudflareRealtimeRequestTimeoutMS: "soon",
			},
		},
		{
			name: "zero timeout",
			env: map[string]string{
				config.CloudflareRealtimeRequestTimeoutMS: "0",
			},
		},
		{
			name: "negative timeout",
			env: map[string]string{
				config.CloudflareRealtimeRequestTimeoutMS: "-1",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			for key, value := range tt.env {
				t.Setenv(key, value)
			}

			_, err := config.Load()
			if err == nil {
				t.Fatal("expected error")
			}
		})
	}
}

func TestLoadRejectsInvalidR2Settings(t *testing.T) {
	tests := []struct {
		name string
		env  map[string]string
	}{
		{
			name: "bad timeout",
			env: map[string]string{
				config.R2RequestTimeoutMS: "soon",
			},
		},
		{
			name: "zero timeout",
			env: map[string]string{
				config.R2RequestTimeoutMS: "0",
			},
		},
		{
			name: "negative timeout",
			env: map[string]string{
				config.R2RequestTimeoutMS: "-1",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			for key, value := range tt.env {
				t.Setenv(key, value)
			}

			_, err := config.Load()
			if err == nil {
				t.Fatal("expected error")
			}
		})
	}
}

func TestLoadRejectsInvalidComposioSettings(t *testing.T) {
	tests := []struct {
		name string
		env  map[string]string
	}{
		{
			name: "bad timeout",
			env: map[string]string{
				config.ComposioTimeoutMS: "soon",
			},
		},
		{
			name: "zero timeout",
			env: map[string]string{
				config.ComposioTimeoutMS: "0",
			},
		},
		{
			name: "negative timeout",
			env: map[string]string{
				config.ComposioTimeoutMS: "-1",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			for key, value := range tt.env {
				t.Setenv(key, value)
			}

			_, err := config.Load()
			if err == nil {
				t.Fatal("expected error")
			}
		})
	}
}
