package authentication_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestServiceRegisterSuccess(t *testing.T) {
	repository := newAuthenticationRepository()
	service := newService(repository)

	result, err := service.Register(context.Background(), authentication.RegisterInput{
		Name:     " Hasan ",
		Email:    " HASAN@EXAMPLE.COM ",
		Password: "  correct horse  ",
	})
	if err != nil {
		t.Fatalf("register: %v", err)
	}

	if result.SessionToken == "" {
		t.Fatal("session token is empty")
	}
	if result.User.Email != "hasan@example.com" {
		t.Fatalf("email = %q, want canonical lowercase email", result.User.Email)
	}
	if result.User.Name != "Hasan" {
		t.Fatalf("name = %q, want trimmed name", result.User.Name)
	}
	if repository.createdSession.TokenHash == result.SessionToken {
		t.Fatal("stored token hash matched raw session token")
	}
	if repository.createdSession.TokenHash != authentication.SessionTokenHash(result.SessionToken) {
		t.Fatal("stored token hash did not match expected session token hash")
	}
}

func TestServiceRegisterDuplicateEmail(t *testing.T) {
	repository := newAuthenticationRepository()
	service := newService(repository)

	_, err := service.Register(context.Background(), authentication.RegisterInput{
		Name:     "Hasan",
		Email:    "hasan@example.com",
		Password: "password123",
	})
	if err != nil {
		t.Fatalf("register first user: %v", err)
	}

	_, err = service.Register(context.Background(), authentication.RegisterInput{
		Name:     "Hasan Two",
		Email:    " HASAN@example.com ",
		Password: "password123",
	})
	if !errors.Is(err, authentication.ErrEmailAlreadyRegistered) {
		t.Fatalf("error = %v, want %v", err, authentication.ErrEmailAlreadyRegistered)
	}
}

func TestServiceLoginSuccess(t *testing.T) {
	repository := newAuthenticationRepository()
	service := newService(repository)
	_, err := service.Register(context.Background(), authentication.RegisterInput{
		Name:     "Hasan",
		Email:    "hasan@example.com",
		Password: "password123",
	})
	if err != nil {
		t.Fatalf("register: %v", err)
	}

	result, err := service.Login(context.Background(), authentication.LoginInput{
		Email:    " HASAN@example.com ",
		Password: " password123 ",
	})
	if err != nil {
		t.Fatalf("login: %v", err)
	}

	if result.User.Email != "hasan@example.com" {
		t.Fatalf("email = %q, want hasan@example.com", result.User.Email)
	}
	if result.SessionToken == "" {
		t.Fatal("session token is empty")
	}
}

func TestServiceLoginWrongPasswordIsGeneric(t *testing.T) {
	repository := newAuthenticationRepository()
	service := newService(repository)
	_, err := service.Register(context.Background(), authentication.RegisterInput{
		Name:     "Hasan",
		Email:    "hasan@example.com",
		Password: "password123",
	})
	if err != nil {
		t.Fatalf("register: %v", err)
	}

	_, err = service.Login(context.Background(), authentication.LoginInput{
		Email:    "hasan@example.com",
		Password: "wrong-password",
	})
	if !errors.Is(err, authentication.ErrInvalidCredentials) {
		t.Fatalf("error = %v, want %v", err, authentication.ErrInvalidCredentials)
	}

	_, err = service.Login(context.Background(), authentication.LoginInput{
		Email:    "missing@example.com",
		Password: "wrong-password",
	})
	if !errors.Is(err, authentication.ErrInvalidCredentials) {
		t.Fatalf("missing email error = %v, want %v", err, authentication.ErrInvalidCredentials)
	}
}

func TestPreparePasswordBoundaries(t *testing.T) {
	if _, err := authentication.PreparePassword("1234567"); !errors.Is(err, authentication.ErrInvalidPassword) {
		t.Fatalf("short password error = %v, want %v", err, authentication.ErrInvalidPassword)
	}

	if password, err := authentication.PreparePassword(" 12345678 "); err != nil || password != "12345678" {
		t.Fatalf("trimmed password = %q, error = %v; want 12345678 nil", password, err)
	}

	if _, err := authentication.PreparePassword(strings.Repeat("a", authentication.MaxPasswordBytes+1)); !errors.Is(err, authentication.ErrInvalidPassword) {
		t.Fatalf("long password error = %v, want %v", err, authentication.ErrInvalidPassword)
	}
}

