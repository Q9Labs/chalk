package middleware

import (
	"log/slog"
	"runtime"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// Paths to skip logging (high-frequency, low-value)
var skipPaths = map[string]bool{
	"/health": true,
}

// RequestLogger logs each request with structured fields for Axiom
func RequestLogger() gin.HandlerFunc {
	return func(c *gin.Context) {
		path := c.Request.URL.Path

		// Skip noisy endpoints
		if skipPaths[path] {
			c.Next()
			return
		}

		start := time.Now()
		method := c.Request.Method

		c.Next()

		latency := time.Since(start)
		status := c.Writer.Status()

		attrs := []any{
			"request_id", GetRequestID(c),
			"method", method,
			"path", path,
			"status", status,
			"latency_ms", latency.Milliseconds(),
			"tenant_id", extractTenantID(c),
			"room_id", extractRoomID(c),
			"participant_id", extractParticipantID(c),
			"client_ip", c.ClientIP(),
		}

		// Add error context for non-2xx responses
		if status >= 400 {
			if errMsg := c.Errors.String(); errMsg != "" {
				attrs = append(attrs, "error", errMsg)
			}
			if status >= 500 {
				attrs = append(attrs, "stack", captureStack(3))
				slog.Error("http request", attrs...)
				return
			}
			slog.Warn("http request", attrs...)
			return
		}

		slog.Info("http request", attrs...)
	}
}

// captureStack returns a condensed stack trace starting from skip frames up
func captureStack(skip int) string {
	var pcs [16]uintptr
	n := runtime.Callers(skip, pcs[:])
	frames := runtime.CallersFrames(pcs[:n])

	var b strings.Builder
	for {
		frame, more := frames.Next()
		// Skip runtime and gin internals
		if strings.Contains(frame.File, "runtime/") ||
			strings.Contains(frame.File, "gin-gonic/gin") {
			if !more {
				break
			}
			continue
		}
		if b.Len() > 0 {
			b.WriteString(" <- ")
		}
		// Format: function:line
		fn := frame.Function
		if idx := strings.LastIndex(fn, "/"); idx >= 0 {
			fn = fn[idx+1:]
		}
		b.WriteString(fn)
		b.WriteString(":")
		b.WriteString(itoa(frame.Line))

		if !more || b.Len() > 500 {
			break
		}
	}
	return b.String()
}

// itoa converts int to string without fmt import
func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var b [20]byte
	pos := len(b)
	for i > 0 {
		pos--
		b[pos] = byte('0' + i%10)
		i /= 10
	}
	return string(b[pos:])
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
