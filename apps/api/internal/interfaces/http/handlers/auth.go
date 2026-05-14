package handlers

import (
	"net/http"

	"github.com/Q9Labs/chalk/internal/domain/auth"
	infraAuth "github.com/Q9Labs/chalk/internal/infrastructure/auth"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	"github.com/Q9Labs/chalk/internal/interfaces/http/middleware"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

type AuthHandler struct {
	queries       *db.Queries
	jwtService    *infraAuth.JWTService
	apiKeyService *infraAuth.APIKeyService
	tenantLookup  *infraAuth.TenantLookup
}

func NewAuthHandler(queries *db.Queries, jwtService *infraAuth.JWTService, apiKeyService *infraAuth.APIKeyService) *AuthHandler {
	var tenantLookup *infraAuth.TenantLookup
	if queries != nil && apiKeyService != nil {
		tenantLookup = infraAuth.NewTenantLookup(queries, apiKeyService)
	}
	return &AuthHandler{
		queries:       queries,
		jwtService:    jwtService,
		apiKeyService: apiKeyService,
		tenantLookup:  tenantLookup,
	}
}

type TokenRequest struct {
	APIKey string `json:"api_key" binding:"required"`
}

type TokenResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	TokenType    string `json:"token_type"`
	ExpiresIn    int    `json:"expires_in"`
}

// POST /api/v1/auth/token - Exchange API key for JWT
func (h *AuthHandler) Token(c *gin.Context) {
	var req TokenRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if h.apiKeyService == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "auth misconfigured"})
		return
	}

	// Validate API key format (fast path; avoids DB work on obviously invalid keys).
	if err := h.apiKeyService.ValidateAPIKeyFormat(req.APIKey); err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid API key format"})
		return
	}

	if h.tenantLookup == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "auth misconfigured"})
		return
	}

	matchedTenant, err := h.tenantLookup.ResolveActiveTenant(c.Request.Context(), req.APIKey)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to validate API key"})
		return
	}
	if matchedTenant == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid API key"})
		return
	}

	// Generate token pair
	claims := buildTenantHostClaims(matchedTenant.ID.String(), matchedTenant.ID)

	tokenPair, err := h.jwtService.GenerateTokenPair(claims)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to generate token"})
		return
	}

	c.JSON(http.StatusOK, TokenResponse{
		AccessToken:  tokenPair.AccessToken,
		RefreshToken: tokenPair.RefreshToken,
		TokenType:    tokenPair.TokenType,
		ExpiresIn:    tokenPair.ExpiresIn,
	})
}

type RefreshRequest struct {
	RefreshToken string `json:"refresh_token" binding:"required"`
}

// POST /api/v1/auth/refresh - Refresh JWT
func (h *AuthHandler) Refresh(c *gin.Context) {
	var req RefreshRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Validate refresh token
	tenantID, subject, err := h.jwtService.ValidateRefreshToken(req.RefreshToken)
	if err != nil {
		status := http.StatusUnauthorized
		message := "invalid refresh token"
		if err == infraAuth.ErrExpiredToken {
			message = "refresh token has expired"
		}
		c.JSON(status, gin.H{"error": message})
		return
	}

	// Verify tenant still exists and is active
	tenant, err := h.queries.GetTenant(c.Request.Context(), tenantID)
	if err != nil || !tenant.IsActive {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "tenant not found or inactive"})
		return
	}

	// Generate new token pair
	claims := buildTenantHostClaims(subject, tenantID)

	tokenPair, err := h.jwtService.GenerateTokenPair(claims)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to generate token"})
		return
	}

	c.JSON(http.StatusOK, TokenResponse{
		AccessToken:  tokenPair.AccessToken,
		RefreshToken: tokenPair.RefreshToken,
		TokenType:    tokenPair.TokenType,
		ExpiresIn:    tokenPair.ExpiresIn,
	})
}

// GenerateParticipantToken creates a token for a room participant
func (h *AuthHandler) GenerateParticipantToken(tenantID, roomID, participantID uuid.UUID, displayName, role, cfAuthToken string) (*auth.TokenPair, error) {
	permissions := auth.DefaultParticipantPermissions()
	if role == "host" {
		permissions = auth.DefaultHostPermissions()
	}

	claims := auth.Claims{
		Subject:     participantID.String(),
		TenantID:    tenantID,
		RoomID:      roomID,
		DisplayName: displayName,
		Role:        role,
		Permissions: permissions,
		CFAuthToken: cfAuthToken,
	}

	return h.jwtService.GenerateTokenPair(claims)
}

func buildTenantHostClaims(subject string, tenantID uuid.UUID) auth.Claims {
	return auth.Claims{
		Subject:     subject,
		TenantID:    tenantID,
		Role:        "host",
		Permissions: auth.DefaultHostPermissions(),
	}
}

// GetCurrentTenant is a helper to get the tenant from middleware context
func GetCurrentTenant(c *gin.Context) (*db.Tenant, bool) {
	return middleware.GetTenant(c)
}

// GetCurrentClaims is a helper to get the claims from middleware context
func GetCurrentClaims(c *gin.Context) (*auth.Claims, bool) {
	return middleware.GetClaims(c)
}
