package transcription

import (
	goredis "github.com/redis/go-redis/v9"
)

// These factory functions are set by the infrastructure package at init time.
// This breaks the circular dependency between domain and infrastructure.

var (
	newCloudflareProviderFromRegistry func(workerURL, dispatchSecret, model string) Provider
	newGroqProviderFromRegistry       func(apiKey string) Provider
	newWhisperProviderFromRegistry    func(redis *goredis.Client, queueKey string, store WhisperJobStore) Provider
)

// RegisterCloudflareFactory registers the factory function for Cloudflare Workers AI provider.
func RegisterCloudflareFactory(fn func(workerURL, dispatchSecret, model string) Provider) {
	newCloudflareProviderFromRegistry = fn
}

// RegisterGroqFactory registers the factory function for Groq provider.
func RegisterGroqFactory(fn func(apiKey string) Provider) {
	newGroqProviderFromRegistry = fn
}

// RegisterWhisperFactory registers the factory function for Whisper provider.
func RegisterWhisperFactory(fn func(redis *goredis.Client, queueKey string, store WhisperJobStore) Provider) {
	newWhisperProviderFromRegistry = fn
}
