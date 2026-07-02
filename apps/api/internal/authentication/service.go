package authentication

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net/mail"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const (
	ProviderPassword = "password"
	ProviderGoogle   = "google"

	MinPasswordLength = 8
	MaxPasswordBytes  = 72

	DefaultSessionTTL     = 30 * 24 * time.Hour
	DefaultOAuthStateTTL  = 10 * time.Minute
	sessionTokenByteCount = 32
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

type OAuthStateStore interface {
	SaveOAuthState(ctx context.Context, state string, verifier string, ttl time.Duration) error
	LoadAndDeleteOAuthState(ctx context.Context, state string) (string, error)
}

type Config struct {
	SessionTTL               time.Duration
	RequireEmailVerification bool
	OAuthStateTTL            time.Duration
	Now                      func() time.Time
}

type Service struct {
	repository               Repository
	passwords                PasswordHasher
	google                   GoogleProvider
	oauthStates              OAuthStateStore
	sessionTTL               time.Duration
	requireEmailVerification bool
	oauthStateTTL            time.Duration
	now                      func() time.Time
}

func NewService(repository Repository, passwords PasswordHasher, google GoogleProvider, oauthStates OAuthStateStore, cfg Config) Service {
	sessionTTL := cfg.SessionTTL
	if sessionTTL <= 0 {
		sessionTTL = DefaultSessionTTL
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
		repository:               repository,
		passwords:                passwords,
		google:                   google,
		oauthStates:              oauthStates,
		sessionTTL:               sessionTTL,
		requireEmailVerification: cfg.RequireEmailVerification,
		oauthStateTTL:            oauthStateTTL,
		now:                      now,
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
		return AuthResult{}, ErrInvalidCredentials
	}

	return s.createAuthResult(ctx, identity.User, input.UserAgent)
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

	state, err := randomURLToken(sessionTokenByteCount)
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
	rawToken, err := randomURLToken(sessionTokenByteCount)
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
