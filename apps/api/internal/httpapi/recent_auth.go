package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/recentauth"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// RecentAuthService is the HTTP-facing issuance seam. Verification is kept on
// recentauth.Verifier so sensitive mutation handlers can depend on the narrow
// context-bound proof check instead of the issuance flow.
type RecentAuthService interface {
	Issue(context.Context, recentauth.IssueInput) (recentauth.Proof, error)
}

// RecentAuthProvider is the composition-root dependency. Keeping issuance
// and verification together at wiring time prevents a route from accidentally
// receiving an issuer without the verifier used by sensitive mutations.
type RecentAuthProvider interface {
	RecentAuthService
	recentauth.Verifier
}

type recentAuthGoogleStarter interface {
	StartGoogleReauthentication(context.Context, utilities.ID, string, utilities.ID) (authentication.GoogleReauthenticationStart, error)
}

type recentAuthProviderChallengeIssuer interface {
	IssueProviderChallenge(context.Context, utilities.ID, string, string, string) (recentauth.Proof, error)
}

type recentAuthRequest struct {
	Password      string  `json:"password"`
	Provider      string  `json:"provider"`
	ProviderState string  `json:"provider_state"`
	ProviderCode  string  `json:"provider_code"`
	Action        string  `json:"action"`
	ResourceID    *string `json:"resource_id"`
}

type recentAuthResponse struct {
	Proof     string `json:"proof"`
	ExpiresAt string `json:"expires_at"`
}

type recentAuthGoogleStartRequest struct {
	Action     string
	ResourceID *string
}

type recentAuthGoogleStartResponse struct {
	AuthorizationURL string `json:"authorization_url"`
	State            string `json:"state"`
}

type recentAuthGoogleCallbackRequest struct {
	State string
	Code  string
}

var apiErrorRecentAuthRequired = APIError{
	Status: http.StatusUnauthorized, Code: "auth.invalid_recent_auth", Message: "Recent authentication failed",
}

func recentAuthEndpoints(service AuthenticationService, recent RecentAuthService) []RouteEndpoint {
	return []RouteEndpoint{
		recentAuthEndpoint(service, recent),
		recentAuthGoogleStartEndpoint(service),
		recentAuthGoogleCallbackEndpoint(service, recent),
	}
}

func recentAuthEndpoint(service AuthenticationService, recent RecentAuthService) Endpoint[recentAuthRequest, recentAuthResponse] {
	return Post("/v1/me/recent-auth", "/me/recent-auth", "issueRecentAuthProof", decodeRecentAuthRequest, func(ctx context.Context, request recentAuthRequest) (recentAuthResponse, error) {
		if recent == nil {
			return recentAuthResponse{}, apiErrorServiceUnavailable
		}
		principal, ok := authentication.PrincipalFromContext(ctx)
		if !ok || principal.Kind != authentication.PrincipalUser || principal.UserID.IsZero() {
			return recentAuthResponse{}, apiErrorUnauthenticated
		}
		accountUser, ok := sessionUserFromContext(ctx)
		if !ok || accountUser.User.ID != principal.UserID {
			return recentAuthResponse{}, apiErrorUnauthenticated
		}
		resourceID, err := recentAuthResourceID(request.ResourceID)
		if err != nil {
			return recentAuthResponse{}, err
		}
		proof, err := recent.Issue(ctx, recentauth.IssueInput{
			AccountID:     principal.UserID,
			Email:         accountUser.User.Email,
			Password:      request.Password,
			Provider:      request.Provider,
			ProviderState: request.ProviderState,
			ProviderCode:  request.ProviderCode,
			Action:        request.Action,
			ResourceID:    resourceID,
		})
		if err != nil {
			return recentAuthResponse{}, err
		}
		return recentAuthResponse{Proof: proof.Value, ExpiresAt: utilities.FormatTimestamp(proof.ExpiresAt)}, nil
	}).
		UserAuth().
		Middleware(requireAuthentication(service)).
		RateLimit(authRecentAuthRateLimit).
		RequestBody("RecentAuthRequest", recentAuthRequest{}).
		Responds(http.StatusOK, "RecentAuth", recentAuthResponse{}).
		Errors(
			apiErrorUnauthenticated,
			apiErrorRecentAuthRequired,
			apiErrorServiceUnavailable,
			apiErrorInvalidRequest,
			apiErrorRateLimited,
			apiErrorInternal,
		).
		MapErrors(recentAuthAPIError).
		WriteWith(writeRecentAuthResponse)
}

