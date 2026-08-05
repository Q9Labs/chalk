package authentication

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/mail"
	"net/url"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"golang.org/x/crypto/bcrypt"
)

const (
	ProviderPassword = "password"
	ProviderGoogle   = "google"

	MinPasswordLength = 8
	MaxPasswordBytes  = 72

	DefaultLoginTTL         = 30 * 24 * time.Hour
	DefaultOAuthStateTTL    = 10 * time.Minute
	authTokenByteCount      = 32
	googleReauthStatePrefix = "chalk-google-reauth-v1."
)

var (
	ErrInvalidEmail              = errors.New("invalid email")
	ErrInvalidPassword           = errors.New("invalid password")
	ErrInvalidUserName           = errors.New("invalid user name")
	ErrEmailAlreadyRegistered    = errors.New("email already registered")
	ErrEmailVerificationRequired = errors.New("email verification required")
	ErrInvalidCredentials        = errors.New("invalid credentials")
	ErrUnauthenticated           = errors.New("unauthenticated")
	ErrIdentityNotFound          = errors.New("identity not found")
	ErrUserNotFound              = errors.New("user not found")
	ErrSessionNotFound           = errors.New("session not found")
	ErrOAuthNotConfigured        = errors.New("oauth not configured")
	ErrOAuthStateNotFound        = errors.New("oauth state not found")
	ErrOAuthEmailConflict        = errors.New("oauth email conflict")
	ErrOAuthEmailNotVerified     = errors.New("oauth email not verified")
)

type User struct {
	ID        utilities.ID
	Name      string
	Email     string
	UpdatedAt time.Time
	CreatedAt time.Time
}

type Session struct {
	ID        utilities.ID
	UserID    utilities.ID
	TokenHash string
	UserAgent *string
	ExpiresAt time.Time
	RevokedAt *time.Time
	UpdatedAt time.Time
	CreatedAt time.Time
}

type PasswordIdentity struct {
	User         User
	PasswordHash string
}

type SessionUser struct {
	Session Session
	User    User
}

type RegisterInput struct {
	Name      string
	Email     string
	Password  string
	UserAgent *string
}

type LoginInput struct {
	Email     string
	Password  string
	UserAgent *string
}

type CreatePasswordUserInput struct {
	UserID       utilities.ID
	IdentityID   utilities.ID
	Name         string
	Email        string
	PasswordHash string
}

type CreateGoogleUserInput struct {
	UserID          utilities.ID
	IdentityID      utilities.ID
	Name            string
	Email           string
	ProviderSubject string
}

type CreateSessionInput struct {
	ID        utilities.ID
	UserID    utilities.ID
	TokenHash string
	UserAgent *string
	ExpiresAt time.Time
}

type AuthResult struct {
	SessionToken string
	ExpiresAt    time.Time
	User         User
}

type GoogleStart struct {
	AuthorizationURL string
}

type GoogleReauthenticationStart struct {
	AuthorizationURL string
	State            string
}

type ProviderChallenge struct {
	AccountID  utilities.ID
	Action     string
	ResourceID utilities.ID
}

type GoogleIdentity struct {
	Subject string
	Email   string
	Name    string
}

type Repository interface {
	CreatePasswordUser(ctx context.Context, input CreatePasswordUserInput) (User, error)
	CreateGoogleUser(ctx context.Context, input CreateGoogleUserInput) (User, error)
	GetPasswordIdentityByEmail(ctx context.Context, email string) (PasswordIdentity, error)
	GetUserByAuthIdentity(ctx context.Context, provider string, subject string) (User, error)
	GetUserByEmail(ctx context.Context, email string) (User, error)
	CreateSession(ctx context.Context, input CreateSessionInput) (Session, error)
	GetSessionByTokenHash(ctx context.Context, tokenHash string) (SessionUser, error)
	RevokeSession(ctx context.Context, sessionID utilities.ID, revokedAt time.Time) error
}

type PasswordHasher interface {
	HashPassword(password string) (string, error)
	ComparePassword(hash string, password string) error
}

type GoogleProvider interface {
	NewVerifier() string
	AuthCodeURL(state string, verifier string) string
	Authenticate(ctx context.Context, code string, verifier string) (GoogleIdentity, error)
}

