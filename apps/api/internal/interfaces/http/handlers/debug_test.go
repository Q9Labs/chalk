package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/Q9Labs/chalk/internal/domain/auth"
	infraAuth "github.com/Q9Labs/chalk/internal/infrastructure/auth"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	"github.com/Q9Labs/chalk/internal/interfaces/http/middleware"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func TestDebugPing_HEAD_204(t *testing.T) {
	gin.SetMode(gin.TestMode)

	r := gin.New()
	h := NewDebugHandler()
	r.HEAD("/api/v1/debug/ping", h.Ping)

	req := httptest.NewRequest(http.MethodHead, "/api/v1/debug/ping", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
	require.Empty(t, rec.Body.String())
}

func TestDebugAuth_Unauthorized_NoHeader_401(t *testing.T) {
	gin.SetMode(gin.TestMode)

	jwtSvc := infraAuth.NewJWTService(infraAuth.DefaultJWTConfig())
	authMw := middleware.NewAuthMiddleware(jwtSvc)

	r := gin.New()
	r.Use(middleware.RequestID())

	h := NewDebugHandler()
	g := r.Group("/api/v1/debug")
	g.Use(authMw.RequireJWT())
	g.GET("/auth", h.Auth)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/debug/auth", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	require.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestDebugAuth_OK_ValidToken_200(t *testing.T) {
	gin.SetMode(gin.TestMode)

	cfg := infraAuth.DefaultJWTConfig()
	jwtSvc := infraAuth.NewJWTService(cfg)
	authMw := middleware.NewAuthMiddleware(jwtSvc)

	tenantID := uuid.New()
	claims := auth.Claims{
		Subject:     "user-123",
		TenantID:    tenantID,
		DisplayName: "Hasan",
		Role:        "host",
		Permissions: auth.DefaultHostPermissions(),
	}

	token, err := jwtSvc.GenerateAccessToken(claims)
	require.NoError(t, err)

	r := gin.New()
	r.Use(middleware.RequestID())

	h := NewDebugHandler()
	g := r.Group("/api/v1/debug")
	g.Use(authMw.RequireJWT())
	g.GET("/auth", h.Auth)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/debug/auth", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-Request-ID", "req-123")

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)

	var resp DebugAuthResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))

	require.Equal(t, "user-123", resp.UserID)
	require.NotNil(t, resp.TenantID)
	require.Equal(t, tenantID.String(), *resp.TenantID)
	require.NotNil(t, resp.DisplayName)
	require.Equal(t, "Hasan", *resp.DisplayName)
	require.NotNil(t, resp.Role)
	require.Equal(t, "host", *resp.Role)
	require.Equal(t, "req-123", resp.RequestID)

	_, err = time.Parse(time.RFC3339, resp.ServerTime)
	require.NoError(t, err)
	_, err = time.Parse(time.RFC3339, resp.TokenIssuedAt)
	require.NoError(t, err)
	_, err = time.Parse(time.RFC3339, resp.TokenExpiresAt)
	require.NoError(t, err)

	require.GreaterOrEqual(t, resp.TokenExpiresInSeconds, 0)
	require.LessOrEqual(t, resp.TokenExpiresInSeconds, int(cfg.AccessTokenExpiry.Seconds()))

	require.NotEmpty(t, resp.APIVersion)
	require.NotEmpty(t, resp.APICommitSHA)
	require.NotEmpty(t, resp.APIBuildTime)

	require.Len(t, resp.Scopes, 4)
}

func TestDebugClientIncident_BadPayload_400(t *testing.T) {
	gin.SetMode(gin.TestMode)

	r := gin.New()
	r.Use(middleware.RequestID())

	h := NewDebugHandler()
	r.POST("/api/v1/debug/client-incident", h.ClientIncident)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/debug/client-incident", bytes.NewBufferString(`{"source":"th-lms"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	require.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestDebugClientIncident_OK_202(t *testing.T) {
	gin.SetMode(gin.TestMode)

	tenantID := uuid.New()
	r := gin.New()
	r.Use(middleware.RequestID())
	r.Use(func(c *gin.Context) {
		c.Set(middleware.TenantKey, &db.Tenant{ID: tenantID})
		c.Next()
	})

	h := NewDebugHandler()
	r.POST("/api/v1/debug/client-incident", h.ClientIncident)

	body := `{
		"incident_id":"inc_123",
		"source":"th-lms",
		"stage":"chalk_join",
		"message":"Failed to fetch",
		"request_url":"https://chalk-api.q9labs.ai/api/v1/rooms/abc/participants",
		"request_method":"post",
		"room_id":"abc"
	}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/debug/client-incident", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Request-ID", "req-debug-1")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	require.Equal(t, http.StatusAccepted, rec.Code)

	var resp ClientIncidentResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))
	require.True(t, resp.Accepted)
	require.Equal(t, "inc_123", resp.IncidentID)
	require.Equal(t, "req-debug-1", resp.RequestID)
}
