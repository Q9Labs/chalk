package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type authenticationQuerier interface {
	CreateGoogleUser(ctx context.Context, arg sqlc.CreateGoogleUserParams) (sqlc.CreateGoogleUserRow, error)
	CreateLoginSession(ctx context.Context, arg sqlc.CreateLoginSessionParams) (sqlc.LoginSession, error)
	CreatePasswordUser(ctx context.Context, arg sqlc.CreatePasswordUserParams) (sqlc.CreatePasswordUserRow, error)
	GetLoginSessionByTokenHash(ctx context.Context, tokenHash string) (sqlc.GetLoginSessionByTokenHashRow, error)
	GetPasswordIdentityByEmail(ctx context.Context, email string) (sqlc.GetPasswordIdentityByEmailRow, error)
	GetUserByAuthIdentity(ctx context.Context, arg sqlc.GetUserByAuthIdentityParams) (sqlc.User, error)
	GetUserByEmail(ctx context.Context, email string) (sqlc.User, error)
	RevokeLoginSession(ctx context.Context, arg sqlc.RevokeLoginSessionParams) (sqlc.LoginSession, error)
}

type AuthenticationRepository struct {
	queries authenticationQuerier
}

func NewAuthenticationRepository(queries authenticationQuerier) AuthenticationRepository {
	return AuthenticationRepository{queries: queries}
}

func (r AuthenticationRepository) CreatePasswordUser(ctx context.Context, input authentication.CreatePasswordUserInput) (authentication.User, error) {
	user, err := r.queries.CreatePasswordUser(ctx, sqlc.CreatePasswordUserParams{
		UserID:       uuid(input.UserID),
		IdentityID:   uuid(input.IdentityID),
		Name:         input.Name,
		Email:        input.Email,
		PasswordHash: pgtype.Text{String: input.PasswordHash, Valid: true},
	})
	if uniqueViolation(err) {
		return authentication.User{}, authentication.ErrEmailAlreadyRegistered
	}
	if err != nil {
		return authentication.User{}, fmt.Errorf("create password user: %w", err)
	}

	return mapAuthenticationUser(user.ID, user.Name, user.Email, user.UpdatedAt, user.CreatedAt), nil
}

func (r AuthenticationRepository) CreateGoogleUser(ctx context.Context, input authentication.CreateGoogleUserInput) (authentication.User, error) {
	user, err := r.queries.CreateGoogleUser(ctx, sqlc.CreateGoogleUserParams{
		UserID:          uuid(input.UserID),
		IdentityID:      uuid(input.IdentityID),
		Name:            input.Name,
		Email:           input.Email,
		ProviderSubject: input.ProviderSubject,
	})
	if uniqueViolation(err) {
		return authentication.User{}, authentication.ErrOAuthEmailConflict
	}
	if err != nil {
		return authentication.User{}, fmt.Errorf("create google user: %w", err)
	}

	return mapAuthenticationUser(user.ID, user.Name, user.Email, user.UpdatedAt, user.CreatedAt), nil
}

func (r AuthenticationRepository) GetPasswordIdentityByEmail(ctx context.Context, email string) (authentication.PasswordIdentity, error) {
	row, err := r.queries.GetPasswordIdentityByEmail(ctx, email)
	if errors.Is(err, pgx.ErrNoRows) {
		return authentication.PasswordIdentity{}, authentication.ErrIdentityNotFound
	}
	if err != nil {
		return authentication.PasswordIdentity{}, fmt.Errorf("get password identity by email: %w", err)
	}

	return authentication.PasswordIdentity{
		User:         mapAuthenticationUser(row.ID, row.Name, row.Email, row.UpdatedAt, row.CreatedAt),
		PasswordHash: row.PasswordHash.String,
	}, nil
}

