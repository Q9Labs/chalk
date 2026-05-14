package middleware

import (
	"crypto/subtle"
	"net/http"

	"github.com/Q9Labs/chalk/internal/config"
	"github.com/gin-gonic/gin"
)

const (
	OpsIngestSourceKey = "ops_ingest_source"
	OpsIngestSource    = "ops-ingest-token"
)

type OpsIngestMiddleware struct {
	config *config.OpsConfig
}

func NewOpsIngestMiddleware(cfg *config.OpsConfig) *OpsIngestMiddleware {
	return &OpsIngestMiddleware{config: cfg}
}

func (m *OpsIngestMiddleware) RequireIngestToken() gin.HandlerFunc {
	return func(c *gin.Context) {
		if m.config == nil || m.config.IngestToken == "" {
			c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "ops ingest auth is misconfigured"})
			return
		}

		token := c.GetHeader("X-Ops-Ingest-Token")
		if token == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "missing ops ingest token"})
			return
		}
		if subtle.ConstantTimeCompare([]byte(token), []byte(m.config.IngestToken)) != 1 {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid ops ingest token"})
			return
		}

		// Source identity for ingest is derived from auth credential, not payload metadata.
		c.Set(OpsIngestSourceKey, OpsIngestSource)
		c.Next()
	}
}
