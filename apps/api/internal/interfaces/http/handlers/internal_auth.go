package handlers

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/Q9Labs/chalk/internal/config"
	domainAuth "github.com/Q9Labs/chalk/internal/domain/auth"
	"github.com/Q9Labs/chalk/internal/infrastructure/auth"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"golang.org/x/oauth2"
	googleoauth "golang.org/x/oauth2/google"
	"google.golang.org/api/idtoken"
)

const (
	internalSessionCookieName = "chalk_session"
	internalClaimCookieName   = "chalk_claim"
	internalTenantCacheTTL    = 5 * time.Minute
	localClientIDHeader       = "X-Chalk-Local-Client-ID"
	localClientTenantTTL      = 7 * 24 * time.Hour
	localLoopbackClientID     = "loopback-shared"
)

var errGoogleAuthNotConfigured = errors.New("google auth is not configured")

type internalAuthQueries interface {
	CreateInternalTenant(ctx context.Context, arg db.CreateInternalTenantParams) (db.Tenant, error)
	CreateTenantClaim(ctx context.Context, arg db.CreateTenantClaimParams) (db.TenantClaim, error)
	CreateUser(ctx context.Context, email string) (db.User, error)
	CreateUserSession(ctx context.Context, arg db.CreateUserSessionParams) (db.UserSession, error)
	CreateWorkspace(ctx context.Context, arg db.CreateWorkspaceParams) (db.Workspace, error)
	CreateWorkspaceMembership(ctx context.Context, arg db.CreateWorkspaceMembershipParams) (db.WorkspaceMembership, error)
	GetInternalTenantByOwnerUserID(ctx context.Context, ownerUserID pgtype.UUID) (db.Tenant, error)
	GetSharedInternalTenantByName(ctx context.Context, name string) (db.Tenant, error)
	GetTenant(ctx context.Context, id uuid.UUID) (db.Tenant, error)
	GetTenantClaimBySecretHash(ctx context.Context, secretHash string) (db.TenantClaim, error)
	GetUser(ctx context.Context, id uuid.UUID) (db.User, error)
	GetUserByEmail(ctx context.Context, lower string) (db.User, error)
	GetUserSessionByRefreshTokenHash(ctx context.Context, refreshTokenHash string) (db.UserSession, error)
	GetWorkspace(ctx context.Context, id uuid.UUID) (db.Workspace, error)
	GetWorkspaceByTenantAndOwner(ctx context.Context, arg db.GetWorkspaceByTenantAndOwnerParams) (db.Workspace, error)
	BindInternalTenantToOwner(ctx context.Context, arg db.BindInternalTenantToOwnerParams) (db.Tenant, error)
	MarkTenantClaimUsed(ctx context.Context, id uuid.UUID) (db.TenantClaim, error)
	RevokeUserSession(ctx context.Context, id uuid.UUID) error
	TouchUserSession(ctx context.Context, id uuid.UUID) error
}

type internalAuthCache interface {
	Set(ctx context.Context, key string, value interface{}, expiration time.Duration) error
	Get(ctx context.Context, key string) (string, error)
	Del(ctx context.Context, keys ...string) error
}

type googleIDTokenValidator func(ctx context.Context, rawToken, audience string) (*idtoken.Payload, error)

type googleIdentity struct {
	Email         string
	EmailVerified bool
}

type googleCodeExchanger func(ctx context.Context, code, redirectURI string) (*googleIdentity, error)

type InternalAuthHandler struct {
	cfg                  *config.Config
	queries              internalAuthQueries
	jwtService           *auth.JWTService
	apiKeySvc            *auth.APIKeyService
	redis                internalAuthCache
	googleTokenValidator googleIDTokenValidator
	googleCodeExchanger  googleCodeExchanger
}

type localClientTenantBootstrap struct {
	TenantID    uuid.UUID `json:"tenant_id"`
	ClaimSecret string    `json:"claim_secret"`
}

type googleAuthRequest struct {
	Code string `json:"code" binding:"required"`
}