func recentAuthGoogleStartEndpoint(service AuthenticationService) Endpoint[recentAuthGoogleStartRequest, recentAuthGoogleStartResponse] {
	return Get("/v1/me/recent-auth/google/start", "/me/recent-auth/google/start", "startRecentAuthGoogle", decodeRecentAuthGoogleStartRequest, func(ctx context.Context, request recentAuthGoogleStartRequest) (recentAuthGoogleStartResponse, error) {
		starter, ok := service.(recentAuthGoogleStarter)
		if !ok {
			return recentAuthGoogleStartResponse{}, apiErrorServiceUnavailable
		}
		principal, accountUser, ok := recentAuthAccount(ctx)
		if !ok {
			return recentAuthGoogleStartResponse{}, apiErrorUnauthenticated
		}
		resourceID, err := recentAuthResourceID(request.ResourceID)
		if err != nil {
			return recentAuthGoogleStartResponse{}, err
		}
		if err := recentauth.ValidateContext(principal.UserID, request.Action, resourceID); err != nil {
			return recentAuthGoogleStartResponse{}, err
		}
		start, err := starter.StartGoogleReauthentication(ctx, accountUser.User.ID, request.Action, resourceID)
		if err != nil {
			return recentAuthGoogleStartResponse{}, err
		}
		return recentAuthGoogleStartResponse{AuthorizationURL: start.AuthorizationURL, State: start.State}, nil
	}).
		UserAuth().
		Middleware(requireAuthentication(service)).
		RateLimit(authOAuthStartRateLimit).
		Parameters(
			APIParameterContract{Name: "action", In: "query", Type: "string", Required: true, MaxLength: recentauth.MaxActionBytes},
			APIParameterContract{Name: "resource_id", In: "query", Type: "string", Required: false},
		).
		Responds(http.StatusOK, "RecentAuthGoogleStart", recentAuthGoogleStartResponse{}).
		Errors(
			apiErrorUnauthenticated,
			apiErrorServiceUnavailable,
			apiErrorOAuthNotConfigured,
			apiErrorInvalidRequest,
			apiErrorRateLimited,
			apiErrorInternal,
		).
		MapErrors(recentAuthAPIError).
		WriteWith(writeRecentAuthGoogleStartResponse)
}

func recentAuthGoogleCallbackEndpoint(service AuthenticationService, recent RecentAuthService) Endpoint[recentAuthGoogleCallbackRequest, recentAuthResponse] {
	return Get("/v1/me/recent-auth/google/callback", "/me/recent-auth/google/callback", "completeRecentAuthGoogle", decodeRecentAuthGoogleCallbackRequest, func(ctx context.Context, request recentAuthGoogleCallbackRequest) (recentAuthResponse, error) {
		issuer, ok := recent.(recentAuthProviderChallengeIssuer)
		if !ok {
			return recentAuthResponse{}, apiErrorServiceUnavailable
		}
		principal, _, ok := recentAuthAccount(ctx)
		if !ok {
			return recentAuthResponse{}, apiErrorUnauthenticated
		}
		proof, err := issuer.IssueProviderChallenge(ctx, principal.UserID, authentication.ProviderGoogle, request.State, request.Code)
		if err != nil {
			return recentAuthResponse{}, err
		}
		return recentAuthResponse{Proof: proof.Value, ExpiresAt: utilities.FormatTimestamp(proof.ExpiresAt)}, nil
	}).
		UserAuth().
		Middleware(requireAuthentication(service)).
		RateLimit(authOAuthCallbackRateLimit).
		Parameters(
			APIParameterContract{Name: "state", In: "query", Type: "string", Required: true},
			APIParameterContract{Name: "code", In: "query", Type: "string", Required: true},
		).
		Responds(http.StatusOK, "RecentAuth", recentAuthResponse{}).
		Errors(
			apiErrorUnauthenticated,
			apiErrorRecentAuthRequired,
			apiErrorServiceUnavailable,
			apiErrorOAuthNotConfigured,
			apiErrorRateLimited,
			apiErrorInternal,
		).
		MapErrors(recentAuthAPIError).
		WriteWith(writeRecentAuthResponse)
}

