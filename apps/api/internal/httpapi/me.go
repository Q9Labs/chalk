package httpapi

import (
	"context"
	"net/http"

	"github.com/go-chi/chi/v5"
)

func mountMeRoutes(r chi.Router, service AuthenticationService, limits RateLimitOptions) {
	for _, endpoint := range meEndpoints(service) {
		endpoint.Mount(r, limits)
	}
}

func meEndpoints(service AuthenticationService) []RouteEndpoint {
	return []RouteEndpoint{
		meEndpoint(service),
	}
}

func meEndpoint(service AuthenticationService) Endpoint[noRequest, authUserResponse] {
	return Get("/v1/me", "/me", "getMe", decodeNoRequest, func(ctx context.Context, request noRequest) (authUserResponse, error) {
		_ = request
		sessionUser, ok := sessionUserFromContext(ctx)
		if !ok {
			return authUserResponse{}, apiErrorUnauthenticated
		}

		return newAuthUserResponse(sessionUser.User), nil
	}).
		Auth(APIAuthSessionOrBearer).
		Middleware(requireAuthentication(service)).
		RateLimit(authMeRateLimit).
		Responds(http.StatusOK, "AuthUser", authUserResponse{}).
		Errors(
			apiErrorUnauthenticated,
			apiErrorServiceUnavailable,
			apiErrorRateLimited,
			apiErrorInternal,
		).
		MapErrors(authenticationAPIError)
}
