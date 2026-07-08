package httpapi

import (
	"context"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const sessionCookieName = "chalk_session"

type AuthenticationService interface {
	Register(ctx context.Context, input authentication.RegisterInput) (authentication.AuthResult, error)
	Login(ctx context.Context, input authentication.LoginInput) (authentication.AuthResult, error)
	AuthenticateSession(ctx context.Context, rawToken string) (authentication.SessionUser, error)
	PrincipalForSession(session authentication.Session) authentication.Principal
	Logout(ctx context.Context, principal authentication.Principal) error
	StartGoogleSignIn(ctx context.Context) (authentication.GoogleStart, error)
	CompleteGoogleSignIn(ctx context.Context, state string, code string, userAgent *string) (authentication.AuthResult, error)
}

type SessionCookieOptions struct {
	Secure bool
}

type authUserResponse struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Email     string `json:"email"`
	UpdatedAt string `json:"updated_at"`
	CreatedAt string `json:"created_at"`
}

type authResponse struct {
	SessionToken string           `json:"session_token"`
	ExpiresAt    string           `json:"expires_at"`
	User         authUserResponse `json:"user"`
}

type registerRequest struct {
	Name      string  `json:"name"`
	Email     string  `json:"email"`
	Password  string  `json:"password"`
	UserAgent *string `json:"-"`
}

type loginRequest struct {
	Email     string  `json:"email"`
	Password  string  `json:"password"`
	UserAgent *string `json:"-"`
}

type googleCallbackRequest struct {
	State     string
	Code      string
	UserAgent *string
}

type logoutRequest struct {
	Principal authentication.Principal
}

type statusResponse struct {
	Status string `json:"status"`
}

type authResultResponse struct {
	Result authentication.AuthResult
}

func mountAuthRoutes(r chi.Router, service AuthenticationService, cookies SessionCookieOptions, limits RateLimitOptions) {
	for _, endpoint := range authEndpoints(service, cookies) {
		endpoint.Mount(r, limits)
	}
}

func authEndpoints(service AuthenticationService, cookies SessionCookieOptions) []RouteEndpoint {
	return []RouteEndpoint{
		registerEndpoint(service, cookies),
		loginEndpoint(service, cookies),
		googleStartEndpoint(service),
		googleCallbackEndpoint(service, cookies),
		logoutEndpoint(service, cookies),
	}
}

func registerEndpoint(service AuthenticationService, cookies SessionCookieOptions) Endpoint[registerRequest, authResultResponse] {
	return Post("/v1/auth/register", "/auth/register", "register", decodeRegisterRequest, func(ctx context.Context, request registerRequest) (authResultResponse, error) {
		if service == nil {
			return authResultResponse{}, apiErrorServiceUnavailable
		}

		result, err := service.Register(ctx, authentication.RegisterInput{
			Name:      request.Name,
			Email:     request.Email,
			Password:  request.Password,
			UserAgent: request.UserAgent,
		})
		if err != nil {
			return authResultResponse{}, err
		}

		return authResultResponse{Result: result}, nil
	}).
		RateLimit(authRegisterRateLimit).
		RequestBody("RegisterRequest", registerRequest{}).
		Responds(http.StatusCreated, "Auth", authResponse{}).
		Errors(
			apiErrorServiceUnavailable,
			apiErrorInvalidRequest,
			apiErrorInvalidEmail,
			apiErrorInvalidPassword,
			apiErrorInvalidUserName,
			apiErrorEmailAlreadyRegistered,
			apiErrorEmailVerificationRequired,
			apiErrorRateLimited,
			apiErrorInternal,
		).
		MapErrors(authenticationAPIError).
		WriteWith(writeAuthResult(cookies))
}

func loginEndpoint(service AuthenticationService, cookies SessionCookieOptions) Endpoint[loginRequest, authResultResponse] {
	return Post("/v1/auth/login", "/auth/login", "login", decodeLoginRequest, func(ctx context.Context, request loginRequest) (authResultResponse, error) {
		if service == nil {
			return authResultResponse{}, apiErrorServiceUnavailable
		}

		result, err := service.Login(ctx, authentication.LoginInput{
			Email:     request.Email,
			Password:  request.Password,
			UserAgent: request.UserAgent,
		})
		if err != nil {
			return authResultResponse{}, err
		}

		return authResultResponse{Result: result}, nil
	}).
		RateLimit(authLoginRateLimit).
		RequestBody("LoginRequest", loginRequest{}).
		Responds(http.StatusOK, "Auth", authResponse{}).
		Errors(
			apiErrorServiceUnavailable,
			apiErrorInvalidRequest,
			apiErrorInvalidEmail,
			apiErrorInvalidPassword,
			apiErrorInvalidCredentials,
			apiErrorRateLimited,
			apiErrorInternal,
		).
		MapErrors(authenticationAPIError).
		WriteWith(writeAuthResult(cookies))
}