func TestServiceAuthenticateSessionRejectsExpiredAndRevoked(t *testing.T) {
	repository := newAuthenticationRepository()
	now := time.Date(2026, 7, 2, 12, 0, 0, 0, time.UTC)
	service := authentication.NewService(repository, passwordHasher{}, nil, nil, authentication.Config{
		SessionTTL: time.Hour,
		Now:        func() time.Time { return now },
	})
	result, err := service.Register(context.Background(), authentication.RegisterInput{
		Name:     "Hasan",
		Email:    "hasan@example.com",
		Password: "password123",
	})
	if err != nil {
		t.Fatalf("register: %v", err)
	}

	sessionUser, err := service.AuthenticateSession(context.Background(), result.SessionToken)
	if err != nil {
		t.Fatalf("authenticate session: %v", err)
	}
	if sessionUser.User.Email != "hasan@example.com" {
		t.Fatalf("session user email = %q, want hasan@example.com", sessionUser.User.Email)
	}

	repository.sessions[authentication.SessionTokenHash(result.SessionToken)] = authentication.SessionUser{
		Session: authentication.Session{
			ID:        repository.createdSession.ID,
			UserID:    repository.createdSession.UserID,
			TokenHash: repository.createdSession.TokenHash,
			ExpiresAt: now.Add(-time.Second),
		},
		User: sessionUser.User,
	}
	if _, err := service.AuthenticateSession(context.Background(), result.SessionToken); !errors.Is(err, authentication.ErrUnauthenticated) {
		t.Fatalf("expired session error = %v, want %v", err, authentication.ErrUnauthenticated)
	}

	revokedAt := now
	repository.sessions[authentication.SessionTokenHash(result.SessionToken)] = authentication.SessionUser{
		Session: authentication.Session{
			ID:        repository.createdSession.ID,
			UserID:    repository.createdSession.UserID,
			TokenHash: repository.createdSession.TokenHash,
			ExpiresAt: now.Add(time.Hour),
			RevokedAt: &revokedAt,
		},
		User: sessionUser.User,
	}
	if _, err := service.AuthenticateSession(context.Background(), result.SessionToken); !errors.Is(err, authentication.ErrUnauthenticated) {
		t.Fatalf("revoked session error = %v, want %v", err, authentication.ErrUnauthenticated)
	}
}

func TestServiceGoogleSignInConflictsWithExistingEmail(t *testing.T) {
	repository := newAuthenticationRepository()
	states := &oauthStates{values: map[string]string{"state": "verifier"}}
	google := googleProvider{
		identity: authentication.GoogleIdentity{
			Subject: "google-sub",
			Email:   "hasan@example.com",
			Name:    "Hasan",
		},
	}
	service := authentication.NewService(repository, passwordHasher{}, google, states, authentication.Config{})

	_, err := service.Register(context.Background(), authentication.RegisterInput{
		Name:     "Hasan",
		Email:    "hasan@example.com",
		Password: "password123",
	})
	if err != nil {
		t.Fatalf("register password user: %v", err)
	}

	_, err = service.CompleteGoogleSignIn(context.Background(), "state", "code", nil)
	if !errors.Is(err, authentication.ErrOAuthEmailConflict) {
		t.Fatalf("error = %v, want %v", err, authentication.ErrOAuthEmailConflict)
	}
}

type authenticationRepository struct {
	users          map[string]authentication.User
	passwords      map[string]string
	identities     map[string]authentication.User
	sessions       map[string]authentication.SessionUser
	createdSession authentication.Session
}

func newAuthenticationRepository() *authenticationRepository {
	return &authenticationRepository{
		users:      map[string]authentication.User{},
		passwords:  map[string]string{},
		identities: map[string]authentication.User{},
		sessions:   map[string]authentication.SessionUser{},
	}
}

func (r *authenticationRepository) CreatePasswordUser(ctx context.Context, input authentication.CreatePasswordUserInput) (authentication.User, error) {
	if _, ok := r.users[input.Email]; ok {
		return authentication.User{}, authentication.ErrEmailAlreadyRegistered
	}

	user := authentication.User{
		ID:        input.UserID,
		Name:      input.Name,
		Email:     input.Email,
		CreatedAt: time.Date(2026, 7, 2, 0, 0, 0, 0, time.UTC),
		UpdatedAt: time.Date(2026, 7, 2, 0, 0, 0, 0, time.UTC),
	}
	r.users[input.Email] = user
	r.passwords[input.Email] = input.PasswordHash
	return user, nil
}

