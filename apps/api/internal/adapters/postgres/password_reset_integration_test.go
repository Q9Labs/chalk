package postgres

import (
	"context"
	"errors"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
)

func TestPasswordResetReplacesExpiresConsumesAndRevokes(t *testing.T) {
	databaseURL := os.Getenv("CHALK_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("CHALK_DATABASE_URL is not set")
	}
	ctx := t.Context()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	repository := NewAuthenticationRepository(sqlc.New(pool), pool, nil)
	accountID := accountTenantIntegrationID(t)
	address := accountID.String() + "@reset.test"
	_, err = repository.CreatePasswordUser(ctx, authentication.CreatePasswordUserInput{
		UserID: accountID, IdentityID: accountTenantIntegrationID(t), Name: "Reset Account", Email: address, PasswordHash: "old-hash",
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		for _, table := range []string{"login_sessions", "auth_identities"} {
			if _, err := pool.Exec(context.Background(), "delete from "+table+" where user_id=$1", uuid(accountID)); err != nil {
				t.Error(err)
			}
		}
		if _, err := pool.Exec(context.Background(), `delete from users where id=$1`, uuid(accountID)); err != nil {
			t.Error(err)
		}
	})
	now := time.Now().UTC().Truncate(time.Microsecond)
	loginHash := authentication.SessionTokenHash(accountID.String() + "login")
	_, err = repository.CreateSession(ctx, authentication.CreateSessionInput{
		ID: accountTenantIntegrationID(t), UserID: accountID, TokenHash: loginHash, ExpiresAt: now.Add(time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	store := func(token string, expires time.Time) {
		t.Helper()
		if err := repository.StorePasswordReset(ctx, authentication.StorePasswordResetInput{
			UserID: accountID, TokenHash: authentication.SessionTokenHash(token), ExpiresAt: expires,
		}); err != nil {
			t.Fatal(err)
		}
	}
	complete := func(token string) error {
		_, err := repository.CompletePasswordReset(ctx, authentication.CompletePasswordResetInput{
			TokenHash: authentication.SessionTokenHash(token), PasswordHash: "new-hash", CompletedAt: now,
		})
		return err
	}
	store("expired", now)
	if err := complete("expired"); !errors.Is(err, authentication.ErrPasswordResetTokenInvalid) {
		t.Fatalf("expired token: %v", err)
	}
	store("replaced", now.Add(authentication.DefaultPasswordResetTTL))
	store("current", now.Add(authentication.DefaultPasswordResetTTL))
	for _, token := range []string{"replaced", "unknown"} {
		if err := complete(token); !errors.Is(err, authentication.ErrPasswordResetTokenInvalid) {
			t.Fatalf("invalid token: %v", err)
		}
	}
	identity, err := repository.GetPasswordIdentityByEmail(ctx, address)
	if err != nil || identity.PasswordHash != "old-hash" {
		t.Fatalf("invalid reset changed password: %v", err)
	}
	if _, err := repository.GetSessionByTokenHash(ctx, loginHash); err != nil {
		t.Fatalf("invalid reset revoked login: %v", err)
	}
	var workers sync.WaitGroup
	results := make(chan error, 2)
	for range 2 {
		workers.Add(1)
		go func() { defer workers.Done(); results <- complete("current") }()
	}
	workers.Wait()
	close(results)
	succeeded := 0
	for err := range results {
		if err == nil {
			succeeded++
		} else if !errors.Is(err, authentication.ErrPasswordResetTokenInvalid) {
			t.Fatal(err)
		}
	}
	if succeeded != 1 {
		t.Fatalf("successful concurrent resets = %d, want 1", succeeded)
	}
	identity, err = repository.GetPasswordIdentityByEmail(ctx, address)
	if err != nil || identity.PasswordHash != "new-hash" {
		t.Fatalf("password not replaced: %v", err)
	}
	if _, err := repository.GetSessionByTokenHash(ctx, loginHash); !errors.Is(err, authentication.ErrSessionNotFound) {
		t.Fatalf("login not revoked: %v", err)
	}
	oldHash := "old-hash"
	if _, err := repository.CreateSession(ctx, authentication.CreateSessionInput{
		ID: accountTenantIntegrationID(t), UserID: accountID, TokenHash: authentication.SessionTokenHash("stale-login" + accountID.String()),
		ExpiresAt: now.Add(time.Hour), ExpectedPasswordHash: &oldHash,
	}); !errors.Is(err, authentication.ErrInvalidCredentials) {
		t.Fatalf("in-flight old-password login was not fenced: %v", err)
	}
}
