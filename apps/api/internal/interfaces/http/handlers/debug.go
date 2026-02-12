package handlers

import (
	"net/http"
	"time"

	"github.com/Q9Labs/chalk/internal/domain/auth"
	"github.com/Q9Labs/chalk/internal/interfaces/http/middleware"
	"github.com/Q9Labs/chalk/internal/version"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"go.opentelemetry.io/otel/trace"
)

type DebugHandler struct{}

func NewDebugHandler() *DebugHandler {
	return &DebugHandler{}
}

type DebugAuthResponse struct {
	UserID      string  `json:"user_id"`
	TenantID    *string `json:"tenant_id"`
	RoomID      *string `json:"room_id"`
	DisplayName *string `json:"display_name"`
	Role        *string `json:"role"`

	Permissions auth.Permissions `json:"permissions"`
	Scopes      []string         `json:"scopes"`

	TokenIssuedAt         string `json:"token_issued_at"`
	TokenExpiresAt        string `json:"token_expires_at"`
	TokenExpiresInSeconds int    `json:"token_expires_in_seconds"`

	ServerTime string `json:"server_time"`

	APIVersion   string `json:"api_version"`
	APICommitSHA string `json:"api_commit_sha"`
	APIBuildTime string `json:"api_build_time"`

	RequestID string `json:"request_id"`
	TraceID   string `json:"trace_id"`
}

// Ping handles HEAD /api/v1/debug/ping.
func (h *DebugHandler) Ping(c *gin.Context) {
	c.Status(http.StatusNoContent)
}

// Auth handles GET /api/v1/debug/auth.
func (h *DebugHandler) Auth(c *gin.Context) {
	claims, ok := middleware.GetClaims(c)
	if !ok || claims == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "no claims in context"})
		return
	}

	now := time.Now().UTC()

	var tenantID *string
	if claims.TenantID != uuid.Nil {
		s := claims.TenantID.String()
		tenantID = &s
	}

	var roomID *string
	if claims.RoomID != uuid.Nil {
		s := claims.RoomID.String()
		roomID = &s
	}

	var displayName *string
	if claims.DisplayName != "" {
		s := claims.DisplayName
		displayName = &s
	}

	var role *string
	if claims.Role != "" {
		s := claims.Role
		role = &s
	}

	expiresIn := int(claims.ExpiresAt.Sub(now).Seconds())
	if expiresIn < 0 {
		expiresIn = 0
	}

	sc := trace.SpanContextFromContext(c.Request.Context())
	traceID := ""
	if sc.IsValid() {
		traceID = sc.TraceID().String()
	}

	c.JSON(http.StatusOK, DebugAuthResponse{
		UserID:      claims.Subject,
		TenantID:    tenantID,
		RoomID:      roomID,
		DisplayName: displayName,
		Role:        role,

		Permissions: claims.Permissions,
		Scopes:      deriveScopes(claims.Permissions),

		TokenIssuedAt:         claims.IssuedAt.UTC().Format(time.RFC3339),
		TokenExpiresAt:        claims.ExpiresAt.UTC().Format(time.RFC3339),
		TokenExpiresInSeconds: expiresIn,

		ServerTime: now.Format(time.RFC3339),

		APIVersion:   version.Version,
		APICommitSHA: version.CommitSHA,
		APIBuildTime: version.BuildTime,

		RequestID: middleware.GetRequestID(c),
		TraceID:   traceID,
	})
}

func deriveScopes(p auth.Permissions) []string {
	scopes := make([]string, 0, 4)
	if p.CanRecord {
		scopes = append(scopes, "recording:control")
	}
	if p.CanScreenShare {
		scopes = append(scopes, "room:screenshare")
	}
	if p.CanKick {
		scopes = append(scopes, "room:kick")
	}
	if p.CanMute {
		scopes = append(scopes, "room:mute")
	}
	return scopes
}
