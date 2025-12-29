package redis

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestNewClient tests Redis client initialization
func TestNewClient(t *testing.T) {
	// Skip if Redis is not available
	t.Skip("Requires Redis server running")

	ctx := context.Background()
	client, err := NewClient(ctx, "redis://localhost:6379")
	require.NoError(t, err)
	defer client.Close()

	assert.NotNil(t, client)
	assert.NotNil(t, client.GetClient())
}

// TestSetGet tests setting and getting values
func TestSetGet(t *testing.T) {
	t.Skip("Requires Redis server running")

	ctx := context.Background()
	client, err := NewClient(ctx, "redis://localhost:6379")
	require.NoError(t, err)
	defer client.Close()

	// Set a value
	err = client.Set(ctx, "test_key", "test_value", 1*time.Hour)
	require.NoError(t, err)

	// Get the value
	value, err := client.Get(ctx, "test_key")
	require.NoError(t, err)
	assert.Equal(t, "test_value", value)
}

// TestDel tests deleting keys
func TestDel(t *testing.T) {
	t.Skip("Requires Redis server running")

	ctx := context.Background()
	client, err := NewClient(ctx, "redis://localhost:6379")
	require.NoError(t, err)
	defer client.Close()

	// Set a value
	err = client.Set(ctx, "test_key_del", "test_value", 1*time.Hour)
	require.NoError(t, err)

	// Delete the value
	err = client.Del(ctx, "test_key_del")
	require.NoError(t, err)

	// Verify it's gone
	exists, err := client.Exists(ctx, "test_key_del")
	require.NoError(t, err)
	assert.Equal(t, int64(0), exists)
}

// TestExists tests checking if keys exist
func TestExists(t *testing.T) {
	t.Skip("Requires Redis server running")

	ctx := context.Background()
	client, err := NewClient(ctx, "redis://localhost:6379")
	require.NoError(t, err)
	defer client.Close()

	// Set a value
	err = client.Set(ctx, "test_key_exists", "test_value", 1*time.Hour)
	require.NoError(t, err)

	// Check existence
	exists, err := client.Exists(ctx, "test_key_exists")
	require.NoError(t, err)
	assert.Equal(t, int64(1), exists)
}
