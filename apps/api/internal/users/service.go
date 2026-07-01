package users

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	ErrInvalidUserID    = errors.New("invalid user id")
	ErrInvalidUserName  = errors.New("invalid user name")
	ErrInvalidUserEmail = errors.New("invalid user email")
	ErrUserNotFound     = errors.New("user not found")
)

type User struct {
	ID        utilities.ID
	Name      string
	Email     string
	UpdatedAt time.Time
	CreatedAt time.Time
}

type UserRepository interface {
	CreateUser(ctx context.Context, input CreateUserInput) (User, error)
	GetUser(ctx context.Context, id utilities.ID) (User, error)
	ListUsers(ctx context.Context, page pagination.PageRequest) (UserList, error)
}

type Service struct {
	repository UserRepository
}

type CreateUserInput struct {
	ID    utilities.ID
	Name  string
	Email string
}

type UserList struct {
	Users []User
	Page  pagination.Page
}

func NewService(repository UserRepository) Service {
	return Service{repository: repository}
}

func (s Service) CreateUser(ctx context.Context, input CreateUserInput) (User, error) {
	id, err := utilities.NewID()
	if err != nil {
		return User{}, err
	}

	input.ID = id
	if err := prepareCreateUserInput(&input); err != nil {
		return User{}, err
	}

	return s.repository.CreateUser(ctx, input)
}

func (s Service) GetUser(ctx context.Context, id utilities.ID) (User, error) {
	if id.IsZero() {
		return User{}, ErrInvalidUserID
	}

	return s.repository.GetUser(ctx, id)
}

func (s Service) ListUsers(ctx context.Context, page pagination.PageRequest) (UserList, error) {
	return s.repository.ListUsers(ctx, page)
}

func prepareCreateUserInput(input *CreateUserInput) error {
	name, err := utilities.RequiredString(input.Name)
	if err != nil {
		return ErrInvalidUserName
	}
	input.Name = name

	email, err := prepareEmail(input.Email)
	if err != nil {
		return ErrInvalidUserEmail
	}
	input.Email = email

	return nil
}

func prepareEmail(value string) (string, error) {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "" || !strings.Contains(value, "@") {
		return "", ErrInvalidUserEmail
	}

	return value, nil
}
