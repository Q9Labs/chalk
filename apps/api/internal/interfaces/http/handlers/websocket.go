package handlers

import (
	"context"
	"log"
	"net/http"
	"os"
	"strings"

	"github.com/Q9Labs/chalk/internal/infrastructure/auth"
	wsocket "github.com/Q9Labs/chalk/internal/interfaces/websocket"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"nhooyr.io/websocket"
)

// WebSocketHandler handles WebSocket upgrades and connections
type WebSocketHandler struct {
	jwtService     *auth.JWTService
	hub            *wsocket.Hub
	allowedOrigins []string
}

// NewWebSocketHandler creates a new WebSocket handler
func NewWebSocketHandler(jwtService *auth.JWTService, hub *wsocket.Hub) *WebSocketHandler {
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
		origins = append(origins, "http://localhost:5173", "http://localhost:3000", "http://127.0.0.1:5173")
	}

	return &WebSocketHandler{
		jwtService:     jwtService,
		hub:            hub,
		allowedOrigins: origins,
	}
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
			log.Printf("Warning: WebSocket token passed via query param (deprecated, use subprotocol)")
		}
	}

	if token == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "missing token"})
		return
	}

	// Validate JWT token
	claims, err := h.jwtService.ValidateToken(token)
	if err != nil {
		log.Printf("Invalid token: %v", err)
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
		log.Printf("Warning: No ALLOWED_WS_ORIGINS configured, WebSocket will reject cross-origin requests")
	}

	ws, err := websocket.Accept(writer, c.Request, acceptOpts)
	if err != nil {
		log.Printf("WebSocket upgrade failed: %v", err)
		return
	}

	// Parse participant ID from claims.Subject
	participantID, err := uuid.Parse(claims.Subject)
	if err != nil {
		log.Printf("Invalid participant ID: %v", err)
		ws.Close(websocket.StatusInternalError, "invalid participant id")
		return
	}

	// Create client
	client := wsocket.NewClient(ws, h.hub, claims.RoomID, participantID, claims.TenantID)

	// Register with hub
	h.hub.Register(client)

	// Start read and write pumps
	ctx, cancel := context.WithCancel(c.Request.Context())
	defer cancel()
	client.Start(ctx)

	// Wait for client to close
	client.Wait()
}
