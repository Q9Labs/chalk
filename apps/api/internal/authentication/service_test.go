package authentication_test

import (
	"context"
	"errors"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"golang.org/x/crypto/bcrypt"
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

func TestServiceVerifyPasswordUsesCanonicalEmailAndGenericFailure(t *testing.T) {
	repository := newAuthenticationRepository()
	service := newService(repository)
	if _, err := service.Register(context.Background(), authentication.RegisterInput{
		Name: "Hasan", Email: "hasan@example.com", Password: "password123",
	}); err != nil {
		t.Fatalf("register: %v", err)
	}
	if err := service.VerifyPassword(context.Background(), " HASAN@example.com ", " password123 "); err != nil {
		t.Fatalf("verify password: %v", err)
	}
	if err := service.VerifyPassword(context.Background(), "hasan@example.com", "wrong"); !errors.Is(err, authentication.ErrInvalidCredentials) {
		t.Fatalf("wrong password error = %v, want %v", err, authentication.ErrInvalidCredentials)
	}
	if err := service.VerifyPassword(context.Background(), "missing@example.com", "wrong"); !errors.Is(err, authentication.ErrInvalidCredentials) {
		t.Fatalf("missing user error = %v, want %v", err, authentication.ErrInvalidCredentials)
	}
}

func TestServiceVerifyPasswordPreservesHasherInfrastructureFailure(t *testing.T) {
	repository := newAuthenticationRepository()
	if _, err := repository.CreatePasswordUser(context.Background(), authentication.CreatePasswordUserInput{
		UserID: mustID(t, "11111111-1111-4111-8111-111111111111"), Name: "Hasan", Email: "hasan@example.com", PasswordHash: "hash:password123",
	}); err != nil {
		t.Fatalf("seed password user: %v", err)
	}
	backendErr := errors.New("password verifier backend unavailable")
	service := authentication.NewService(repository, passwordHasher{compareErr: backendErr}, nil, nil, authentication.Config{})
	if err := service.VerifyPassword(context.Background(), "hasan@example.com", "password123"); !errors.Is(err, backendErr) {
		t.Fatalf("hasher infrastructure error = %v, want propagated error", err)
	}
}

func TestServiceVerifyGoogleReauthenticationBindsIdentityToAccount(t *testing.T) {
	repository := newAuthenticationRepository()
	accountID := mustID(t, "11111111-1111-4111-8111-111111111111")
	repository.users["hasan@example.com"] = authentication.User{ID: accountID, Email: "hasan@example.com"}
	repository.identities[authentication.ProviderGoogle+":google-sub"] = repository.users["hasan@example.com"]
	states := &oauthStates{values: map[string]string{"state": "verifier"}}
	google := googleProvider{identity: authentication.GoogleIdentity{Subject: "google-sub"}}
	service := authentication.NewService(repository, passwordHasher{}, google, states, authentication.Config{})

	if err := service.VerifyGoogleReauthentication(context.Background(), accountID, " state ", " code "); err != nil {
		t.Fatalf("verify Google reauthentication: %v", err)
	}
	if _, ok := states.values["state"]; ok {
		t.Fatal("OAuth state was not consumed")
	}

	states.values["state"] = "verifier"
	otherAccountID := mustID(t, "22222222-2222-4222-8222-222222222222")
	if err := service.VerifyGoogleReauthentication(context.Background(), otherAccountID, "state", "code"); !errors.Is(err, authentication.ErrInvalidCredentials) {
		t.Fatalf("mismatched account error = %v, want ErrInvalidCredentials", err)
	}
}

func TestServiceVerifyGoogleReauthenticationPreservesOperationalFailures(t *testing.T) {
	accountID := mustID(t, "11111111-1111-4111-8111-111111111111")
	stateErr := errors.New("oauth state store unavailable")
	states := &oauthStates{values: map[string]string{"state": "verifier"}, loadErr: stateErr}
	service := authentication.NewService(newAuthenticationRepository(), passwordHasher{}, googleProvider{}, states, authentication.Config{})
	if err := service.VerifyGoogleReauthentication(context.Background(), accountID, "state", "code"); !errors.Is(err, stateErr) {
		t.Fatalf("state store error = %v, want propagated error", err)
	}

	providerErr := errors.New("google exchange unavailable")
	states = &oauthStates{values: map[string]string{"state": "verifier"}}
	service = authentication.NewService(newAuthenticationRepository(), passwordHasher{}, googleProvider{err: providerErr}, states, authentication.Config{})
	if err := service.VerifyGoogleReauthentication(context.Background(), accountID, "state", "code"); !errors.Is(err, providerErr) {
		t.Fatalf("provider error = %v, want propagated error", err)
	}

	identityErr := errors.New("identity repository unavailable")
	repository := newAuthenticationRepository()
	repository.authIdentityErr = identityErr
	states = &oauthStates{values: map[string]string{"state": "verifier"}}
	service = authentication.NewService(repository, passwordHasher{}, googleProvider{identity: authentication.GoogleIdentity{Subject: "google-sub"}}, states, authentication.Config{})
	if err := service.VerifyGoogleReauthentication(context.Background(), accountID, "state", "code"); !errors.Is(err, identityErr) {
		t.Fatalf("identity repository error = %v, want propagated error", err)
	}

	if err := (authentication.Service{}).VerifyGoogleReauthentication(context.Background(), accountID, "state", "code"); !errors.Is(err, authentication.ErrOAuthNotConfigured) {
		t.Fatalf("missing provider error = %v, want ErrOAuthNotConfigured", err)
	}
}

func TestServiceGoogleReauthenticationChallengeBindsServerState(t *testing.T) {
	repository := newAuthenticationRepository()
	accountID := mustID(t, "11111111-1111-4111-8111-111111111111")
	resourceID := mustID(t, "22222222-2222-4222-8222-222222222222")
	repository.identities[authentication.ProviderGoogle+":google-sub"] = authentication.User{ID: accountID}
	states := &oauthStates{values: map[string]string{}}
	service := authentication.NewService(repository, passwordHasher{}, googleProvider{identity: authentication.GoogleIdentity{Subject: "google-sub"}}, states, authentication.Config{})

	start, err := service.StartGoogleReauthentication(context.Background(), accountID, "api_key.create", resourceID)
	if err != nil {
		t.Fatalf("start Google reauthentication: %v", err)
	}
	if start.State == "" || start.AuthorizationURL == "" || strings.Contains(start.AuthorizationURL, accountID.String()) || strings.Contains(start.AuthorizationURL, resourceID.String()) {
		t.Fatalf("start response leaks binding or is incomplete: %#v", start)
	}
	authorizationURL, err := url.Parse(start.AuthorizationURL)
	if err != nil {
		t.Fatalf("parse authorization URL: %v", err)
	}
	if got := authorizationURL.Query().Get("redirect_uri"); got != "https://dashboard.test/api/me/recent-auth/google/callback" {
		t.Fatalf("Google redirect_uri = %q, want reauthentication callback", got)
	}
	stored := states.values[start.State]
	if !strings.HasPrefix(stored, "chalk-google-reauth-v1.") {
		t.Fatalf("stored state = %q, want server-side reauth envelope", stored)
	}

	challenge, err := service.VerifyProviderChallenge(context.Background(), accountID, authentication.ProviderGoogle, start.State, "code")
	if err != nil {
		t.Fatalf("verify Google challenge: %v", err)
	}
	if challenge.AccountID != accountID || challenge.Action != "api_key.create" || challenge.ResourceID != resourceID {
		t.Fatalf("challenge = %#v", challenge)
	}
	if _, err := service.VerifyProviderChallenge(context.Background(), accountID, authentication.ProviderGoogle, start.State, "code"); !errors.Is(err, authentication.ErrInvalidCredentials) {
		t.Fatalf("replayed challenge error = %v, want ErrInvalidCredentials", err)
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
	users           map[string]authentication.User
	passwords       map[string]string
	identities      map[string]authentication.User
	sessions        map[string]authentication.SessionUser
	createdSession  authentication.Session
	authIdentityErr error
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
	if r.authIdentityErr != nil {
		return authentication.User{}, r.authIdentityErr
	}
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

type passwordHasher struct {
	compareErr error
}

func (passwordHasher) HashPassword(password string) (string, error) {
	return "hash:" + password, nil
}

func (h passwordHasher) ComparePassword(hash string, password string) error {
	if h.compareErr != nil {
		return h.compareErr
	}
	if hash != "hash:"+password {
		return bcrypt.ErrMismatchedHashAndPassword
	}

	return nil
}

type googleProvider struct {
	identity authentication.GoogleIdentity
	err      error
}

func (g googleProvider) NewVerifier() string {
	return "verifier"
}

func (g googleProvider) AuthCodeURL(state string, verifier string) string {
	return "https://accounts.google.test/auth?state=" + state + "&verifier=" + verifier + "&redirect_uri=https%3A%2F%2Fdashboard.test%2Fapi%2Fauth%2Fgoogle%2Fcallback"
}

func (g googleProvider) AuthCodeURLWithRedirect(state string, verifier string, redirectURL string) string {
	return "https://accounts.google.test/auth?state=" + state + "&verifier=" + verifier + "&redirect_uri=" + url.QueryEscape(redirectURL)
}

func (g googleProvider) Authenticate(ctx context.Context, code string, verifier string) (authentication.GoogleIdentity, error) {
	if g.err != nil {
		return authentication.GoogleIdentity{}, g.err
	}
	return g.identity, nil
}

func (g googleProvider) AuthenticateWithRedirect(ctx context.Context, code string, verifier string, redirectURL string) (authentication.GoogleIdentity, error) {
	return g.Authenticate(ctx, code, verifier)
}

type oauthStates struct {
	values  map[string]string
	loadErr error
}

func (s *oauthStates) SaveOAuthState(ctx context.Context, state string, verifier string, ttl time.Duration) error {
	s.values[state] = verifier
	return nil
}

func (s *oauthStates) LoadAndDeleteOAuthState(ctx context.Context, state string) (string, error) {
	if s.loadErr != nil {
		return "", s.loadErr
	}
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

func mustID(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatalf("parse test id: %v", err)
	}
	return id
}