func googleStartEndpoint(service AuthenticationService) Endpoint[noRequest, authentication.GoogleStart] {
	return Get("/v1/auth/google/start", "/auth/google/start", "startGoogleSignIn", decodeNoRequest, func(ctx context.Context, request noRequest) (authentication.GoogleStart, error) {
		_ = request
		if service == nil {
			return authentication.GoogleStart{}, apiErrorServiceUnavailable
		}

		return service.StartGoogleSignIn(ctx)
	}).
		RateLimit(authOAuthStartRateLimit).
		RespondsNoBody(http.StatusFound).
		ResponseHeaders(APIHeaderContract{Name: "Location", Type: "string", Required: true}).
		Errors(
			apiErrorServiceUnavailable,
			apiErrorOAuthNotConfigured,
			apiErrorRateLimited,
			apiErrorInternal,
		).
		MapErrors(authenticationAPIError).
		WriteWith(writeGoogleStartRedirect)
}

func googleCallbackEndpoint(service AuthenticationService, cookies SessionCookieOptions) Endpoint[googleCallbackRequest, authResultResponse] {
	return Get("/v1/auth/google/callback", "/auth/google/callback", "completeGoogleSignIn", decodeGoogleCallbackRequest, func(ctx context.Context, request googleCallbackRequest) (authResultResponse, error) {
		if service == nil {
			return authResultResponse{}, apiErrorServiceUnavailable
		}

		result, err := service.CompleteGoogleSignIn(ctx, request.State, request.Code, request.UserAgent)
		if err != nil {
			return authResultResponse{}, err
		}

		return authResultResponse{Result: result}, nil
	}).
		RateLimit(authOAuthCallbackRateLimit).
		Parameters(
			APIParameterContract{Name: "state", In: "query", Type: "string", Required: true},
			APIParameterContract{Name: "code", In: "query", Type: "string", Required: true},
		).
		Responds(http.StatusOK, "Auth", authResponse{}).
		Errors(
			apiErrorServiceUnavailable,
			apiErrorInvalidOAuthState,
			apiErrorOAuthEmailConflict,
			apiErrorOAuthEmailNotVerified,
			apiErrorRateLimited,
			apiErrorInternal,
		).
		MapErrors(authenticationAPIError).
		WriteWith(writeAuthResult(cookies))
}

func logoutEndpoint(service AuthenticationService, cookies SessionCookieOptions) Endpoint[logoutRequest, statusResponse] {
	return Post("/v1/auth/logout", "/auth/logout", "logout", decodeLogoutRequest, func(ctx context.Context, request logoutRequest) (statusResponse, error) {
		if service == nil {
			return statusResponse{}, apiErrorServiceUnavailable
		}

		if err := service.Logout(ctx, request.Principal); err != nil {
			return statusResponse{}, err
		}

		return statusResponse{Status: "ok"}, nil
	}).
		Auth(APIAuthSessionOrBearer).
		Middleware(requireAuthentication(service)).
		Responds(http.StatusOK, "Status", statusResponse{}).
		Errors(
			apiErrorUnauthenticated,
			apiErrorServiceUnavailable,
			apiErrorInternal,
		).
		MapErrors(authenticationAPIError).
		WriteWith(writeLogout(cookies))
}

func decodeGoogleCallbackRequest(r *http.Request) (googleCallbackRequest, error) {
	return googleCallbackRequest{
		State:     r.URL.Query().Get("state"),
		Code:      r.URL.Query().Get("code"),
		UserAgent: requestUserAgent(r),
	}, nil
}

func decodeRegisterRequest(r *http.Request) (registerRequest, error) {
	request, err := decodeJSONBody[registerRequest](r)
	if err != nil {
		return registerRequest{}, err
	}
	request.UserAgent = requestUserAgent(r)
	return request, nil
}