type internalAuthUserResponse struct {
	Email string `json:"email"`
}

func NewInternalAuthHandler(
	cfg *config.Config,
	queries internalAuthQueries,
	jwtService *auth.JWTService,
	apiKeySvc *auth.APIKeyService,
	redisClient internalAuthCache,
) *InternalAuthHandler {
	h := &InternalAuthHandler{
		cfg:                  cfg,
		queries:              queries,
		jwtService:           jwtService,
		apiKeySvc:            apiKeySvc,
		redis:                redisClient,
		googleTokenValidator: idtoken.Validate,
	}
	h.googleCodeExchanger = h.exchangeGoogleCode
	return h
}

// POST /api/v1/internal/auth/google
func (h *InternalAuthHandler) Google(c *gin.Context) {
	var req googleAuthRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if strings.TrimSpace(c.GetHeader("X-Requested-With")) != "XMLHttpRequest" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "missing oauth request header"})
		return
	}

	redirectURI := h.resolveGoogleRedirectURI(c.Request)
	if redirectURI == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid oauth origin"})
		return
	}
	if h.googleCodeExchanger == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": errGoogleAuthNotConfigured.Error()})
		return
	}

	identity, err := h.googleCodeExchanger(c.Request.Context(), strings.TrimSpace(req.Code), redirectURI)
	if err != nil {
		status := http.StatusUnauthorized
		if errors.Is(err, errGoogleAuthNotConfigured) {
			status = http.StatusServiceUnavailable
		}
		c.JSON(status, gin.H{"error": err.Error()})
		return
	}
	if !identity.EmailVerified {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "google account email is not verified"})
		return
	}

	user, err := h.getOrCreateUser(c.Request.Context(), strings.ToLower(identity.Email))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create user"})
		return
	}

	tenant, err := h.establishSession(c, user.ID)
	if err != nil || tenant == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to establish session"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"ok":        true,
		"tenant_id": tenant.ID,
		"user": internalAuthUserResponse{
			Email: user.Email,
		},
	})
}

// GET /api/v1/internal/auth/session
func (h *InternalAuthHandler) Session(c *gin.Context) {
	user, status, message := h.currentUser(c.Request.Context(), c)
	if status != 0 {
		c.JSON(status, gin.H{"error": message})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"user": internalAuthUserResponse{Email: user.Email},
	})
}

