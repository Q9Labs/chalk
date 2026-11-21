package config

import (
	"cmp"
	"fmt"
	"net"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/artifactpolicy"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
)

const (
	CloudflareAccountID         = "CHALK_CLOUDFLARE_ACCOUNT_ID"
	CloudflareRealtimeAppID     = "CHALK_CLOUDFLARE_REALTIME_APP_ID"
	CloudflareRealtimeAppSecret = "CHALK_CLOUDFLARE_REALTIME_APP_SECRET"
	CloudflareRealtimeBaseURL   = "CHALK_CLOUDFLARE_REALTIME_BASE_URL"
	CloudflareTurnKeyID         = "CHALK_CLOUDFLARE_TURN_KEY_ID"
	CloudflareTurnAPIToken      = "CHALK_CLOUDFLARE_TURN_API_TOKEN"

	CloudflareRealtimeRequestTimeoutMS        = "CHALK_CLOUDFLARE_REALTIME_TIMEOUT_MS"
	DefaultMediaPlane                         = "CHALK_DEFAULT_MEDIA_PLANE"
	NewSpaceMediaPlane                        = "CHALK_NEW_SPACE_MEDIA_PLANE"
	NewSpaceRecordingPolicy                   = "CHALK_NEW_SPACE_RECORDING_POLICY"
	NewSpaceTranscriptionPolicy               = "CHALK_NEW_SPACE_TRANSCRIPTION_POLICY"
	DefaultCloudflareRealtimeRequestTimeoutMS = int64(6000)
	DefaultCloudflareRealtimeTimeout          = time.Duration(DefaultCloudflareRealtimeRequestTimeoutMS) * time.Millisecond
)

type CloudflareRealtimeConfig struct {
	AccountID         string
	RealtimeAppID     string
	RealtimeAppSecret string
	RealtimeBaseURL   string
	// TurnKeyID and TurnAPIToken are optional and set together. Without them
	// clients get STUN only.
	TurnKeyID    string
	TurnAPIToken string

	RequestTimeout time.Duration
}

// ChalkSFURole says whether placement prefers a node. A primary takes new
// Episodes in configuration order; a standby takes one only when no primary can.

func (cfg *Config) loadMedia(environment string) error {
	realtimeBaseURL, err := loadRealtimeBaseURL(environment)
	if err != nil {
		return err
	}
	cfg.DefaultMediaPlane, err = loadDefaultMediaPlane()
	if err != nil {
		return err
	}
	cfg.CloudflareRealtime = CloudflareRealtimeConfig{
		AccountID:         envOrDefault(CloudflareAccountID, ""),
		RealtimeAppID:     envOrDefault(CloudflareRealtimeAppID, ""),
		RealtimeAppSecret: envOrDefault(CloudflareRealtimeAppSecret, ""),
		RealtimeBaseURL:   realtimeBaseURL,
		TurnKeyID:         envOrDefault(CloudflareTurnKeyID, ""),
		TurnAPIToken:      envOrDefault(CloudflareTurnAPIToken, ""),

		RequestTimeout: cfg.CloudflareRealtime.RequestTimeout,
	}
	cfg.ChalkSFU, err = loadChalkSFUConfig()
	if err != nil {
		return err
	}
	cfg.NewSpace, err = loadNewSpaceDefaults(cfg.ChalkSFU)
	if err != nil {
		return err
	}
	if err := validateTurnProcessConfig(cfg.CloudflareRealtime); err != nil {
		return err
	}
	if err := validateMediaPlaneProcessConfig(cfg.DefaultMediaPlane, cfg.CloudflareRealtime, cfg.ChalkSFU); err != nil {
		return err
	}
	if err := validateProviderBridgeMediaPlaneProcessConfig(cfg.ProviderBridge, cfg.CloudflareRealtime); err != nil {
		return err
	}
	return nil
}

