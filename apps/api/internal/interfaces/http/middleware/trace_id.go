package middleware

import (
	"github.com/gin-gonic/gin"
	"go.opentelemetry.io/otel/trace"
)

// TraceIDHeader sets X-Chalk-Trace-Id when a valid OTEL span is present.
func TraceIDHeader() gin.HandlerFunc {
	return func(c *gin.Context) {
		sc := trace.SpanContextFromContext(c.Request.Context())
		if sc.IsValid() {
			c.Header("X-Chalk-Trace-Id", sc.TraceID().String())
		}
		c.Next()
	}
}
