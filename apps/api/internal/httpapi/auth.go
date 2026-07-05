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
	Name     string `json:"name"`
	Email    string `json:"email"`
	Password string `json:"password"`
}

type loginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

func mountAuthRoutes(r chi.Router, service AuthenticationService, cookies SessionCookieOptions, limits RateLimitOptions) {
	r.With(rateLimit(limits, authRegisterRateLimit)).Post("/auth/register", handleRegister(service, cookies))
	r.With(rateLimit(limits, authLoginRateLimit)).Post("/auth/login", handleLogin(service, cookies))
	r.With(rateLimit(limits, authOAuthStartRateLimit)).Get("/auth/google/start", handleGoogleStart(service))
	r.With(rateLimit(limits, authOAuthCallbackRateLimit)).Get("/auth/google/callback", handleGoogleCallback(service, cookies))
	r.With(requireAuthentication(service)).Post("/auth/logout", handleLogout(service, cookies))
}

func handleRegister(service AuthenticationService, cookies SessionCookieOptions) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if service == nil {
			writeServiceUnavailable(w)
			return
		}

		var request registerRequest
		if err := decodeRequest(r, &request); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request", "Invalid request body")
			return
		}

		result, err := service.Register(r.Context(), authentication.RegisterInput{
			Name:      request.Name,
			Email:     request.Email,
			Password:  request.Password,
			UserAgent: requestUserAgent(r),
		})
		if writeAuthenticationServiceError(w, err) {
			return
		}

		setSessionCookie(w, result, cookies)
		writeJSON(w, http.StatusCreated, newAuthResponse(result))
	}
}

func handleLogin(service AuthenticationService, cookies SessionCookieOptions) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if service == nil {
			writeServiceUnavailable(w)
			return
		}

		var request loginRequest
		if err := decodeRequest(r, &request); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request", "Invalid request body")
			return
		}

		result, err := service.Login(r.Context(), authentication.LoginInput{
			Email:     request.Email,
			Password:  request.Password,
			UserAgent: requestUserAgent(r),
		})
		if writeAuthenticationServiceError(w, err) {
			return
		}

		setSessionCookie(w, result, cookies)
		writeJSON(w, http.StatusOK, newAuthResponse(result))
	}
}

func handleLogout(service AuthenticationService, cookies SessionCookieOptions) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		principal, ok := authentication.PrincipalFromContext(r.Context())
		if !ok {
			writeUnauthenticated(w)
			return
		}

		if err := service.Logout(r.Context(), principal); writeAuthenticationServiceError(w, err) {
			return
		}

		clearSessionCookie(w, cookies)
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	}
}

func handleGoogleStart(service AuthenticationService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if service == nil {
			writeServiceUnavailable(w)
			return
		}

		start, err := service.StartGoogleSignIn(r.Context())
		if writeAuthenticationServiceError(w, err) {
			return
		}

		http.Redirect(w, r, start.AuthorizationURL, http.StatusFound)
	}
}

func handleGoogleCallback(service AuthenticationService, cookies SessionCookieOptions) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if service == nil {
			writeServiceUnavailable(w)
			return
		}

		result, err := service.CompleteGoogleSignIn(
			r.Context(),
			r.URL.Query().Get("state"),
			r.URL.Query().Get("code"),
			requestUserAgent(r),
		)
		if writeAuthenticationServiceError(w, err) {
			return
		}

		setSessionCookie(w, result, cookies)
		writeJSON(w, http.StatusOK, newAuthResponse(result))
	}
}

func writeAuthenticationServiceError(w http.ResponseWriter, err error) bool {
	switch {
	case err == nil:
		return false
	case errors.Is(err, authentication.ErrInvalidEmail):
		writeError(w, http.StatusBadRequest, "invalid_email", "Invalid email")
	case errors.Is(err, authentication.ErrInvalidPassword):
		writeError(w, http.StatusBadRequest, "invalid_password", "Invalid password")
	case errors.Is(err, authentication.ErrInvalidUserName):
		writeError(w, http.StatusBadRequest, "invalid_user_name", "Invalid user name")
	case errors.Is(err, authentication.ErrEmailAlreadyRegistered):
		writeError(w, http.StatusConflict, "email_already_registered", "Email already registered")
	case errors.Is(err, authentication.ErrEmailVerificationRequired):
		writeError(w, http.StatusForbidden, "email_verification_required", "Email verification is required")
	case errors.Is(err, authentication.ErrInvalidCredentials):
		writeError(w, http.StatusUnauthorized, "invalid_credentials", "Invalid email or password")
	case errors.Is(err, authentication.ErrUnauthenticated):
		writeUnauthenticated(w)
	case errors.Is(err, authentication.ErrOAuthNotConfigured):
		writeError(w, http.StatusServiceUnavailable, "oauth_not_configured", "OAuth is not configured")
	case errors.Is(err, authentication.ErrOAuthStateNotFound):
		writeError(w, http.StatusBadRequest, "invalid_oauth_state", "Invalid OAuth state")
	case errors.Is(err, authentication.ErrOAuthEmailConflict):
		writeError(w, http.StatusConflict, "oauth_email_conflict", "Email is already registered with another sign-in method")
	case errors.Is(err, authentication.ErrOAuthEmailNotVerified):
		writeError(w, http.StatusUnauthorized, "oauth_email_not_verified", "Google email is not verified")
	default:
		writeError(w, http.StatusInternalServerError, "internal_error", "Internal server error")
	}

	return true
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