// GoogleReauthenticationProvider keeps the OAuth redirect URI used to start a
// provider challenge identical to the URI sent during its code exchange.
// Existing GoogleProvider implementations remain valid for sign-in; the
// reauthentication flow requires this seam when its state carries a redirect.
type GoogleReauthenticationProvider interface {
	AuthCodeURLWithRedirect(state string, verifier string, redirectURL string) string
	AuthenticateWithRedirect(ctx context.Context, code string, verifier string, redirectURL string) (GoogleIdentity, error)
}

type OAuthStateStore interface {
	SaveOAuthState(ctx context.Context, state string, verifier string, ttl time.Duration) error
	LoadAndDeleteOAuthState(ctx context.Context, state string) (string, error)
}

type Config struct {
	SessionTTL                        time.Duration
	RequireEmailVerification          bool
	OAuthStateTTL                     time.Duration
	GoogleReauthenticationRedirectURL string
	Now                               func() time.Time
}

type Service struct {
	repository                        Repository
	passwords                         PasswordHasher
	google                            GoogleProvider
	oauthStates                       OAuthStateStore
	sessionTTL                        time.Duration
	requireEmailVerification          bool
	oauthStateTTL                     time.Duration
	googleReauthenticationRedirectURL string
	now                               func() time.Time
}

func NewService(repository Repository, passwords PasswordHasher, google GoogleProvider, oauthStates OAuthStateStore, cfg Config) Service {
	sessionTTL := cfg.SessionTTL
	if sessionTTL <= 0 {
		sessionTTL = DefaultLoginTTL
	}

	oauthStateTTL := cfg.OAuthStateTTL
	if oauthStateTTL <= 0 {
		oauthStateTTL = DefaultOAuthStateTTL
	}

	now := cfg.Now
	if now == nil {
		now = time.Now
	}

	return Service{
		repository:                        repository,
		passwords:                         passwords,
		google:                            google,
		oauthStates:                       oauthStates,
		sessionTTL:                        sessionTTL,
		requireEmailVerification:          cfg.RequireEmailVerification,
		oauthStateTTL:                     oauthStateTTL,
		googleReauthenticationRedirectURL: cfg.GoogleReauthenticationRedirectURL,
		now:                               now,
	}
}

func (s Service) Register(ctx context.Context, input RegisterInput) (AuthResult, error) {
	if s.requireEmailVerification {
		return AuthResult{}, ErrEmailVerificationRequired
	}

	name, err := utilities.RequiredString(input.Name)
	if err != nil {
		return AuthResult{}, ErrInvalidUserName
	}

	email, err := CanonicalEmail(input.Email)
	if err != nil {
		return AuthResult{}, err
	}

	password, err := PreparePassword(input.Password)
	if err != nil {
		return AuthResult{}, err
	}

	if s.passwords == nil {
		return AuthResult{}, fmt.Errorf("password hasher is not configured")
	}

	passwordHash, err := s.passwords.HashPassword(password)
	if err != nil {
		return AuthResult{}, fmt.Errorf("hash password: %w", err)
	}

	userID, err := utilities.NewID()
	if err != nil {
		return AuthResult{}, err
	}
	identityID, err := utilities.NewID()
	if err != nil {
		return AuthResult{}, err
	}

	user, err := s.repository.CreatePasswordUser(ctx, CreatePasswordUserInput{
		UserID:       userID,
		IdentityID:   identityID,
		Name:         name,
		Email:        email,
		PasswordHash: passwordHash,
	})
	if err != nil {
		return AuthResult{}, err
	}

	return s.createAuthResult(ctx, user, input.UserAgent)
}

func (s Service) Login(ctx context.Context, input LoginInput) (AuthResult, error) {
	email, err := CanonicalEmail(input.Email)
	if err != nil {
		return AuthResult{}, ErrInvalidCredentials
	}

	password, err := PreparePassword(input.Password)
	if err != nil {
		return AuthResult{}, ErrInvalidCredentials
	}

	identity, err := s.repository.GetPasswordIdentityByEmail(ctx, email)
	if errors.Is(err, ErrIdentityNotFound) {
		return AuthResult{}, ErrInvalidCredentials
	}
	if err != nil {
		return AuthResult{}, err
	}

	if s.passwords == nil {
		return AuthResult{}, fmt.Errorf("password hasher is not configured")
	}
	if err := s.passwords.ComparePassword(identity.PasswordHash, password); err != nil {
		if errors.Is(err, bcrypt.ErrMismatchedHashAndPassword) {
			return AuthResult{}, ErrInvalidCredentials
		}
		return AuthResult{}, err
	}

	return s.createAuthResult(ctx, identity.User, input.UserAgent)
}

