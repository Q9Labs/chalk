package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Q9Labs/chalk/internal/domain/auth"
	infraAuth "github.com/Q9Labs/chalk/internal/infrastructure/auth"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestAuthHandler_Token_MissingAPIKey(t *testing.T) {
	router := setupTestRouter()
	handler := NewAuthHandler(nil, nil, nil)
	router.POST("/auth/token", handler.Token)

	body := bytes.NewBufferString(`{}`)
	req := httptest.NewRequest("POST", "/auth/token", body)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	var response map[string]interface{}
	err := json.Unmarshal(w.Body.Bytes(), &response)
	require.NoError(t, err)
	assert.NotNil(t, response["error"])
}

func TestAuthHandler_Token_InvalidJSON(t *testing.T) {
	router := setupTestRouter()
	handler := NewAuthHandler(nil, nil, nil)
	router.POST("/auth/token", handler.Token)

	body := bytes.NewBufferString(`{invalid}`)
	req := httptest.NewRequest("POST", "/auth/token", body)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestAuthHandler_Token_InvalidAPIKeyFormat(t *testing.T) {
	router := setupTestRouter()
	apiKeyService := infraAuth.NewAPIKeyService()
	handler := NewAuthHandler(nil, nil, apiKeyService)
	router.POST("/auth/token", handler.Token)

	body := bytes.NewBufferString(`{"api_key": "invalid-format"}`)
	req := httptest.NewRequest("POST", "/auth/token", body)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
	var response map[string]interface{}
	err := json.Unmarshal(w.Body.Bytes(), &response)
	require.NoError(t, err)
	assert.Equal(t, "invalid API key format", response["error"])
}

func TestAuthHandler_Refresh_MissingRefreshToken(t *testing.T) {
	router := setupTestRouter()
	handler := NewAuthHandler(nil, nil, nil)
	router.POST("/auth/refresh", handler.Refresh)

	body := bytes.NewBufferString(`{}`)
	req := httptest.NewRequest("POST", "/auth/refresh", body)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	var response map[string]interface{}
	err := json.Unmarshal(w.Body.Bytes(), &response)
	require.NoError(t, err)
	assert.NotNil(t, response["error"])
}

func TestAuthHandler_Refresh_InvalidJSON(t *testing.T) {
	router := setupTestRouter()
	handler := NewAuthHandler(nil, nil, nil)
	router.POST("/auth/refresh", handler.Refresh)

	body := bytes.NewBufferString(`{invalid}`)
	req := httptest.NewRequest("POST", "/auth/refresh", body)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestAuthHandler_Refresh_InvalidRefreshToken(t *testing.T) {
	config := infraAuth.DefaultJWTConfig()
	jwtService := infraAuth.NewJWTService(config)
	router := setupTestRouter()
	handler := NewAuthHandler(nil, jwtService, nil)
	router.POST("/auth/refresh", handler.Refresh)

	body := bytes.NewBufferString(`{"refresh_token": "invalid.token.here"}`)
	req := httptest.NewRequest("POST", "/auth/refresh", body)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
	var response map[string]interface{}
	err := json.Unmarshal(w.Body.Bytes(), &response)
	require.NoError(t, err)
	assert.Equal(t, "invalid refresh token", response["error"])
}

func TestAuthHandler_GenerateParticipantToken_Host(t *testing.T) {
	config := infraAuth.DefaultJWTConfig()
	jwtService := infraAuth.NewJWTService(config)
	handler := NewAuthHandler(nil, jwtService, nil)

	tenantID := uuid.New()
	roomID := uuid.New()
	participantID := uuid.New()

	tokenPair, err := handler.GenerateParticipantToken(tenantID, roomID, participantID, "Test User", "host", "cf-token")
	require.NoError(t, err)
	require.NotNil(t, tokenPair)
	assert.NotEmpty(t, tokenPair.AccessToken)
	assert.NotEmpty(t, tokenPair.RefreshToken)
	assert.Equal(t, "Bearer", tokenPair.TokenType)
	assert.Greater(t, tokenPair.ExpiresIn, 0)

	// Validate the access token
	claims, err := jwtService.ValidateToken(tokenPair.AccessToken)
	require.NoError(t, err)
	assert.Equal(t, participantID.String(), claims.Subject)
	assert.Equal(t, tenantID, claims.TenantID)
	assert.Equal(t, roomID, claims.RoomID)
	assert.Equal(t, "Test User", claims.DisplayName)
	assert.Equal(t, "host", claims.Role)
	// CFAuthToken not in JWT - returned separately in API response
	// Host should have all permissions
	assert.True(t, claims.Permissions.CanMute)
	assert.True(t, claims.Permissions.CanKick)
	assert.True(t, claims.Permissions.CanRecord)
}

func TestAuthHandler_GenerateParticipantToken_Participant(t *testing.T) {
	config := infraAuth.DefaultJWTConfig()
	jwtService := infraAuth.NewJWTService(config)
	handler := NewAuthHandler(nil, jwtService, nil)

	tenantID := uuid.New()
	roomID := uuid.New()
	participantID := uuid.New()

	tokenPair, err := handler.GenerateParticipantToken(tenantID, roomID, participantID, "Test Participant", "participant", "cf-token-2")
	require.NoError(t, err)
	require.NotNil(t, tokenPair)

	claims, err := jwtService.ValidateToken(tokenPair.AccessToken)
	require.NoError(t, err)
	assert.Equal(t, "participant", claims.Role)
	// Participant should have limited permissions
	assert.False(t, claims.Permissions.CanMute)
	assert.False(t, claims.Permissions.CanKick)
	assert.False(t, claims.Permissions.CanRecord)
}

func TestTokenRequest_Binding(t *testing.T) {
	testCases := []struct {
		name    string
		json    string
		wantErr bool
	}{
		{"valid", `{"api_key": "ck_live_123"}`, false},
		{"missing api_key", `{}`, true},
		{"empty api_key", `{"api_key": ""}`, true},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			gin.SetMode(gin.TestMode)
			w := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(w)
			c.Request = httptest.NewRequest("POST", "/", bytes.NewBufferString(tc.json))
			c.Request.Header.Set("Content-Type", "application/json")

			var req TokenRequest
			err := c.ShouldBindJSON(&req)
			if tc.wantErr {
				assert.Error(t, err)
			} else {
				assert.NoError(t, err)
				assert.Equal(t, "ck_live_123", req.APIKey)
			}
		})
	}
}

