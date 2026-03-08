package handlers

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"net"
	"net/http"
	"net/mail"
	"net/url"
	"strings"
	"time"

	"github.com/Q9Labs/chalk/internal/config"
	domainAuth "github.com/Q9Labs/chalk/internal/domain/auth"
	"github.com/Q9Labs/chalk/internal/infrastructure/auth"
	"github.com/Q9Labs/chalk/internal/infrastructure/email"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
)

const (
	internalSessionCookieName = "chalk_session"
	internalClaimCookieName   = "chalk_claim"
	internalTenantCacheTTL    = 5 * time.Minute
)

type internalAuthQueries interface {
	CreateInternalTenant(ctx context.Context, arg db.CreateInternalTenantParams) (db.Tenant, error)
	CreateTenantClaim(ctx context.Context, arg db.CreateTenantClaimParams) (db.TenantClaim, error)
	CreateUser(ctx context.Context, email string) (db.User, error)
	CreateUserSession(ctx context.Context, arg db.CreateUserSessionParams) (db.UserSession, error)
	GetInternalTenantByOwnerUserID(ctx context.Context, ownerUserID pgtype.UUID) (db.Tenant, error)
	GetTenantClaimBySecretHash(ctx context.Context, secretHash string) (db.TenantClaim, error)
	GetUserByEmail(ctx context.Context, lower string) (db.User, error)
	GetUserSessionByRefreshTokenHash(ctx context.Context, refreshTokenHash string) (db.UserSession, error)
	BindInternalTenantToOwner(ctx context.Context, arg db.BindInternalTenantToOwnerParams) (db.Tenant, error)
	MarkTenantClaimUsed(ctx context.Context, id uuid.UUID) (db.TenantClaim, error)
	TouchUserSession(ctx context.Context, id uuid.UUID) error
}

type internalAuthCache interface {
	Set(ctx context.Context, key string, value interface{}, expiration time.Duration) error
	Get(ctx context.Context, key string) (string, error)
	Del(ctx context.Context, keys ...string) error
}

type InternalAuthHandler struct {
	cfg          *config.Config
	queries      internalAuthQueries
	jwtService   *auth.JWTService
	apiKeySvc    *auth.APIKeyService
	redis        internalAuthCache
	resendClient *email.ResendClient
}

func NewInternalAuthHandler(
	cfg *config.Config,
	queries internalAuthQueries,
	jwtService *auth.JWTService,
	apiKeySvc *auth.APIKeyService,
	redisClient internalAuthCache,
) *InternalAuthHandler {
	var resendClient *email.ResendClient
	if cfg != nil && cfg.Auth.ResendAPIKey != "" && cfg.Auth.ResendFromEmail != "" {
		resendClient = email.NewResendClient(cfg.Auth.ResendAPIKey, cfg.Auth.ResendFromEmail)
	}

	return &InternalAuthHandler{
		cfg:          cfg,
		queries:      queries,
		jwtService:   jwtService,
		apiKeySvc:    apiKeySvc,
		redis:        redisClient,
		resendClient: resendClient,
	}
}

type startInternalAuthRequest struct {
	Email       string `json:"email" binding:"required"`
	CallbackURL string `json:"callback_url"`
}

// POST /api/v1/internal/auth/start
func (h *InternalAuthHandler) Start(c *gin.Context) {
	var req startInternalAuthRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	emailAddr := strings.ToLower(strings.TrimSpace(req.Email))
	if _, err := mail.ParseAddress(emailAddr); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid email"})
		return
	}

	if h.redis == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "redis not configured"})
		return
	}
	if h.resendClient == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "email provider not configured"})
		return
	}

	magicToken, err := randomToken(32)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to generate token"})
		return
	}

	ttl := 15 * time.Minute
	if h.cfg != nil && h.cfg.Auth.MagicLinkTTLMinutes > 0 {
		ttl = time.Duration(h.cfg.Auth.MagicLinkTTLMinutes) * time.Minute
	}

	key := magicLinkRedisKey(magicToken)
	if err := h.redis.Set(c.Request.Context(), key, emailAddr, ttl); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to store token"})
		return
	}

	callbackURL := h.resolveMagicLinkCallbackURL(req.CallbackURL)
	link := h.buildMagicLinkVerificationURL(c, magicToken, callbackURL)

	if err := h.resendClient.SendMagicLink(c.Request.Context(), emailAddr, link); err != nil {
		_ = h.redis.Del(c.Request.Context(), key)
		c.JSON(http.StatusBadGateway, gin.H{"error": "failed to send email"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"ok": true})
}