// POST /api/v1/internal/auth/logout
func (h *InternalAuthHandler) Logout(c *gin.Context) {
	if sessionToken, err := c.Cookie(internalSessionCookieName); err == nil && strings.TrimSpace(sessionToken) != "" {
		if sess, lookupErr := h.queries.GetUserSessionByRefreshTokenHash(c.Request.Context(), sha256Hex(sessionToken)); lookupErr == nil {
			_ = h.queries.RevokeUserSession(c.Request.Context(), sess.ID)
		}
	}

	h.clearCookie(c, internalSessionCookieName)
	h.clearCookie(c, internalClaimCookieName)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// GET /api/v1/internal/auth/access-token
func (h *InternalAuthHandler) AccessToken(c *gin.Context) {
	ctx := c.Request.Context()

	var tenantID uuid.UUID
	var workspaceID uuid.UUID
	var subject string
	localClientID := localClientBootstrapKey(c.Request, strings.TrimSpace(c.GetHeader(localClientIDHeader)))
	localBootstrap, hasLocalBootstrap := h.getCachedLocalClientTenant(ctx, c.Request, localClientID)

	if sessionToken, err := c.Cookie(internalSessionCookieName); err == nil && sessionToken != "" {
		sess, err := h.queries.GetUserSessionByRefreshTokenHash(ctx, sha256Hex(sessionToken))
		if err == nil {
			_ = h.queries.TouchUserSession(ctx, sess.ID)
			subject = sess.UserID.String()
			scope, resolveErr := h.resolveSessionScope(ctx, sess.UserID)
			if resolveErr != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to initialize workspace"})
				return
			}
			tenantID = scope.Tenant.ID
			workspaceID = scope.Workspace.ID
		}
	}

	if tenantID == uuid.Nil {
		if claimSecret, err := c.Cookie(internalClaimCookieName); err == nil && claimSecret != "" {
			claim, err := h.queries.GetTenantClaimBySecretHash(ctx, sha256Hex(claimSecret))
			if err == nil {
				tenantID = claim.TenantID
				subject = "claim:" + claim.ID.String()
			}
		}
	}

	if tenantID == uuid.Nil {
		if hasLocalBootstrap && localBootstrap != nil {
			bootstrap := localBootstrap
			tenantID = bootstrap.TenantID
			subject = "claim:" + tenantID.String()
			h.setCookie(c, internalClaimCookieName, bootstrap.ClaimSecret, time.Now().Add(localClientTenantTTL))
		} else {
			tenant, claimSecret, err := h.createInternalTenantWithClaim(ctx)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to initialize workspace"})
				return
			}
			tenantID = tenant.ID
			subject = "claim:" + tenant.ID.String()
			if localClientID != "" {
				h.setCachedLocalClientTenant(ctx, c.Request, localClientID, tenant.ID, claimSecret)
			}
			h.setCookie(c, internalClaimCookieName, claimSecret, time.Now().Add(localClientTenantTTL))
		}
	}

	claims := domainAuth.Claims{
		Subject:     subject,
		TenantID:    tenantID,
		WorkspaceID: workspaceID,
		Role:        "host",
		Permissions: domainAuth.DefaultHostPermissions(),
	}

	tokenPair, err := h.jwtService.GenerateTokenPair(claims)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to mint token"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"access_token": tokenPair.AccessToken,
		"expires_in":   tokenPair.ExpiresIn,
	})
}

func (h *InternalAuthHandler) exchangeGoogleCode(ctx context.Context, code, redirectURI string) (*googleIdentity, error) {
	googleClientID := strings.TrimSpace(h.googleClientID())
	googleClientSecret := strings.TrimSpace(h.googleClientSecret())
	if googleClientID == "" || googleClientSecret == "" {
		return nil, errGoogleAuthNotConfigured
	}
	if h.googleTokenValidator == nil {
		return nil, errGoogleAuthNotConfigured
	}

	conf := &oauth2.Config{
		ClientID:     googleClientID,
		ClientSecret: googleClientSecret,
		RedirectURL:  redirectURI,
		Scopes:       []string{"openid", "email", "profile"},
		Endpoint:     googleoauth.Endpoint,
	}

	token, err := conf.Exchange(ctx, code)
	if err != nil {
		return nil, errors.New("invalid google authorization code")
	}

	rawIDToken, ok := token.Extra("id_token").(string)
	if !ok || strings.TrimSpace(rawIDToken) == "" {
		return nil, errors.New("google id token missing")
	}

	payload, err := h.googleTokenValidator(ctx, rawIDToken, googleClientID)
	if err != nil {
		return nil, errors.New("invalid google id token")
	}
	if !isGoogleIssuer(payload.Issuer) {
		return nil, errors.New("invalid google issuer")
	}

	emailAddr, ok := claimString(payload.Claims, "email")
	if !ok || emailAddr == "" {
		return nil, errors.New("google account email missing")
	}

	return &googleIdentity{
		Email:         strings.ToLower(emailAddr),
		EmailVerified: claimBool(payload.Claims, "email_verified"),
	}, nil
}

func (h *InternalAuthHandler) resolveGoogleRedirectURI(r *http.Request) string {
	if r == nil {
		return ""
	}

	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" {
		referer := strings.TrimSpace(r.Header.Get("Referer"))
		refererOrigin, ok := normalizedOrigin(referer)
		if ok {
			origin = refererOrigin
		}
	}
	origin, ok := normalizedOrigin(origin)
	if !ok {
		return ""
	}
	if !h.isAllowedGoogleOrigin(origin) {
		return ""
	}
	return origin
}