func recentAuthAccount(ctx context.Context) (authentication.Principal, authentication.SessionUser, bool) {
	principal, ok := authentication.PrincipalFromContext(ctx)
	if !ok || principal.Kind != authentication.PrincipalUser || principal.UserID.IsZero() {
		return authentication.Principal{}, authentication.SessionUser{}, false
	}
	accountUser, ok := sessionUserFromContext(ctx)
	if !ok || accountUser.User.ID != principal.UserID {
		return authentication.Principal{}, authentication.SessionUser{}, false
	}
	return principal, accountUser, true
}

func decodeRecentAuthRequest(r *http.Request) (recentAuthRequest, error) {
	request, err := decodeJSONBody[recentAuthRequest](r)
	if err != nil {
		return recentAuthRequest{}, err
	}
	request.Action = strings.TrimSpace(request.Action)
	request.Provider = strings.TrimSpace(request.Provider)
	request.ProviderState = strings.TrimSpace(request.ProviderState)
	request.ProviderCode = strings.TrimSpace(request.ProviderCode)
	return request, nil
}

func decodeRecentAuthGoogleStartRequest(r *http.Request) (recentAuthGoogleStartRequest, error) {
	return recentAuthGoogleStartRequest{
		Action:     strings.TrimSpace(r.URL.Query().Get("action")),
		ResourceID: queryValue(r.URL.Query().Get("resource_id")),
	}, nil
}

func decodeRecentAuthGoogleCallbackRequest(r *http.Request) (recentAuthGoogleCallbackRequest, error) {
	return recentAuthGoogleCallbackRequest{
		State: strings.TrimSpace(r.URL.Query().Get("state")),
		Code:  strings.TrimSpace(r.URL.Query().Get("code")),
	}, nil
}

func queryValue(value string) *string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return &value
}

func recentAuthResourceID(value *string) (utilities.ID, error) {
	if value == nil || strings.TrimSpace(*value) == "" {
		return utilities.ID{}, nil
	}
	id, err := utilities.ParseID(*value)
	if err != nil {
		return utilities.ID{}, apiErrorInvalidRequest
	}
	return id, nil
}

func recentAuthAPIError(err error) (APIError, bool) {
	switch {
	case errors.Is(err, recentauth.ErrPasswordInvalid), errors.Is(err, recentauth.ErrProviderInvalid):
		return apiErrorRecentAuthRequired, true
	case errors.Is(err, recentauth.ErrInvalidInput), errors.Is(err, recentauth.ErrMalformedAction):
		return apiErrorInvalidRequest, true
	case errors.Is(err, recentauth.ErrSecretNotConfigured), errors.Is(err, recentauth.ErrPasswordVerifierMissing), errors.Is(err, recentauth.ErrProviderVerifierMissing):
		return apiErrorServiceUnavailable, true
	default:
		return authenticationAPIError(err)
	}
}

func writeRecentAuthGoogleStartResponse(w http.ResponseWriter, r *http.Request, status int, response recentAuthGoogleStartResponse) {
	_ = r
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	writeJSON(w, status, response)
}

func writeRecentAuthResponse(w http.ResponseWriter, r *http.Request, status int, response recentAuthResponse) {
	_ = r
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	writeJSON(w, status, response)
}
