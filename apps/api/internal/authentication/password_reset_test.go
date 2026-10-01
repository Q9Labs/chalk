package authentication

import (
	"context"
	"errors"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/email"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type resetRepository struct {
	identity PasswordIdentity
	reset    *StorePasswordResetInput
	sessions int
}

func (r *resetRepository) CreatePasswordUser(context.Context, CreatePasswordUserInput) (User, error) {
	return User{}, nil
}
func (r *resetRepository) CreateGoogleUser(context.Context, CreateGoogleUserInput) (User, error) {
	return User{}, nil
}
func (r *resetRepository) GetPasswordIdentityByEmail(_ context.Context, value string) (PasswordIdentity, error) {
	if value != r.identity.User.Email {
		return PasswordIdentity{}, ErrIdentityNotFound
	}
	return r.identity, nil
}
func (r *resetRepository) GetUserByAuthIdentity(context.Context, string, string) (User, error) {
	return User{}, ErrIdentityNotFound
}
func (r *resetRepository) GetUserByEmail(context.Context, string) (User, error) {
	return User{}, ErrUserNotFound
}
func (r *resetRepository) CreateSession(_ context.Context, input CreateSessionInput) (Session, error) {
	if input.ExpectedPasswordHash != nil && *input.ExpectedPasswordHash != r.identity.PasswordHash {
		return Session{}, ErrInvalidCredentials
	}
	return Session{}, nil
}
func (r *resetRepository) GetSessionByTokenHash(context.Context, string) (SessionUser, error) {
	return SessionUser{}, ErrSessionNotFound
}
func (r *resetRepository) RevokeSession(context.Context, utilities.ID, time.Time) error { return nil }
func (r *resetRepository) StorePasswordReset(_ context.Context, input StorePasswordResetInput) error {
	copy := input
	r.reset = &copy
	return nil
}
func (r *resetRepository) CompletePasswordReset(_ context.Context, input CompletePasswordResetInput) (User, error) {
	if r.reset == nil || r.reset.TokenHash != input.TokenHash || !r.reset.ExpiresAt.After(input.CompletedAt) {
		return User{}, ErrPasswordResetTokenInvalid
	}
	r.reset = nil
	r.identity.PasswordHash = input.PasswordHash
	r.sessions = 0
	return r.identity.User, nil
}

type resetHasher struct{}

type pausedResetHasher struct {
	resetHasher
	started chan struct{}
	release chan struct{}
}

func (h pausedResetHasher) ComparePassword(hash, value string) error {
	close(h.started)
	<-h.release
	return h.resetHasher.ComparePassword(hash, value)
}

func TestPasswordResetFencesLoginWithPreviouslyReadPassword(t *testing.T) {
	accountID, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	repository := &resetRepository{identity: PasswordIdentity{User: User{ID: accountID, Email: "account@example.com"}, PasswordHash: "hash:old-password"}}
	hasher := pausedResetHasher{started: make(chan struct{}), release: make(chan struct{})}
	sender := &resetSender{}
	service := NewService(repository, hasher, nil, nil, Config{PasswordResetURL: "https://dashboard.example/reset-password", PasswordResetEmailFrom: "auth@example.com"}).WithEmailSender(sender)
	if err := service.RequestPasswordReset(t.Context(), "account@example.com"); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := service.Login(t.Context(), LoginInput{Email: "account@example.com", Password: "old-password"})
		done <- err
	}()
	<-hasher.started
	_, resetErr := service.CompletePasswordReset(t.Context(), resetTokenFromMessage(t, sender.messages[0]), "new-password")
	close(hasher.release)
	if resetErr != nil {
		t.Fatal(resetErr)
	}
	if err := <-done; !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("stale login = %v", err)
	}
}

func (resetHasher) HashPassword(value string) (string, error) { return "hash:" + value, nil }
func (resetHasher) ComparePassword(hash string, value string) error {
	if hash != "hash:"+value {
		return errors.New("mismatch")
	}
	return nil
}

type resetSender struct{ messages []email.SendEmailInput }

