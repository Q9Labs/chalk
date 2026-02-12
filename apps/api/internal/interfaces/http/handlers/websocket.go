package handlers

import (
	"context"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/Q9Labs/chalk/internal/domain"
	"github.com/Q9Labs/chalk/internal/infrastructure/auth"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	"github.com/Q9Labs/chalk/internal/interfaces/http/middleware"
	wsocket "github.com/Q9Labs/chalk/internal/interfaces/websocket"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"go.opentelemetry.io/otel/trace"
	"nhooyr.io/websocket"
)

const defaultWsReadLimitBytes = 32 << 20 // 32MB

// WebSocketHandler handles WebSocket upgrades and connections
type WebSocketHandler struct {
	jwtService     *auth.JWTService
	hub            *wsocket.Hub
	queries        *db.Queries
	allowedOrigins []string
}

// NewWebSocketHandler creates a new WebSocket handler
func NewWebSocketHandler(jwtService *auth.JWTService, hub *wsocket.Hub, queries *db.Queries) *WebSocketHandler {
	origins := buildAllowedWSOrigins()

	return &WebSocketHandler{
		jwtService:     jwtService,
		hub:            hub,
		queries:        queries,
		allowedOrigins: origins,
	}
}

func getWsReadLimitBytes() int64 {
	// Prefer CHALK_WS_READ_LIMIT_BYTES; fall back to WS_READ_LIMIT_BYTES.
	if raw := os.Getenv("CHALK_WS_READ_LIMIT_BYTES"); raw != "" {
		if v, err := strconv.ParseInt(raw, 10, 64); err == nil && v > 0 {
			return v
		}
	}
	if raw := os.Getenv("WS_READ_LIMIT_BYTES"); raw != "" {
		if v, err := strconv.ParseInt(raw, 10, 64); err == nil && v > 0 {
			return v
		}
	}
	return defaultWsReadLimitBytes
}

