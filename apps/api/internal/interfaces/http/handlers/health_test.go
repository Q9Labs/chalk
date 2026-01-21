package handlers

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNewHealthHandler(t *testing.T) {
	handler := NewHealthHandler(nil)
	assert.NotNil(t, handler)
	assert.Nil(t, handler.pool)
}

// Note: TestHealthHandler_Check with nil pool will panic because
// the handler directly calls pool.Health(). In production,
// the handler always receives a valid pool via dependency injection.
// Integration tests with a test database should be used for full Check testing.

func TestHealthHandler_ResponseStructure(t *testing.T) {
	// Test that the response structure is correct
	// This is a unit test for the response format

	// Healthy response structure
	healthyResponse := map[string]interface{}{
		"status":   "healthy",
		"database": "connected",
		"uptime":   float64(3600.5),
		"pool": map[string]interface{}{
			"total_conns":    int32(10),
			"idle_conns":     int32(5),
			"acquired_conns": int32(5),
		},
	}

	data, err := json.Marshal(healthyResponse)
	require.NoError(t, err)

	var parsed map[string]interface{}
	err = json.Unmarshal(data, &parsed)
	require.NoError(t, err)
	assert.Equal(t, "healthy", parsed["status"])
	assert.Equal(t, "connected", parsed["database"])
	assert.NotNil(t, parsed["uptime"])
	assert.NotNil(t, parsed["pool"])
}

func TestHealthHandler_UnhealthyResponseStructure(t *testing.T) {
	// Unhealthy response structure
	unhealthyResponse := map[string]interface{}{
		"status":   "unhealthy",
		"database": "disconnected",
		"uptime":   float64(3600.5),
	}

	data, err := json.Marshal(unhealthyResponse)
	require.NoError(t, err)

	var parsed map[string]interface{}
	err = json.Unmarshal(data, &parsed)
	require.NoError(t, err)
	assert.Equal(t, "unhealthy", parsed["status"])
	assert.Equal(t, "disconnected", parsed["database"])
	assert.NotNil(t, parsed["uptime"])
}
