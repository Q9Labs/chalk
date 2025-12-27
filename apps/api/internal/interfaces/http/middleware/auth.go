package middleware

import (
	"net/http"
	"strings"

	"github.com/Q9Labs/chalk/internal/domain/auth"
	infraAuth "github.com/Q9Labs/chalk/internal/infrastructure/auth"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	"github.com/gin-gonic/gin"
)

const (
	// Context keys
	ClaimsKey   = "claims"
	TenantKey   = "tenant"
	APIKeyKey   = "api_key"
)

// AuthMiddleware handles JWT authentication
type AuthMiddleware struct {
	jwtService *infraAuth.JWTService
}

// NewAuthMiddleware creates a new auth middleware
func NewAuthMiddleware(jwtService *infraAuth.JWTService) *AuthMiddleware {
	return &AuthMiddleware{jwtService: jwtService}
}

// RequireJWT validates JWT tokens in the Authorization header
func (m *AuthMiddleware) RequireJWT() gin.HandlerFunc {
	return func(c *gin.Context) {
		authHeader := c.GetHeader("Authorization")
		if authHeader == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
				"error": "missing authorization header",
			})
			return
		}

		// Extract Bearer token
		parts := strings.SplitN(authHeader, " ", 2)
		if len(parts) != 2 || strings.ToLower(parts[0]) != "bearer" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
				"error": "invalid authorization header format",
			})
			return
		}

		tokenString := parts[1]
		claims, err := m.jwtService.ValidateToken(tokenString)
		if err != nil {
			status := http.StatusUnauthorized
			message := "invalid token"
			if err == infraAuth.ErrExpiredToken {
				message = "token has expired"
			}
			c.AbortWithStatusJSON(status, gin.H{"error": message})
			return
		}

		// Store claims in context
		c.Set(ClaimsKey, claims)
		c.Next()
	}
}

// RequirePermission checks if the user has a specific permission
func (m *AuthMiddleware) RequirePermission(check func(auth.Permissions) bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		claimsVal, exists := c.Get(ClaimsKey)
		if !exists {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
				"error": "no claims in context",
			})
			return
		}

		claims, ok := claimsVal.(*auth.Claims)
		if !ok {
			c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{
				"error": "invalid claims type",
			})
			return
		}

		if !check(claims.Permissions) {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{
				"error": "insufficient permissions",
			})
			return
		}

		c.Next()
	}
}

// RequireHost ensures the user has host role
func (m *AuthMiddleware) RequireHost() gin.HandlerFunc {
	return func(c *gin.Context) {
		claimsVal, exists := c.Get(ClaimsKey)
		if !exists {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
				"error": "no claims in context",
			})
			return
		}

		claims, ok := claimsVal.(*auth.Claims)
		if !ok || claims.Role != "host" {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{
				"error": "host role required",
			})
			return
		}

		c.Next()
	}
}

// APIKeyMiddleware handles API key authentication
type APIKeyMiddleware struct {
	apiKeyService *infraAuth.APIKeyService
	queries       *db.Queries
}

// NewAPIKeyMiddleware creates a new API key middleware
func NewAPIKeyMiddleware(apiKeyService *infraAuth.APIKeyService, queries *db.Queries) *APIKeyMiddleware {
	return &APIKeyMiddleware{
		apiKeyService: apiKeyService,
		queries:       queries,
	}
}

// RequireAPIKey validates API keys in the X-API-Key header
func (m *APIKeyMiddleware) RequireAPIKey() gin.HandlerFunc {
	return func(c *gin.Context) {
		apiKey := c.GetHeader("X-API-Key")
		if apiKey == "" {
			// Also check Authorization header for API key
			authHeader := c.GetHeader("Authorization")
			if strings.HasPrefix(authHeader, "Bearer ck_") {
				apiKey = strings.TrimPrefix(authHeader, "Bearer ")
			}
		}

		if apiKey == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
				"error": "missing API key",
			})
			return
		}

		// Validate format
		if err := m.apiKeyService.ValidateAPIKeyFormat(apiKey); err != nil {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
				"error": "invalid API key format",
			})
			return
		}

		// Find tenant by iterating through active tenants and checking hash
		// In production, you'd use a more efficient lookup
		tenants, err := m.queries.ListActiveTenants(c.Request.Context(), db.ListActiveTenantsParams{
			Limit:  1000,
			Offset: 0,
		})
		if err != nil {
			c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{
				"error": "failed to validate API key",
			})
			return
		}

		var matchedTenant *db.Tenant
		for _, tenant := range tenants {
			if m.apiKeyService.VerifyAPIKey(apiKey, tenant.ApiKeyHash) {
				matchedTenant = &tenant
				break
			}
		}

		if matchedTenant == nil {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
				"error": "invalid API key",
			})
			return
		}

		// Store tenant in context
		c.Set(TenantKey, matchedTenant)
		c.Set(APIKeyKey, apiKey)
		c.Next()
	}
}

// GetClaims retrieves claims from the context
func GetClaims(c *gin.Context) (*auth.Claims, bool) {
	val, exists := c.Get(ClaimsKey)
	if !exists {
		return nil, false
	}
	claims, ok := val.(*auth.Claims)
	return claims, ok
}

// GetTenant retrieves tenant from the context
func GetTenant(c *gin.Context) (*db.Tenant, bool) {
	val, exists := c.Get(TenantKey)
	if !exists {
		return nil, false
	}
	tenant, ok := val.(*db.Tenant)
	return tenant, ok
}
