package middleware

import (
	"log/slog"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"go.opentelemetry.io/otel/trace"
)

// Paths to skip logging (high-frequency, low-value)
var skipPaths = map[string]bool{
	"/health":            true,
	"/api/v1/debug/ping": true,
	"/ws":                true,
}

// RequestLogger logs each request with structured fields for Axiom
func RequestLogger() gin.HandlerFunc {
	return func(c *gin.Context) {
		path := c.Request.URL.Path
		route := c.FullPath()
		if route == "" {
			route = path
		}

		// Skip noisy endpoints
		if skipPaths[path] {
			c.Next()
			return
		}

		start := time.Now()
		method := c.Request.Method

		c.Next()

		latency := time.Since(start)
		statusCode := c.Writer.Status()
		statusClass := statusCode / 100

		sc := trace.SpanContextFromContext(c.Request.Context())
		traceID := ""
		spanID := ""
		if sc.IsValid() {
			traceID = sc.TraceID().String()
			spanID = sc.SpanID().String()
		}

		attrs := []any{
			"event", "http.request",
			"request_id", GetRequestID(c),
			"trace_id", traceID,
			"span_id", spanID,
			"http_method", method,
			"route", route,
			"path", path,
			"status_code", statusCode,
			"status_class", statusClass,
			"duration_ms", latency.Milliseconds(),
			"latency_ms", latency.Milliseconds(),
			"tenant_id", extractTenantID(c),
			"room_id", extractRoomID(c),
			"participant_id", extractParticipantID(c),
			"client_ip", c.ClientIP(),
			"user_agent", c.GetHeader("User-Agent"),
		}

		// Add error context for non-2xx responses
		if statusCode >= 400 {
			attrs = attachGinErrors(attrs, c)
			if errMsg := c.Errors.String(); errMsg != "" {
				attrs = append(attrs, "gin_error_chain", errMsg)
			}
			if statusCode >= 500 {
				attrs = append(attrs, "stack", captureStack(3))
				slog.Error("http.request", attrs...)
				return
			}
			slog.Warn("http.request", attrs...)
			return
		}

		slog.Info("http.request", attrs...)
	}
}

func attachGinErrors(attrs []any, c *gin.Context) []any {
	if len(c.Errors) == 0 {
		return attrs
	}

	for i, e := range c.Errors {
		if e.Err != nil {
			attrs = append(attrs, "error_"+strconv.Itoa(i), e.Err.Error())
		}
		if e.Meta != nil {
			if m, ok := e.Meta.(map[string]any); ok {
				for k, v := range m {
					attrs = append(attrs, k, v)
				}
			} else {
				attrs = append(attrs, "error_meta_"+strconv.Itoa(i), e.Meta)
			}
		}
	}
	return attrs
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
