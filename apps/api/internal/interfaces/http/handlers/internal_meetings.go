package handlers

import (
	"net/http"
	"strconv"

	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	"github.com/Q9Labs/chalk/internal/interfaces/http/middleware"
	"github.com/gin-gonic/gin"
)

type InternalMeetingsHandler struct {
	queries *db.Queries
}

func NewInternalMeetingsHandler(queries *db.Queries) *InternalMeetingsHandler {
	return &InternalMeetingsHandler{queries: queries}
}

// GET /api/v1/internal/meetings
func (h *InternalMeetingsHandler) List(c *gin.Context) {
	claims, ok := middleware.GetClaims(c)
	if !ok || claims == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}

	tenant, err := h.queries.GetTenant(c.Request.Context(), claims.TenantID)
	if err != nil || tenant.TenantKind != "internal" {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}

	// Optional signup: dashboard requires email-verified ownership.
	if !tenant.OwnerUserID.Valid {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "login required"})
		return
	}

	limit, _ := strconv.ParseInt(c.DefaultQuery("limit", "50"), 10, 32)
	offset, _ := strconv.ParseInt(c.DefaultQuery("offset", "0"), 10, 32)

	rows, err := h.queries.ListMeetingsByTenant(c.Request.Context(), db.ListMeetingsByTenantParams{
		TenantID: claims.TenantID,
		Limit:    int32(limit),
		Offset:   int32(offset),
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	total, _ := h.queries.CountMeetingsByTenant(c.Request.Context(), claims.TenantID)

	c.JSON(http.StatusOK, gin.H{
		"meetings": rows,
		"total":    total,
		"limit":    limit,
		"offset":   offset,
	})
}