func decodeLoginRequest(r *http.Request) (loginRequest, error) {
	request, err := decodeJSONBody[loginRequest](r)
	if err != nil {
		return loginRequest{}, err
	}
	request.UserAgent = requestUserAgent(r)
	return request, nil
}

func decodeLogoutRequest(r *http.Request) (logoutRequest, error) {
	principal, ok := authentication.PrincipalFromContext(r.Context())
	if !ok {
		return logoutRequest{}, apiErrorUnauthenticated
	}
	return logoutRequest{Principal: principal}, nil
}

func writeAuthResult(cookies SessionCookieOptions) EndpointWriter[authResultResponse] {
	return func(w http.ResponseWriter, r *http.Request, status int, response authResultResponse) {
		_ = r
		setSessionCookie(w, response.Result, cookies)
		writeJSON(w, status, newAuthResponse(response.Result))
	}
}

func writeGoogleStartRedirect(w http.ResponseWriter, r *http.Request, status int, response authentication.GoogleStart) {
	http.Redirect(w, r, response.AuthorizationURL, status)
}

func writeLogout(cookies SessionCookieOptions) EndpointWriter[statusResponse] {
	return func(w http.ResponseWriter, r *http.Request, status int, response statusResponse) {
		_ = r
		clearSessionCookie(w, cookies)
		writeJSON(w, status, response)
	}
}

func writeAuthenticationServiceError(w http.ResponseWriter, err error) bool {
	if err == nil {
		return false
	}
	if apiErr, ok := authenticationAPIError(err); ok {
		writeAPIError(w, apiErr)
		return true
	}
	writeAPIError(w, apiErrorInternal)
	return true
}

func authenticationAPIError(err error) (APIError, bool) {
	switch {
	case err == nil:
		return APIError{}, false
	case errors.Is(err, authentication.ErrInvalidEmail):
		return apiErrorInvalidEmail, true
	case errors.Is(err, authentication.ErrInvalidPassword):
		return apiErrorInvalidPassword, true
	case errors.Is(err, authentication.ErrInvalidUserName):
		return apiErrorInvalidUserName, true
	case errors.Is(err, authentication.ErrEmailAlreadyRegistered):
		return apiErrorEmailAlreadyRegistered, true
	case errors.Is(err, authentication.ErrEmailVerificationRequired):
		return apiErrorEmailVerificationRequired, true
	case errors.Is(err, authentication.ErrInvalidCredentials):
		return apiErrorInvalidCredentials, true
	case errors.Is(err, authentication.ErrUnauthenticated):
		return apiErrorUnauthenticated, true
	case errors.Is(err, authentication.ErrOAuthNotConfigured):
		return apiErrorOAuthNotConfigured, true
	case errors.Is(err, authentication.ErrOAuthStateNotFound):
		return apiErrorInvalidOAuthState, true
	case errors.Is(err, authentication.ErrOAuthEmailConflict):
		return apiErrorOAuthEmailConflict, true
	case errors.Is(err, authentication.ErrOAuthEmailNotVerified):
		return apiErrorOAuthEmailNotVerified, true
	default:
		return APIError{}, false
	}
}

func newAuthResponse(result authentication.AuthResult) authResponse {
	return authResponse{
		SessionToken: result.SessionToken,
		ExpiresAt:    utilities.FormatTimestamp(result.ExpiresAt),
		User:         newAuthUserResponse(result.User),
	}
}

func newAuthUserResponse(user authentication.User) authUserResponse {
	return authUserResponse{
		ID:        user.ID.String(),
		Name:      user.Name,
		Email:     user.Email,
		UpdatedAt: utilities.FormatTimestamp(user.UpdatedAt),
		CreatedAt: utilities.FormatTimestamp(user.CreatedAt),
	}
}

func setSessionCookie(w http.ResponseWriter, result authentication.AuthResult, options SessionCookieOptions) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    result.SessionToken,
		Path:     "/",
		Expires:  result.ExpiresAt,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   options.Secure,
	})
}

func clearSessionCookie(w http.ResponseWriter, options SessionCookieOptions) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   options.Secure,
	})
}

func requestUserAgent(r *http.Request) *string {
	value := r.UserAgent()
	if value == "" {
		return nil
	}

	return &value
}