// VerifyPassword re-checks the password for an already authenticated user.
// Callers must obtain the email from that authenticated principal; this
// method deliberately does not accept a user ID from an untrusted request.
func (s Service) VerifyPassword(ctx context.Context, email string, password string) error {
	canonicalEmail, err := CanonicalEmail(email)
	if err != nil {
		return ErrInvalidCredentials
	}
	preparedPassword, err := PreparePassword(password)
	if err != nil {
		return ErrInvalidCredentials
	}
	identity, err := s.repository.GetPasswordIdentityByEmail(ctx, canonicalEmail)
	if errors.Is(err, ErrIdentityNotFound) {
		return ErrInvalidCredentials
	}
	if err != nil {
		return err
	}
	if s.passwords == nil {
		return fmt.Errorf("password hasher is not configured")
	}
	if err := s.passwords.ComparePassword(identity.PasswordHash, preparedPassword); err != nil {
		if errors.Is(err, bcrypt.ErrMismatchedHashAndPassword) {
			return ErrInvalidCredentials
		}
		return err
	}
	return nil
}

// VerifyProvider validates a fresh provider assertion for the supplied
// Dashboard Account and exact recent-auth context. It deliberately does not
// create or rotate a login credential.
func (s Service) VerifyProvider(ctx context.Context, accountID utilities.ID, provider string, state string, code string, action string, resourceID utilities.ID) error {
	challenge, err := s.VerifyProviderChallenge(ctx, accountID, provider, state, code)
	if err != nil {
		return err
	}
	if challenge.Action != strings.TrimSpace(action) || challenge.ResourceID != resourceID {
		return ErrInvalidCredentials
	}
	return nil
}

// VerifyProviderChallenge consumes a single-use provider state and returns
// the server-bound recent-auth context stored with it.
func (s Service) VerifyProviderChallenge(ctx context.Context, accountID utilities.ID, provider string, state string, code string) (ProviderChallenge, error) {
	if strings.ToLower(strings.TrimSpace(provider)) != ProviderGoogle {
		return ProviderChallenge{}, ErrInvalidCredentials
	}
	challenge, err := s.verifyGoogleIdentity(ctx, accountID, state, code, true)
	if err != nil {
		return ProviderChallenge{}, err
	}
	return challenge, nil
}

// VerifyGoogleReauthentication consumes one OAuth state and requires the
// resulting Google identity to resolve to the currently authenticated Account.
// Provider and repository failures are returned unchanged so infrastructure
// failures cannot be mistaken for a rejected user credential.
func (s Service) VerifyGoogleReauthentication(ctx context.Context, accountID utilities.ID, state string, code string) error {
	_, err := s.verifyGoogleIdentity(ctx, accountID, state, code, false)
	return err
}

func (s Service) verifyGoogleIdentity(ctx context.Context, accountID utilities.ID, state string, code string, requireBoundContext bool) (ProviderChallenge, error) {
	if accountID.IsZero() {
		return ProviderChallenge{}, ErrInvalidCredentials
	}
	if s.google == nil || s.oauthStates == nil {
		return ProviderChallenge{}, ErrOAuthNotConfigured
	}
	state = strings.TrimSpace(state)
	code = strings.TrimSpace(code)
	if state == "" || code == "" {
		return ProviderChallenge{}, ErrInvalidCredentials
	}

	stored, err := s.oauthStates.LoadAndDeleteOAuthState(ctx, state)
	if errors.Is(err, ErrOAuthStateNotFound) {
		return ProviderChallenge{}, ErrInvalidCredentials
	}
	if err != nil {
		return ProviderChallenge{}, err
	}
	challenge, verifier, redirectURL, err := decodeGoogleReauthenticationState(stored)
	if err != nil {
		return ProviderChallenge{}, ErrInvalidCredentials
	}
	if requireBoundContext && (challenge.AccountID.IsZero() || challenge.AccountID.String() != accountID.String() || challenge.Action == "") {
		return ProviderChallenge{}, ErrInvalidCredentials
	}
	if !challenge.AccountID.IsZero() && challenge.AccountID.String() != accountID.String() {
		return ProviderChallenge{}, ErrInvalidCredentials
	}

	identity, err := s.authenticateGoogleReauthentication(ctx, code, verifier, redirectURL)
	if errors.Is(err, ErrOAuthEmailNotVerified) {
		return ProviderChallenge{}, ErrInvalidCredentials
	}
	if err != nil {
		return ProviderChallenge{}, err
	}

	subject := strings.TrimSpace(identity.Subject)
	if subject == "" {
		return ProviderChallenge{}, ErrInvalidCredentials
	}
	user, err := s.repository.GetUserByAuthIdentity(ctx, ProviderGoogle, subject)
	if errors.Is(err, ErrIdentityNotFound) {
		return ProviderChallenge{}, ErrInvalidCredentials
	}
	if err != nil {
		return ProviderChallenge{}, err
	}
	if user.ID != accountID {
		return ProviderChallenge{}, ErrInvalidCredentials
	}
	return challenge, nil
}