func (h *InternalAuthHandler) isAllowedGoogleOrigin(origin string) bool {
	if h.cfg != nil {
		configuredOrigin, ok := normalizedOrigin(h.cfg.Auth.InternalAppURL)
		if ok && strings.EqualFold(origin, configuredOrigin) {
			return true
		}
	}

	parsed, err := url.Parse(origin)
	if err != nil {
		return false
	}
	return isLocalHostForInternalAuth(parsed.Hostname())
}

func normalizedOrigin(rawURL string) (string, bool) {
	trimmed := strings.TrimSpace(rawURL)
	if trimmed == "" {
		return "", false
	}

	parsed, err := url.Parse(trimmed)
	if err != nil {
		return "", false
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", false
	}
	if parsed.Host == "" {
		return "", false
	}
	return parsed.Scheme + "://" + parsed.Host, true
}

func (h *InternalAuthHandler) currentUser(ctx context.Context, c *gin.Context) (*db.User, int, string) {
	sess, status, message := h.currentSession(ctx, c)
	if status != 0 {
		return nil, status, message
	}
	user, err := h.queries.GetUser(ctx, sess.UserID)
	if err != nil {
		return nil, http.StatusUnauthorized, "not authenticated"
	}
	return &user, 0, ""
}

func (h *InternalAuthHandler) currentSession(ctx context.Context, c *gin.Context) (*db.UserSession, int, string) {
	sessionToken, err := c.Cookie(internalSessionCookieName)
	if err != nil || strings.TrimSpace(sessionToken) == "" {
		return nil, http.StatusUnauthorized, "not authenticated"
	}
	sess, err := h.queries.GetUserSessionByRefreshTokenHash(ctx, sha256Hex(sessionToken))
	if err != nil {
		return nil, http.StatusUnauthorized, "not authenticated"
	}
	_ = h.queries.TouchUserSession(ctx, sess.ID)
	return &sess, 0, ""
}

func (h *InternalAuthHandler) establishSession(c *gin.Context, userID uuid.UUID) (*db.Tenant, error) {
	ctx := c.Request.Context()
	if claimSecret, err := c.Cookie(internalClaimCookieName); err == nil && claimSecret != "" {
		_ = h.tryClaimTenant(ctx, claimSecret, userID)
	}
	scope, err := h.ensureSessionScopeForUser(ctx, userID)
	if err != nil {
		return nil, err
	}

	refresh, err := randomToken(48)
	if err != nil {
		return nil, err
	}

	sessionTTL := 30 * 24 * time.Hour
	if h.cfg != nil && h.cfg.Auth.SessionTTLDays > 0 {
		sessionTTL = time.Duration(h.cfg.Auth.SessionTTLDays) * 24 * time.Hour
	}

	_, err = h.queries.CreateUserSession(ctx, db.CreateUserSessionParams{
		UserID:           userID,
		RefreshTokenHash: sha256Hex(refresh),
		ExpiresAt:        time.Now().Add(sessionTTL),
		IpAddress:        nil,
		UserAgent:        strPtr(c.Request.UserAgent()),
	})
	if err != nil {
		return nil, err
	}

	h.setCookie(c, internalSessionCookieName, refresh, time.Now().Add(sessionTTL))
	h.clearCookie(c, internalClaimCookieName)
	return &scope.Tenant, nil
}

type resolvedSessionScope struct {
	Tenant    db.Tenant
	Workspace db.Workspace
}

func (h *InternalAuthHandler) resolveSessionScope(ctx context.Context, userID uuid.UUID) (*resolvedSessionScope, error) {
	return h.ensureSessionScopeForUser(ctx, userID)
}

func (h *InternalAuthHandler) getOrCreateUser(ctx context.Context, emailAddr string) (*db.User, error) {
	existing, err := h.queries.GetUserByEmail(ctx, emailAddr)
	if err == nil {
		return &existing, nil
	}
	created, err := h.queries.CreateUser(ctx, emailAddr)
	if err != nil {
		existing, err2 := h.queries.GetUserByEmail(ctx, emailAddr)
		if err2 == nil {
			return &existing, nil
		}
		return nil, err
	}
	return &created, nil
}

