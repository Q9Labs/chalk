package handlers

import (
	"bytes"
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
	userByID         db.User
	userByEmail      db.User

	tenantByOwner        db.Tenant
	sharedTenant         db.Tenant
	workspaceByOwner     db.Workspace
	getInternalCalls     int
	touchUserSessionCnt  int
	createTenantCalls    int
	createClaimCalls     int
	createUserCalls      int
	createSessionCalls   int
	createWorkspaceCalls int
	revokeSessionCalls   int
	createdTenant        db.Tenant
	createdClaim         db.TenantClaim
	claimBySecret        db.TenantClaim
	bindTenantCalls      int
	bindTenantErr        error
}

func (q *internalAuthQueriesStub) CreateInternalTenant(context.Context, db.CreateInternalTenantParams) (db.Tenant, error) {
	q.createTenantCalls++
	if q.createdTenant.ID == uuid.Nil {
		q.createdTenant = db.Tenant{ID: uuid.New()}
	}
	return q.createdTenant, nil
}

func (q *internalAuthQueriesStub) CreateTenantClaim(context.Context, db.CreateTenantClaimParams) (db.TenantClaim, error) {
	q.createClaimCalls++
	if q.createdClaim.ID == uuid.Nil {
		q.createdClaim = db.TenantClaim{ID: uuid.New(), TenantID: q.createdTenant.ID}
	}
	return q.createdClaim, nil
}

func (q *internalAuthQueriesStub) CreateUser(_ context.Context, email string) (db.User, error) {
	q.createUserCalls++
	if q.userByEmail.ID == uuid.Nil {
		q.userByEmail = db.User{ID: uuid.New(), Email: email}
	}
	q.userByID = q.userByEmail
	return q.userByEmail, nil
}

func (q *internalAuthQueriesStub) CreateUserSession(context.Context, db.CreateUserSessionParams) (db.UserSession, error) {
	q.createSessionCalls++
	return db.UserSession{ID: uuid.New()}, nil
}

func (q *internalAuthQueriesStub) CreateWorkspace(_ context.Context, arg db.CreateWorkspaceParams) (db.Workspace, error) {
	q.createWorkspaceCalls++
	if q.workspaceByOwner.ID == uuid.Nil {
		q.workspaceByOwner = db.Workspace{
			ID:          uuid.New(),
			TenantID:    arg.TenantID,
			OwnerUserID: arg.OwnerUserID,
			Name:        arg.Name,
			Kind:        arg.Kind,
		}
	}
	return q.workspaceByOwner, nil
}

func (q *internalAuthQueriesStub) CreateWorkspaceMembership(context.Context, db.CreateWorkspaceMembershipParams) (db.WorkspaceMembership, error) {
	return db.WorkspaceMembership{}, nil
}

func (q *internalAuthQueriesStub) GetInternalTenantByOwnerUserID(_ context.Context, _ pgtype.UUID) (db.Tenant, error) {
	q.getInternalCalls++
	if q.tenantByOwner.ID == uuid.Nil {
		return db.Tenant{}, errors.New("tenant not found")
	}
	return q.tenantByOwner, nil
}

func (q *internalAuthQueriesStub) GetSharedInternalTenantByName(_ context.Context, _ string) (db.Tenant, error) {
	if q.sharedTenant.ID == uuid.Nil {
		return db.Tenant{}, errors.New("tenant not found")
	}
	return q.sharedTenant, nil
}

func (q *internalAuthQueriesStub) GetTenant(_ context.Context, id uuid.UUID) (db.Tenant, error) {
	if q.sharedTenant.ID == id {
		return q.sharedTenant, nil
	}
	if q.createdTenant.ID == id {
		return q.createdTenant, nil
	}
	return db.Tenant{}, errors.New("tenant not found")
}

func (q *internalAuthQueriesStub) GetTenantClaimBySecretHash(context.Context, string) (db.TenantClaim, error) {
	if q.claimBySecret.ID == uuid.Nil {
		return db.TenantClaim{}, errors.New("claim not found")
	}
	return q.claimBySecret, nil
}

func (q *internalAuthQueriesStub) GetUser(_ context.Context, id uuid.UUID) (db.User, error) {
	if q.userByID.ID == id {
		return q.userByID, nil
	}
	return db.User{}, errors.New("user not found")
}