// StartGoogleReauthentication creates an OAuth challenge whose state stores
// the Account, action, and resource on the server alongside the PKCE verifier.
func (s Service) StartGoogleReauthentication(ctx context.Context, accountID utilities.ID, action string, resourceID utilities.ID) (GoogleReauthenticationStart, error) {
	if accountID.IsZero() || strings.TrimSpace(action) == "" || len([]byte(strings.TrimSpace(action))) > 64 {
		return GoogleReauthenticationStart{}, ErrInvalidCredentials
	}
	if s.google == nil || s.oauthStates == nil {
		return GoogleReauthenticationStart{}, ErrOAuthNotConfigured
	}
	state, err := randomURLToken(authTokenByteCount)
	if err != nil {
		return GoogleReauthenticationStart{}, err
	}
	verifier := s.google.NewVerifier()
	authorizationURL, redirectURL, err := s.googleReauthenticationURL(state, verifier)
	if err != nil {
		return GoogleReauthenticationStart{}, err
	}
	stored, err := encodeGoogleReauthenticationState(googleReauthenticationState{
		AccountID:   accountID.String(),
		Action:      strings.TrimSpace(action),
		ResourceID:  resourceString(resourceID),
		Verifier:    verifier,
		RedirectURL: redirectURL,
	})
	if err != nil {
		return GoogleReauthenticationStart{}, err
	}
	if err := s.oauthStates.SaveOAuthState(ctx, state, stored, s.oauthStateTTL); err != nil {
		return GoogleReauthenticationStart{}, err
	}
	return GoogleReauthenticationStart{
		AuthorizationURL: authorizationURL,
		State:            state,
	}, nil
}

func (s Service) googleReauthenticationURL(state string, verifier string) (string, string, error) {
	baseAuthorizationURL := s.google.AuthCodeURL(state, verifier)
	parsed, err := url.Parse(baseAuthorizationURL)
	if err != nil {
		return "", "", fmt.Errorf("parse Google authorization URL: %w", err)
	}
	query := parsed.Query()
	redirectURL := s.googleReauthenticationRedirectURL
	if redirectURL == "" {
		redirectURL = query.Get("redirect_uri")
		if strings.HasSuffix(redirectURL, "/auth/google/callback") {
			redirectURL = strings.TrimSuffix(redirectURL, "/auth/google/callback") + "/me/recent-auth/google/callback"
		}
	}
	if redirectURL != "" {
		if _, err := url.ParseRequestURI(redirectURL); err != nil {
			return "", "", fmt.Errorf("parse Google reauthentication redirect URL: %w", err)
		}
		query.Set("redirect_uri", redirectURL)
		parsed.RawQuery = query.Encode()
	}
	if redirectURL != "" {
		if provider, ok := s.google.(GoogleReauthenticationProvider); ok {
			authorizationURL := provider.AuthCodeURLWithRedirect(state, verifier, redirectURL)
			parsedAuthorizationURL, err := url.Parse(authorizationURL)
			if err != nil {
				return "", "", fmt.Errorf("parse Google reauthentication authorization URL: %w", err)
			}
			if parsedAuthorizationURL.Query().Get("redirect_uri") != redirectURL {
				return "", "", fmt.Errorf("google reauthentication authorization redirect does not match token exchange redirect")
			}
			return authorizationURL, redirectURL, nil
		}
	}
	return parsed.String(), redirectURL, nil
}