// HandleWebSocket upgrades an HTTP connection to WebSocket
func (h *WebSocketHandler) HandleWebSocket(c *gin.Context) {
	// Prefer token from Sec-WebSocket-Protocol header (more secure - not logged)
	var token string
	protocolHeader := c.GetHeader("Sec-WebSocket-Protocol")
	if protocolHeader != "" {
		for _, entry := range strings.Split(protocolHeader, ",") {
			entry = strings.TrimSpace(entry)
			if strings.HasPrefix(entry, "token.") {
				token = strings.TrimPrefix(entry, "token.")
				break
			}
		}
	}

	// Fallback: query parameter (deprecated - logs token in access logs)
	if token == "" {
		token = c.Query("token")
		if token != "" {
			wsWarn(
				"websocket token passed via query param (deprecated, use subprotocol)",
				append([]any{"event", "websocket.auth.deprecated_query_token"}, wsBaseAttrs(c)...)...,
			)
		}
	}

	if token == "" {
		wsWarn(
			"websocket auth failed: missing token",
			append([]any{"event", "websocket.auth_failed", "reason", "missing_token"}, wsBaseAttrs(c)...)...,
		)
		c.JSON(http.StatusUnauthorized, gin.H{"error": "missing token"})
		return
	}

	// Validate JWT token
	claims, err := h.jwtService.ValidateToken(token)
	if err != nil {
		wsWarn(
			"websocket auth failed: invalid token",
			append([]any{"event", "websocket.auth_failed", "reason", "invalid_token", "error", err.Error()}, wsBaseAttrs(c)...)...,
		)
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid token"})
		return
	}

	// Best-effort: log if token is near expiry to debug reconnect/kick patterns.
	// Server does not proactively disconnect on JWT expiry, but clients may reconnect
	// with an expired token.
	secsToExpiry := int64(time.Until(claims.ExpiresAt).Seconds())

	// Extract required IDs from claims
	if claims.RoomID.String() == "00000000-0000-0000-0000-000000000000" {
		wsWarn(
			"websocket auth failed: missing room_id in token",
			append([]any{"event", "websocket.auth_failed", "reason", "missing_room_id", "tenant_id", claims.TenantID}, wsBaseAttrs(c)...)...,
		)
		c.JSON(http.StatusBadRequest, gin.H{"error": "missing room_id in token"})
		return
	}

	if claims.Subject == "" {
		wsWarn(
			"websocket auth failed: missing participant_id in token",
			append([]any{"event", "websocket.auth_failed", "reason", "missing_participant_id", "tenant_id", claims.TenantID, "room_id", claims.RoomID}, wsBaseAttrs(c)...)...,
		)
		c.JSON(http.StatusBadRequest, gin.H{"error": "missing participant_id in token"})
		return
	}

	// Tenant-aware origin validation (defense in depth)
	origin := c.Request.Header.Get("Origin")
	if origin != "" && h.queries != nil {
		tenant, err := h.queries.GetTenant(c.Request.Context(), claims.TenantID)
		if err == nil {
			if !middleware.IsOriginAllowedForTenant(origin, &tenant) {
				wsWarn(
					"websocket origin forbidden",
					append([]any{
						"event", "websocket.origin_forbidden",
						"origin", origin,
						"tenant_id", claims.TenantID,
						"room_id", claims.RoomID,
						"participant_id", claims.Subject,
					}, wsBaseAttrs(c)...)...,
				)
				c.JSON(http.StatusForbidden, gin.H{"error": "origin not allowed"})
				return
			}
		}
		// If tenant lookup fails, fall through to pattern-based check below
	}

	// Upgrade connection to WebSocket with origin checking
	var writer http.ResponseWriter = c.Writer
	if uw, ok := writer.(interface{ Unwrap() http.ResponseWriter }); ok {
		writer = uw.Unwrap()
	}

	acceptOpts := &websocket.AcceptOptions{
		Subprotocols: []string{"chalk"},
	}

	// API-HIGH-03: Enable origin checking in production
	if len(h.allowedOrigins) > 0 {
		acceptOpts.OriginPatterns = h.allowedOrigins
	} else {
		// No origins configured - strict mode (will reject cross-origin)
		wsWarn(
			"no ALLOWED_WS_ORIGINS configured, WebSocket will reject cross-origin requests",
			append([]any{"event", "websocket.config.missing_allowed_origins"}, wsBaseAttrs(c)...)...,
		)
	}

	ws, err := websocket.Accept(writer, c.Request, acceptOpts)
	if err != nil {
		wsError(
			"websocket upgrade failed",
			append([]any{
				"event", "websocket.upgrade_failed",
				"error", err.Error(),
				"tenant_id", claims.TenantID,
				"room_id", claims.RoomID,
				"participant_id", claims.Subject,
			}, wsBaseAttrs(c)...)...,
		)
		return
	}
	ws.SetReadLimit(getWsReadLimitBytes())

	// Parse participant ID from claims.Subject
	participantID, err := uuid.Parse(claims.Subject)
	if err != nil {
		wsError(
			"invalid participant ID in token",
			append([]any{
				"event", "websocket.auth_failed",
				"reason", "invalid_participant_id",
				"error", err.Error(),
				"tenant_id", claims.TenantID,
				"room_id", claims.RoomID,
			}, wsBaseAttrs(c)...)...,
		)
		ws.Close(websocket.StatusInternalError, "invalid participant id")
		return
	}

	sc := trace.SpanContextFromContext(c.Request.Context())
	traceID := ""
	spanID := ""
	if sc.IsValid() {
		traceID = sc.TraceID().String()
		spanID = sc.SpanID().String()
	}

	// Presence diagnostics: helps debug "same room_id but users can't see each other".
	// If expected_active_participants > local_room_clients, likely multi-instance WS
	// with no cross-instance fanout (or sticky sessions issues).
	localRoomClients := len(h.hub.GetParticipantsInRoom(claims.RoomID))
	expectedActive := int64(-1)
	if h.queries != nil {
		if n, err := h.queries.CountActiveParticipantsByRoom(c.Request.Context(), claims.RoomID); err == nil {
			expectedActive = n
		}
	}
	wsInfo(
		"websocket presence snapshot",
		append([]any{
			"event", "websocket.presence",
			"tenant_id", claims.TenantID,
			"room_id", claims.RoomID,
			"participant_id", participantID,
			"local_room_clients", localRoomClients,
			"expected_active_participants", expectedActive,
		}, wsBaseAttrs(c)...)...,
	)

	wsInfo(
		"websocket upgrade ok",
		append([]any{
			"event", "websocket.upgrade_ok",
			"tenant_id", claims.TenantID,
			"room_id", claims.RoomID,
			"participant_id", participantID,
			"token_expires_at", claims.ExpiresAt.UTC().Format(time.RFC3339Nano),
			"token_secs_to_expiry", secsToExpiry,
			"trace_id", traceID,
			"span_id", spanID,
			"ws_read_limit_bytes", getWsReadLimitBytes(),
			"local_room_clients", localRoomClients,
			"expected_active_participants", expectedActive,
		}, wsBaseAttrs(c)...)...,
	)

	// Best-effort: hydrate participant metadata on *this* instance.
	// WS may land on a different API instance than the /participants join request.
	if h.queries != nil {
		if p, err := h.queries.GetParticipant(c.Request.Context(), participantID); err == nil {
			displayName := ""
			if p.DisplayName != nil {
				displayName = *p.DisplayName
			}
			joinedAt := time.Now()
			if p.JoinedAt.Valid {
				joinedAt = p.JoinedAt.Time
			}
			h.hub.SetParticipantMetadata(participantID, domain.ParticipantMetadata{
				DisplayName: displayName,
				Role:        p.Role,
				JoinedAt:    joinedAt,
			})
		}
	}

	// Create client
	client := wsocket.NewClient(ws, h.hub, claims.RoomID, participantID, claims.TenantID)

	// Register with hub
	h.hub.Register(client)

	// Start read and write pumps
	// IMPORTANT: Use context.Background() instead of c.Request.Context()
	// The HTTP request context gets canceled when the upgrade completes,
	// which would immediately terminate the WebSocket connection.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	client.Start(ctx)

	// Wait for client to close
	client.Wait()
}
