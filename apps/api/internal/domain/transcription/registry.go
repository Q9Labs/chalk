package transcription

import goredis "github.com/redis/go-redis/v9"

// RegistryConfig holds configuration for the provider registry.
type RegistryConfig struct {
	GroqAPIKey     string
	WhisperEnabled bool
	WhisperQueue   string
}

// ProviderRegistry manages transcription provider availability and creation.
type ProviderRegistry struct {
	groqAPIKey      string
	whisperEnabled  bool
	whisperQueue    string
	whisperJobStore WhisperJobStore
	redis           *goredis.Client
}

// NewProviderRegistry creates a new provider registry.
func NewProviderRegistry(cfg RegistryConfig, redis *goredis.Client, whisperJobStore WhisperJobStore) *ProviderRegistry {
	return &ProviderRegistry{
		groqAPIKey:      cfg.GroqAPIKey,
		whisperEnabled:  cfg.WhisperEnabled,
		whisperQueue:    cfg.WhisperQueue,
		whisperJobStore: whisperJobStore,
		redis:           redis,
	}
}

// ProviderInfo describes a transcription provider.
type ProviderInfo struct {
	ID                string `json:"id"`
	Name              string `json:"name"`
	Type              string `json:"type"` // cloud, self_hosted
	BYOKSupported     bool   `json:"byok_supported"`
	Available         bool   `json:"available"`
	UnavailableReason string `json:"unavailable_reason,omitempty"`
}

// GetAvailableProviders returns information about all providers.
func (r *ProviderRegistry) GetAvailableProviders() []ProviderInfo {
	providers := []ProviderInfo{
		{
			ID:            "groq",
			Name:          "Groq",
			Type:          "cloud",
			BYOKSupported: true,
			Available:     true,
		},
	}

	whisperInfo := ProviderInfo{
		ID:            "whisper",
		Name:          "Self-Hosted Whisper",
		Type:          "self_hosted",
		BYOKSupported: false,
	}
	if r.whisperEnabled && r.redis != nil && r.whisperQueue != "" {
		whisperInfo.Available = true
	} else {
		whisperInfo.Available = false
		whisperInfo.UnavailableReason = "Self-hosted Whisper is not provisioned on this instance"
	}
	providers = append(providers, whisperInfo)

	return providers
}

// CreateProvider instantiates a provider by name.
// tenantAPIKey is used for BYOK; if empty, the platform default is used.
func (r *ProviderRegistry) CreateProvider(providerName string, tenantAPIKey string) (Provider, error) {
	if providerName == "" {
		providerName = r.GetDefaultProvider()
	}

	switch providerName {
	case "groq":
		apiKey := tenantAPIKey
		if apiKey == "" {
			apiKey = r.groqAPIKey
		}
		if apiKey == "" {
			return nil, ErrProviderNotConfigured
		}
		return newGroqProviderFromRegistry(apiKey), nil

	case "whisper":
		if !r.whisperEnabled {
			return nil, ErrWhisperNotAvailable
		}
		if r.redis == nil || r.whisperQueue == "" {
			return nil, ErrWhisperNotAvailable
		}
		return newWhisperProviderFromRegistry(r.redis, r.whisperQueue, r.whisperJobStore), nil

	default:
		return nil, ErrNoProviderAvailable
	}
}

// GetDefaultProvider returns the name of the default provider.
func (r *ProviderRegistry) GetDefaultProvider() string {
	if r.whisperEnabled && r.redis != nil && r.whisperQueue != "" {
		return "whisper"
	}
	if r.groqAPIKey != "" {
		return "groq"
	}
	return ""
}

// HasProvider returns true if the registry can create the named provider.
func (r *ProviderRegistry) HasProvider(name string) bool {
	switch name {
	case "groq":
		return r.groqAPIKey != ""
	case "whisper":
		return r.whisperEnabled && r.redis != nil && r.whisperQueue != ""
	default:
		return false
	}
}
