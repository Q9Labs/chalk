package middleware

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/Q9Labs/chalk/internal/domain/auth"
	infraAuth "github.com/Q9Labs/chalk/internal/infrastructure/auth"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func setupTestGin() *gin.Engine {
	gin.SetMode(gin.TestMode)
	return gin.New()
}

func TestAuthMiddleware_RequireJWT_ValidToken(t *testing.T) {
	config := infraAuth.DefaultJWTConfig()
	jwtService := infraAuth.NewJWTService(config)
	middleware := NewAuthMiddleware(jwtService)

	tenantID := uuid.New()
	claims := auth.Claims{
		Subject:     "user-123",
		TenantID:    tenantID,
		DisplayName: "Test User",
		Role:        "host",
	}

	token, err := jwtService.GenerateAccessToken(claims)
	require.NoError(t, err)

	router := setupTestGin()
	router.GET("/test", middleware.RequireJWT(), func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "success"})
	})

	req, err := http.NewRequest("GET", "/test", nil)
	require.NoError(t, err)
	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", token))

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestAuthMiddleware_RequireJWT_MissingHeader(t *testing.T) {
	config := infraAuth.DefaultJWTConfig()
	jwtService := infraAuth.NewJWTService(config)
	middleware := NewAuthMiddleware(jwtService)

	router := setupTestGin()
	router.GET("/test", middleware.RequireJWT(), func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "success"})
	})

	req, err := http.NewRequest("GET", "/test", nil)
	require.NoError(t, err)

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
	assert.Contains(t, w.Body.String(), "missing authorization header")
}

func TestAuthMiddleware_RequireJWT_InvalidBearerFormat(t *testing.T) {
	config := infraAuth.DefaultJWTConfig()
	jwtService := infraAuth.NewJWTService(config)
	middleware := NewAuthMiddleware(jwtService)

	router := setupTestGin()
	router.GET("/test", middleware.RequireJWT(), func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "success"})
	})

	testCases := []struct {
		authHeader      string
		expectedMessage string
	}{
		{"InvalidToken", "invalid authorization header format"},
		{"Bearer", "invalid authorization header format"},
		{"basic token", "invalid authorization header format"},
		{"api-key xyz123", "invalid authorization header format"},
		{"Bearer  token", "invalid token"}, // Has valid format but invalid token
	}

	for _, tc := range testCases {
		t.Run("invalid_format_"+tc.authHeader, func(t *testing.T) {
			req, err := http.NewRequest("GET", "/test", nil)
			require.NoError(t, err)
			req.Header.Set("Authorization", tc.authHeader)

			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)

			assert.Equal(t, http.StatusUnauthorized, w.Code)
			assert.Contains(t, w.Body.String(), tc.expectedMessage)
		})
	}
}

func TestAuthMiddleware_RequireJWT_InvalidToken(t *testing.T) {
	config := infraAuth.DefaultJWTConfig()
	jwtService := infraAuth.NewJWTService(config)
	middleware := NewAuthMiddleware(jwtService)

	router := setupTestGin()
	router.GET("/test", middleware.RequireJWT(), func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "success"})
	})

	req, err := http.NewRequest("GET", "/test", nil)
	require.NoError(t, err)
	req.Header.Set("Authorization", "Bearer invalid.token.here")

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
	assert.Contains(t, w.Body.String(), "invalid token")
}

func TestAuthMiddleware_RequireJWT_ExpiredToken(t *testing.T) {
	config := infraAuth.JWTConfig{
		SecretKey:          "chalk-dev-secret-change-in-production",
		AccessTokenExpiry:  -1 * time.Second,
		RefreshTokenExpiry: 7 * 24 * time.Hour,
		Issuer:             "chalk",
	}
	jwtService := infraAuth.NewJWTService(config)
	middleware := NewAuthMiddleware(jwtService)

	tenantID := uuid.New()
	claims := auth.Claims{
		Subject:  "user-123",
		TenantID: tenantID,
	}

	token, err := jwtService.GenerateAccessToken(claims)
	require.NoError(t, err)

	time.Sleep(10 * time.Millisecond)

	router := setupTestGin()
	router.GET("/test", middleware.RequireJWT(), func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "success"})
	})

	req, err := http.NewRequest("GET", "/test", nil)
	require.NoError(t, err)
	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", token))

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
	assert.Contains(t, w.Body.String(), "token has expired")
}

