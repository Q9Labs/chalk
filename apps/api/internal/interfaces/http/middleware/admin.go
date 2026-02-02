package middleware

import (
	"crypto/subtle"
	"net/http"

	"github.com/Q9Labs/chalk/internal/config"
	"github.com/gin-gonic/gin"
)

type AdminMiddleware struct {
	config *config.AdminConfig
}

func NewAdminMiddleware(cfg *config.AdminConfig) *AdminMiddleware {
	return &AdminMiddleware{config: cfg}
}

func (m *AdminMiddleware) RequireAdmin() gin.HandlerFunc {
	return func(c *gin.Context) {
		if !m.config.Enabled {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "admin API is disabled"})
			return
		}

		// IP restriction
		if len(m.config.AllowedIPs) > 0 {
			clientIP := c.ClientIP()
			allowed := false
			for _, ip := range m.config.AllowedIPs {
				if clientIP == ip {
					allowed = true
					break
				}
			}
			if !allowed {
				c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "IP not allowed"})
				return
			}
		}

		// Secret check (constant-time)
		secret := c.GetHeader("X-Admin-Secret")
		if secret == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "missing admin secret"})
			return
		}
		if subtle.ConstantTimeCompare([]byte(secret), []byte(m.config.Secret)) != 1 {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid admin secret"})
			return
		}

		c.Next()
	}
}
