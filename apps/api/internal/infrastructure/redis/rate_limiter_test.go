//nolint:errcheck
package redis

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNewWSRateLimiter(t *testing.T) {
	t.Skip("Requires Redis server running")

	ctx := context.Background()
	client, err := NewClient(ctx, "redis://localhost:6379")
	require.NoError(t, err)
	defer client.Close()

	limiter := NewWSRateLimiter(client)
	assert.NotNil(t, limiter)
	assert.Equal(t, DefaultWSLimits, limiter.limits)
}

func TestWSRateLimiterWithCustomLimits(t *testing.T) {
	t.Skip("Requires Redis server running")

	ctx := context.Background()
	client, err := NewClient(ctx, "redis://localhost:6379")
	require.NoError(t, err)
	defer client.Close()

	customLimits := map[string]RateLimit{
		"custom.action": {MaxRequests: 5, Window: 5 * time.Second},
	}

	limiter := NewWSRateLimiterWithLimits(client, customLimits)
	assert.NotNil(t, limiter)
	assert.Equal(t, customLimits, limiter.limits)
}

func TestWSRateLimiterAllowUnknownAction(t *testing.T) {
	t.Skip("Requires Redis server running")

	ctx := context.Background()
	client, err := NewClient(ctx, "redis://localhost:6379")
	require.NoError(t, err)
	defer client.Close()

	limiter := NewWSRateLimiter(client)
	participantID := uuid.New()

	allowed := limiter.Allow(ctx, participantID, "unknown.action")
	assert.True(t, allowed)
}

func TestWSRateLimiterChatSend(t *testing.T) {
	t.Skip("Requires Redis server running")

	ctx := context.Background()
	client, err := NewClient(ctx, "redis://localhost:6379")
	require.NoError(t, err)
	defer client.Close()

	limiter := NewWSRateLimiter(client)
	participantID := uuid.New()

	defer limiter.Reset(ctx, participantID, "chat.send")

	limit := DefaultWSLimits["chat.send"]
	for i := 0; i < limit.MaxRequests; i++ {
		allowed := limiter.Allow(ctx, participantID, "chat.send")
		assert.True(t, allowed, "Request %d should be allowed", i+1)
	}

	allowed := limiter.Allow(ctx, participantID, "chat.send")
	assert.False(t, allowed, "Request should be rate limited")
}

func TestWSRateLimiterReactionSend(t *testing.T) {
	t.Skip("Requires Redis server running")

	ctx := context.Background()
	client, err := NewClient(ctx, "redis://localhost:6379")
	require.NoError(t, err)
	defer client.Close()

	limiter := NewWSRateLimiter(client)
	participantID := uuid.New()

	defer limiter.Reset(ctx, participantID, "reaction.send")

	limit := DefaultWSLimits["reaction.send"]
	for i := 0; i < limit.MaxRequests; i++ {
		allowed := limiter.Allow(ctx, participantID, "reaction.send")
		assert.True(t, allowed, "Request %d should be allowed", i+1)
	}

	allowed := limiter.Allow(ctx, participantID, "reaction.send")
	assert.False(t, allowed, "Request should be rate limited")
}

func TestWSRateLimiterHandRaise(t *testing.T) {
	t.Skip("Requires Redis server running")

	ctx := context.Background()
	client, err := NewClient(ctx, "redis://localhost:6379")
	require.NoError(t, err)
	defer client.Close()

	limiter := NewWSRateLimiter(client)
	participantID := uuid.New()

	defer limiter.Reset(ctx, participantID, "hand.raise")

	limit := DefaultWSLimits["hand.raise"]
	for i := 0; i < limit.MaxRequests; i++ {
		allowed := limiter.Allow(ctx, participantID, "hand.raise")
		assert.True(t, allowed, "Request %d should be allowed", i+1)
	}

	allowed := limiter.Allow(ctx, participantID, "hand.raise")
	assert.False(t, allowed, "Request should be rate limited")
}