func (h *InternalAuthHandler) ensureSessionScopeForUser(ctx context.Context, userID uuid.UUID) (*resolvedSessionScope, error) {
	tenant, err := h.getOrCreateSharedInternalTenant(ctx)
	if err != nil {
		return nil, err
	}

	workspace, err := h.getOrCreatePersonalWorkspace(ctx, tenant.ID, userID)
	if err != nil {
		return nil, err
	}

	return &resolvedSessionScope{
		Tenant:    *tenant,
		Workspace: *workspace,
	}, nil
}

func (h *InternalAuthHandler) getOrCreateSharedInternalTenant(ctx context.Context) (*db.Tenant, error) {
	if cachedTenantID, ok := h.getCachedSharedInternalTenantID(ctx); ok {
		tenant, err := h.queries.GetTenant(ctx, cachedTenantID)
		if err == nil && tenant.TenantKind == "internal" {
			return &tenant, nil
		}
		h.clearCachedSharedInternalTenantID(ctx)
	}

	tenant, err := h.queries.GetSharedInternalTenantByName(ctx, sharedFirstPartyTenantName)
	if err == nil {
		h.setCachedSharedInternalTenantID(ctx, tenant.ID)
		return &tenant, nil
	}

	created, createErr := h.createInternalTenant(ctx, nil, sharedFirstPartyTenantName)
	if createErr == nil && created != nil {
		h.setCachedSharedInternalTenantID(ctx, created.ID)
		return created, nil
	}

	tenant, err = h.queries.GetSharedInternalTenantByName(ctx, sharedFirstPartyTenantName)
	if err != nil {
		if createErr != nil {
			return nil, createErr
		}
		return nil, err
	}
	h.setCachedSharedInternalTenantID(ctx, tenant.ID)
	return &tenant, nil
}

func (h *InternalAuthHandler) getOrCreatePersonalWorkspace(ctx context.Context, tenantID, userID uuid.UUID) (*db.Workspace, error) {
	if cachedWorkspaceID, ok := h.getCachedWorkspaceByOwner(ctx, userID); ok {
		workspace, err := h.queries.GetWorkspace(ctx, cachedWorkspaceID)
		if err == nil && workspace.TenantID == tenantID {
			_, _ = h.queries.CreateWorkspaceMembership(ctx, db.CreateWorkspaceMembershipParams{
				WorkspaceID: workspace.ID,
				UserID:      userID,
				Role:        "owner",
			})
			return &workspace, nil
		}
		h.clearCachedWorkspaceByOwner(ctx, userID)
	}

	workspace, err := h.queries.GetWorkspaceByTenantAndOwner(ctx, db.GetWorkspaceByTenantAndOwnerParams{
		TenantID:    tenantID,
		OwnerUserID: pgUUID(userID),
		Kind:        personalWorkspaceKind,
	})
	if err == nil {
		h.setCachedWorkspaceByOwner(ctx, userID, workspace.ID)
		_, _ = h.queries.CreateWorkspaceMembership(ctx, db.CreateWorkspaceMembershipParams{
			WorkspaceID: workspace.ID,
			UserID:      userID,
			Role:        "owner",
		})
		return &workspace, nil
	}

	created, createErr := h.queries.CreateWorkspace(ctx, db.CreateWorkspaceParams{
		TenantID:    tenantID,
		OwnerUserID: pgUUID(userID),
		Name:        personalWorkspaceName,
		Kind:        personalWorkspaceKind,
	})
	if createErr != nil {
		workspace, err = h.queries.GetWorkspaceByTenantAndOwner(ctx, db.GetWorkspaceByTenantAndOwnerParams{
			TenantID:    tenantID,
			OwnerUserID: pgUUID(userID),
			Kind:        personalWorkspaceKind,
		})
		if err != nil {
			return nil, createErr
		}
		created = workspace
	}

	_, _ = h.queries.CreateWorkspaceMembership(ctx, db.CreateWorkspaceMembershipParams{
		WorkspaceID: created.ID,
		UserID:      userID,
		Role:        "owner",
	})
	h.setCachedWorkspaceByOwner(ctx, userID, created.ID)
	return &created, nil
}

