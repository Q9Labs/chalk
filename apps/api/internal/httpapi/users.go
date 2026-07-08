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

type listUsersRequest struct {
	Page pagination.PageRequest
}

type getUserRequest struct {
	UserID utilities.ID
}

func mountUserRoutes(r chi.Router, service UserService, limits RateLimitOptions) {
	for _, endpoint := range userEndpoints(service) {
		endpoint.Mount(r, limits)
	}
}

func userEndpoints(service UserService) []RouteEndpoint {
	return []RouteEndpoint{
		createUserEndpoint(service),
		listUsersEndpoint(service),
		getUserEndpoint(service),
	}
}

func createUserEndpoint(service UserService) Endpoint[createUserRequest, userResponse] {
	return Post("/v1/users", "/users", "createUser", decodeJSONBody[createUserRequest], func(ctx context.Context, request createUserRequest) (userResponse, error) {
		if service == nil {
			return userResponse{}, apiErrorServiceUnavailable
		}

		user, err := service.CreateUser(ctx, request.input())
		if err != nil {
			return userResponse{}, err
		}
		return newUserResponse(user), nil
	}).
		Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedWriteRateLimit).
		RequestBody("CreateUserRequest", createUserRequest{}).
		Responds(http.StatusCreated, "User", userResponse{}).
		Errors(
			apiErrorUnauthenticated,
			apiErrorServiceUnavailable,
			apiErrorInvalidRequest,
			apiErrorInvalidUserName,
			apiErrorInvalidUserEmail,
			apiErrorRateLimited,
			apiErrorInternal,
		).
		MapErrors(userServiceAPIError)
}

func listUsersEndpoint(service UserService) Endpoint[listUsersRequest, userListResponse] {
	return Get("/v1/users", "/users", "listUsers", decodeListUsersRequest, func(ctx context.Context, request listUsersRequest) (userListResponse, error) {
		if service == nil {
			return userListResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeGlobalRead(ctx); err != nil {
			return userListResponse{}, err
		}

		users, err := service.ListUsers(ctx, request.Page)
		if err != nil {
			return userListResponse{}, err
		}
		return newUserListResponse(users)
	}).
		Auth(APIAuthSessionOrBearer).
		Parameters(paginationParameters()...).
		Responds(http.StatusOK, "UserList", userListResponse{}).
		Errors(
			apiErrorUnauthenticated,
			apiErrorForbidden,
			apiErrorServiceUnavailable,
			apiErrorInvalidPageSize,
			apiErrorInvalidCursor,
			apiErrorInternal,
		).
		MapErrors(userEndpointAPIError)
}

func getUserEndpoint(service UserService) Endpoint[getUserRequest, userResponse] {
	return Get("/v1/users/{user_id}", "/users/{user_id}", "getUser", decodeGetUserRequest, func(ctx context.Context, request getUserRequest) (userResponse, error) {
		if service == nil {
			return userResponse{}, apiErrorServiceUnavailable
		}

		user, err := service.GetUser(ctx, request.UserID)
		if err != nil {
			return userResponse{}, err
		}
		return newUserResponse(user), nil
	}).
		Auth(APIAuthSessionOrBearer).
		Parameters(userIDParameter()).
		Responds(http.StatusOK, "User", userResponse{}).
		Errors(
			apiErrorUnauthenticated,
			apiErrorServiceUnavailable,
			apiErrorInvalidUserID,
			apiErrorUserNotFound,
			apiErrorInternal,
		).
		MapErrors(userServiceAPIError)
}

func decodeListUsersRequest(r *http.Request) (listUsersRequest, error) {
	page, err := parsePageRequest(r)
	if err != nil {
		return listUsersRequest{}, paginationAPIError(err)
	}
	return listUsersRequest{Page: page}, nil
}

func decodeGetUserRequest(r *http.Request) (getUserRequest, error) {
	userID, err := userIDRequest(r)
	if err != nil {
		return getUserRequest{}, err
	}
	return getUserRequest{UserID: userID}, nil
}

func userEndpointAPIError(err error) (APIError, bool) {
	if apiErr, ok := userServiceAPIError(err); ok {
		return apiErr, true
	}
	return authorizationAPIError(err), true
}

func userServiceAPIError(err error) (APIError, bool) {
	switch {
	case err == nil:
		return APIError{}, false
	case errors.Is(err, users.ErrInvalidUserID):
		return apiErrorInvalidUserID, true
	case errors.Is(err, users.ErrInvalidUserName):
		return apiErrorInvalidUserName, true
	case errors.Is(err, users.ErrInvalidUserEmail):
		return apiErrorInvalidUserEmail, true
	case errors.Is(err, users.ErrUserNotFound):
		return apiErrorUserNotFound, true
	default:
		return APIError{}, false
	}
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
