package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/Q9Labs/chalk/internal/config"
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

func TestInternalAuthResolveMagicLinkAppURL(t *testing.T) {
	handler := &InternalAuthHandler{
		cfg: &config.Config{
			Auth: config.AuthConfig{
				InternalAppURL: "https://chalk.q9labs.ai",
			},
		},
	}

	t.Run("uses configured app url by default", func(t *testing.T) {
		got := handler.resolveMagicLinkAppURL("")
		require.Equal(t, "https://chalk.q9labs.ai", got)
	})

	t.Run("accepts configured origin callback", func(t *testing.T) {
		got := handler.resolveMagicLinkAppURL("https://chalk.q9labs.ai/dashboard")
		require.Equal(t, "https://chalk.q9labs.ai", got)
	})

	t.Run("accepts localhost callback for dev ui", func(t *testing.T) {
		got := handler.resolveMagicLinkAppURL("http://localhost:3000/auth/callback")
		require.Equal(t, "http://localhost:3000", got)
	})

	t.Run("accepts localhost subdomain callback for dev ui", func(t *testing.T) {
		got := handler.resolveMagicLinkAppURL("http://chalk.localhost:3000/auth/callback")
		require.Equal(t, "http://chalk.localhost:3000", got)
	})

	t.Run("accepts loopback ipv6 callback for dev ui", func(t *testing.T) {
		got := handler.resolveMagicLinkAppURL("http://[::1]:3000/auth/callback")
		require.Equal(t, "http://[::1]:3000", got)
	})

	t.Run("rejects non-allowlisted domain", func(t *testing.T) {
		got := handler.resolveMagicLinkAppURL("https://evil.example.com/auth/callback")
		require.Equal(t, "https://chalk.q9labs.ai", got)
	})

	t.Run("rejects invalid callback URL", func(t *testing.T) {
		got := handler.resolveMagicLinkAppURL("javascript:alert(1)")
		require.Equal(t, "https://chalk.q9labs.ai", got)
	})
}

func TestInternalAuthResolveMagicLinkCallbackURL(t *testing.T) {
	handler := &InternalAuthHandler{
		cfg: &config.Config{
			Auth: config.AuthConfig{
				InternalAppURL: "https://chalk.q9labs.ai",
			},
		},
	}

	t.Run("defaults to dashboard when callback is missing", func(t *testing.T) {
		got := handler.resolveMagicLinkCallbackURL("")
		require.Equal(t, "https://chalk.q9labs.ai/dashboard", got)
	})

	t.Run("preserves allowlisted hosted callback path", func(t *testing.T) {
		got := handler.resolveMagicLinkCallbackURL("https://chalk.q9labs.ai/dashboard?tab=recent")
		require.Equal(t, "https://chalk.q9labs.ai/dashboard?tab=recent", got)
	})

	t.Run("preserves localhost callback path", func(t *testing.T) {
		got := handler.resolveMagicLinkCallbackURL("http://localhost:3070/auth/callback?next=%2Fdashboard")
		require.Equal(t, "http://localhost:3070/auth/callback?next=%2Fdashboard", got)
	})

	t.Run("normalizes root callback to dashboard", func(t *testing.T) {
		got := handler.resolveMagicLinkCallbackURL("https://chalk.q9labs.ai")
		require.Equal(t, "https://chalk.q9labs.ai/dashboard", got)
	})

	t.Run("falls back to default dashboard for non-allowlisted callback", func(t *testing.T) {
		got := handler.resolveMagicLinkCallbackURL("https://evil.example.com/dashboard")
		require.Equal(t, "https://chalk.q9labs.ai/dashboard", got)
	})
}

func TestInternalAuthBuildMagicLinkVerificationURL(t *testing.T) {
	gin.SetMode(gin.TestMode)

	handler := &InternalAuthHandler{}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/internal/auth/start", nil)
	req.Host = "chalk-api.q9labs.ai"
	req.Header.Set("X-Forwarded-Proto", "https")

	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = req

	got := handler.buildMagicLinkVerificationURL(
		c,
		"token-123",
		"https://chalk.q9labs.ai/dashboard",
	)

	require.Equal(
		t,
		"https://chalk-api.q9labs.ai/api/v1/internal/auth/verify?callback_url=https%3A%2F%2Fchalk.q9labs.ai%2Fdashboard&token=token-123",
		got,
	)
}

func TestInternalAuthCookieSameSite(t *testing.T) {
	gin.SetMode(gin.TestMode)

	t.Run("uses SameSite None for production auth cookies", func(t *testing.T) {
		handler := &InternalAuthHandler{
			cfg: &config.Config{
				Server: config.ServerConfig{Env: "production"},
				Auth:   config.AuthConfig{CookieDomain: ".q9labs.ai"},
			},
		}

		req := httptest.NewRequest(http.MethodGet, "/", nil)
		w := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(w)
		c.Request = req

		handler.setCookie(c, internalSessionCookieName, "session-token", time.Now().Add(time.Hour))

		cookies := w.Result().Cookies()
		require.Len(t, cookies, 1)
		require.Equal(t, http.SameSiteNoneMode, cookies[0].SameSite)
		require.True(t, cookies[0].Secure)
		require.Equal(t, "q9labs.ai", cookies[0].Domain)
	})

	t.Run("uses SameSite Lax for local auth cookies", func(t *testing.T) {
		handler := &InternalAuthHandler{
			cfg: &config.Config{
				Server: config.ServerConfig{Env: "development"},
			},
		}

		req := httptest.NewRequest(http.MethodGet, "/", nil)
		w := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(w)
		c.Request = req

		handler.setCookie(c, internalSessionCookieName, "session-token", time.Now().Add(time.Hour))

		cookies := w.Result().Cookies()
		require.Len(t, cookies, 1)
		require.Equal(t, http.SameSiteLaxMode, cookies[0].SameSite)
		require.False(t, cookies[0].Secure)
	})
}
