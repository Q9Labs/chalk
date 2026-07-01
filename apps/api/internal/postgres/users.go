package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/postgres/db"
	"github.com/q9labs/chalk/apps/api/internal/users"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type userQuerier interface {
	CreateUser(ctx context.Context, arg db.CreateUserParams) (db.User, error)
	GetUser(ctx context.Context, id pgtype.UUID) (db.User, error)
	ListUsers(ctx context.Context, arg db.ListUsersParams) ([]db.User, error)
}

type UserRepository struct {
	queries userQuerier
}

func NewUserRepository(queries userQuerier) UserRepository {
	return UserRepository{queries: queries}
}

func (r UserRepository) CreateUser(ctx context.Context, input users.CreateUserInput) (users.User, error) {
	user, err := r.queries.CreateUser(ctx, db.CreateUserParams{
		ID:    pgtype.UUID{Bytes: input.ID.Bytes(), Valid: true},
		Name:  input.Name,
		Email: input.Email,
	})
	if err != nil {
		return users.User{}, fmt.Errorf("create user: %w", err)
	}

	return mapUser(user), nil
}

func (r UserRepository) GetUser(ctx context.Context, id utilities.ID) (users.User, error) {
	user, err := r.queries.GetUser(ctx, pgtype.UUID{Bytes: id.Bytes(), Valid: true})
	if errors.Is(err, pgx.ErrNoRows) {
		return users.User{}, users.ErrUserNotFound
	}
	if err != nil {
		return users.User{}, fmt.Errorf("get user: %w", err)
	}

	return mapUser(user), nil
}

func (r UserRepository) ListUsers(ctx context.Context, page pagination.PageRequest) (users.UserList, error) {
	rows, err := r.queries.ListUsers(ctx, listUsersParams(page))
	if err != nil {
		return users.UserList{}, fmt.Errorf("list users: %w", err)
	}

	size := page.Size()
	hasMore := len(rows) > size
	if hasMore {
		rows = rows[:size]
	}

	response := users.UserList{
		Users: make([]users.User, 0, len(rows)),
		Page: pagination.Page{
			PageSize: size,
			HasMore:  hasMore,
		},
	}
	for _, row := range rows {
		response.Users = append(response.Users, mapUser(row))
	}

	if hasMore && len(response.Users) > 0 {
		lastUser := response.Users[len(response.Users)-1]
		response.Page.NextCursor = &pagination.Cursor{
			CreatedAt: lastUser.CreatedAt,
			ID:        lastUser.ID,
		}
	}

	return response, nil
}

func listUsersParams(page pagination.PageRequest) db.ListUsersParams {
	cursor := page.Cursor()
	params := db.ListUsersParams{
		PageSize: int32(page.Size() + 1),
	}
	if cursor == nil {
		return params
	}

	params.CursorSet = true
	params.CursorCreatedAt = pgtype.Timestamptz{Time: cursor.CreatedAt, Valid: true}
	params.CursorID = pgtype.UUID{Bytes: cursor.ID.Bytes(), Valid: true}
	return params
}

func mapUser(user db.User) users.User {
	return users.User{
		ID:        utilities.IDFromBytes(user.ID.Bytes),
		Name:      user.Name,
		Email:     user.Email,
		UpdatedAt: timestamp(user.UpdatedAt),
		CreatedAt: timestamp(user.CreatedAt),
	}
}

var _ users.UserRepository = UserRepository{}