func TestAuthMiddleware_RequireJWT_StoresClaimsInContext(t *testing.T) {
	config := infraAuth.DefaultJWTConfig()
	jwtService := infraAuth.NewJWTService(config)
	middleware := NewAuthMiddleware(jwtService)

	tenantID := uuid.New()
	roomID := uuid.New()
	expectedClaims := auth.Claims{
		Subject:     "user-123",
		TenantID:    tenantID,
		RoomID:      roomID,
		DisplayName: "Test User",
		Role:        "host",
		Permissions: auth.DefaultHostPermissions(),
		CFAuthToken: "cf-token",
	}

	token, err := jwtService.GenerateAccessToken(expectedClaims)
	require.NoError(t, err)

	router := setupTestGin()
	router.GET("/test", middleware.RequireJWT(), func(c *gin.Context) {
		claims, exists := GetClaims(c)
		if !exists {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "claims not found"})
			return
		}

		c.JSON(http.StatusOK, gin.H{
			"subject":      claims.Subject,
			"tenant_id":    claims.TenantID.String(),
			"room_id":      claims.RoomID.String(),
			"display_name": claims.DisplayName,
			"role":         claims.Role,
		})
	})

	req, err := http.NewRequest("GET", "/test", nil)
	require.NoError(t, err)
	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", token))

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Contains(t, w.Body.String(), "user-123")
	assert.Contains(t, w.Body.String(), tenantID.String())
}

func TestAuthMiddleware_RequireJWT_CaseSensitiveBearerPrefix(t *testing.T) {
	config := infraAuth.DefaultJWTConfig()
	jwtService := infraAuth.NewJWTService(config)
	middleware := NewAuthMiddleware(jwtService)

	tenantID := uuid.New()
	claims := auth.Claims{
		Subject:  "user-123",
		TenantID: tenantID,
	}

	token, err := jwtService.GenerateAccessToken(claims)
	require.NoError(t, err)

	router := setupTestGin()
	router.GET("/test", middleware.RequireJWT(), func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "success"})
	})

	// Test with lowercase "bearer"
	req, err := http.NewRequest("GET", "/test", nil)
	require.NoError(t, err)
	req.Header.Set("Authorization", fmt.Sprintf("bearer %s", token))

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestAuthMiddleware_RequireJWT_MalformedTokenFormats(t *testing.T) {
	config := infraAuth.DefaultJWTConfig()
	jwtService := infraAuth.NewJWTService(config)
	middleware := NewAuthMiddleware(jwtService)

	router := setupTestGin()
	router.GET("/test", middleware.RequireJWT(), func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "success"})
	})

	testCases := []string{
		"Bearer abc",
		"Bearer abc.def",
		"Bearer abc.def.ghi.jkl",
		"Bearer ",
	}

	for _, authHeader := range testCases {
		t.Run("malformed_"+authHeader, func(t *testing.T) {
			req, err := http.NewRequest("GET", "/test", nil)
			require.NoError(t, err)
			req.Header.Set("Authorization", authHeader)

			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)

			assert.Equal(t, http.StatusUnauthorized, w.Code)
		})
	}
}

// APIKeyMiddleware tests are skipped here because they require a real database connection
// The middleware calls db.Queries.ListActiveTenants which requires a database.
// Integration tests should be created with a test database for APIKeyMiddleware testing.

func TestGetClaims_NotInContext(t *testing.T) {
	router := setupTestGin()
	router.GET("/test", func(c *gin.Context) {
		claims, exists := GetClaims(c)
		c.JSON(http.StatusOK, gin.H{
			"claims_exist": exists,
			"claims":       claims,
		})
	})

	req, err := http.NewRequest("GET", "/test", nil)
	require.NoError(t, err)

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Contains(t, w.Body.String(), "\"claims_exist\":false")
	assert.Contains(t, w.Body.String(), "\"claims\":null")
}

func TestGetTenant_NotInContext(t *testing.T) {
	router := setupTestGin()
	router.GET("/test", func(c *gin.Context) {
		tenant, exists := GetTenant(c)
		c.JSON(http.StatusOK, gin.H{
			"tenant_exist": exists,
			"tenant":       tenant,
		})
	})

	req, err := http.NewRequest("GET", "/test", nil)
	require.NoError(t, err)

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Contains(t, w.Body.String(), "\"tenant_exist\":false")
	assert.Contains(t, w.Body.String(), "\"tenant\":null")
}