func TestWSRateLimiterReset(t *testing.T) {
	t.Skip("Requires Redis server running")

	ctx := context.Background()
	client, err := NewClient(ctx, "redis://localhost:6379")
	require.NoError(t, err)
	defer client.Close()

	limiter := NewWSRateLimiter(client)
	participantID := uuid.New()

	defer limiter.Reset(ctx, participantID, "chat.send")

	limit := DefaultWSLimits["chat.send"]
	for i := 0; i < limit.MaxRequests; i++ {
		limiter.Allow(ctx, participantID, "chat.send")
	}

	allowed := limiter.Allow(ctx, participantID, "chat.send")
	assert.False(t, allowed)

	err = limiter.Reset(ctx, participantID, "chat.send")
	require.NoError(t, err)

	allowed = limiter.Allow(ctx, participantID, "chat.send")
	assert.True(t, allowed)
}

func TestWSRateLimiterResetAll(t *testing.T) {
	t.Skip("Requires Redis server running")

	ctx := context.Background()
	client, err := NewClient(ctx, "redis://localhost:6379")
	require.NoError(t, err)
	defer client.Close()

	limiter := NewWSRateLimiter(client)
	participantID := uuid.New()

	defer limiter.ResetAll(ctx, participantID)

	for action, limit := range DefaultWSLimits {
		for i := 0; i < limit.MaxRequests; i++ {
			limiter.Allow(ctx, participantID, action)
		}
	}

	err = limiter.ResetAll(ctx, participantID)
	require.NoError(t, err)

	for action := range DefaultWSLimits {
		allowed := limiter.Allow(ctx, participantID, action)
		assert.True(t, allowed, "Action %s should be allowed after reset", action)
	}
}

func TestWSRateLimiterGetLimit(t *testing.T) {
	t.Skip("Requires Redis server running")

	ctx := context.Background()
	client, err := NewClient(ctx, "redis://localhost:6379")
	require.NoError(t, err)
	defer client.Close()

	limiter := NewWSRateLimiter(client)

	limit, ok := limiter.GetLimit("chat.send")
	assert.True(t, ok)
	assert.Equal(t, DefaultWSLimits["chat.send"], limit)

	_, ok = limiter.GetLimit("unknown")
	assert.False(t, ok)
}

func TestWSRateLimiterSetLimit(t *testing.T) {
	t.Skip("Requires Redis server running")

	ctx := context.Background()
	client, err := NewClient(ctx, "redis://localhost:6379")
	require.NoError(t, err)
	defer client.Close()

	limiter := NewWSRateLimiter(client)

	newLimit := RateLimit{MaxRequests: 100, Window: 1 * time.Minute}
	limiter.SetLimit("custom", newLimit)

	limit, ok := limiter.GetLimit("custom")
	assert.True(t, ok)
	assert.Equal(t, newLimit, limit)
}

func TestWSRateLimiterDifferentParticipants(t *testing.T) {
	t.Skip("Requires Redis server running")

	ctx := context.Background()
	client, err := NewClient(ctx, "redis://localhost:6379")
	require.NoError(t, err)
	defer client.Close()

	limiter := NewWSRateLimiter(client)
	participant1 := uuid.New()
	participant2 := uuid.New()

	defer limiter.ResetAll(ctx, participant1)
	defer limiter.ResetAll(ctx, participant2)

	limit := DefaultWSLimits["chat.send"]
	for i := 0; i < limit.MaxRequests; i++ {
		limiter.Allow(ctx, participant1, "chat.send")
	}

	allowed := limiter.Allow(ctx, participant1, "chat.send")
	assert.False(t, allowed, "Participant 1 should be rate limited")

	allowed = limiter.Allow(ctx, participant2, "chat.send")
	assert.True(t, allowed, "Participant 2 should not be rate limited")
}

func TestWSRateLimiterTokenRefill(t *testing.T) {
	t.Skip("Requires Redis server running")

	ctx := context.Background()
	client, err := NewClient(ctx, "redis://localhost:6379")
	require.NoError(t, err)
	defer client.Close()

	shortWindow := map[string]RateLimit{
		"test.action": {MaxRequests: 2, Window: 500 * time.Millisecond},
	}
	limiter := NewWSRateLimiterWithLimits(client, shortWindow)
	participantID := uuid.New()

	defer limiter.Reset(ctx, participantID, "test.action")

	limiter.Allow(ctx, participantID, "test.action")
	limiter.Allow(ctx, participantID, "test.action")

	allowed := limiter.Allow(ctx, participantID, "test.action")
	assert.False(t, allowed, "Should be rate limited")

	time.Sleep(600 * time.Millisecond)

	allowed = limiter.Allow(ctx, participantID, "test.action")
	assert.True(t, allowed, "Token should have refilled")
}