func (s Service) authenticateGoogleReauthentication(ctx context.Context, code string, verifier string, redirectURL string) (GoogleIdentity, error) {
	if redirectURL == "" {
		return s.google.Authenticate(ctx, code, verifier)
	}
	provider, ok := s.google.(GoogleReauthenticationProvider)
	if !ok {
		return GoogleIdentity{}, fmt.Errorf("google reauthentication redirect exchange unavailable")
	}
	return provider.AuthenticateWithRedirect(ctx, code, verifier, redirectURL)
}

type googleReauthenticationState struct {
	AccountID   string `json:"account_id"`
	Action      string `json:"action"`
	ResourceID  string `json:"resource_id,omitempty"`
	Verifier    string `json:"verifier"`
	RedirectURL string `json:"redirect_url"`
}

func encodeGoogleReauthenticationState(state googleReauthenticationState) (string, error) {
	payload, err := json.Marshal(state)
	if err != nil {
		return "", err
	}
	return googleReauthStatePrefix + base64.RawURLEncoding.EncodeToString(payload), nil
}

func decodeGoogleReauthenticationState(raw string) (ProviderChallenge, string, string, error) {
	if !strings.HasPrefix(raw, googleReauthStatePrefix) {
		if strings.TrimSpace(raw) == "" {
			return ProviderChallenge{}, "", "", ErrInvalidCredentials
		}
		return ProviderChallenge{}, raw, "", nil
	}
	payload, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(raw, googleReauthStatePrefix))
	if err != nil {
		return ProviderChallenge{}, "", "", err
	}
	var state googleReauthenticationState
	if err := json.Unmarshal(payload, &state); err != nil || state.AccountID == "" || state.Action == "" || state.Verifier == "" || state.RedirectURL == "" {
		return ProviderChallenge{}, "", "", ErrInvalidCredentials
	}
	accountID, err := utilities.ParseID(state.AccountID)
	if err != nil {
		return ProviderChallenge{}, "", "", err
	}
	var resourceID utilities.ID
	if state.ResourceID != "" {
		resourceID, err = utilities.ParseID(state.ResourceID)
		if err != nil {
			return ProviderChallenge{}, "", "", err
		}
	}
	return ProviderChallenge{AccountID: accountID, Action: state.Action, ResourceID: resourceID}, state.Verifier, state.RedirectURL, nil
}

func resourceString(resourceID utilities.ID) string {
	if resourceID.IsZero() {
		return ""
	}
	return resourceID.String()
}

func (s Service) AuthenticateSession(ctx context.Context, rawToken string) (SessionUser, error) {
	rawToken = strings.TrimSpace(rawToken)
	if rawToken == "" {
		return SessionUser{}, ErrUnauthenticated
	}

	sessionUser, err := s.repository.GetSessionByTokenHash(ctx, SessionTokenHash(rawToken))
	if errors.Is(err, ErrSessionNotFound) {
		return SessionUser{}, ErrUnauthenticated
	}
	if err != nil {
		return SessionUser{}, err
	}

	now := s.now()
	if sessionUser.Session.RevokedAt != nil || !sessionUser.Session.ExpiresAt.After(now) {
		return SessionUser{}, ErrUnauthenticated
	}

	return sessionUser, nil
}

func (s Service) PrincipalForSession(session Session) Principal {
	return Principal{
		Kind:      PrincipalUser,
		UserID:    session.UserID,
		SessionID: session.ID,
	}
}

func (s Service) Logout(ctx context.Context, principal Principal) error {
	if principal.Kind != PrincipalUser || principal.SessionID.IsZero() {
		return ErrUnauthenticated
	}

	return s.repository.RevokeSession(ctx, principal.SessionID, s.now())
}

func (s Service) StartGoogleSignIn(ctx context.Context) (GoogleStart, error) {
	if s.google == nil || s.oauthStates == nil {
		return GoogleStart{}, ErrOAuthNotConfigured
	}

	state, err := randomURLToken(authTokenByteCount)
	if err != nil {
		return GoogleStart{}, err
	}
	verifier := s.google.NewVerifier()

	if err := s.oauthStates.SaveOAuthState(ctx, state, verifier, s.oauthStateTTL); err != nil {
		return GoogleStart{}, err
	}

	return GoogleStart{
		AuthorizationURL: s.google.AuthCodeURL(state, verifier),
	}, nil
}

