package handlers

import (
	"context"
	"log"
	"net/http"

	"github.com/Q9Labs/chalk/internal/infrastructure/auth"
	wsocket "github.com/Q9Labs/chalk/internal/interfaces/websocket"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"nhooyr.io/websocket"
)

// WebSocketHandler handles WebSocket upgrades and connections
type WebSocketHandler struct {
	jwtService *auth.JWTService
	hub        *wsocket.Hub
}

// NewWebSocketHandler creates a new WebSocket handler
func NewWebSocketHandler(jwtService *auth.JWTService, hub *wsocket.Hub) *WebSocketHandler {
	return &WebSocketHandler{
		jwtService: jwtService,
		hub:        hub,
	}
}

// HandleWebSocket upgrades an HTTP connection to WebSocket
func (h *WebSocketHandler) HandleWebSocket(c *gin.Context) {
	// Extract JWT from query parameter
	token := c.Query("token")
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

	// Upgrade connection to WebSocket
	ws, err := websocket.Accept(c.Writer, c.Request, &websocket.AcceptOptions{
		Subprotocols: []string{},
	})
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