type verifyInternalAuthRequest struct {
	Token string `json:"token" binding:"required"`
}

// POST /api/v1/internal/auth/verify
func (h *InternalAuthHandler) Verify(c *gin.Context) {
	if c.Request.Method == http.MethodGet {
		h.verifyBrowserRedirect(c)
		return
	}

	var req verifyInternalAuthRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	tenant, status, message := h.completeMagicLinkVerification(c, req.Token)
	if status != 0 {
		c.JSON(status, gin.H{"error": message})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"ok":        true,
		"tenant_id": tenant.ID,
	})
}

func (h *InternalAuthHandler) verifyBrowserRedirect(c *gin.Context) {
	token := strings.TrimSpace(c.Query("token"))
	callbackURL := h.resolveMagicLinkCallbackURL(c.Query("callback_url"))

	if token == "" {
		c.Redirect(http.StatusSeeOther, appendURLQuery(callbackURL, "error", "Missing token"))
		return
	}

	_, status, message := h.completeMagicLinkVerification(c, token)
	if status != 0 {
		c.Redirect(http.StatusSeeOther, appendURLQuery(callbackURL, "error", message))
		return
	}

	c.Redirect(http.StatusSeeOther, callbackURL)
}

func (h *InternalAuthHandler) completeMagicLinkVerification(c *gin.Context, token string) (*db.Tenant, int, string) {
	if h.redis == nil {
		return nil, http.StatusInternalServerError, "redis not configured"
	}

	key := magicLinkRedisKey(token)
	emailAddr, err := h.redis.Get(c.Request.Context(), key)
	if err != nil || emailAddr == "" {
		return nil, http.StatusBadRequest, "invalid or expired token"
	}
	_ = h.redis.Del(c.Request.Context(), key) // single-use

	user, err := h.getOrCreateUser(c.Request.Context(), emailAddr)
	if err != nil {
		return nil, http.StatusInternalServerError, "failed to create user"
	}

	// If this browser has an unclaimed internal tenant, bind it to the user.
	if claimSecret, err := c.Cookie(internalClaimCookieName); err == nil && claimSecret != "" {
		_ = h.tryClaimTenant(c.Request.Context(), claimSecret, user.ID)
	}

	// Ensure user has a workspace tenant (hard 1:1 enforced in DB for internal).
	tenant, err := h.ensureInternalTenantForUser(c.Request.Context(), user.ID)
	if err != nil || tenant == nil {
		return nil, http.StatusInternalServerError, "failed to resolve tenant"
	}

	refresh, err := randomToken(48)
	if err != nil {
		return nil, http.StatusInternalServerError, "failed to create session"
	}

	sessionTTL := 30 * 24 * time.Hour
	if h.cfg != nil && h.cfg.Auth.SessionTTLDays > 0 {
		sessionTTL = time.Duration(h.cfg.Auth.SessionTTLDays) * 24 * time.Hour
	}

	_, err = h.queries.CreateUserSession(c.Request.Context(), db.CreateUserSessionParams{
		UserID:           user.ID,
		RefreshTokenHash: sha256Hex(refresh),
		ExpiresAt:        time.Now().Add(sessionTTL),
		IpAddress:        nil,
		UserAgent:        strPtr(c.Request.UserAgent()),
	})
	if err != nil {
		return nil, http.StatusInternalServerError, "failed to create session"
	}

	h.setCookie(c, internalSessionCookieName, refresh, time.Now().Add(sessionTTL))
	// Clear claim cookie after successful login.
	h.clearCookie(c, internalClaimCookieName)

	return tenant, 0, ""
}

