package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	infraAuth "github.com/Q9Labs/chalk/internal/infrastructure/auth"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"
)

type internalAuthCacheStub struct {
	values map[string]string
	getErr error
}

func (c *internalAuthCacheStub) Set(_ context.Context, key string, value interface{}, _ time.Duration) error {
	if c.values == nil {
		c.values = map[string]string{}
	}
	text, ok := value.(string)
	if !ok {
		return errors.New("cache value must be string")
	}
	c.values[key] = text
	return nil
}

func (c *internalAuthCacheStub) Get(_ context.Context, key string) (string, error) {
	if c.getErr != nil {
		return "", c.getErr
	}
	return c.values[key], nil
}

func (c *internalAuthCacheStub) Del(_ context.Context, keys ...string) error {
	for _, key := range keys {
		delete(c.values, key)
	}
	return nil
}

type internalAuthQueriesStub struct {
	sessionTokenHash string
	sessionUserID    uuid.UUID
	sessionID        uuid.UUID

	tenantByOwner       db.Tenant
	getInternalCalls    int
	touchUserSessionCnt int
}

func (q *internalAuthQueriesStub) CreateInternalTenant(context.Context, db.CreateInternalTenantParams) (db.Tenant, error) {
	panic("unexpected CreateInternalTenant")
}

func (q *internalAuthQueriesStub) CreateTenantClaim(context.Context, db.CreateTenantClaimParams) (db.TenantClaim, error) {
	panic("unexpected CreateTenantClaim")
}

func (q *internalAuthQueriesStub) CreateUser(context.Context, string) (db.User, error) {
	panic("unexpected CreateUser")
}

func (q *internalAuthQueriesStub) CreateUserSession(context.Context, db.CreateUserSessionParams) (db.UserSession, error) {
	panic("unexpected CreateUserSession")
}

func (q *internalAuthQueriesStub) GetInternalTenantByOwnerUserID(_ context.Context, _ pgtype.UUID) (db.Tenant, error) {
	q.getInternalCalls++
	return q.tenantByOwner, nil
}

func (q *internalAuthQueriesStub) GetTenantClaimBySecretHash(context.Context, string) (db.TenantClaim, error) {
	return db.TenantClaim{}, errors.New("claim not found")
}

func (q *internalAuthQueriesStub) GetUserByEmail(context.Context, string) (db.User, error) {
	panic("unexpected GetUserByEmail")
}

func (q *internalAuthQueriesStub) GetUserSessionByRefreshTokenHash(_ context.Context, refreshTokenHash string) (db.UserSession, error) {
	if refreshTokenHash != q.sessionTokenHash {
		return db.UserSession{}, errors.New("session not found")
	}
	return db.UserSession{
		ID:        q.sessionID,
		UserID:    q.sessionUserID,
		CreatedAt: time.Now(),
		ExpiresAt: time.Now().Add(time.Hour),
	}, nil
}

func (q *internalAuthQueriesStub) BindInternalTenantToOwner(context.Context, db.BindInternalTenantToOwnerParams) (db.Tenant, error) {
	panic("unexpected BindInternalTenantToOwner")
}

func (q *internalAuthQueriesStub) MarkTenantClaimUsed(context.Context, uuid.UUID) (db.TenantClaim, error) {
	panic("unexpected MarkTenantClaimUsed")
}

func (q *internalAuthQueriesStub) TouchUserSession(context.Context, uuid.UUID) error {
	q.touchUserSessionCnt++
	return nil
}

func TestInternalAuthAccessToken_UsesOwnerTenantCache(t *testing.T) {
	gin.SetMode(gin.TestMode)
	sessionToken := "session-token"
	userID := uuid.New()
	tenantID := uuid.New()

	queryStub := &internalAuthQueriesStub{
		sessionTokenHash: sha256Hex(sessionToken),
		sessionUserID:    userID,
		sessionID:        uuid.New(),
		tenantByOwner: db.Tenant{
			ID: tenantID,
		},
	}
	cacheStub := &internalAuthCacheStub{
		values: map[string]string{
			internalTenantByOwnerRedisKey(userID): tenantID.String(),
		},
	}

	handler := NewInternalAuthHandler(
		nil,
		queryStub,
		infraAuth.NewJWTService(infraAuth.DefaultJWTConfig()),
		infraAuth.NewAPIKeyService(),
		cacheStub,
	)

	req := httptest.NewRequest(http.MethodGet, "/access-token", nil)
	req.AddCookie(&http.Cookie{Name: internalSessionCookieName, Value: sessionToken})
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = req

	handler.AccessToken(c)
	require.Equal(t, http.StatusOK, w.Code)
	require.Equal(t, 0, queryStub.getInternalCalls)
	require.Equal(t, 1, queryStub.touchUserSessionCnt)

	var body map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.NotEmpty(t, body["access_token"])
}

func TestInternalAuthAccessToken_InvalidOwnerTenantCacheFallsBackToDB(t *testing.T) {
	gin.SetMode(gin.TestMode)
	sessionToken := "session-token"
	userID := uuid.New()
	tenantID := uuid.New()

	queryStub := &internalAuthQueriesStub{
		sessionTokenHash: sha256Hex(sessionToken),
		sessionUserID:    userID,
		sessionID:        uuid.New(),
		tenantByOwner: db.Tenant{
			ID: tenantID,
		},
	}
	cacheStub := &internalAuthCacheStub{
		values: map[string]string{
			internalTenantByOwnerRedisKey(userID): "not-a-uuid",
		},
	}

	handler := NewInternalAuthHandler(
		nil,
		queryStub,
		infraAuth.NewJWTService(infraAuth.DefaultJWTConfig()),
		infraAuth.NewAPIKeyService(),
		cacheStub,
	)

	req := httptest.NewRequest(http.MethodGet, "/access-token", nil)
	req.AddCookie(&http.Cookie{Name: internalSessionCookieName, Value: sessionToken})
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = req

	handler.AccessToken(c)
	require.Equal(t, http.StatusOK, w.Code)
	require.Equal(t, 1, queryStub.getInternalCalls)
	require.Equal(t, tenantID.String(), cacheStub.values[internalTenantByOwnerRedisKey(userID)])
}
