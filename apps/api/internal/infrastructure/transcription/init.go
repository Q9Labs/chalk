package transcription

import (
	goredis "github.com/redis/go-redis/v9"

	domain "github.com/Q9Labs/chalk/internal/domain/transcription"
)

func init() {
	// Register provider factories with the domain package.
	// This breaks the circular dependency by having infrastructure
	// register its implementations at package initialization time.
	domain.RegisterGroqFactory(func(apiKey string) domain.Provider {
		return NewGroqProvider(apiKey)
	})

	domain.RegisterWhisperFactory(func(redis *goredis.Client, queueKey string) domain.Provider {
		return NewWhisperProvider(redis, queueKey)
	})
}