func (q *internalAuthQueriesStub) GetUserByEmail(_ context.Context, email string) (db.User, error) {
	if q.userByEmail.ID != uuid.Nil && q.userByEmail.Email == email {
		return q.userByEmail, nil
	}
	return db.User{}, errors.New("user not found")
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

func (q *internalAuthQueriesStub) GetWorkspace(_ context.Context, id uuid.UUID) (db.Workspace, error) {
	if q.workspaceByOwner.ID == id {
		return q.workspaceByOwner, nil
	}
	return db.Workspace{}, errors.New("workspace not found")
}

func (q *internalAuthQueriesStub) GetWorkspaceByTenantAndOwner(_ context.Context, arg db.GetWorkspaceByTenantAndOwnerParams) (db.Workspace, error) {
	if q.workspaceByOwner.ID == uuid.Nil {
		return db.Workspace{}, errors.New("workspace not found")
	}
	if q.workspaceByOwner.TenantID != arg.TenantID {
		return db.Workspace{}, errors.New("workspace not found")
	}
	if !q.workspaceByOwner.OwnerUserID.Valid || q.workspaceByOwner.OwnerUserID.Bytes != arg.OwnerUserID.Bytes {
		return db.Workspace{}, errors.New("workspace not found")
	}
	return q.workspaceByOwner, nil
}

func (q *internalAuthQueriesStub) BindInternalTenantToOwner(_ context.Context, arg db.BindInternalTenantToOwnerParams) (db.Tenant, error) {
	q.bindTenantCalls++
	if q.bindTenantErr != nil {
		return db.Tenant{}, q.bindTenantErr
	}
	return db.Tenant{ID: arg.ID}, nil
}

func (q *internalAuthQueriesStub) MarkTenantClaimUsed(context.Context, uuid.UUID) (db.TenantClaim, error) {
	return db.TenantClaim{}, nil
}

func (q *internalAuthQueriesStub) RevokeUserSession(context.Context, uuid.UUID) error {
	q.revokeSessionCalls++
	return nil
}

func (q *internalAuthQueriesStub) TouchUserSession(context.Context, uuid.UUID) error {
	q.touchUserSessionCnt++
	return nil
}

func TestInternalAuthGoogle_ExchangesOAuthCodeAndEstablishesSession(t *testing.T) {
	gin.SetMode(gin.TestMode)
	queryStub := &internalAuthQueriesStub{}
	handler := NewInternalAuthHandler(
		&config.Config{Auth: config.AuthConfig{GoogleClientID: "google-client-id", GoogleClientSecret: "google-client-secret", InternalAppURL: "http://localhost:3070"}},
		queryStub,
		infraAuth.NewJWTService(infraAuth.DefaultJWTConfig()),
		infraAuth.NewAPIKeyService(),
		nil,
	)
	handler.googleCodeExchanger = func(_ context.Context, code, redirectURI string) (*googleIdentity, error) {
		require.Equal(t, "oauth-code", code)
		require.Equal(t, "http://localhost:3070", redirectURI)
		return &googleIdentity{Email: "hasan@q9labs.ai", EmailVerified: true}, nil
	}

	body := bytes.NewBufferString(`{"code":"oauth-code"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/internal/auth/google", body)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "http://localhost:3070")
	req.Header.Set("X-Requested-With", "XMLHttpRequest")
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = req

	handler.Google(c)
	require.Equal(t, http.StatusOK, w.Code)
	require.Equal(t, 1, queryStub.createUserCalls)
	require.Equal(t, 1, queryStub.createSessionCalls)
	require.Equal(t, 1, queryStub.createTenantCalls)
	require.Equal(t, 1, queryStub.createWorkspaceCalls)
	require.Contains(t, w.Header().Get("Set-Cookie"), internalSessionCookieName+"=")

	var bodyJSON map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &bodyJSON))
	require.Equal(t, "hasan@q9labs.ai", bodyJSON["user"].(map[string]any)["email"])
}

func TestInternalAuthGoogle_AcceptsMultipleHostedOrigins(t *testing.T) {
	gin.SetMode(gin.TestMode)
	queryStub := &internalAuthQueriesStub{}
	handler := NewInternalAuthHandler(
		&config.Config{Auth: config.AuthConfig{
			GoogleClientID:     "google-client-id",
			GoogleClientSecret: "google-client-secret",
			InternalAppURL:     "https://chalk.q9labs.ai",
			InternalAppURLs:    "https://chalkmeet.com, https://chalk.q9labs.ai",
		}},
		queryStub,
		infraAuth.NewJWTService(infraAuth.DefaultJWTConfig()),
		infraAuth.NewAPIKeyService(),
		nil,
	)
	handler.googleCodeExchanger = func(_ context.Context, code, redirectURI string) (*googleIdentity, error) {
		require.Equal(t, "oauth-code", code)
		require.Equal(t, "https://chalkmeet.com", redirectURI)
		return &googleIdentity{Email: "hasan@q9labs.ai", EmailVerified: true}, nil
	}

	body := bytes.NewBufferString(`{"code":"oauth-code"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/internal/auth/google", body)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "https://chalkmeet.com")
	req.Header.Set("X-Requested-With", "XMLHttpRequest")
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = req

	handler.Google(c)
	require.Equal(t, http.StatusOK, w.Code)
	require.Equal(t, 1, queryStub.createUserCalls)
	require.Equal(t, 1, queryStub.createSessionCalls)
	require.Equal(t, 1, queryStub.createTenantCalls)
	require.Equal(t, 1, queryStub.createWorkspaceCalls)
	require.Contains(t, w.Header().Get("Set-Cookie"), internalSessionCookieName+"=")
}

func TestInternalAuthGoogle_RejectsInvalidOrigin(t *testing.T) {
	gin.SetMode(gin.TestMode)
	handler := NewInternalAuthHandler(
		&config.Config{Auth: config.AuthConfig{GoogleClientID: "google-client-id", GoogleClientSecret: "google-client-secret", InternalAppURL: "https://chalk.q9labs.ai"}},
		&internalAuthQueriesStub{},
		infraAuth.NewJWTService(infraAuth.DefaultJWTConfig()),
		infraAuth.NewAPIKeyService(),
		nil,
	)

	body := bytes.NewBufferString(`{"code":"oauth-code"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/internal/auth/google", body)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "https://evil.example.com")
	req.Header.Set("X-Requested-With", "XMLHttpRequest")
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = req

	handler.Google(c)
	require.Equal(t, http.StatusBadRequest, w.Code)
	require.JSONEq(t, `{"error":"invalid oauth origin"}`, w.Body.String())
}

func TestInternalAuthSession_ReturnsCurrentUser(t *testing.T) {
	gin.SetMode(gin.TestMode)
	sessionToken := "session-token"
	userID := uuid.New()
	queryStub := &internalAuthQueriesStub{
		sessionTokenHash: sha256Hex(sessionToken),
		sessionUserID:    userID,
		sessionID:        uuid.New(),
		userByID:         db.User{ID: userID, Email: "hasan@q9labs.ai"},
	}

	handler := NewInternalAuthHandler(
		nil,
		queryStub,
		infraAuth.NewJWTService(infraAuth.DefaultJWTConfig()),
		infraAuth.NewAPIKeyService(),
		nil,
	)

	req := httptest.NewRequest(http.MethodGet, "/session", nil)
	req.AddCookie(&http.Cookie{Name: internalSessionCookieName, Value: sessionToken})
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = req

	handler.Session(c)
	require.Equal(t, http.StatusOK, w.Code)
	require.Equal(t, 1, queryStub.touchUserSessionCnt)
	require.JSONEq(t, `{"user":{"email":"hasan@q9labs.ai"}}`, w.Body.String())
}

func TestInternalAuthLogout_RevokesSessionAndClearsCookies(t *testing.T) {
	gin.SetMode(gin.TestMode)
	sessionToken := "session-token"
	userID := uuid.New()
	queryStub := &internalAuthQueriesStub{
		sessionTokenHash: sha256Hex(sessionToken),
		sessionUserID:    userID,
		sessionID:        uuid.New(),
	}

	handler := NewInternalAuthHandler(
		nil,
		queryStub,
		infraAuth.NewJWTService(infraAuth.DefaultJWTConfig()),
		infraAuth.NewAPIKeyService(),
		nil,
	)

	req := httptest.NewRequest(http.MethodPost, "/logout", nil)
	req.AddCookie(&http.Cookie{Name: internalSessionCookieName, Value: sessionToken})
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = req

	handler.Logout(c)
	require.Equal(t, http.StatusOK, w.Code)
	require.Equal(t, 1, queryStub.revokeSessionCalls)
	cookies := w.Result().Cookies()
	require.Len(t, cookies, 2)
	require.Equal(t, internalSessionCookieName, cookies[0].Name)
	require.Equal(t, "", cookies[0].Value)
}

func TestInternalAuthAccessToken_UsesSharedTenantAndWorkspaceCache(t *testing.T) {
	gin.SetMode(gin.TestMode)
	sessionToken := "session-token"
	userID := uuid.New()
	tenantID := uuid.New()
	workspaceID := uuid.New()

	queryStub := &internalAuthQueriesStub{
		sessionTokenHash: sha256Hex(sessionToken),
		sessionUserID:    userID,
		sessionID:        uuid.New(),
		sharedTenant: db.Tenant{
			ID:         tenantID,
			TenantKind: "internal",
		},
		workspaceByOwner: db.Workspace{
			ID:          workspaceID,
			TenantID:    tenantID,
			OwnerUserID: pgtype.UUID{Bytes: userID, Valid: true},
		},
	}
	cacheStub := &internalAuthCacheStub{
		values: map[string]string{
			sharedInternalTenantRedisKey():   tenantID.String(),
			workspaceByOwnerRedisKey(userID): workspaceID.String(),
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

func TestInternalAuthAccessToken_InvalidWorkspaceCacheFallsBackToDB(t *testing.T) {
	gin.SetMode(gin.TestMode)
	sessionToken := "session-token"
	userID := uuid.New()
	tenantID := uuid.New()
	workspaceID := uuid.New()

	queryStub := &internalAuthQueriesStub{
		sessionTokenHash: sha256Hex(sessionToken),
		sessionUserID:    userID,
		sessionID:        uuid.New(),
		sharedTenant: db.Tenant{
			ID:         tenantID,
			TenantKind: "internal",
		},
		workspaceByOwner: db.Workspace{
			ID:          workspaceID,
			TenantID:    tenantID,
			OwnerUserID: pgtype.UUID{Bytes: userID, Valid: true},
		},
	}
	cacheStub := &internalAuthCacheStub{
		values: map[string]string{
			sharedInternalTenantRedisKey():   tenantID.String(),
			workspaceByOwnerRedisKey(userID): "not-a-uuid",
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
	require.Equal(t, workspaceID.String(), cacheStub.values[workspaceByOwnerRedisKey(userID)])
}
