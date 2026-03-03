package handlers

import (
	"net/http"
	"strings"
	"time"

	"github.com/Q9Labs/chalk/internal/domain/auth"
	applogging "github.com/Q9Labs/chalk/internal/infrastructure/logging"
	"github.com/Q9Labs/chalk/internal/interfaces/http/middleware"
	"github.com/Q9Labs/chalk/internal/version"
	"github.com/gin-gonic/gin"
	"github.com/gin-gonic/gin/binding"
	"github.com/google/uuid"
	"go.opentelemetry.io/otel/trace"
	"log/slog"
)

type DebugHandler struct{}

func NewDebugHandler() *DebugHandler {
	return &DebugHandler{}
}

type ClientIncidentRequest struct {
	IncidentID    string         `json:"incident_id" binding:"required,max=128"`
	Source        string         `json:"source" binding:"required,max=64"`
	Stage         string         `json:"stage" binding:"omitempty,max=64"`
	Severity      string         `json:"severity" binding:"omitempty,max=16"`
	Message       string         `json:"message" binding:"required,max=512"`
	ErrorName     string         `json:"error_name" binding:"omitempty,max=128"`
	ErrorCode     string         `json:"error_code" binding:"omitempty,max=128"`
	RequestURL    string         `json:"request_url" binding:"omitempty,max=1024"`
	RequestMethod string         `json:"request_method" binding:"omitempty,max=16"`
	SessionID     string         `json:"session_id" binding:"omitempty,max=128"`
	RoomID        string         `json:"room_id" binding:"omitempty,max=128"`
	MeetingURL    string         `json:"meeting_url" binding:"omitempty,max=256"`
	ExternalID    string         `json:"external_id" binding:"omitempty,max=128"`
	UserAgent     string         `json:"user_agent" binding:"omitempty,max=512"`
	PageURL       string         `json:"page_url" binding:"omitempty,max=1024"`
	Online        *bool          `json:"online,omitempty"`
	Visibility    string         `json:"visibility" binding:"omitempty,max=32"`
	Details       map[string]any `json:"details,omitempty"`
}

type ClientIncidentResponse struct {
	Accepted   bool   `json:"accepted"`
	IncidentID string `json:"incident_id"`
	RequestID  string `json:"request_id"`
}

type SDKIncidentContext struct {
	URL             string `json:"url" binding:"omitempty,max=1024"`
	UserAgent       string `json:"userAgent" binding:"omitempty,max=512"`
	Online          *bool  `json:"online,omitempty"`
	VisibilityState string `json:"visibilityState" binding:"omitempty,max=32"`
}

type SDKIncidentPayload struct {
	ID            string             `json:"id" binding:"required,max=128"`
	Timestamp     string             `json:"timestamp" binding:"omitempty,max=64"`
	Severity      string             `json:"severity" binding:"omitempty,max=16"`
	Source        string             `json:"source" binding:"required,max=64"`
	Message       string             `json:"message" binding:"required,max=512"`
	Code          string             `json:"code" binding:"omitempty,max=128"`
	RoomID        string             `json:"roomId" binding:"omitempty,max=128"`
	ParticipantID string             `json:"participantId" binding:"omitempty,max=128"`
	TraceID       string             `json:"traceId" binding:"omitempty,max=128"`
	Phase         string             `json:"phase" binding:"omitempty,max=64"`
	Stage         string             `json:"stage" binding:"omitempty,max=64"`
	Retryable     *bool              `json:"retryable,omitempty"`
	Details       map[string]any     `json:"details,omitempty"`
	Breadcrumbs   []any              `json:"breadcrumbs,omitempty"`
	Context       SDKIncidentContext `json:"context,omitempty"`
}