func (h *InternalAuthHandler) createInternalTenant(ctx context.Context, ownerUserID *uuid.UUID, name string) (*db.Tenant, error) {
	apiKey, apiKeyHash, err := h.apiKeySvc.GenerateAPIKey(false)
	if err != nil {
		return nil, err
	}
	_ = apiKey

	tenantCfg := []byte(`{"force_recording":true,"recording_retention_days":7,"allow_early_join":true,"transcription_enabled":true}`)
	var claimedAt *time.Time
	if ownerUserID != nil {
		now := time.Now()
		claimedAt = &now
	}

	tenant, err := h.queries.CreateInternalTenant(ctx, db.CreateInternalTenantParams{
		Name:                        name,
		ApiKeyHash:                  apiKeyHash,
		Config:                      []byte("{}"),
		MaxConcurrentRooms:          100,
		MaxParticipantsPerRoom:      10,
		MaxRecordingDurationMinutes: 120,
		OwnerUserID:                 pgUUIDPtr(ownerUserID),
		ClaimedAt:                   pgTimestamptzPtr(claimedAt),
		TenantConfig:                tenantCfg,
	})
	if err != nil {
		return nil, err
	}
	return &tenant, nil
}

func (h *InternalAuthHandler) createInternalTenantWithClaim(ctx context.Context) (*db.Tenant, string, error) {
	tenant, err := h.createInternalTenant(ctx, nil, "Chalk")
	if err != nil {
		return nil, "", err
	}
	secret, err := randomToken(32)
	if err != nil {
		return nil, "", err
	}
	_, err = h.queries.CreateTenantClaim(ctx, db.CreateTenantClaimParams{
		TenantID:   tenant.ID,
		SecretHash: sha256Hex(secret),
		ExpiresAt:  time.Now().Add(7 * 24 * time.Hour),
	})
	if err != nil {
		return nil, "", err
	}
	return tenant, secret, nil
}

func (h *InternalAuthHandler) tryClaimTenant(ctx context.Context, claimSecret string, userID uuid.UUID) bool {
	claim, err := h.queries.GetTenantClaimBySecretHash(ctx, sha256Hex(claimSecret))
	if err != nil {
		return false
	}
	_, err = h.queries.BindInternalTenantToOwner(ctx, db.BindInternalTenantToOwnerParams{
		ID:          claim.TenantID,
		OwnerUserID: pgUUID(userID),
	})
	if err != nil {
		return false
	}
	_, _ = h.queries.MarkTenantClaimUsed(ctx, claim.ID)
	return true
}

func (h *InternalAuthHandler) setCookie(c *gin.Context, name, value string, expiresAt time.Time) {
	secure := h.cookieSecure(c.Request)
	c.SetSameSite(h.cookieSameSite(c.Request))
	c.SetCookie(name, value, int(time.Until(expiresAt).Seconds()), "/", h.cookieDomain(c.Request), secure, true)
}

func (h *InternalAuthHandler) clearCookie(c *gin.Context, name string) {
	secure := h.cookieSecure(c.Request)
	c.SetSameSite(h.cookieSameSite(c.Request))
	c.SetCookie(name, "", -1, "/", h.cookieDomain(c.Request), secure, true)
}

func (h *InternalAuthHandler) cookieDomain(r *http.Request) string {
	if isLocalRequest(r) {
		return ""
	}
	if h.cfg == nil {
		return ""
	}
	return h.cfg.Auth.CookieDomain
}

func (h *InternalAuthHandler) cookieSecure(r *http.Request) bool {
	if isLocalRequest(r) {
		return false
	}
	return h.cfg != nil && h.cfg.Server.Env == "production"
}

func (h *InternalAuthHandler) cookieSameSite(r *http.Request) http.SameSite {
	if h.cookieSecure(r) {
		return http.SameSiteNoneMode
	}
	return http.SameSiteLaxMode
}

