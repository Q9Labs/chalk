package httpapi

import (
	"context"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/users"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type UserService interface {
	CreateUser(ctx context.Context, input users.CreateUserInput) (users.User, error)
	GetUser(ctx context.Context, id utilities.ID) (users.User, error)
	ListUsers(ctx context.Context, page pagination.PageRequest) (users.UserList, error)
}

type userResponse struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Email     string `json:"email"`
	UpdatedAt string `json:"updated_at"`
	CreatedAt string `json:"created_at"`
}

type userListResponse struct {
	Users      []userResponse     `json:"users"`
	Pagination paginationResponse `json:"pagination"`
}

type createUserRequest struct {
	Name  string `json:"name"`
	Email string `json:"email"`
}

func mountUserRoutes(r chi.Router, service UserService) {
	r.Post("/users", handleCreateUser(service))
	r.Get("/users", handleListUsers(service))
	r.Get("/users/{user_id}", handleGetUser(service))
}

func handleCreateUser(service UserService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if service == nil {
			writeError(w, http.StatusServiceUnavailable, "service_unavailable", "Service is not ready")
			return
		}

		var request createUserRequest
		if err := decodeRequest(r, &request); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request", "Invalid request body")
			return
		}

		user, err := service.CreateUser(r.Context(), request.input())
		if writeUserServiceError(w, err) {
			return
		}

		writeJSON(w, http.StatusCreated, newUserResponse(user))
	}
}

func handleListUsers(service UserService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if service == nil {
			writeError(w, http.StatusServiceUnavailable, "service_unavailable", "Service is not ready")
			return
		}

		page, err := parsePageRequest(r)
		if writePaginationError(w, err) {
			return
		}

		users, err := service.ListUsers(r.Context(), page)
		if writeUserServiceError(w, err) {
			return
		}

		response, err := newUserListResponse(users)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal_error", "Internal server error")
			return
		}

		writeJSON(w, http.StatusOK, response)
	}
}

func handleGetUser(service UserService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if service == nil {
			writeError(w, http.StatusServiceUnavailable, "service_unavailable", "Service is not ready")
			return
		}

		id, err := utilities.ParseID(chi.URLParam(r, "user_id"))
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid_user_id", "Invalid user id")
			return
		}

		user, err := service.GetUser(r.Context(), id)
		if writeUserServiceError(w, err) {
			return
		}

		writeJSON(w, http.StatusOK, newUserResponse(user))
	}
}

func writeUserServiceError(w http.ResponseWriter, err error) bool {
	switch {
	case err == nil:
		return false
	case errors.Is(err, users.ErrInvalidUserID):
		writeError(w, http.StatusBadRequest, "invalid_user_id", "Invalid user id")
	case errors.Is(err, users.ErrInvalidUserName):
		writeError(w, http.StatusBadRequest, "invalid_user_name", "Invalid user name")
	case errors.Is(err, users.ErrInvalidUserEmail):
		writeError(w, http.StatusBadRequest, "invalid_user_email", "Invalid user email")
	case errors.Is(err, users.ErrUserNotFound):
		writeError(w, http.StatusNotFound, "not_found", "User not found")
	default:
		writeError(w, http.StatusInternalServerError, "internal_error", "Internal server error")
	}

	return true
}

func newUserListResponse(list users.UserList) (userListResponse, error) {
	page, err := newPaginationResponse(list.Page)
	if err != nil {
		return userListResponse{}, err
	}

	response := userListResponse{
		Users:      make([]userResponse, 0, len(list.Users)),
		Pagination: page,
	}
	for _, user := range list.Users {
		response.Users = append(response.Users, newUserResponse(user))
	}

	return response, nil
}

func newUserResponse(user users.User) userResponse {
	return userResponse{
		ID:        user.ID.String(),
		Name:      user.Name,
		Email:     user.Email,
		UpdatedAt: utilities.FormatTimestamp(user.UpdatedAt),
		CreatedAt: utilities.FormatTimestamp(user.CreatedAt),
	}
}

func (r createUserRequest) input() users.CreateUserInput {
	return users.CreateUserInput{
		Name:  r.Name,
		Email: r.Email,
	}
}