func loadRealtimeBaseURL(environment string) (string, error) {
	realtimeBaseURL := strings.TrimRight(strings.TrimSpace(envOrDefault(CloudflareRealtimeBaseURL, "")), "/")
	if realtimeBaseURL != "" {
		if environment != DefaultEnvironment {
			return "", fmt.Errorf("%s is only supported in local environments", CloudflareRealtimeBaseURL)
		}
		parsed, parseErr := url.Parse(realtimeBaseURL)
		host := parsed.Hostname()
		ip := net.ParseIP(host)
		if parseErr != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.RawQuery != "" || parsed.Fragment != "" || (host != "localhost" && (ip == nil || !ip.IsLoopback())) {
			return "", fmt.Errorf("%s must be an absolute localhost URL without query or fragment", CloudflareRealtimeBaseURL)
		}
	}
	return realtimeBaseURL, nil
}

// LoadPlanePolicy reads the plane policy from the environment the API runs with,
// for the operator command, which does not load the whole configuration.
func LoadPlanePolicy() (spaces.PlanePolicy, error) {
	platform, err := loadDefaultMediaPlane()
	if err != nil {
		return spaces.PlanePolicy{}, err
	}
	allowed, err := spaces.ParseChalkSFUAllowlist(envList(ChalkSFUAllowedSpaces))
	if err != nil {
		return spaces.PlanePolicy{}, fmt.Errorf("%s: %w", ChalkSFUAllowedSpaces, err)
	}
	paused, err := loadNewEpisodesPaused()
	if err != nil {
		return spaces.PlanePolicy{}, err
	}
	return spaces.PlanePolicy{Platform: platform, Allowed: allowed, NewEpisodesPaused: paused}, nil
}

func loadDefaultMediaPlane() (mediaplane.Provider, error) {
	value, ok := os.LookupEnv(DefaultMediaPlane)
	if !ok || strings.TrimSpace(value) == "" {
		return "", nil
	}

	provider, err := mediaplane.ParseSettingName(value)
	if err != nil {
		return "", fmt.Errorf("%s: %w", DefaultMediaPlane, err)
	}
	return provider, nil
}

// loadNewSpaceDefaults reads what a Create Space request gets for the fields it
// omits. A new Space has a random ID that no allowlist can name in advance, so
// the Chalk SFU as the new-Space plane needs every Space allowed. Automatic capture
// defaults on the Chalk SFU need capture, or new Spaces would promise artifacts
// that no node produces. An omitted policy is the database default, so it counts.
func loadNewSpaceDefaults(chalkSFU ChalkSFUConfig) (spaces.NewSpaceDefaults, error) {
	var defaults spaces.NewSpaceDefaults
	if value := strings.TrimSpace(os.Getenv(NewSpaceMediaPlane)); value != "" {
		provider, err := mediaplane.ParseSettingName(value)
		if err != nil {
			return spaces.NewSpaceDefaults{}, fmt.Errorf("%s: %w", NewSpaceMediaPlane, err)
		}
		defaults.MediaPlane = provider
	}
	if value := strings.TrimSpace(os.Getenv(NewSpaceRecordingPolicy)); value != "" {
		defaults.RecordingPolicy = artifactpolicy.RecordingMode(value)
		if err := defaults.RecordingPolicy.Validate(); err != nil {
			return spaces.NewSpaceDefaults{}, fmt.Errorf("%s: %w", NewSpaceRecordingPolicy, err)
		}
	}
	if value := strings.TrimSpace(os.Getenv(NewSpaceTranscriptionPolicy)); value != "" {
		defaults.TranscriptionPolicy = artifactpolicy.TranscriptionMode(value)
		if err := defaults.TranscriptionPolicy.Validate(); err != nil {
			return spaces.NewSpaceDefaults{}, fmt.Errorf("%s: %w", NewSpaceTranscriptionPolicy, err)
		}
	}
	if defaults.MediaPlane != mediaplane.ProviderChalkSFU {
		return defaults, nil
	}
	if !chalkSFU.Enabled || chalkSFU.AllowedSpaces.Size() != -1 {
		return spaces.NewSpaceDefaults{}, fmt.Errorf("%s=%s requires %s=true and %s=*", NewSpaceMediaPlane, defaults.MediaPlane, ChalkSFUEnabled, ChalkSFUAllowedSpaces)
	}
	recording := cmp.Or(defaults.RecordingPolicy, spaces.DatabaseDefaultRecordingPolicy)
	transcription := cmp.Or(defaults.TranscriptionPolicy, spaces.DatabaseDefaultTranscriptionPolicy)
	capturing := recording != artifactpolicy.RecordingDisabled || transcription != artifactpolicy.TranscriptionDisabled
	if capturing && !chalkSFU.CaptureEnabled {
		return spaces.NewSpaceDefaults{}, fmt.Errorf("new Spaces get recording %s and transcription %s (%s and %s default to %s and %s); unless both are disabled they need %s=true when %s=%s", recording, transcription, NewSpaceRecordingPolicy, NewSpaceTranscriptionPolicy, spaces.DatabaseDefaultRecordingPolicy, spaces.DatabaseDefaultTranscriptionPolicy, ChalkSFUCaptureEnabled, NewSpaceMediaPlane, defaults.MediaPlane)
	}
	return defaults, nil
}