func (r AuthenticationRepository) GetUserByAuthIdentity(ctx context.Context, provider string, subject string) (authentication.User, error) {
	user, err := r.queries.GetUserByAuthIdentity(ctx, sqlc.GetUserByAuthIdentityParams{
		Provider:        provider,
		ProviderSubject: subject,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return authentication.User{}, authentication.ErrIdentityNotFound
	}
	if err != nil {
		return authentication.User{}, fmt.Errorf("get user by auth identity: %w", err)
	}

	return mapAuthenticationUser(user.ID, user.Name, user.Email, user.UpdatedAt, user.CreatedAt), nil
}

func (r AuthenticationRepository) GetUserByEmail(ctx context.Context, email string) (authentication.User, error) {
	user, err := r.queries.GetUserByEmail(ctx, email)
	if errors.Is(err, pgx.ErrNoRows) {
		return authentication.User{}, authentication.ErrUserNotFound
	}
	if err != nil {
		return authentication.User{}, fmt.Errorf("get user by email: %w", err)
	}

	return mapAuthenticationUser(user.ID, user.Name, user.Email, user.UpdatedAt, user.CreatedAt), nil
}

func (r AuthenticationRepository) CreateSession(ctx context.Context, input authentication.CreateSessionInput) (authentication.Session, error) {
	session, err := r.queries.CreateLoginSession(ctx, sqlc.CreateLoginSessionParams{
		ID:        uuid(input.ID),
		UserID:    uuid(input.UserID),
		TokenHash: input.TokenHash,
		UserAgent: text(input.UserAgent),
		ExpiresAt: pgtype.Timestamptz{Time: input.ExpiresAt, Valid: true},
	})
	if err != nil {
		return authentication.Session{}, fmt.Errorf("create login session: %w", err)
	}

	return mapAuthenticationSession(session), nil
}

func (r AuthenticationRepository) GetSessionByTokenHash(ctx context.Context, tokenHash string) (authentication.SessionUser, error) {
	row, err := r.queries.GetLoginSessionByTokenHash(ctx, tokenHash)
	if errors.Is(err, pgx.ErrNoRows) {
		return authentication.SessionUser{}, authentication.ErrSessionNotFound
	}
	if err != nil {
		return authentication.SessionUser{}, fmt.Errorf("get login session by token hash: %w", err)
	}

	return authentication.SessionUser{
		Session: authentication.Session{
			ID:        utilities.IDFromBytes(row.SessionID.Bytes),
			UserID:    utilities.IDFromBytes(row.UserID.Bytes),
			TokenHash: row.TokenHash,
			UserAgent: nullableText(row.UserAgent),
			ExpiresAt: timestamp(row.ExpiresAt),
			RevokedAt: nullableTimestamp(row.RevokedAt),
			UpdatedAt: timestamp(row.SessionUpdatedAt),
			CreatedAt: timestamp(row.SessionCreatedAt),
		},
		User: mapAuthenticationUser(row.ID, row.Name, row.Email, row.UpdatedAt, row.CreatedAt),
	}, nil
}

func (r AuthenticationRepository) RevokeSession(ctx context.Context, sessionID utilities.ID, revokedAt time.Time) error {
	_, err := r.queries.RevokeLoginSession(ctx, sqlc.RevokeLoginSessionParams{
		ID:        uuid(sessionID),
		RevokedAt: pgtype.Timestamptz{Time: revokedAt, Valid: true},
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return authentication.ErrSessionNotFound
	}
	if err != nil {
		return fmt.Errorf("revoke login session: %w", err)
	}

	return nil
}

func mapAuthenticationSession(session sqlc.LoginSession) authentication.Session {
	return authentication.Session{
		ID:        utilities.IDFromBytes(session.ID.Bytes),
		UserID:    utilities.IDFromBytes(session.UserID.Bytes),
		TokenHash: session.TokenHash,
		UserAgent: nullableText(session.UserAgent),
		ExpiresAt: timestamp(session.ExpiresAt),
		RevokedAt: nullableTimestamp(session.RevokedAt),
		UpdatedAt: timestamp(session.UpdatedAt),
		CreatedAt: timestamp(session.CreatedAt),
	}
}

func mapAuthenticationUser(id pgtype.UUID, name string, email string, updatedAt pgtype.Timestamptz, createdAt pgtype.Timestamptz) authentication.User {
	return authentication.User{
		ID:        utilities.IDFromBytes(id.Bytes),
		Name:      name,
		Email:     email,
		UpdatedAt: timestamp(updatedAt),
		CreatedAt: timestamp(createdAt),
	}
}

func uniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

func uniqueConstraintViolation(err error, constraint string) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505" && pgErr.ConstraintName == constraint
}

var _ authentication.Repository = AuthenticationRepository{}
