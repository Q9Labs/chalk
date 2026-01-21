package handlers

import (
	"net/http"
	"time"

	"github.com/Q9Labs/chalk/internal/infrastructure/postgres"
	"github.com/gin-gonic/gin"
)

var startTime = time.Now()

type HealthHandler struct {
	pool *postgres.Pool
}

func NewHealthHandler(pool *postgres.Pool) *HealthHandler {
	return &HealthHandler{pool: pool}
}

func (h *HealthHandler) Check(c *gin.Context) {
	uptime := time.Since(startTime).Seconds()

	// Check database connection
	if err := h.pool.Health(c.Request.Context()); err != nil {
		// API-MED-07: Don't expose internal DB errors - log server-side only
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"status":   "unhealthy",
			"database": "disconnected",
			"uptime":   uptime,
		})
		return
	}

	stats := h.pool.Stats()
	c.JSON(http.StatusOK, gin.H{
		"status":   "healthy",
		"database": "connected",
		"uptime":   uptime,
		"pool": gin.H{
			"total_conns":    stats.TotalConns(),
			"idle_conns":     stats.IdleConns(),
			"acquired_conns": stats.AcquiredConns(),
		},
	})
}
