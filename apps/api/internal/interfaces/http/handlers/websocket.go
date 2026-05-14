package handlers

import (
	"context"
	"errors"
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
	tokenSource := "subprotocol"
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
			tokenSource = "query_param"
			wsWarn(
				"websocket token passed via query param (deprecated, use subprotocol)",
				append([]any{
					"event", "websocket.auth.deprecated_query_token",
					"token_source", tokenSource,
				}, wsBaseAttrs(c)...)...,
			)
		}
	}

	roomQueryRaw := strings.TrimSpace(c.Query("room"))
	roomQueryPresent := roomQueryRaw != ""
	roomQueryID, roomQueryParseErr := uuid.Parse(roomQueryRaw)
	roomQueryIsUUID := roomQueryParseErr == nil

	if token == "" {
		wsWarn(
			"websocket auth failed: missing token",
			append([]any{
				"event", "websocket.auth_failed",
				"reason", "missing_token",
				"token_source", tokenSource,
				"query_room_present", roomQueryPresent,
				"query_room_is_uuid", roomQueryIsUUID,
				"query_room", roomQueryRaw,
			}, wsBaseAttrs(c)...)...,
		)
		c.JSON(http.StatusUnauthorized, gin.H{"error": "missing token"})
		return
	}

	// Validate JWT token
	claims, err := h.jwtService.ValidateToken(token)
	if err != nil {
		reason := "invalid_token"
		switch {
		case errors.Is(err, auth.ErrExpiredToken):
			reason = "expired_token"
		case errors.Is(err, auth.ErrWrongTokenType):
			reason = "wrong_token_type"
		case errors.Is(err, auth.ErrInvalidClaim):
			reason = "invalid_claim"
		}
		wsWarn(
			"websocket auth failed: invalid token",
			append([]any{
				"event", "websocket.auth_failed",
				"reason", reason,
				"error", err.Error(),
				"token_source", tokenSource,
				"query_room_present", roomQueryPresent,
				"query_room_is_uuid", roomQueryIsUUID,
				"query_room", roomQueryRaw,
			}, wsBaseAttrs(c)...)...,
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
			append([]any{
				"event", "websocket.auth_failed",
				"reason", "missing_room_id",
				"tenant_id", claims.TenantID,
				"participant_id", claims.Subject,
				"token_source", tokenSource,
				"query_room_present", roomQueryPresent,
				"query_room_is_uuid", roomQueryIsUUID,
				"query_room", roomQueryRaw,
				"token_secs_to_expiry", secsToExpiry,
			}, wsBaseAttrs(c)...)...,
		)
		c.JSON(http.StatusBadRequest, gin.H{"error": "missing room_id in token"})
		return
	}

	if claims.Subject == "" {
		wsWarn(
			"websocket auth failed: missing participant_id in token",
			append([]any{
				"event", "websocket.auth_failed",
				"reason", "missing_participant_id",
				"tenant_id", claims.TenantID,
				"room_id", claims.RoomID,
				"token_source", tokenSource,
				"query_room_present", roomQueryPresent,
				"query_room_is_uuid", roomQueryIsUUID,
				"query_room", roomQueryRaw,
				"token_secs_to_expiry", secsToExpiry,
			}, wsBaseAttrs(c)...)...,
		)
		c.JSON(http.StatusBadRequest, gin.H{"error": "missing participant_id in token"})
		return
	}

	if roomQueryPresent {
		if !roomQueryIsUUID {
			wsWarn(
				"websocket room query is not a uuid",
				append([]any{
					"event", "websocket.auth.room_query_invalid",
					"tenant_id", claims.TenantID,
					"room_id", claims.RoomID,
					"participant_id", claims.Subject,
					"token_source", tokenSource,
					"query_room", roomQueryRaw,
				}, wsBaseAttrs(c)...)...,
			)
		} else if roomQueryID != claims.RoomID {
			wsWarn(
				"websocket room query does not match token room_id",
				append([]any{
					"event", "websocket.auth.room_query_mismatch",
					"tenant_id", claims.TenantID,
					"room_id", claims.RoomID,
					"participant_id", claims.Subject,
					"token_source", tokenSource,
					"query_room", roomQueryRaw,
				}, wsBaseAttrs(c)...)...,
			)
		}
	}

	// Tenant-aware origin validation (defense in depth)
	origin := c.Request.Header.Get("Origin")
	tenantOriginAllowed := false
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
			tenantOriginAllowed = true
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

	acceptOpts.OriginPatterns = resolveWSOriginPatterns(origin, tenantOriginAllowed, h.allowedOrigins)
	if len(acceptOpts.OriginPatterns) > 0 {
		// API-HIGH-03: Enable origin checking in production
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
			"token_source", tokenSource,
			"query_room_present", roomQueryPresent,
			"query_room_is_uuid", roomQueryIsUUID,
			"query_room_matches_claim_room", roomQueryIsUUID && roomQueryID == claims.RoomID,
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
			"token_source", tokenSource,
			"query_room_present", roomQueryPresent,
			"query_room_is_uuid", roomQueryIsUUID,
			"query_room_matches_claim_room", roomQueryIsUUID && roomQueryID == claims.RoomID,
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
				IdentityKey: firstNonEmptyString(p.ExternalUserID, participantID.String()),
				Role:        p.Role,
				JoinedAt:    joinedAt,
			})
		}

		// Best-effort: hydrate room whiteboard policy from tenant config.
		if tenant, err := h.queries.GetTenantByRoomID(c.Request.Context(), claims.RoomID); err == nil {
			h.hub.SetRoomWhiteboardPolicy(claims.RoomID, wsocket.ParseWhiteboardRoomPolicy(tenant.WhiteboardConfig))
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

func firstNonEmptyString(value *string, fallback string) string {
	if value != nil && strings.TrimSpace(*value) != "" {
		return strings.TrimSpace(*value)
	}
	return fallback
}