type ClientIncidentEnvelope struct {
	Incident   SDKIncidentPayload `json:"incident" binding:"required"`
	ReportedAt string             `json:"reportedAt" binding:"omitempty,max=64"`
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

// ClientIncident handles POST /api/v1/debug/client-incident.
// Authenticated by API key middleware; intended for browser-side telemetry from integrators.
func (h *DebugHandler) ClientIncident(c *gin.Context) {
	var req ClientIncidentRequest
	if err := c.ShouldBindBodyWith(&req, binding.JSON); err != nil {
		var envelope ClientIncidentEnvelope
		if envErr := c.ShouldBindBodyWith(&envelope, binding.JSON); envErr != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		req = ClientIncidentRequest{
			IncidentID: envelope.Incident.ID,
			Source:     envelope.Incident.Source,
			Stage:      envelope.Incident.Stage,
			Severity:   envelope.Incident.Severity,
			Message:    envelope.Incident.Message,
			ErrorCode:  envelope.Incident.Code,
			RoomID:     envelope.Incident.RoomID,
			UserAgent:  envelope.Incident.Context.UserAgent,
			PageURL:    envelope.Incident.Context.URL,
			Online:     envelope.Incident.Context.Online,
			Visibility: envelope.Incident.Context.VisibilityState,
			Details:    envelope.Incident.Details,
		}
		if req.Stage == "" {
			req.Stage = envelope.Incident.Phase
		}
		if req.Details == nil {
			req.Details = map[string]any{}
		}
		if envelope.ReportedAt != "" {
			req.Details["reportedAt"] = envelope.ReportedAt
		}
		if envelope.Incident.Timestamp != "" {
			req.Details["timestamp"] = envelope.Incident.Timestamp
		}
		if envelope.Incident.TraceID != "" {
			req.Details["traceId"] = envelope.Incident.TraceID
		}
		if envelope.Incident.ParticipantID != "" {
			req.Details["participantId"] = envelope.Incident.ParticipantID
		}
		if envelope.Incident.Retryable != nil {
			req.Details["retryable"] = *envelope.Incident.Retryable
		}
		if len(envelope.Incident.Breadcrumbs) > 0 {
			req.Details["breadcrumbs"] = envelope.Incident.Breadcrumbs
		}
		if envelope.Incident.Context.URL != "" ||
			envelope.Incident.Context.UserAgent != "" ||
			envelope.Incident.Context.Online != nil ||
			envelope.Incident.Context.VisibilityState != "" {
			req.Details["context"] = envelope.Incident.Context
		}
	}

	tenantID := ""
	if tenant, ok := middleware.GetTenant(c); ok && tenant != nil {
		tenantID = tenant.ID.String()
	}

	if req.Severity == "" {
		req.Severity = "error"
	}
	req.Severity = strings.ToLower(strings.TrimSpace(req.Severity))

	eventAttrs := []any{
		"event", "client.incident",
		"incident_id", req.IncidentID,
		"source", req.Source,
		"stage", req.Stage,
		"severity", req.Severity,
		"message", req.Message,
		"error_name", req.ErrorName,
		"error_code", req.ErrorCode,
		"request_url", req.RequestURL,
		"request_method", strings.ToUpper(req.RequestMethod),
		"session_id", req.SessionID,
		"room_id", req.RoomID,
		"meeting_url", req.MeetingURL,
		"external_id", req.ExternalID,
		"online", req.Online,
		"visibility", req.Visibility,
		"page_url", req.PageURL,
		"reported_user_agent", req.UserAgent,
		"tenant_id", tenantID,
		"request_id", middleware.GetRequestID(c),
		"client_ip", c.ClientIP(),
		"origin", c.Request.Header.Get("Origin"),
		"path", c.Request.URL.Path,
	}
	if len(req.Details) > 0 {
		eventAttrs = append(eventAttrs, "details", req.Details)
	}

	debugWarn(
		"chalk client incident",
		eventAttrs...,
	)

	c.JSON(http.StatusAccepted, ClientIncidentResponse{
		Accepted:   true,
		IncidentID: req.IncidentID,
		RequestID:  middleware.GetRequestID(c),
	})
}

func debugWarn(msg string, attrs ...any) {
	slog.Warn(msg, attrs...)
	if applogging.AxiomEnabled() {
		applogging.Stdout().Warn(msg, attrs...)
	}
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
