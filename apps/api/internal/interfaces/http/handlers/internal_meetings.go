package handlers

import (
	"context"
	"net/http"
	"net/url"
	"strconv"

	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	"github.com/Q9Labs/chalk/internal/interfaces/http/middleware"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
)

type internalMeetingsQueries interface {
	GetTenant(ctx context.Context, id uuid.UUID) (db.Tenant, error)
	ListMeetingsByTenant(ctx context.Context, arg db.ListMeetingsByTenantParams) ([]db.ListMeetingsByTenantRow, error)
	ListMeetingsByWorkspace(ctx context.Context, arg db.ListMeetingsByWorkspaceParams) ([]db.ListMeetingsByWorkspaceRow, error)
	CountMeetingsByTenant(ctx context.Context, tenantID uuid.UUID) (int64, error)
	CountMeetingsByWorkspace(ctx context.Context, workspaceID pgtype.UUID) (int64, error)
}

type InternalMeetingsHandler struct {
	queries internalMeetingsQueries
}

func NewInternalMeetingsHandler(queries internalMeetingsQueries) *InternalMeetingsHandler {
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

	// Localhost dev should work without email auth; first-party sessions carry workspace_id.
	if claims.WorkspaceID == uuid.Nil && !isLocalInternalDashboardRequest(c.Request) {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "login required"})
		return
	}

	limit, _ := strconv.ParseInt(c.DefaultQuery("limit", "50"), 10, 32)
	offset, _ := strconv.ParseInt(c.DefaultQuery("offset", "0"), 10, 32)

	var (
		rows  any
		total int64
	)

	if claims.WorkspaceID != uuid.Nil {
		rows, err = h.queries.ListMeetingsByWorkspace(c.Request.Context(), db.ListMeetingsByWorkspaceParams{
			WorkspaceID: pgtype.UUID{Bytes: claims.WorkspaceID, Valid: true},
			Limit:       int32(limit),
			Offset:      int32(offset),
		})
		if err == nil {
			total, _ = h.queries.CountMeetingsByWorkspace(c.Request.Context(), pgtype.UUID{Bytes: claims.WorkspaceID, Valid: true})
		}
	} else {
		rows, err = h.queries.ListMeetingsByTenant(c.Request.Context(), db.ListMeetingsByTenantParams{
			TenantID: claims.TenantID,
			Limit:    int32(limit),
			Offset:   int32(offset),
		})
		if err == nil {
			total, _ = h.queries.CountMeetingsByTenant(c.Request.Context(), claims.TenantID)
		}
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"meetings": rows,
		"total":    total,
		"limit":    limit,
		"offset":   offset,
	})
}

func isLocalInternalDashboardRequest(r *http.Request) bool {
	origin, err := url.Parse(requestOrigin(r))
	if err != nil {
		return false
	}
	return isLocalMagicLinkHost(origin.Hostname())
}
