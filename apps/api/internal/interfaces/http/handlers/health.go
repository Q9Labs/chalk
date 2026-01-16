package handlers

import (
	"net/http"

	"github.com/Q9Labs/chalk/internal/infrastructure/postgres"
	"github.com/gin-gonic/gin"
)

type HealthHandler struct {
	pool *postgres.Pool
}

func NewHealthHandler(pool *postgres.Pool) *HealthHandler {
	return &HealthHandler{pool: pool}
}

func (h *HealthHandler) Check(c *gin.Context) {
	// Check database connection
	if err := h.pool.Health(c.Request.Context()); err != nil {
		// API-MED-07: Don't expose internal DB errors - log server-side only
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"status":   "unhealthy",
			"database": "disconnected",
		})
		return
	}

	stats := h.pool.Stats()
	c.JSON(http.StatusOK, gin.H{
		"status":   "healthy",
		"database": "connected",
		"pool": gin.H{
			"total_conns":    stats.TotalConns(),
			"idle_conns":     stats.IdleConns(),
			"acquired_conns": stats.AcquiredConns(),
		},
	})
}
