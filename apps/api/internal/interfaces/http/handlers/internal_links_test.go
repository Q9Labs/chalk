package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	domainAuth "github.com/Q9Labs/chalk/internal/domain/auth"
	"github.com/Q9Labs/chalk/internal/domain/links"
	"github.com/Q9Labs/chalk/internal/infrastructure/auth"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	"github.com/Q9Labs/chalk/internal/interfaces/http/middleware"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

type internalLinksRoomServiceStub struct {
	roomByID   map[uuid.UUID]db.Room
	roomByName map[string]db.Room
}

func (s *internalLinksRoomServiceStub) GetRoom(_ context.Context, roomID uuid.UUID) (*db.Room, error) {
	room, ok := s.roomByID[roomID]
	if !ok {
		return nil, errors.New("room not found")
	}
	return &room, nil
}

func (s *internalLinksRoomServiceStub) GetRoomByName(_ context.Context, name string, tenantID uuid.UUID) (*db.Room, error) {
	room, ok := s.roomByName[name]
	if !ok || room.TenantID != tenantID {
		return nil, errors.New("room not found")
	}
	return &room, nil
}

func TestInternalLinksCreateJoinToken_CanonicalizesExistingRoomTarget(t *testing.T) {
	gin.SetMode(gin.TestMode)

	tenantID := uuid.New()
	roomID := uuid.New()
	roomSvc := &internalLinksRoomServiceStub{
		roomByName: map[string]db.Room{
			"algebra": {
				ID:       roomID,
				TenantID: tenantID,
			},
		},
	}
	handler := &InternalLinksHandler{
		signingKey: []byte("test-signing-key"),
		jwtService: auth.NewJWTService(auth.DefaultJWTConfig()),
		roomSvc:    roomSvc,
	}

	req := httptest.NewRequest(http.MethodPost, "/api/v1/rooms/algebra/join-token", nil)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = req
	c.Params = gin.Params{{Key: "id", Value: "algebra"}}
	c.Set(middleware.ClaimsKey, &domainAuth.Claims{TenantID: tenantID, Role: "host"})

	handler.CreateJoinToken(c)
	require.Equal(t, http.StatusOK, w.Code)

	var body map[string]string
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	payload, err := links.VerifyJoinToken([]byte("test-signing-key"), body["join_token"], time.Now())
	require.NoError(t, err)
	require.Equal(t, tenantID, payload.TenantID)
	require.Equal(t, roomID.String(), payload.RoomName)
}

func TestInternalLinksExchangeJoinToken_ReturnsNotFoundWhenRoomIsMissing(t *testing.T) {
	gin.SetMode(gin.TestMode)

	tenantID := uuid.New()
	roomID := uuid.New()
	handler := &InternalLinksHandler{
		signingKey: []byte("test-signing-key"),
		jwtService: auth.NewJWTService(auth.DefaultJWTConfig()),
		roomSvc:    &internalLinksRoomServiceStub{},
	}

	joinToken, err := links.SignJoinToken([]byte("test-signing-key"), tenantID, roomID.String(), time.Now().Add(time.Hour))
	require.NoError(t, err)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/public/join-token/exchange", strings.NewReader(`{"join_token":"`+joinToken+`"}`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = req

	handler.ExchangeJoinToken(c)
	require.Equal(t, http.StatusNotFound, w.Code)
	require.JSONEq(t, `{"error":"room not found"}`, w.Body.String())
}

func TestInternalLinksExchangeJoinToken_ReturnsCanonicalRoomIdentity(t *testing.T) {
	gin.SetMode(gin.TestMode)

	tenantID := uuid.New()
	roomID := uuid.New()
	roomName := "Phantom Tea"
	handler := &InternalLinksHandler{
		signingKey: []byte("test-signing-key"),
		jwtService: auth.NewJWTService(auth.DefaultJWTConfig()),
		roomSvc: &internalLinksRoomServiceStub{
			roomByID: map[uuid.UUID]db.Room{
				roomID: {
					ID:       roomID,
					TenantID: tenantID,
					Name:     &roomName,
				},
			},
		},
	}

	joinToken, err := links.SignJoinToken([]byte("test-signing-key"), tenantID, roomID.String(), time.Now().Add(time.Hour))
	require.NoError(t, err)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/public/join-token/exchange", strings.NewReader(`{"join_token":"`+joinToken+`"}`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = req

	handler.ExchangeJoinToken(c)
	require.Equal(t, http.StatusOK, w.Code)

	var body map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.Equal(t, roomID.String(), body["room_id"])
	require.Equal(t, roomName, body["room_name"])
}