func (s *resetSender) SendEmail(_ context.Context, input email.SendEmailInput) (email.SendEmailResult, error) {
	s.messages = append(s.messages, input)
	return email.SendEmailResult{}, nil
}

func TestPasswordResetLifecycle(t *testing.T) {
	now := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	accountID, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	repository := &resetRepository{identity: PasswordIdentity{User: User{ID: accountID, Email: "account@example.com"}}, sessions: 3}
	sender := &resetSender{}
	service := NewService(repository, resetHasher{}, nil, nil, Config{Now: func() time.Time { return now }, PasswordResetURL: "https://dashboard.example/reset-password", PasswordResetEmailFrom: "Chalk <auth@example.com>"}).WithEmailSender(sender)

	if err := service.RequestPasswordReset(context.Background(), "missing@example.com"); err != nil {
		t.Fatal(err)
	}
	if len(sender.messages) != 0 {
		t.Fatalf("unknown Account sent %d emails", len(sender.messages))
	}
	if err := service.RequestPasswordReset(context.Background(), "account@example.com"); err != nil {
		t.Fatal(err)
	}
	firstHash := repository.reset.TokenHash
	firstToken := resetTokenFromMessage(t, sender.messages[0])
	if strings.Contains(sender.messages[0].TextBody, firstHash) {
		t.Fatal("email exposed stored token hash")
	}
	if err := service.RequestPasswordReset(context.Background(), "account@example.com"); err != nil {
		t.Fatal(err)
	}
	if repository.reset.TokenHash == firstHash {
		t.Fatal("replacement retained earlier token")
	}
	if _, err := service.CompletePasswordReset(context.Background(), firstToken, "new-password"); !errors.Is(err, ErrPasswordResetTokenInvalid) {
		t.Fatalf("replaced token error = %v", err)
	}

	secondToken := resetTokenFromMessage(t, sender.messages[1])
	if _, err := service.CompletePasswordReset(context.Background(), secondToken, "new-password"); err != nil {
		t.Fatal(err)
	}
	if repository.sessions != 0 {
		t.Fatalf("sessions = %d, want revoked", repository.sessions)
	}
	if _, err := service.CompletePasswordReset(context.Background(), secondToken, "new-password"); !errors.Is(err, ErrPasswordResetTokenInvalid) {
		t.Fatalf("reused token error = %v", err)
	}
}

func TestPasswordResetExpiryAndNoEnumeration(t *testing.T) {
	now := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	accountID, _ := utilities.NewID()
	repository := &resetRepository{identity: PasswordIdentity{User: User{ID: accountID, Email: "account@example.com"}}}
	sender := &resetSender{}
	service := NewService(repository, resetHasher{}, nil, nil, Config{Now: func() time.Time { return now }, PasswordResetURL: "https://dashboard.example/reset-password", PasswordResetEmailFrom: "auth@example.com"}).WithEmailSender(sender)
	if err := service.RequestPasswordReset(context.Background(), "not-an-email"); err != nil {
		t.Fatal(err)
	}
	if err := service.RequestPasswordReset(context.Background(), "missing@example.com"); err != nil {
		t.Fatal(err)
	}
	if err := service.RequestPasswordReset(context.Background(), "account@example.com"); err != nil {
		t.Fatal(err)
	}
	token := resetTokenFromMessage(t, sender.messages[0])
	now = now.Add(DefaultPasswordResetTTL)
	if _, err := service.CompletePasswordReset(context.Background(), token, "new-password"); !errors.Is(err, ErrPasswordResetTokenInvalid) {
		t.Fatalf("expired token error = %v", err)
	}
}

func resetTokenFromMessage(t *testing.T, message email.SendEmailInput) string {
	t.Helper()
	start := strings.Index(message.TextBody, "https://")
	parsed, err := url.Parse(message.TextBody[start:])
	if err != nil {
		t.Fatal(err)
	}
	fragment, err := url.ParseQuery(parsed.Fragment)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Query().Get("token") != "" {
		t.Fatal("reset token must not reach HTTP request logs")
	}
	token := fragment.Get("token")
	if token == "" {
		t.Fatal("missing reset token")
	}
	return token
}
