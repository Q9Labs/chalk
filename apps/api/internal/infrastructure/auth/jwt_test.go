package auth

import (
	"testing"
	"time"

	"github.com/Q9Labs/chalk/internal/domain/auth"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestJWTService_GenerateAccessToken(t *testing.T) {
	config := DefaultJWTConfig()
	svc := NewJWTService(config)

	tenantID := uuid.New()
	claims := auth.Claims{
		Subject:     "user-123",
		TenantID:    tenantID,
		RoomID:      uuid.New(),
		DisplayName: "John Doe",
		Role:        "host",
		Permissions: auth.DefaultHostPermissions(),
	}

	token, err := svc.GenerateAccessToken(claims)

	require.NoError(t, err)
	assert.NotEmpty(t, token)
	assert.Contains(t, token, ".")
}

func TestJWTService_GenerateAccessToken_ValidToken(t *testing.T) {
	// Test that generated token can be validated and claims extracted
	config := DefaultJWTConfig()
	svc := NewJWTService(config)

	tenantID := uuid.New()
	roomID := uuid.New()
	claims := auth.Claims{
		Subject:     "user-123",
		TenantID:    tenantID,
		RoomID:      roomID,
		DisplayName: "John Doe",
		Role:        "host",
		Permissions: auth.DefaultHostPermissions(),
	}

	token, err := svc.GenerateAccessToken(claims)
	require.NoError(t, err)

	validatedClaims, err := svc.ValidateToken(token)
	require.NoError(t, err)

	assert.Equal(t, claims.Subject, validatedClaims.Subject)
	assert.Equal(t, tenantID, validatedClaims.TenantID)
	assert.Equal(t, roomID, validatedClaims.RoomID)
	assert.Equal(t, "John Doe", validatedClaims.DisplayName)
	assert.Equal(t, "host", validatedClaims.Role)
	assert.Equal(t, claims.Permissions, validatedClaims.Permissions)
	// Note: CFAuthToken is NOT embedded in JWT - returned separately in API response
}

func TestJWTService_GenerateRefreshToken(t *testing.T) {
	config := DefaultJWTConfig()
	svc := NewJWTService(config)

	tenantID := uuid.New()
	token, err := svc.GenerateRefreshToken(tenantID, "user-123")

	require.NoError(t, err)
	assert.NotEmpty(t, token)
	assert.Contains(t, token, ".")
}

func TestJWTService_GenerateRefreshToken_HasCorrectType(t *testing.T) {
	config := DefaultJWTConfig()
	svc := NewJWTService(config)

	tenantID := uuid.New()
	token, err := svc.GenerateRefreshToken(tenantID, "user-123")
	require.NoError(t, err)

	// Parse token manually to check type
	validatedTenant, validatedSubject, err := svc.ValidateRefreshToken(token)
	require.NoError(t, err)
	assert.Equal(t, tenantID, validatedTenant)
	assert.Equal(t, "user-123", validatedSubject)
}

func TestJWTService_GenerateTokenPair(t *testing.T) {
	config := DefaultJWTConfig()
	svc := NewJWTService(config)

	tenantID := uuid.New()
	claims := auth.Claims{
		Subject:     "user-123",
		TenantID:    tenantID,
		DisplayName: "John Doe",
		Role:        "participant",
		Permissions: auth.DefaultParticipantPermissions(),
	}

	pair, err := svc.GenerateTokenPair(claims)

	require.NoError(t, err)
	assert.NotEmpty(t, pair.AccessToken)
	assert.NotEmpty(t, pair.RefreshToken)
	assert.Equal(t, "Bearer", pair.TokenType)
	assert.Equal(t, int(config.AccessTokenExpiry.Seconds()), pair.ExpiresIn)
	assert.NotZero(t, pair.ExpiresAt)
}

func TestJWTService_GenerateTokenPair_TokensAreDistinct(t *testing.T) {
	config := DefaultJWTConfig()
	svc := NewJWTService(config)

	tenantID := uuid.New()
	claims := auth.Claims{
		Subject:  "user-123",
		TenantID: tenantID,
	}

	pair, err := svc.GenerateTokenPair(claims)
	require.NoError(t, err)

	assert.NotEqual(t, pair.AccessToken, pair.RefreshToken)
}

func TestJWTService_ValidateToken_ValidToken(t *testing.T) {
	config := DefaultJWTConfig()
	svc := NewJWTService(config)

	tenantID := uuid.New()
	claims := auth.Claims{
		Subject:     "user-123",
		TenantID:    tenantID,
		DisplayName: "Test User",
		Role:        "host",
		Permissions: auth.DefaultHostPermissions(),
	}

	token, err := svc.GenerateAccessToken(claims)
	require.NoError(t, err)

	validatedClaims, err := svc.ValidateToken(token)

	require.NoError(t, err)
	assert.NotNil(t, validatedClaims)
}

func TestJWTService_ValidateToken_InvalidSignature(t *testing.T) {
	config := DefaultJWTConfig()
	svc := NewJWTService(config)

	// Create a token with the correct structure but sign with different secret
	wrongConfig := JWTConfig{
		SecretKey:          "different-secret-key",
		AccessTokenExpiry:  15 * time.Minute,
		RefreshTokenExpiry: 7 * 24 * time.Hour,
		Issuer:             "chalk",
	}
	wrongSvc := NewJWTService(wrongConfig)

	tenantID := uuid.New()
	claims := auth.Claims{
		Subject:  "user-123",
		TenantID: tenantID,
	}

	token, err := wrongSvc.GenerateAccessToken(claims)
	require.NoError(t, err)

	// Try to validate with wrong service
	_, err = svc.ValidateToken(token)

	assert.Error(t, err)
	assert.Equal(t, ErrInvalidToken, err)
}

func TestJWTService_ValidateToken_ExpiredToken(t *testing.T) {
	// Create service with very short expiry
	expiredConfig := JWTConfig{
		SecretKey:          "chalk-dev-secret-change-in-production",
		AccessTokenExpiry:  -1 * time.Second, // Already expired
		RefreshTokenExpiry: 7 * 24 * time.Hour,
		Issuer:             "chalk",
	}
	svc := NewJWTService(expiredConfig)

	tenantID := uuid.New()
	claims := auth.Claims{
		Subject:  "user-123",
		TenantID: tenantID,
	}

	token, err := svc.GenerateAccessToken(claims)
	require.NoError(t, err)

	// Wait a bit to ensure token is expired
	time.Sleep(10 * time.Millisecond)

	_, err = svc.ValidateToken(token)

	assert.Error(t, err)
	assert.Equal(t, ErrExpiredToken, err)
}

func TestJWTService_ValidateToken_MalformedToken(t *testing.T) {
	config := DefaultJWTConfig()
	svc := NewJWTService(config)

	testCases := []string{
		"not.a.token",
		"malformed",
		"",
		"a.b.c.d",
	}

	for _, tokenStr := range testCases {
		t.Run("malformed_"+tokenStr, func(t *testing.T) {
			_, err := svc.ValidateToken(tokenStr)
			assert.Error(t, err)
		})
	}
}

func TestJWTService_ValidateToken_ExtractsAllClaims(t *testing.T) {
	config := DefaultJWTConfig()
	svc := NewJWTService(config)

	tenantID := uuid.New()
	roomID := uuid.New()
	permissions := auth.Permissions{
		CanRecord:      true,
		CanScreenShare: false,
		CanKick:        true,
		CanMute:        false,
	}

	originalClaims := auth.Claims{
		Subject:     "participant-456",
		TenantID:    tenantID,
		RoomID:      roomID,
		DisplayName: "Jane Doe",
		Role:        "participant",
		Permissions: permissions,
	}

	token, err := svc.GenerateAccessToken(originalClaims)
	require.NoError(t, err)

	validatedClaims, err := svc.ValidateToken(token)
	require.NoError(t, err)

	assert.Equal(t, originalClaims.Subject, validatedClaims.Subject)
	assert.Equal(t, originalClaims.TenantID, validatedClaims.TenantID)
	assert.Equal(t, originalClaims.RoomID, validatedClaims.RoomID)
	assert.Equal(t, originalClaims.DisplayName, validatedClaims.DisplayName)
	assert.Equal(t, originalClaims.Role, validatedClaims.Role)
	assert.Equal(t, originalClaims.Permissions, validatedClaims.Permissions)
	// CFAuthToken not in JWT - returned separately
}

func TestJWTService_ValidateRefreshToken_ValidToken(t *testing.T) {
	config := DefaultJWTConfig()
	svc := NewJWTService(config)

	tenantID := uuid.New()
	subject := "user-123"

	token, err := svc.GenerateRefreshToken(tenantID, subject)
	require.NoError(t, err)

	validatedTenantID, validatedSubject, err := svc.ValidateRefreshToken(token)

	require.NoError(t, err)
	assert.Equal(t, tenantID, validatedTenantID)
	assert.Equal(t, subject, validatedSubject)
}

func TestJWTService_ValidateRefreshToken_RejectsAccessToken(t *testing.T) {
	config := DefaultJWTConfig()
	svc := NewJWTService(config)

	tenantID := uuid.New()
	claims := auth.Claims{
		Subject:  "user-123",
		TenantID: tenantID,
	}

	// Generate an access token (not a refresh token)
	accessToken, err := svc.GenerateAccessToken(claims)
	require.NoError(t, err)

	// Try to validate as refresh token
	_, _, err = svc.ValidateRefreshToken(accessToken)

	assert.Error(t, err)
	assert.Equal(t, ErrInvalidClaim, err)
}

func TestJWTService_ValidateRefreshToken_ExpiredToken(t *testing.T) {
	expiredConfig := JWTConfig{
		SecretKey:          "chalk-dev-secret-change-in-production",
		AccessTokenExpiry:  15 * time.Minute,
		RefreshTokenExpiry: -1 * time.Second, // Already expired
		Issuer:             "chalk",
	}
	svc := NewJWTService(expiredConfig)

	tenantID := uuid.New()
	token, err := svc.GenerateRefreshToken(tenantID, "user-123")
	require.NoError(t, err)

	time.Sleep(10 * time.Millisecond)

	_, _, err = svc.ValidateRefreshToken(token)

	assert.Error(t, err)
	assert.Equal(t, ErrExpiredToken, err)
}

func TestJWTService_ValidateRefreshToken_InvalidSignature(t *testing.T) {
	config := DefaultJWTConfig()
	svc := NewJWTService(config)

	wrongConfig := JWTConfig{
		SecretKey:          "wrong-secret",
		AccessTokenExpiry:  15 * time.Minute,
		RefreshTokenExpiry: 7 * 24 * time.Hour,
		Issuer:             "chalk",
	}
	wrongSvc := NewJWTService(wrongConfig)

	tenantID := uuid.New()
	token, err := wrongSvc.GenerateRefreshToken(tenantID, "user-123")
	require.NoError(t, err)

	_, _, err = svc.ValidateRefreshToken(token)

	assert.Error(t, err)
	assert.Equal(t, ErrInvalidToken, err)
}

func TestJWTService_ValidateRefreshToken_MalformedToken(t *testing.T) {
	config := DefaultJWTConfig()
	svc := NewJWTService(config)

	testCases := []string{
		"not.a.token",
		"malformed",
		"",
		"a.b.c.d",
	}

	for _, tokenStr := range testCases {
		t.Run("malformed_"+tokenStr, func(t *testing.T) {
			_, _, err := svc.ValidateRefreshToken(tokenStr)
			assert.Error(t, err)
		})
	}
}

func TestJWTService_TokenTypesDistinct(t *testing.T) {
	// Ensure refresh tokens are validated with correct token type
	// and access tokens cannot be used as refresh tokens
	config := DefaultJWTConfig()
	svc := NewJWTService(config)

	tenantID := uuid.New()
	claims := auth.Claims{
		Subject:  "user-123",
		TenantID: tenantID,
	}

	accessToken, err := svc.GenerateAccessToken(claims)
	require.NoError(t, err)

	refreshToken, err := svc.GenerateRefreshToken(tenantID, "user-123")
	require.NoError(t, err)

	// Access token should validate successfully
	accessClaims, err := svc.ValidateToken(accessToken)
	require.NoError(t, err)
	assert.NotNil(t, accessClaims)

	// Refresh token will validate as access token (ValidateToken doesn't check type)
	// This is by design - type is only checked in ValidateRefreshToken
	refreshAsAccess, err := svc.ValidateToken(refreshToken)
	require.NoError(t, err)
	assert.NotNil(t, refreshAsAccess)

	// Refresh token should validate successfully with ValidateRefreshToken
	refreshTenant, refreshSubject, err := svc.ValidateRefreshToken(refreshToken)
	require.NoError(t, err)
	assert.Equal(t, tenantID, refreshTenant)
	assert.Equal(t, "user-123", refreshSubject)

	// Access token should NOT validate as refresh token (type mismatch)
	_, _, err = svc.ValidateRefreshToken(accessToken)
	assert.Error(t, err)
	assert.Equal(t, ErrInvalidClaim, err)
}

func TestJWTService_IssuedAtAndExpiresAtAreSet(t *testing.T) {
	config := DefaultJWTConfig()
	svc := NewJWTService(config)

	beforeGeneration := time.Now()

	tenantID := uuid.New()
	claims := auth.Claims{
		Subject:  "user-123",
		TenantID: tenantID,
	}

	token, err := svc.GenerateAccessToken(claims)
	require.NoError(t, err)

	afterGeneration := time.Now()

	validatedClaims, err := svc.ValidateToken(token)
	require.NoError(t, err)

	// IssuedAt should be between beforeGeneration and afterGeneration
	assert.True(t, validatedClaims.IssuedAt.After(beforeGeneration.Add(-time.Second)))
	assert.True(t, validatedClaims.IssuedAt.Before(afterGeneration.Add(time.Second)))

	// ExpiresAt should be approximately AccessTokenExpiry in the future
	expectedExpiry := beforeGeneration.Add(config.AccessTokenExpiry)
	assert.True(t, validatedClaims.ExpiresAt.After(expectedExpiry.Add(-2*time.Second)))
	assert.True(t, validatedClaims.ExpiresAt.Before(afterGeneration.Add(config.AccessTokenExpiry + 2*time.Second)))
}

func TestJWTService_EmptyClaimsHandling(t *testing.T) {
	config := DefaultJWTConfig()
	svc := NewJWTService(config)

	claims := auth.Claims{} // Empty claims except Subject

	token, err := svc.GenerateAccessToken(claims)

	require.NoError(t, err)
	assert.NotEmpty(t, token)

	validatedClaims, err := svc.ValidateToken(token)
	require.NoError(t, err)
	assert.Equal(t, "", validatedClaims.Subject)
	assert.Equal(t, uuid.Nil, validatedClaims.TenantID)
}

func TestJWTService_DifferentSecrets_DontValidate(t *testing.T) {
	// Service with default secret
	config1 := DefaultJWTConfig()
	svc1 := NewJWTService(config1)

	// Service with different secret
	config2 := JWTConfig{
		SecretKey:          "different-secret-key-12345",
		AccessTokenExpiry:  15 * time.Minute,
		RefreshTokenExpiry: 7 * 24 * time.Hour,
		Issuer:             "chalk",
	}
	svc2 := NewJWTService(config2)

	tenantID := uuid.New()
	claims := auth.Claims{
		Subject:  "user-123",
		TenantID: tenantID,
	}

	token, err := svc1.GenerateAccessToken(claims)
	require.NoError(t, err)

	// Token from svc1 should not validate with svc2
	_, err = svc2.ValidateToken(token)
	assert.Error(t, err)
	assert.Equal(t, ErrInvalidToken, err)
}