func (h *InternalAuthHandler) googleClientID() string {
	if h.cfg == nil {
		return ""
	}
	return strings.TrimSpace(h.cfg.Auth.GoogleClientID)
}

func (h *InternalAuthHandler) googleClientSecret() string {
	if h.cfg == nil {
		return ""
	}
	return strings.TrimSpace(h.cfg.Auth.GoogleClientSecret)
}

func sharedInternalTenantRedisKey() string {
	return "internal_auth:shared_tenant:v1"
}

func workspaceByOwnerRedisKey(ownerUserID uuid.UUID) string {
	return "internal_auth:workspace_by_owner:v1:" + ownerUserID.String()
}

func (h *InternalAuthHandler) getCachedSharedInternalTenantID(ctx context.Context) (uuid.UUID, bool) {
	if h.redis == nil {
		return uuid.Nil, false
	}
	value, err := h.redis.Get(ctx, sharedInternalTenantRedisKey())
	if err != nil || value == "" {
		return uuid.Nil, false
	}
	tenantID, parseErr := uuid.Parse(value)
	if parseErr != nil {
		_ = h.redis.Del(ctx, sharedInternalTenantRedisKey())
		return uuid.Nil, false
	}
	return tenantID, true
}

func (h *InternalAuthHandler) setCachedSharedInternalTenantID(ctx context.Context, tenantID uuid.UUID) {
	if h.redis == nil {
		return
	}
	_ = h.redis.Set(ctx, sharedInternalTenantRedisKey(), tenantID.String(), internalTenantCacheTTL)
}

func (h *InternalAuthHandler) clearCachedSharedInternalTenantID(ctx context.Context) {
	if h.redis == nil {
		return
	}
	_ = h.redis.Del(ctx, sharedInternalTenantRedisKey())
}

func (h *InternalAuthHandler) getCachedWorkspaceByOwner(ctx context.Context, ownerUserID uuid.UUID) (uuid.UUID, bool) {
	if h.redis == nil {
		return uuid.Nil, false
	}
	value, err := h.redis.Get(ctx, workspaceByOwnerRedisKey(ownerUserID))
	if err != nil || value == "" {
		return uuid.Nil, false
	}
	workspaceID, parseErr := uuid.Parse(value)
	if parseErr != nil {
		_ = h.redis.Del(ctx, workspaceByOwnerRedisKey(ownerUserID))
		return uuid.Nil, false
	}
	return workspaceID, true
}

func (h *InternalAuthHandler) setCachedWorkspaceByOwner(ctx context.Context, ownerUserID, workspaceID uuid.UUID) {
	if h.redis == nil {
		return
	}
	_ = h.redis.Set(ctx, workspaceByOwnerRedisKey(ownerUserID), workspaceID.String(), internalTenantCacheTTL)
}

func (h *InternalAuthHandler) clearCachedWorkspaceByOwner(ctx context.Context, ownerUserID uuid.UUID) {
	if h.redis == nil {
		return
	}
	_ = h.redis.Del(ctx, workspaceByOwnerRedisKey(ownerUserID))
}

func localClientTenantRedisKey(clientID string) string {
	return "internal_auth:local_client:v1:" + clientID
}

func localClientBootstrapKey(r *http.Request, clientID string) string {
	if isLocalRequest(r) {
		return localLoopbackClientID
	}
	return clientID
}

func (h *InternalAuthHandler) getCachedLocalClientTenant(ctx context.Context, r *http.Request, clientID string) (*localClientTenantBootstrap, bool) {
	if h.redis == nil || clientID == "" || !isLocalRequest(r) {
		return nil, false
	}
	payload, err := h.redis.Get(ctx, localClientTenantRedisKey(clientID))
	if err != nil || payload == "" {
		return nil, false
	}
	var bootstrap localClientTenantBootstrap
	if err := json.Unmarshal([]byte(payload), &bootstrap); err != nil {
		_ = h.redis.Del(ctx, localClientTenantRedisKey(clientID))
		return nil, false
	}
	if bootstrap.TenantID == uuid.Nil || strings.TrimSpace(bootstrap.ClaimSecret) == "" {
		_ = h.redis.Del(ctx, localClientTenantRedisKey(clientID))
		return nil, false
	}
	return &bootstrap, true
}