func (r *authenticationRepository) CreateGoogleUser(ctx context.Context, input authentication.CreateGoogleUserInput) (authentication.User, error) {
	if _, ok := r.users[input.Email]; ok {
		return authentication.User{}, authentication.ErrOAuthEmailConflict
	}

	user := authentication.User{
		ID:    input.UserID,
		Name:  input.Name,
		Email: input.Email,
	}
	r.users[input.Email] = user
	r.identities[authentication.ProviderGoogle+":"+input.ProviderSubject] = user
	return user, nil
}

func (r *authenticationRepository) GetPasswordIdentityByEmail(ctx context.Context, email string) (authentication.PasswordIdentity, error) {
	user, ok := r.users[email]
	if !ok {
		return authentication.PasswordIdentity{}, authentication.ErrIdentityNotFound
	}

	return authentication.PasswordIdentity{User: user, PasswordHash: r.passwords[email]}, nil
}

func (r *authenticationRepository) GetUserByAuthIdentity(ctx context.Context, provider string, subject string) (authentication.User, error) {
	user, ok := r.identities[provider+":"+subject]
	if !ok {
		return authentication.User{}, authentication.ErrIdentityNotFound
	}

	return user, nil
}

func (r *authenticationRepository) GetUserByEmail(ctx context.Context, email string) (authentication.User, error) {
	user, ok := r.users[email]
	if !ok {
		return authentication.User{}, authentication.ErrUserNotFound
	}

	return user, nil
}

func (r *authenticationRepository) CreateSession(ctx context.Context, input authentication.CreateSessionInput) (authentication.Session, error) {
	session := authentication.Session{
		ID:        input.ID,
		UserID:    input.UserID,
		TokenHash: input.TokenHash,
		UserAgent: input.UserAgent,
		ExpiresAt: input.ExpiresAt,
	}
	r.createdSession = session

	var user authentication.User
	for _, candidate := range r.users {
		if candidate.ID == input.UserID {
			user = candidate
			break
		}
	}
	r.sessions[input.TokenHash] = authentication.SessionUser{Session: session, User: user}
	return session, nil
}

func (r *authenticationRepository) GetSessionByTokenHash(ctx context.Context, tokenHash string) (authentication.SessionUser, error) {
	sessionUser, ok := r.sessions[tokenHash]
	if !ok {
		return authentication.SessionUser{}, authentication.ErrSessionNotFound
	}

	return sessionUser, nil
}

func (r *authenticationRepository) RevokeSession(ctx context.Context, sessionID utilities.ID, revokedAt time.Time) error {
	for tokenHash, sessionUser := range r.sessions {
		if sessionUser.Session.ID == sessionID {
			sessionUser.Session.RevokedAt = &revokedAt
			r.sessions[tokenHash] = sessionUser
			return nil
		}
	}

	return authentication.ErrSessionNotFound
}

type passwordHasher struct{}

func (passwordHasher) HashPassword(password string) (string, error) {
	return "hash:" + password, nil
}

func (passwordHasher) ComparePassword(hash string, password string) error {
	if hash != "hash:"+password {
		return errors.New("password mismatch")
	}

	return nil
}

type googleProvider struct {
	identity authentication.GoogleIdentity
}

func (g googleProvider) NewVerifier() string {
	return "verifier"
}

func (g googleProvider) AuthCodeURL(state string, verifier string) string {
	return "https://accounts.google.test/auth?state=" + state + "&verifier=" + verifier
}

func (g googleProvider) Authenticate(ctx context.Context, code string, verifier string) (authentication.GoogleIdentity, error) {
	return g.identity, nil
}

type oauthStates struct {
	values map[string]string
}

func (s *oauthStates) SaveOAuthState(ctx context.Context, state string, verifier string, ttl time.Duration) error {
	s.values[state] = verifier
	return nil
}

func (s *oauthStates) LoadAndDeleteOAuthState(ctx context.Context, state string) (string, error) {
	verifier, ok := s.values[state]
	if !ok {
		return "", authentication.ErrOAuthStateNotFound
	}

	delete(s.values, state)
	return verifier, nil
}

func newService(repository *authenticationRepository) authentication.Service {
	return authentication.NewService(repository, passwordHasher{}, nil, nil, authentication.Config{
		SessionTTL: time.Hour,
		Now: func() time.Time {
			return time.Date(2026, 7, 2, 12, 0, 0, 0, time.UTC)
		},
	})
}
