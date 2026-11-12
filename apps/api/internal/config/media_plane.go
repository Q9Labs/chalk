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
	"github.com/q9labs/chalk/apps/api/internal/spaces"
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

// loadNewEpisodesPaused reads the kill switch. It is on unless set to off.
func loadNewEpisodesPaused() (bool, error) {
	value := strings.ToLower(strings.TrimSpace(os.Getenv(ChalkSFUNewEpisodes)))
	switch value {
	case "", "on", "true":
		return false, nil
	case "off", "false":
		return true, nil
	default:
		return false, fmt.Errorf("%s must be on or off", ChalkSFUNewEpisodes)
	}
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

func loadDefaultMediaPlane() (spaces.MediaPlaneProvider, error) {
	value, ok := os.LookupEnv(DefaultMediaPlane)
	if !ok || strings.TrimSpace(value) == "" {
		return "", nil
	}

	provider, err := spaces.ParseMediaPlaneProvider(value)
	if err != nil {
		return "", fmt.Errorf("%s: %w", DefaultMediaPlane, err)
	}
	return provider, nil
}

// loadNewSpaceDefaults reads what a Create Space request gets for the fields it
// omits. A new Space has a random ID that no allowlist can name in advance, so
// the own SFU as the new-Space plane needs every Space allowed. Automatic capture
// defaults on the own SFU need capture, or new Spaces would promise artifacts
// that no node produces. An omitted policy is the database default, so it counts.
func loadNewSpaceDefaults(chalkSFU ChalkSFUConfig) (spaces.NewSpaceDefaults, error) {
	var defaults spaces.NewSpaceDefaults
	if value := strings.TrimSpace(os.Getenv(NewSpaceMediaPlane)); value != "" {
		provider, err := spaces.ParseMediaPlaneProvider(value)
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
	if defaults.MediaPlane != spaces.MediaPlaneProviderChalkSFU {
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

// validateMediaPlaneProcessConfig checks what a platform default needs to run. Cloudflare is
// needed under either default: it is the default itself, or the fallback for an SDK that
// cannot run the own SFU, for the kill switch and for Episodes already bound to it.
func validateMediaPlaneProcessConfig(provider spaces.MediaPlaneProvider, processConfig CloudflareRealtimeConfig, chalkSFU ChalkSFUConfig) error {
	if provider == "" {
		return nil
	}
	if processConfig.RequestTimeout <= 0 {
		return fmt.Errorf("%s must be greater than zero", CloudflareRealtimeRequestTimeoutMS)
	}
	if provider == spaces.MediaPlaneProviderChalkSFU && !chalkSFU.Enabled {
		return fmt.Errorf("%s=%s requires %s=true", DefaultMediaPlane, provider, ChalkSFUEnabled)
	}
	// A Space can turn recording or transcription on at any time, and an Episode on the own SFU
	// has no capture path without this flag, so every inheriting Space would lose them.
	if provider == spaces.MediaPlaneProviderChalkSFU && !chalkSFU.CaptureEnabled {
		return fmt.Errorf("%s=%s requires %s=true, because recording and transcription of an own-SFU Episode need capture", DefaultMediaPlane, provider, ChalkSFUCaptureEnabled)
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

func loadCloudflareRealtimeConfig(environment string) (CloudflareRealtimeConfig, error) {
	requestTimeout, err := envPositiveMilliseconds(CloudflareRealtimeRequestTimeoutMS, DefaultCloudflareRealtimeRequestTimeoutMS)
	if err != nil {
		return CloudflareRealtimeConfig{}, err
	}
	baseURL := strings.TrimRight(strings.TrimSpace(envOrDefault(CloudflareRealtimeBaseURL, "")), "/")
	if baseURL != "" {
		if environment != DefaultEnvironment {
			return CloudflareRealtimeConfig{}, fmt.Errorf("%s is only supported in local environments", CloudflareRealtimeBaseURL)
		}
		if !isLocalhostURL(baseURL) {
			return CloudflareRealtimeConfig{}, fmt.Errorf("%s must be an absolute localhost URL without query or fragment", CloudflareRealtimeBaseURL)
		}
	}
	return CloudflareRealtimeConfig{
		AccountID:         envOrDefault(CloudflareAccountID, ""),
		RealtimeAppID:     envOrDefault(CloudflareRealtimeAppID, ""),
		RealtimeAppSecret: envOrDefault(CloudflareRealtimeAppSecret, ""),
		RealtimeBaseURL:   baseURL,
		TurnKeyID:         envOrDefault(CloudflareTurnKeyID, ""),
		TurnAPIToken:      envOrDefault(CloudflareTurnAPIToken, ""),
		RequestTimeout:    requestTimeout,
	}, nil
}

func isLocalhostURL(raw string) bool {
	parsed, err := url.Parse(raw)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return false
	}
	host := parsed.Hostname()
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