func (s Service) CompleteGoogleSignIn(ctx context.Context, state string, code string, userAgent *string) (AuthResult, error) {
	if s.google == nil || s.oauthStates == nil {
		return AuthResult{}, ErrOAuthNotConfigured
	}
	state = strings.TrimSpace(state)
	code = strings.TrimSpace(code)
	if state == "" || code == "" {
		return AuthResult{}, ErrOAuthStateNotFound
	}

	verifier, err := s.oauthStates.LoadAndDeleteOAuthState(ctx, state)
	if errors.Is(err, ErrOAuthStateNotFound) {
		return AuthResult{}, err
	}
	if err != nil {
		return AuthResult{}, err
	}

	identity, err := s.google.Authenticate(ctx, code, verifier)
	if err != nil {
		return AuthResult{}, err
	}

	subject := strings.TrimSpace(identity.Subject)
	if subject == "" {
		return AuthResult{}, ErrInvalidCredentials
	}

	email, err := CanonicalEmail(identity.Email)
	if err != nil {
		return AuthResult{}, err
	}

	user, err := s.repository.GetUserByAuthIdentity(ctx, ProviderGoogle, subject)
	if err == nil {
		return s.createAuthResult(ctx, user, userAgent)
	}
	if !errors.Is(err, ErrIdentityNotFound) {
		return AuthResult{}, err
	}

	_, err = s.repository.GetUserByEmail(ctx, email)
	if err == nil {
		return AuthResult{}, ErrOAuthEmailConflict
	}
	if !errors.Is(err, ErrUserNotFound) {
		return AuthResult{}, err
	}

	name := strings.TrimSpace(identity.Name)
	if name == "" {
		name = email
	}

	userID, err := utilities.NewID()
	if err != nil {
		return AuthResult{}, err
	}
	identityID, err := utilities.NewID()
	if err != nil {
		return AuthResult{}, err
	}

	user, err = s.repository.CreateGoogleUser(ctx, CreateGoogleUserInput{
		UserID:          userID,
		IdentityID:      identityID,
		Name:            name,
		Email:           email,
		ProviderSubject: subject,
	})
	if err != nil {
		return AuthResult{}, err
	}

	return s.createAuthResult(ctx, user, userAgent)
}

func (s Service) createAuthResult(ctx context.Context, user User, userAgent *string) (AuthResult, error) {
	rawToken, err := randomURLToken(authTokenByteCount)
	if err != nil {
		return AuthResult{}, err
	}

	sessionID, err := utilities.NewID()
	if err != nil {
		return AuthResult{}, err
	}

	expiresAt := s.now().Add(s.sessionTTL)
	if _, err := s.repository.CreateSession(ctx, CreateSessionInput{
		ID:        sessionID,
		UserID:    user.ID,
		TokenHash: SessionTokenHash(rawToken),
		UserAgent: userAgent,
		ExpiresAt: expiresAt,
	}); err != nil {
		return AuthResult{}, err
	}

	return AuthResult{
		SessionToken: rawToken,
		ExpiresAt:    expiresAt,
		User:         user,
	}, nil
}

func CanonicalEmail(value string) (string, error) {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "" {
		return "", ErrInvalidEmail
	}

	address, err := mail.ParseAddress(value)
	if err != nil || address.Address != value || strings.Contains(address.Address, " ") {
		return "", ErrInvalidEmail
	}

	return value, nil
}

func PreparePassword(value string) (string, error) {
	value = strings.TrimSpace(value)
	if len(value) < MinPasswordLength || len([]byte(value)) > MaxPasswordBytes {
		return "", ErrInvalidPassword
	}

	return value, nil
}

func SessionTokenHash(rawToken string) string {
	sum := sha256.Sum256([]byte(rawToken))
	return hex.EncodeToString(sum[:])
}

func randomURLToken(byteCount int) (string, error) {
	var bytes = make([]byte, byteCount)
	if _, err := rand.Read(bytes); err != nil {
		return "", fmt.Errorf("generate random token: %w", err)
	}

	return base64.RawURLEncoding.EncodeToString(bytes), nil
}