func (h *InternalAuthHandler) setCachedLocalClientTenant(ctx context.Context, r *http.Request, clientID string, tenantID uuid.UUID, claimSecret string) {
	if h.redis == nil || clientID == "" || claimSecret == "" || !isLocalRequest(r) {
		return
	}
	payload, err := json.Marshal(localClientTenantBootstrap{TenantID: tenantID, ClaimSecret: claimSecret})
	if err != nil {
		return
	}
	_ = h.redis.Set(ctx, localClientTenantRedisKey(clientID), string(payload), localClientTenantTTL)
}

func isGoogleIssuer(issuer string) bool {
	normalized := strings.TrimSpace(issuer)
	return normalized == "https://accounts.google.com" || normalized == "accounts.google.com"
}

func claimString(claims map[string]interface{}, key string) (string, bool) {
	if claims == nil {
		return "", false
	}
	value, ok := claims[key]
	if !ok {
		return "", false
	}
	text, ok := value.(string)
	if !ok {
		return "", false
	}
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return "", false
	}
	return trimmed, true
}

func claimBool(claims map[string]interface{}, key string) bool {
	if claims == nil {
		return false
	}
	value, ok := claims[key]
	if !ok {
		return false
	}
	switch typed := value.(type) {
	case bool:
		return typed
	case string:
		return strings.EqualFold(strings.TrimSpace(typed), "true")
	default:
		return false
	}
}

func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

func randomToken(bytesLen int) (string, error) {
	b := make([]byte, bytesLen)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func strPtr(s string) *string { return &s }

func isLocalHostForInternalAuth(host string) bool {
	normalizedHost := strings.ToLower(strings.TrimSpace(host))
	if normalizedHost == "" {
		return false
	}
	if normalizedHost == "localhost" || strings.HasSuffix(normalizedHost, ".localhost") {
		return true
	}
	ip := net.ParseIP(normalizedHost)
	return ip != nil && ip.IsLoopback()
}

func isLocalMagicLinkHost(host string) bool {
	return isLocalHostForInternalAuth(host)
}

func isLocalRequest(r *http.Request) bool {
	if r == nil {
		return false
	}
	host := strings.TrimSpace(r.Header.Get("X-Forwarded-Host"))
	if host == "" {
		host = strings.TrimSpace(r.Host)
	}
	if host == "" {
		return false
	}
	parsedHost := host
	if strings.Contains(host, "://") {
		if parsed, err := url.Parse(host); err == nil {
			parsedHost = parsed.Host
		}
	}
	hostname := parsedHost
	if value, _, err := net.SplitHostPort(parsedHost); err == nil {
		hostname = value
	}
	hostname = strings.Trim(hostname, "[]")
	return isLocalHostForInternalAuth(hostname)
}

func requestOrigin(r *http.Request) string {
	scheme := strings.TrimSpace(r.Header.Get("X-Forwarded-Proto"))
	if scheme == "" {
		if r.TLS != nil {
			scheme = "https"
		} else {
			scheme = "http"
		}
	}
	host := strings.TrimSpace(r.Header.Get("X-Forwarded-Host"))
	if host == "" {
		host = strings.TrimSpace(r.Host)
	}
	return scheme + "://" + host
}

func pgUUID(id uuid.UUID) pgtype.UUID {
	return pgtype.UUID{Bytes: id, Valid: true}
}

func pgUUIDPtr(id *uuid.UUID) pgtype.UUID {
	if id == nil {
		return pgtype.UUID{}
	}
	return pgUUID(*id)
}

func pgTimestamptzPtr(t *time.Time) pgtype.Timestamptz {
	if t == nil {
		return pgtype.Timestamptz{}
	}
	return pgtype.Timestamptz{Time: *t, Valid: true}
}
