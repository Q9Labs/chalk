package handlers

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"net/http"
	"net/mail"
	"strings"
	"time"

	"github.com/Q9Labs/chalk/internal/config"
	domainAuth "github.com/Q9Labs/chalk/internal/domain/auth"
	"github.com/Q9Labs/chalk/internal/infrastructure/auth"
	"github.com/Q9Labs/chalk/internal/infrastructure/email"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	"github.com/Q9Labs/chalk/internal/infrastructure/redis"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
)

const (
	internalSessionCookieName = "chalk_session"
	internalClaimCookieName   = "chalk_claim"
)

type InternalAuthHandler struct {
	cfg          *config.Config
	queries      *db.Queries
	jwtService   *auth.JWTService
	apiKeySvc    *auth.APIKeyService
	redis        *redis.Client
	resendClient *email.ResendClient
}

func NewInternalAuthHandler(cfg *config.Config, queries *db.Queries, jwtService *auth.JWTService, apiKeySvc *auth.APIKeyService, redisClient *redis.Client) *InternalAuthHandler {
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
	Email string `json:"email" binding:"required"`
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

	appURL := "http://localhost:3070"
	if h.cfg != nil && h.cfg.Auth.InternalAppURL != "" {
		appURL = strings.TrimRight(h.cfg.Auth.InternalAppURL, "/")
	}
	link := appURL + "/auth/callback?token=" + magicToken

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
	var req verifyInternalAuthRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if h.redis == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "redis not configured"})
		return
	}

	key := magicLinkRedisKey(req.Token)
	emailAddr, err := h.redis.Get(c.Request.Context(), key)
	if err != nil || emailAddr == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid or expired token"})
		return
	}
	_ = h.redis.Del(c.Request.Context(), key) // single-use

	user, err := h.getOrCreateUser(c.Request.Context(), emailAddr)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create user"})
		return
	}

	// If this browser has an unclaimed internal tenant, bind it to the user.
	if claimSecret, err := c.Cookie(internalClaimCookieName); err == nil && claimSecret != "" {
		_ = h.tryClaimTenant(c.Request.Context(), claimSecret, user.ID)
	}

	// Ensure user has a workspace tenant (hard 1:1 enforced in DB for internal).
	tenant, err := h.ensureInternalTenantForUser(c.Request.Context(), user.ID)
	if err != nil || tenant == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to resolve tenant"})
		return
	}

	refresh, err := randomToken(48)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create session"})
		return
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
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create session"})
		return
	}

	h.setCookie(c, internalSessionCookieName, refresh, time.Now().Add(sessionTTL))
	// Clear claim cookie after successful login.
	h.clearCookie(c, internalClaimCookieName)

	c.JSON(http.StatusOK, gin.H{
		"ok":        true,
		"tenant_id": tenant.ID,
	})
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

	_, _ = h.queries.MarkTenantClaimUsed(ctx, claim.ID)
	return true
}

func (h *InternalAuthHandler) setCookie(c *gin.Context, name, value string, expiresAt time.Time) {
	secure := h.cfg != nil && h.cfg.Server.Env == "production"
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
	secure := h.cfg != nil && h.cfg.Server.Env == "production"
	c.SetCookie(name, "", -1, "/", h.cookieDomain(), secure, true)
}

func (h *InternalAuthHandler) cookieDomain() string {
	if h.cfg == nil {
		return ""
	}
	return h.cfg.Auth.CookieDomain
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
