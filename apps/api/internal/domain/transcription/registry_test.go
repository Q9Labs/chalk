package transcription

import (
	"context"
	"testing"

	goredis "github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"
)

type registryStubProvider struct {
	name string
}

func (p registryStubProvider) Transcribe(_ context.Context, _ TranscriptionRequest) (*TranscriptionResult, error) {
	return nil, nil
}

func (p registryStubProvider) Name() string {
	return p.name
}

func (p registryStubProvider) MaxFileSize() int64 {
	return 0
}

func TestProviderRegistry_GetDefaultProviderUsesConfiguredDefault(t *testing.T) {
	registry := NewProviderRegistry(RegistryConfig{
		DefaultProvider:          "cloudflare",
		CloudflareWorkerURL:      "https://worker.example.com",
		CloudflareDispatchSecret: "token",
	}, nil, nil)

	require.Equal(t, "cloudflare", registry.GetDefaultProvider())
}

func TestProviderRegistry_GetDefaultProviderFallsBackWhenConfiguredDefaultUnavailable(t *testing.T) {
	registry := NewProviderRegistry(RegistryConfig{
		DefaultProvider: "whisper",
		GroqAPIKey:      "groq-key",
	}, nil, nil)

	require.Equal(t, "groq", registry.GetDefaultProvider())
}

func TestProviderRegistry_GetAvailableProvidersIncludesCloudflareAvailability(t *testing.T) {
	registry := NewProviderRegistry(RegistryConfig{
		CloudflareWorkerURL:      "https://worker.example.com",
		CloudflareDispatchSecret: "token",
		WhisperEnabled:           true,
		WhisperQueue:             "transcription:jobs",
	}, &goredis.Client{}, nil)

	providers := registry.GetAvailableProviders()
	require.Len(t, providers, 3)
	require.Equal(t, "cloudflare", providers[0].ID)
	require.True(t, providers[0].Available)
}
