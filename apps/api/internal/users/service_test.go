package users_test

import (
	"context"
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/users"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestServiceCreateUser(t *testing.T) {
	repository := &userRepository{}
	service := users.NewService(repository)

	user, err := service.CreateUser(context.Background(), users.CreateUserInput{
		Name:  " Hasan ",
		Email: " HASAN@Example.COM ",
	})
	if err != nil {
		t.Fatalf("create user: %v", err)
	}

	if user.ID.IsZero() {
		t.Fatal("user id was not generated")
	}
	if repository.createInput.Name != "Hasan" {
		t.Fatalf("name = %q, want Hasan", repository.createInput.Name)
	}
	if repository.createInput.Email != "hasan@example.com" {
		t.Fatalf("email = %q, want hasan@example.com", repository.createInput.Email)
	}
}

func TestServiceCreateUserRejectsInvalidEmail(t *testing.T) {
	repository := &userRepository{}
	service := users.NewService(repository)

	_, err := service.CreateUser(context.Background(), users.CreateUserInput{
		Name:  "Hasan",
		Email: "not-email",
	})
	if !errors.Is(err, users.ErrInvalidUserEmail) {
		t.Fatalf("error = %v, want %v", err, users.ErrInvalidUserEmail)
	}
	if repository.called {
		t.Fatal("repository was called")
	}
}

func TestServiceGetUserRejectsZeroID(t *testing.T) {
	repository := &userRepository{}
	service := users.NewService(repository)

	_, err := service.GetUser(context.Background(), utilities.ID{})
	if !errors.Is(err, users.ErrInvalidUserID) {
		t.Fatalf("error = %v, want %v", err, users.ErrInvalidUserID)
	}
	if repository.called {
		t.Fatal("repository was called")
	}
}

type userRepository struct {
	called      bool
	requestedID utilities.ID
	createInput users.CreateUserInput
	listPage    pagination.PageRequest
	err         error
}

func (r *userRepository) CreateUser(ctx context.Context, input users.CreateUserInput) (users.User, error) {
	r.called = true
	r.createInput = input
	if r.err != nil {
		return users.User{}, r.err
	}

	return users.User{
		ID:    input.ID,
		Name:  input.Name,
		Email: input.Email,
	}, nil
}

func (r *userRepository) GetUser(ctx context.Context, id utilities.ID) (users.User, error) {
	r.called = true
	r.requestedID = id
	if r.err != nil {
		return users.User{}, r.err
	}

	return users.User{ID: id}, nil
}

func (r *userRepository) ListUsers(ctx context.Context, page pagination.PageRequest) (users.UserList, error) {
	r.called = true
	r.listPage = page
	if r.err != nil {
		return users.UserList{}, r.err
	}

	return users.UserList{
		Page: pagination.Page{PageSize: page.Size()},
	}, nil
}
