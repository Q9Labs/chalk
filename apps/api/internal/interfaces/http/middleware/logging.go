package middleware

import (
	"log/slog"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// RequestLogger logs each request with structured fields for Axiom
func RequestLogger() gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		path := c.Request.URL.Path
		method := c.Request.Method

		c.Next()

		latency := time.Since(start)
		status := c.Writer.Status()

		slog.Info("http request",
			"request_id", GetRequestID(c),
			"method", method,
			"path", path,
			"status", status,
			"latency_ms", latency.Milliseconds(),
			"tenant_id", extractTenantID(c),
			"room_id", extractRoomID(c),
			"participant_id", extractParticipantID(c),
			"client_ip", c.ClientIP(),
		)
	}
}

// extractTenantID gets tenant ID from JWT claims or API key tenant
func extractTenantID(c *gin.Context) string {
	if claims, ok := GetClaims(c); ok && claims != nil {
		if claims.TenantID != uuid.Nil {
			return claims.TenantID.String()
		}
	}
	if tenant, ok := GetTenant(c); ok && tenant != nil {
		return tenant.ID.String()
	}
	return ""
}

// extractRoomID gets room ID from JWT claims
func extractRoomID(c *gin.Context) string {
	if claims, ok := GetClaims(c); ok && claims != nil {
		if claims.RoomID != uuid.Nil {
			return claims.RoomID.String()
		}
	}
	return ""
}

// extractParticipantID gets participant ID from JWT claims (stored in Subject)
func extractParticipantID(c *gin.Context) string {
	if claims, ok := GetClaims(c); ok && claims != nil {
		return claims.Subject
	}
	return ""
}
