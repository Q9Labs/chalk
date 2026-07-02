package postgres_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestAuthenticationRepositoryCreateSession(t *testing.T) {
	expiresAt := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	userAgent := "Helium"
	querier := &authenticationQuerier{}
	repository := postgres.NewAuthenticationRepository(querier)

	session, err := repository.CreateSession(context.Background(), authentication.CreateSessionInput{
		ID:        mustAuthID(t, "22222222-2222-4222-8222-222222222222"),
		UserID:    mustAuthID(t, "11111111-1111-4111-8111-111111111111"),
		TokenHash: "stored-token-hash",
		UserAgent: &userAgent,
		ExpiresAt: expiresAt,
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}

	if querier.createSessionArg.TokenHash != "stored-token-hash" {
		t.Fatalf("token hash arg = %q, want stored-token-hash", querier.createSessionArg.TokenHash)
	}
	if querier.createSessionArg.UserAgent.String != "Helium" {
		t.Fatalf("user agent arg = %q, want Helium", querier.createSessionArg.UserAgent.String)
	}
	if session.TokenHash != "stored-token-hash" {
		t.Fatalf("session token hash = %q, want stored-token-hash", session.TokenHash)
	}
	if session.UserAgent == nil || *session.UserAgent != "Helium" {
		t.Fatalf("session user agent = %v, want Helium", session.UserAgent)
	}
}

func TestAuthenticationRepositoryGetSessionByTokenHashNotFound(t *testing.T) {
	repository := postgres.NewAuthenticationRepository(&authenticationQuerier{err: pgx.ErrNoRows})

	_, err := repository.GetSessionByTokenHash(context.Background(), "missing-hash")
	if !errors.Is(err, authentication.ErrSessionNotFound) {
		t.Fatalf("error = %v, want %v", err, authentication.ErrSessionNotFound)
	}
}

type authenticationQuerier struct {
	err              error
	createSessionArg sqlc.CreateLoginSessionParams
}

func (q *authenticationQuerier) CreateGoogleUser(ctx context.Context, arg sqlc.CreateGoogleUserParams) (sqlc.CreateGoogleUserRow, error) {
	return sqlc.CreateGoogleUserRow{}, q.err
}

func (q *authenticationQuerier) CreateLoginSession(ctx context.Context, arg sqlc.CreateLoginSessionParams) (sqlc.LoginSession, error) {
	q.createSessionArg = arg
	if q.err != nil {
		return sqlc.LoginSession{}, q.err
	}

	return sqlc.LoginSession{
		ID:        arg.ID,
		UserID:    arg.UserID,
		TokenHash: arg.TokenHash,
		UserAgent: arg.UserAgent,
		ExpiresAt: arg.ExpiresAt,
		UpdatedAt: timestamp(time.Date(2026, 7, 2, 0, 0, 0, 0, time.UTC)),
		CreatedAt: timestamp(time.Date(2026, 7, 2, 0, 0, 0, 0, time.UTC)),
	}, nil
}

func (q *authenticationQuerier) CreatePasswordUser(ctx context.Context, arg sqlc.CreatePasswordUserParams) (sqlc.CreatePasswordUserRow, error) {
	return sqlc.CreatePasswordUserRow{}, q.err
}

func (q *authenticationQuerier) GetLoginSessionByTokenHash(ctx context.Context, tokenHash string) (sqlc.GetLoginSessionByTokenHashRow, error) {
	return sqlc.GetLoginSessionByTokenHashRow{}, q.err
}

func (q *authenticationQuerier) GetPasswordIdentityByEmail(ctx context.Context, email string) (sqlc.GetPasswordIdentityByEmailRow, error) {
	return sqlc.GetPasswordIdentityByEmailRow{}, q.err
}

func (q *authenticationQuerier) GetUserByAuthIdentity(ctx context.Context, arg sqlc.GetUserByAuthIdentityParams) (sqlc.User, error) {
	return sqlc.User{}, q.err
}

func (q *authenticationQuerier) GetUserByEmail(ctx context.Context, email string) (sqlc.User, error) {
	return sqlc.User{}, q.err
}

func (q *authenticationQuerier) RevokeLoginSession(ctx context.Context, arg sqlc.RevokeLoginSessionParams) (sqlc.LoginSession, error) {
	return sqlc.LoginSession{}, q.err
}

func mustAuthID(t *testing.T, value string) utilities.ID {
	t.Helper()

	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatalf("parse id: %v", err)
	}

	return id
}