func TestRefreshRequest_Binding(t *testing.T) {
	testCases := []struct {
		name    string
		json    string
		wantErr bool
	}{
		{"valid", `{"refresh_token": "token123"}`, false},
		{"missing refresh_token", `{}`, true},
		{"empty refresh_token", `{"refresh_token": ""}`, true},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			gin.SetMode(gin.TestMode)
			w := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(w)
			c.Request = httptest.NewRequest("POST", "/", bytes.NewBufferString(tc.json))
			c.Request.Header.Set("Content-Type", "application/json")

			var req RefreshRequest
			err := c.ShouldBindJSON(&req)
			if tc.wantErr {
				assert.Error(t, err)
			} else {
				assert.NoError(t, err)
				assert.Equal(t, "token123", req.RefreshToken)
			}
		})
	}
}

func TestTokenResponse_JSONMarshaling(t *testing.T) {
	resp := TokenResponse{
		AccessToken:  "access123",
		RefreshToken: "refresh456",
		TokenType:    "Bearer",
		ExpiresIn:    3600,
	}

	data, err := json.Marshal(resp)
	require.NoError(t, err)

	var parsed TokenResponse
	err = json.Unmarshal(data, &parsed)
	require.NoError(t, err)
	assert.Equal(t, resp, parsed)
}

func TestGetCurrentTenant_NotInContext(t *testing.T) {
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)

	tenant, exists := GetCurrentTenant(c)
	assert.False(t, exists)
	assert.Nil(t, tenant)
}

func TestGetCurrentClaims_NotInContext(t *testing.T) {
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)

	claims, exists := GetCurrentClaims(c)
	assert.False(t, exists)
	assert.Nil(t, claims)
}

func TestGetCurrentClaims_InContext(t *testing.T) {
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)

	expectedClaims := &auth.Claims{
		Subject:     "user-123",
		TenantID:    uuid.New(),
		DisplayName: "Test User",
	}
	c.Set("claims", expectedClaims)

	claims, exists := GetCurrentClaims(c)
	assert.True(t, exists)
	assert.Equal(t, expectedClaims, claims)
}
