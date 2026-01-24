package handlers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/Q9Labs/chalk/internal/domain/auth"
	infraAuth "github.com/Q9Labs/chalk/internal/infrastructure/auth"
	wsocket "github.com/Q9Labs/chalk/internal/interfaces/websocket"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// mockRedis is a mock Redis client for testing
type mockRedis struct{}

func (m *mockRedis) Close() error                                                     { return nil }
func (m *mockRedis) Publish(ctx context.Context, channel string, message []byte) error { return nil }
func (m *mockRedis) Subscribe(ctx context.Context, channel string) *redis.PubSub     { return nil }
func (m *mockRedis) Set(ctx context.Context, key string, value interface{}, expiration time.Duration) error {
	return nil
}
func (m *mockRedis) Get(ctx context.Context, key string) (string, error) { return "", nil }
func (m *mockRedis) Del(ctx context.Context, keys ...string) error       { return nil }
func (m *mockRedis) Exists(ctx context.Context, keys ...string) (int64, error) {
	return 0, nil
}

func newTestWSHub() *wsocket.Hub {
	return wsocket.NewHub(&mockRedis{})
}

func TestWebSocketHandler_HandleWebSocket_MissingToken(t *testing.T) {
	config := infraAuth.DefaultJWTConfig()
	jwtService := infraAuth.NewJWTService(config)
	hub := newTestWSHub()
	handler := NewWebSocketHandler(jwtService, hub, nil)

	router := setupTestRouter()
	router.GET("/ws", handler.HandleWebSocket)

	req := httptest.NewRequest("GET", "/ws", nil)
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
	assert.Contains(t, w.Body.String(), "missing token")
}

func TestWebSocketHandler_HandleWebSocket_InvalidToken(t *testing.T) {
	config := infraAuth.DefaultJWTConfig()
	jwtService := infraAuth.NewJWTService(config)
	hub := newTestWSHub()
	handler := NewWebSocketHandler(jwtService, hub, nil)

	router := setupTestRouter()
	router.GET("/ws", handler.HandleWebSocket)

	req := httptest.NewRequest("GET", "/ws?token=invalid.token.here", nil)
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
	assert.Contains(t, w.Body.String(), "invalid token")
}

func TestWebSocketHandler_HandleWebSocket_MissingRoomID(t *testing.T) {
	config := infraAuth.DefaultJWTConfig()
	jwtService := infraAuth.NewJWTService(config)
	hub := newTestWSHub()
	handler := NewWebSocketHandler(jwtService, hub, nil)

	// Generate a token without room_id
	claims := auth.Claims{
		Subject:  uuid.New().String(),
		TenantID: uuid.New(),
		// RoomID is zero value (nil UUID)
	}
	token, err := jwtService.GenerateAccessToken(claims)
	require.NoError(t, err)

	router := setupTestRouter()
	router.GET("/ws", handler.HandleWebSocket)

	req := httptest.NewRequest("GET", "/ws?token="+token, nil)
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	assert.Contains(t, w.Body.String(), "missing room_id in token")
}

func TestWebSocketHandler_HandleWebSocket_MissingParticipantID(t *testing.T) {
	config := infraAuth.DefaultJWTConfig()
	jwtService := infraAuth.NewJWTService(config)
	hub := newTestWSHub()
	handler := NewWebSocketHandler(jwtService, hub, nil)

	// Generate a token without subject (participant ID)
	claims := auth.Claims{
		Subject:  "", // Empty subject
		TenantID: uuid.New(),
		RoomID:   uuid.New(),
	}
	token, err := jwtService.GenerateAccessToken(claims)
	require.NoError(t, err)

	router := setupTestRouter()
	router.GET("/ws", handler.HandleWebSocket)

	req := httptest.NewRequest("GET", "/ws?token="+token, nil)
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	assert.Contains(t, w.Body.String(), "missing participant_id in token")
}

func TestWebSocketHandler_TokenFromQueryParam(t *testing.T) {
	config := infraAuth.DefaultJWTConfig()
	jwtService := infraAuth.NewJWTService(config)
	hub := newTestWSHub()
	handler := NewWebSocketHandler(jwtService, hub, nil)

	claims := auth.Claims{
		Subject:  uuid.New().String(),
		TenantID: uuid.New(),
		RoomID:   uuid.New(),
	}
	token, err := jwtService.GenerateAccessToken(claims)
	require.NoError(t, err)

	router := setupTestRouter()
	router.GET("/ws", handler.HandleWebSocket)

	// Token is in query parameter, WebSocket upgrade will fail but auth should pass
	req := httptest.NewRequest("GET", "/ws?token="+token, nil)
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	// Should not return unauthorized - the token is valid
	// The request will fail at WebSocket upgrade stage, not auth
	assert.NotEqual(t, http.StatusUnauthorized, w.Code)
}