// GET /api/v1/internal/auth/access-token
// Mints a tenant-scoped Chalk JWT based on either:
// - user session cookie (email login), or
// - internal tenant claim cookie (pre-login)
func (h *InternalAuthHandler) AccessToken(c *gin.Context) {
	ctx := c.Request.Context()

	var tenantID uuid.UUID
	var subject string

	// 1) Session cookie (logged in)
	if sessionToken, err := c.Cookie(internalSessionCookieName); err == nil && sessionToken != "" {
		sess, err := h.queries.GetUserSessionByRefreshTokenHash(ctx, sha256Hex(sessionToken))
		if err == nil {
			_ = h.queries.TouchUserSession(ctx, sess.ID)
			subject = sess.UserID.String()

			if cachedTenantID, ok := h.getCachedInternalTenantByOwner(ctx, sess.UserID); ok {
				tenantID = cachedTenantID
			} else {
				t, err := h.queries.GetInternalTenantByOwnerUserID(ctx, pgUUID(sess.UserID))
				if err != nil {
					created, err := h.createInternalTenant(ctx, &sess.UserID)
					if err != nil || created == nil {
						c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create tenant"})
						return
					}
					tenantID = created.ID
				} else {
					tenantID = t.ID
					h.setCachedInternalTenantByOwner(ctx, sess.UserID, t.ID)
				}
			}
		}
	}

	// 2) Claim cookie (pre-login)
	if tenantID == uuid.Nil {
		if claimSecret, err := c.Cookie(internalClaimCookieName); err == nil && claimSecret != "" {
			claim, err := h.queries.GetTenantClaimBySecretHash(ctx, sha256Hex(claimSecret))
			if err == nil {
				tenantID = claim.TenantID
				subject = "claim:" + claim.ID.String()
			}
		}
	}

	// 3) No session/claim yet: create a temporary internal tenant + claim cookie.
	if tenantID == uuid.Nil {
		tenant, claimSecret, err := h.createInternalTenantWithClaim(ctx)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to initialize workspace"})
			return
		}
		tenantID = tenant.ID
		subject = "claim:" + tenant.ID.String()

		h.setCookie(c, internalClaimCookieName, claimSecret, time.Now().Add(7*24*time.Hour))
	}

	claims := domainAuth.Claims{
		Subject:     subject,
		TenantID:    tenantID,
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

func (h *InternalAuthHandler) getOrCreateUser(ctx context.Context, emailAddr string) (*db.User, error) {
	existing, err := h.queries.GetUserByEmail(ctx, emailAddr)
	if err == nil {
		return &existing, nil
	}

	created, err := h.queries.CreateUser(ctx, emailAddr)
	if err != nil {
		// Race: user was created concurrently.
		existing, err2 := h.queries.GetUserByEmail(ctx, emailAddr)
		if err2 == nil {
			return &existing, nil
		}
		return nil, err
	}
	return &created, nil
}

func (h *InternalAuthHandler) ensureInternalTenantForUser(ctx context.Context, userID uuid.UUID) (*db.Tenant, error) {
	tenant, err := h.queries.GetInternalTenantByOwnerUserID(ctx, pgUUID(userID))
	if err == nil {
		return &tenant, nil
	}
	return h.createInternalTenant(ctx, &userID)
}

func (h *InternalAuthHandler) createInternalTenant(ctx context.Context, ownerUserID *uuid.UUID) (*db.Tenant, error) {
	apiKey, apiKeyHash, err := h.apiKeySvc.GenerateAPIKey(false)
	if err != nil {
		return nil, err
	}
	_ = apiKey // internal tenants should never return/share plaintext keys

	tenantCfg := []byte(`{"force_recording":true,"recording_retention_days":7,"allow_early_join":true,"transcription_enabled":true}`)

	var claimedAt *time.Time
	if ownerUserID != nil {
		now := time.Now()
		claimedAt = &now
	}

	tenant, err := h.queries.CreateInternalTenant(ctx, db.CreateInternalTenantParams{
		Name:                        "Chalk",
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
	if ownerUserID != nil {
		h.setCachedInternalTenantByOwner(ctx, *ownerUserID, tenant.ID)
	}
	return &tenant, nil
}

func (h *InternalAuthHandler) createInternalTenantWithClaim(ctx context.Context) (*db.Tenant, string, error) {
	tenant, err := h.createInternalTenant(ctx, nil)
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
		// Either already claimed or not internal
		return false
	}

	h.setCachedInternalTenantByOwner(ctx, userID, claim.TenantID)
	_, _ = h.queries.MarkTenantClaimUsed(ctx, claim.ID)
	return true
}

func (h *InternalAuthHandler) setCookie(c *gin.Context, name, value string, expiresAt time.Time) {
	secure := h.cookieSecure()
	c.SetSameSite(h.cookieSameSite())
	c.SetCookie(
		name,
		value,
		int(time.Until(expiresAt).Seconds()),
		"/",
		h.cookieDomain(),
		secure,
		true, // httpOnly
	)
}

func (h *InternalAuthHandler) clearCookie(c *gin.Context, name string) {
	secure := h.cookieSecure()
	c.SetSameSite(h.cookieSameSite())
	c.SetCookie(name, "", -1, "/", h.cookieDomain(), secure, true)
}

func (h *InternalAuthHandler) cookieDomain() string {
	if h.cfg == nil {
		return ""
	}
	return h.cfg.Auth.CookieDomain
}

func (h *InternalAuthHandler) cookieSecure() bool {
	return h.cfg != nil && h.cfg.Server.Env == "production"
}

func (h *InternalAuthHandler) cookieSameSite() http.SameSite {
	if h.cookieSecure() {
		return http.SameSiteNoneMode
	}
	return http.SameSiteLaxMode
}

func internalTenantByOwnerRedisKey(ownerUserID uuid.UUID) string {
	return "internal_auth:tenant_by_owner:v1:" + ownerUserID.String()
}

func (h *InternalAuthHandler) getCachedInternalTenantByOwner(ctx context.Context, ownerUserID uuid.UUID) (uuid.UUID, bool) {
	if h.redis == nil {
		return uuid.Nil, false
	}

	value, err := h.redis.Get(ctx, internalTenantByOwnerRedisKey(ownerUserID))
	if err != nil || value == "" {
		return uuid.Nil, false
	}

	tenantID, parseErr := uuid.Parse(value)
	if parseErr != nil {
		_ = h.redis.Del(ctx, internalTenantByOwnerRedisKey(ownerUserID))
		return uuid.Nil, false
	}

	return tenantID, true
}

func (h *InternalAuthHandler) setCachedInternalTenantByOwner(ctx context.Context, ownerUserID, tenantID uuid.UUID) {
	if h.redis == nil {
		return
	}
	_ = h.redis.Set(ctx, internalTenantByOwnerRedisKey(ownerUserID), tenantID.String(), internalTenantCacheTTL)
}

func magicLinkRedisKey(token string) string {
	return "internal_auth:magic:" + sha256Hex(token)
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
	// url-safe, no padding
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func strPtr(s string) *string { return &s }

func (h *InternalAuthHandler) resolveMagicLinkCallbackURL(requestedCallbackURL string) string {
	appURL := h.resolveMagicLinkAppURL(requestedCallbackURL)
	defaultCallbackURL := appURL + "/dashboard"

	trimmed := strings.TrimSpace(requestedCallbackURL)
	if trimmed == "" {
		return defaultCallbackURL
	}

	parsed, err := url.Parse(trimmed)
	if err != nil {
		return defaultCallbackURL
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return defaultCallbackURL
	}
	if parsed.Host == "" {
		return defaultCallbackURL
	}

	origin := parsed.Scheme + "://" + parsed.Host
	if !h.isAllowedMagicLinkOrigin(origin) {
		return defaultCallbackURL
	}

	parsed.User = nil
	parsed.Fragment = ""
	if strings.TrimSpace(parsed.Path) == "" || parsed.Path == "/" {
		parsed.Path = "/dashboard"
	}

	return parsed.String()
}

func (h *InternalAuthHandler) buildMagicLinkVerificationURL(c *gin.Context, token, callbackURL string) string {
	verifyURL := requestOrigin(c.Request) + "/api/v1/internal/auth/verify"
	verifyURL = appendURLQuery(verifyURL, "token", token)
	return appendURLQuery(verifyURL, "callback_url", callbackURL)
}

func (h *InternalAuthHandler) resolveMagicLinkAppURL(requestedCallbackURL string) string {
	defaultAppURL := "http://localhost:3070"
	if h.cfg != nil && h.cfg.Auth.InternalAppURL != "" {
		defaultAppURL = strings.TrimRight(h.cfg.Auth.InternalAppURL, "/")
	}

	requestedOrigin, ok := normalizedOrigin(requestedCallbackURL)
	if !ok {
		return defaultAppURL
	}
	if !h.isAllowedMagicLinkOrigin(requestedOrigin) {
		return defaultAppURL
	}
	return requestedOrigin
}

func (h *InternalAuthHandler) isAllowedMagicLinkOrigin(origin string) bool {
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

	return isLocalMagicLinkHost(parsed.Hostname())
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

func isLocalMagicLinkHost(host string) bool {
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

func appendURLQuery(rawURL, key, value string) string {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return rawURL
	}

	query := parsed.Query()
	query.Set(key, value)
	parsed.RawQuery = query.Encode()
	return parsed.String()
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