func validateMediaPlaneProcessConfig(provider mediaplane.Provider, processConfig CloudflareRealtimeConfig, chalkSFU ChalkSFUConfig) error {
	if provider == "" {
		return nil
	}
	if processConfig.RequestTimeout <= 0 {
		return fmt.Errorf("%s must be greater than zero", CloudflareRealtimeRequestTimeoutMS)
	}
	if provider == mediaplane.ProviderChalkSFU && !chalkSFU.Enabled {
		return fmt.Errorf("%s=%s requires %s=true", DefaultMediaPlane, provider, ChalkSFUEnabled)
	}
	// A Space can turn recording or transcription on at any time, and an Episode on the Chalk SFU
	// has no capture path without this flag, so every inheriting Space would lose them.
	if provider == mediaplane.ProviderChalkSFU && !chalkSFU.CaptureEnabled {
		return fmt.Errorf("%s=%s requires %s=true, because recording and transcription of a Chalk SFU Episode need capture", DefaultMediaPlane, provider, ChalkSFUCaptureEnabled)
	}
	if strings.TrimSpace(processConfig.RealtimeAppID) == "" {
		return fmt.Errorf("%s must be set when %s=%s", CloudflareRealtimeAppID, DefaultMediaPlane, provider)
	}
	if strings.TrimSpace(processConfig.RealtimeAppSecret) == "" {
		return fmt.Errorf("%s must be set when %s=%s", CloudflareRealtimeAppSecret, DefaultMediaPlane, provider)
	}
	return nil
}

func validateTurnProcessConfig(processConfig CloudflareRealtimeConfig) error {
	if (strings.TrimSpace(processConfig.TurnKeyID) == "") != (strings.TrimSpace(processConfig.TurnAPIToken) == "") {
		return fmt.Errorf("%s and %s must be set together", CloudflareTurnKeyID, CloudflareTurnAPIToken)
	}
	return nil
}

func validateProviderBridgeMediaPlaneProcessConfig(providerBridge ProviderBridgeConfig, processConfig CloudflareRealtimeConfig) error {
	if !providerBridge.Enabled {
		return nil
	}
	if strings.TrimSpace(processConfig.RealtimeAppID) == "" {
		return fmt.Errorf("%s must be set when the ProviderBridge is enabled", CloudflareRealtimeAppID)
	}
	if strings.TrimSpace(processConfig.RealtimeAppSecret) == "" {
		return fmt.Errorf("%s must be set when the ProviderBridge is enabled", CloudflareRealtimeAppSecret)
	}
	return nil
}