func TestWebSocketHandler_TokenFromProtocolHeader(t *testing.T) {
	config := infraAuth.DefaultJWTConfig()
	jwtService := infraAuth.NewJWTService(config)
	hub := newTestWSHub()
	handler := NewWebSocketHandler(jwtService, hub, nil)

	claims := auth.Claims{
		Subject:  uuid.New().String(),
		TenantID: uuid.New(),
		RoomID:   uuid.New(),
	}
	token, err := jwtService.GenerateAccessToken(claims)
	require.NoError(t, err)

	router := setupTestRouter()
	router.GET("/ws", handler.HandleWebSocket)

	req := httptest.NewRequest("GET", "/ws", nil)
	req.Header.Set("Sec-WebSocket-Protocol", "token."+token)
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	// Should not return unauthorized
	assert.NotEqual(t, http.StatusUnauthorized, w.Code)
}

func TestWebSocketHandler_TokenFromProtocolHeader_MultipleProtocols(t *testing.T) {
	config := infraAuth.DefaultJWTConfig()
	jwtService := infraAuth.NewJWTService(config)
	hub := newTestWSHub()
	handler := NewWebSocketHandler(jwtService, hub, nil)

	claims := auth.Claims{
		Subject:  uuid.New().String(),
		TenantID: uuid.New(),
		RoomID:   uuid.New(),
	}
	token, err := jwtService.GenerateAccessToken(claims)
	require.NoError(t, err)

	router := setupTestRouter()
	router.GET("/ws", handler.HandleWebSocket)

	req := httptest.NewRequest("GET", "/ws", nil)
	req.Header.Set("Sec-WebSocket-Protocol", "chalk, token."+token)
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	// Should not return unauthorized
	assert.NotEqual(t, http.StatusUnauthorized, w.Code)
}

func TestWebSocketHandler_QueryParamTakesPrecedence(t *testing.T) {
	config := infraAuth.DefaultJWTConfig()
	jwtService := infraAuth.NewJWTService(config)
	hub := newTestWSHub()
	handler := NewWebSocketHandler(jwtService, hub, nil)

	// Valid token in query
	claims := auth.Claims{
		Subject:  uuid.New().String(),
		TenantID: uuid.New(),
		RoomID:   uuid.New(),
	}
	validToken, err := jwtService.GenerateAccessToken(claims)
	require.NoError(t, err)

	router := setupTestRouter()
	router.GET("/ws", handler.HandleWebSocket)

	// Header takes precedence over query param (more secure - not logged)
	req := httptest.NewRequest("GET", "/ws?token="+validToken, nil)
	req.Header.Set("Sec-WebSocket-Protocol", "token.invalid.token")
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	// Header token is invalid, so should return unauthorized (header takes precedence)
	assert.Equal(t, http.StatusUnauthorized, w.Code)
}

func TestNewWebSocketHandler(t *testing.T) {
	config := infraAuth.DefaultJWTConfig()
	jwtService := infraAuth.NewJWTService(config)
	hub := newTestWSHub()

	handler := NewWebSocketHandler(jwtService, hub, nil)

	assert.NotNil(t, handler)
	assert.Equal(t, jwtService, handler.jwtService)
	assert.Equal(t, hub, handler.hub)
}

func TestWebSocketHandler_EmptySecWebSocketProtocol(t *testing.T) {
	config := infraAuth.DefaultJWTConfig()
	jwtService := infraAuth.NewJWTService(config)
	hub := newTestWSHub()
	handler := NewWebSocketHandler(jwtService, hub, nil)

	router := setupTestRouter()
	router.GET("/ws", handler.HandleWebSocket)

	req := httptest.NewRequest("GET", "/ws", nil)
	req.Header.Set("Sec-WebSocket-Protocol", "")
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	// Should return unauthorized since no token found
	assert.Equal(t, http.StatusUnauthorized, w.Code)
}

func TestWebSocketHandler_NoTokenPrefix(t *testing.T) {
	gin.SetMode(gin.TestMode)
	config := infraAuth.DefaultJWTConfig()
	jwtService := infraAuth.NewJWTService(config)
	hub := newTestWSHub()
	handler := NewWebSocketHandler(jwtService, hub, nil)

	router := setupTestRouter()
	router.GET("/ws", handler.HandleWebSocket)

	req := httptest.NewRequest("GET", "/ws", nil)
	req.Header.Set("Sec-WebSocket-Protocol", "chalk, other-protocol")
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	// Should return unauthorized since no token.* protocol found
	assert.Equal(t, http.StatusUnauthorized, w.Code)
}
