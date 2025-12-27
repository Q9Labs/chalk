package auth

import (
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestDefaultHostPermissions_AllPermissionsEnabled tests that host has all permissions enabled
func TestDefaultHostPermissions_AllPermissionsEnabled(t *testing.T) {
	perms := DefaultHostPermissions()

	assert.True(t, perms.CanRecord, "Host should have CanRecord enabled")
	assert.True(t, perms.CanScreenShare, "Host should have CanScreenShare enabled")
	assert.True(t, perms.CanKick, "Host should have CanKick enabled")
	assert.True(t, perms.CanMute, "Host should have CanMute enabled")
}

// TestDefaultParticipantPermissions_LimitedPermissions tests that participant has limited permissions
func TestDefaultParticipantPermissions_LimitedPermissions(t *testing.T) {
	perms := DefaultParticipantPermissions()

	assert.False(t, perms.CanRecord, "Participant should not have CanRecord enabled")
	assert.True(t, perms.CanScreenShare, "Participant should have CanScreenShare enabled")
	assert.False(t, perms.CanKick, "Participant should not have CanKick enabled")
	assert.False(t, perms.CanMute, "Participant should not have CanMute enabled")
}

// TestPermissions_ZeroValue tests that zero value of Permissions has all fields false
func TestPermissions_ZeroValue(t *testing.T) {
	var perms Permissions

	assert.False(t, perms.CanRecord, "Zero value should have CanRecord as false")
	assert.False(t, perms.CanScreenShare, "Zero value should have CanScreenShare as false")
	assert.False(t, perms.CanKick, "Zero value should have CanKick as false")
	assert.False(t, perms.CanMute, "Zero value should have CanMute as false")
}

// TestClaims_ZeroValue tests that zero value of Claims has expected defaults
func TestClaims_ZeroValue(t *testing.T) {
	var claims Claims

	assert.Equal(t, "", claims.Subject, "Zero value Subject should be empty string")
	assert.Equal(t, "", claims.DisplayName, "Zero value DisplayName should be empty string")
	assert.Equal(t, "", claims.Role, "Zero value Role should be empty string")
	assert.Equal(t, "", claims.CFAuthToken, "Zero value CFAuthToken should be empty string")
	assert.True(t, claims.IssuedAt.IsZero(), "Zero value IssuedAt should be zero time")
	assert.True(t, claims.ExpiresAt.IsZero(), "Zero value ExpiresAt should be zero time")
	assert.Equal(t, uuid.Nil, claims.TenantID, "Zero value TenantID should be nil UUID")
	assert.Equal(t, uuid.Nil, claims.RoomID, "Zero value RoomID should be nil UUID")
	assert.Equal(t, Permissions{}, claims.Permissions, "Zero value Permissions should be empty")
}

// TestTokenPair_ZeroValue tests that zero value of TokenPair has expected defaults
func TestTokenPair_ZeroValue(t *testing.T) {
	var tokenPair TokenPair

	assert.Equal(t, "", tokenPair.AccessToken, "Zero value AccessToken should be empty string")
	assert.Equal(t, "", tokenPair.RefreshToken, "Zero value RefreshToken should be empty string")
	assert.Equal(t, "", tokenPair.TokenType, "Zero value TokenType should be empty string")
	assert.Equal(t, 0, tokenPair.ExpiresIn, "Zero value ExpiresIn should be 0")
	assert.True(t, tokenPair.ExpiresAt.IsZero(), "Zero value ExpiresAt should be zero time")
}

// TestAPIKeyInfo_ZeroValue tests that zero value of APIKeyInfo has expected defaults
func TestAPIKeyInfo_ZeroValue(t *testing.T) {
	var apiKeyInfo APIKeyInfo

	assert.Equal(t, uuid.Nil, apiKeyInfo.TenantID, "Zero value TenantID should be nil UUID")
	assert.Equal(t, "", apiKeyInfo.KeyHash, "Zero value KeyHash should be empty string")
}

// TestClaimsWithValues tests Claims struct with populated values
func TestClaimsWithValues(t *testing.T) {
	tenantID := uuid.New()
	roomID := uuid.New()
	participantID := uuid.New().String()
	now := time.Now()
	expiry := now.Add(24 * time.Hour)

	claims := Claims{
		Subject:     participantID,
		IssuedAt:    now,
		ExpiresAt:   expiry,
		TenantID:    tenantID,
		RoomID:      roomID,
		DisplayName: "Test User",
		Role:        "host",
		Permissions: DefaultHostPermissions(),
		CFAuthToken: "cf_token_xyz",
	}

	assert.Equal(t, participantID, claims.Subject)
	assert.Equal(t, tenantID, claims.TenantID)
	assert.Equal(t, roomID, claims.RoomID)
	assert.Equal(t, "Test User", claims.DisplayName)
	assert.Equal(t, "host", claims.Role)
	assert.Equal(t, "cf_token_xyz", claims.CFAuthToken)
	assert.True(t, claims.IssuedAt.Equal(now))
	assert.True(t, claims.ExpiresAt.Equal(expiry))
	assert.True(t, claims.Permissions.CanRecord)
	assert.True(t, claims.Permissions.CanScreenShare)
	assert.True(t, claims.Permissions.CanKick)
	assert.True(t, claims.Permissions.CanMute)
}

// TestTokenPairWithValues tests TokenPair struct with populated values
func TestTokenPairWithValues(t *testing.T) {
	expiresAt := time.Now().Add(1 * time.Hour)

	tokenPair := TokenPair{
		AccessToken:  "access_token_123",
		RefreshToken: "refresh_token_456",
		TokenType:    "Bearer",
		ExpiresIn:    3600,
		ExpiresAt:    expiresAt,
	}

	assert.Equal(t, "access_token_123", tokenPair.AccessToken)
	assert.Equal(t, "refresh_token_456", tokenPair.RefreshToken)
	assert.Equal(t, "Bearer", tokenPair.TokenType)
	assert.Equal(t, 3600, tokenPair.ExpiresIn)
	assert.True(t, tokenPair.ExpiresAt.Equal(expiresAt))
}

// TestAPIKeyInfoWithValues tests APIKeyInfo struct with populated values
func TestAPIKeyInfoWithValues(t *testing.T) {
	tenantID := uuid.New()
	keyHash := "sha256_hash_value"

	apiKeyInfo := APIKeyInfo{
		TenantID: tenantID,
		KeyHash:  keyHash,
	}

	assert.Equal(t, tenantID, apiKeyInfo.TenantID)
	assert.Equal(t, keyHash, apiKeyInfo.KeyHash)
}

// TestPermissionsCopy tests that creating a new Permissions struct doesn't affect the original
func TestPermissionsCopy(t *testing.T) {
	original := DefaultHostPermissions()
	copy := original

	// Modify the copy
	copy.CanRecord = false

	// Original should be unchanged
	assert.True(t, original.CanRecord)
	assert.False(t, copy.CanRecord)
}

// TestDifferentRolePermissions tests that host and participant permissions are different
func TestDifferentRolePermissions(t *testing.T) {
	hostPerms := DefaultHostPermissions()
	participantPerms := DefaultParticipantPermissions()

	assert.NotEqual(t, hostPerms, participantPerms, "Host and participant permissions should be different")
	assert.True(t, hostPerms.CanRecord, "Host should be able to record")
	assert.False(t, participantPerms.CanRecord, "Participant should not be able to record")
	assert.True(t, hostPerms.CanKick, "Host should be able to kick")
	assert.False(t, participantPerms.CanKick, "Participant should not be able to kick")
	// Both should be able to screen share
	assert.True(t, hostPerms.CanScreenShare)
	assert.True(t, participantPerms.CanScreenShare)
}

// TestClaimsIssuedAtBeforeExpiresAt validates that issued_at is before expires_at
func TestClaimsIssuedAtBeforeExpiresAt(t *testing.T) {
	now := time.Now()
	expiresAt := now.Add(24 * time.Hour)

	claims := Claims{
		IssuedAt:  now,
		ExpiresAt: expiresAt,
	}

	require.True(t, claims.IssuedAt.Before(claims.ExpiresAt), "IssuedAt should be before ExpiresAt")
}

// TestTokenPairExpiresAtConsistency validates ExpiresIn and ExpiresAt consistency
func TestTokenPairExpiresAtConsistency(t *testing.T) {
	now := time.Now()
	tokenPair := TokenPair{
		ExpiresIn: 3600, // 1 hour
		ExpiresAt: now.Add(1 * time.Hour),
	}

	// The ExpiresAt should be approximately 1 hour from now
	diff := tokenPair.ExpiresAt.Sub(now)
	// Allow 1 second tolerance for test execution time
	assert.True(t, diff >= 3599*time.Second && diff <= 3601*time.Second,
		"ExpiresAt should be approximately ExpiresIn seconds from now")
}
