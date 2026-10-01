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
	StorePasswordReset(ctx context.Context, arg sqlc.StorePasswordResetParams) error
	CompletePasswordReset(ctx context.Context, arg sqlc.CompletePasswordResetParams) (sqlc.User, error)
}

type AuthenticationRepository struct {
	queries    authenticationQuerier
	transactor authenticationTransactor
	decorate   func(sqlc.Querier) sqlc.Querier
}

type authenticationTransactor interface {
	BeginTx(context.Context, pgx.TxOptions) (pgx.Tx, error)
}

func NewAuthenticationRepository(queries authenticationQuerier, transactor authenticationTransactor, decorate func(sqlc.Querier) sqlc.Querier) AuthenticationRepository {
	return AuthenticationRepository{queries: queries, transactor: transactor, decorate: decorate}
}

func (r AuthenticationRepository) transactionQueries(tx pgx.Tx) sqlc.Querier {
	queries := sqlc.New(tx)
	if r.decorate != nil {
		return r.decorate(queries)
	}
	return queries
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
	tx, err := r.transactor.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return authentication.Session{}, fmt.Errorf("begin login issuance: %w", err)
	}
	defer tx.Rollback(ctx)
	queries := r.transactionQueries(tx)
	// Reset takes the same account lock before its revocation statement starts.
	if _, err := queries.LockAuthenticationAccount(ctx, uuid(input.UserID)); err != nil {
		return authentication.Session{}, fmt.Errorf("lock login Account: %w", err)
	}
	if input.ExpectedPasswordHash != nil {
		hash, err := queries.GetAccountPasswordHash(ctx, uuid(input.UserID))
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && (!hash.Valid || hash.String != *input.ExpectedPasswordHash)) {
			return authentication.Session{}, authentication.ErrInvalidCredentials
		}
		if err != nil {
			return authentication.Session{}, fmt.Errorf("check login credentials: %w", err)
		}
	}
	session, err := queries.CreateLoginSession(ctx, sqlc.CreateLoginSessionParams{
		ID:        uuid(input.ID),
		UserID:    uuid(input.UserID),
		TokenHash: input.TokenHash,
		UserAgent: text(input.UserAgent),
		ExpiresAt: pgtype.Timestamptz{Time: input.ExpiresAt, Valid: true},
	})
	if err != nil {
		return authentication.Session{}, fmt.Errorf("create login session: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return authentication.Session{}, fmt.Errorf("commit login issuance: %w", err)
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

func (r AuthenticationRepository) StorePasswordReset(ctx context.Context, input authentication.StorePasswordResetInput) error {
	err := r.queries.StorePasswordReset(ctx, sqlc.StorePasswordResetParams{
		AccountID: uuid(input.UserID), TokenHash: input.TokenHash,
		ExpiresAt: pgtype.Timestamptz{Time: input.ExpiresAt, Valid: true},
	})
	if err != nil {
		return fmt.Errorf("store password reset: %w", err)
	}
	return nil
}

func (r AuthenticationRepository) CompletePasswordReset(ctx context.Context, input authentication.CompletePasswordResetInput) (authentication.User, error) {
	tx, err := r.transactor.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return authentication.User{}, fmt.Errorf("begin password reset: %w", err)
	}
	defer tx.Rollback(ctx)
	queries := r.transactionQueries(tx)
	accountID, err := queries.GetPasswordResetAccount(ctx, input.TokenHash)
	if errors.Is(err, pgx.ErrNoRows) {
		return authentication.User{}, authentication.ErrPasswordResetTokenInvalid
	}
	if err != nil {
		return authentication.User{}, fmt.Errorf("find reset Account: %w", err)
	}
	if _, err := queries.LockAuthenticationAccount(ctx, accountID); err != nil {
		return authentication.User{}, fmt.Errorf("lock reset Account: %w", err)
	}
	user, err := queries.CompletePasswordReset(ctx, sqlc.CompletePasswordResetParams{
		TokenHash: input.TokenHash, PasswordHash: pgtype.Text{String: input.PasswordHash, Valid: true},
		CompletedAt: pgtype.Timestamptz{Time: input.CompletedAt, Valid: true},
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return authentication.User{}, authentication.ErrPasswordResetTokenInvalid
	}
	if err != nil {
		return authentication.User{}, fmt.Errorf("complete password reset: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return authentication.User{}, fmt.Errorf("commit password reset: %w", err)
	}
	return mapAuthenticationUser(user.ID, user.Name, user.Email, user.UpdatedAt, user.CreatedAt), nil
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
