package handlers

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"

	"github.com/Q9Labs/chalk/internal/infrastructure/auth"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	"github.com/Q9Labs/chalk/internal/interfaces/http/middleware"
	wsocket "github.com/Q9Labs/chalk/internal/interfaces/websocket"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
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
	// Parse allowed origins from environment
	originsEnv := os.Getenv("ALLOWED_WS_ORIGINS")
	var origins []string
	if originsEnv != "" {
		origins = strings.Split(originsEnv, ",")
		for i := range origins {
			origins[i] = strings.TrimSpace(origins[i])
		}
	}
	// Add default development origins
	if os.Getenv("ENV") != "production" {
		origins = append(origins,
			"http://localhost:*",
			"http://127.0.0.1:*",
			"localhost:*", // Some browsers send origin without scheme
			"127.0.0.1:*",
		)
	}

	// Production/staging origins (always allowed)
	// Include patterns with and without scheme for compatibility
	origins = append(origins,
		"https://chalk.q9labs.ai",
		"chalk.q9labs.ai", // Some requests may not include scheme
		"https://collabdash-dev.vercel.app",
		"collabdash-dev.vercel.app",
		"https://app.collabdash.io",
		"app.collabdash.io",
		// TuitionHighway origins
		"https://dev.dwd4jsk5p7j52.amplifyapp.com",
		"dev.dwd4jsk5p7j52.amplifyapp.com",
		"https://dev.d17jmjn2v13h91.amplifyapp.com",
		"dev.d17jmjn2v13h91.amplifyapp.com",
		"https://portal-dev.tuitionhighway.com",
		"portal-dev.tuitionhighway.com",
		"https://portal.tuitionhighway.com",
		"portal.tuitionhighway.com",
		"https://backend.tuitionhighway.com",
		"backend.tuitionhighway.com",
		"https://backend-dev.tuitionhighway.com",
		"backend-dev.tuitionhighway.com",
		// Allow localhost for development/testing even in production
		"http://localhost:*",
		"localhost:*",
		"http://127.0.0.1:*",
		"127.0.0.1:*",
	)

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
			slog.Warn("websocket token passed via query param (deprecated, use subprotocol)")
		}
	}

	if token == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "missing token"})
		return
	}

	// Validate JWT token
	claims, err := h.jwtService.ValidateToken(token)
	if err != nil {
		slog.Debug("invalid websocket token", "error", err.Error())
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid token"})
		return
	}

	// Extract required IDs from claims
	if claims.RoomID.String() == "00000000-0000-0000-0000-000000000000" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "missing room_id in token"})
		return
	}

	if claims.Subject == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "missing participant_id in token"})
		return
	}

	// Tenant-aware origin validation (defense in depth)
	origin := c.Request.Header.Get("Origin")
	if origin != "" && h.queries != nil {
		tenant, err := h.queries.GetTenant(c.Request.Context(), claims.TenantID)
		if err == nil {
			if !middleware.IsOriginAllowedForTenant(origin, &tenant) {
				slog.Warn("websocket origin not allowed for tenant",
					"origin", origin,
					"tenant_id", claims.TenantID,
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
		slog.Warn("no ALLOWED_WS_ORIGINS configured, WebSocket will reject cross-origin requests")
	}

	ws, err := websocket.Accept(writer, c.Request, acceptOpts)
	if err != nil {
		slog.Error("websocket upgrade failed", "error", err.Error())
		return
	}
	ws.SetReadLimit(getWsReadLimitBytes())

	// Parse participant ID from claims.Subject
	participantID, err := uuid.Parse(claims.Subject)
	if err != nil {
		slog.Error("invalid participant ID in token", "error", err.Error())
		ws.Close(websocket.StatusInternalError, "invalid participant id")
		return
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
