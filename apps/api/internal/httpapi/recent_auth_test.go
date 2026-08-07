package httpapi_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/recentauth"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type recentAuthService struct {
	issue     func(context.Context, recentauth.IssueInput) (recentauth.Proof, error)
	challenge func(context.Context, utilities.ID, string, string, string) (recentauth.Proof, error)
}

func (s recentAuthService) Issue(ctx context.Context, input recentauth.IssueInput) (recentauth.Proof, error) {
	if s.issue == nil {
		return recentauth.Proof{}, errors.New("unexpected recent-auth issue")
	}
	return s.issue(ctx, input)
}

func (recentAuthService) Verify(context.Context, string, utilities.ID, string, utilities.ID) error {
	return nil
}

func (s recentAuthService) IssueProviderChallenge(ctx context.Context, accountID utilities.ID, provider string, state string, code string) (recentauth.Proof, error) {
	if s.challenge == nil {
		return recentauth.Proof{}, errors.New("unexpected recent-auth provider challenge")
	}
	return s.challenge(ctx, accountID, provider, state, code)
}

func TestRecentAuthEndpointIssuesNoStoreActionBoundProof(t *testing.T) {
	expiresAt := time.Date(2026, 8, 4, 12, 0, 0, 0, time.UTC)
	var got recentauth.IssueInput
	res := authenticatedRequestWithOptionsAndBody(t, http.MethodPost, "/v1/me/recent-auth", `{"password":"correct horse","action":"api_key.create","resource_id":"33333333-3333-4333-8333-333333333333"}`, httpapi.Options{
		RecentAuth: recentAuthService{issue: func(_ context.Context, input recentauth.IssueInput) (recentauth.Proof, error) {
			got = input
			return recentauth.Proof{Value: "opaque-proof", ExpiresAt: expiresAt}, nil
		}},
	})
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}
	if got.AccountID.String() != "11111111-1111-4111-8111-111111111111" || got.Email != "hasan@example.com" || got.Password != "correct horse" || got.Action != "api_key.create" || got.ResourceID.IsZero() {
		t.Fatalf("issue input = %#v", got)
	}
	if res.Header().Get("Cache-Control") != "no-store" || res.Header().Get("Pragma") != "no-cache" {
		t.Fatalf("cache headers = %#v", res.Header())
	}
	var body struct {
		Proof     string `json:"proof"`
		ExpiresAt string `json:"expires_at"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body.Proof != "opaque-proof" || body.ExpiresAt == "" {
		t.Fatalf("response = %#v", body)
	}
}

func TestRecentAuthEndpointRejectsAPIKeyCredential(t *testing.T) {
	res := requestWithOptionsAndBody(t, http.MethodPost, "/v1/me/recent-auth", `{"password":"password","action":"api_key.create"}`, authenticatedOptions(t, httpapi.Options{
		RecentAuth: recentAuthService{issue: func(context.Context, recentauth.IssueInput) (recentauth.Proof, error) {
			t.Fatal("api-key credential must not issue proof")
			return recentauth.Proof{}, nil
		}},
	}))
	if res.Code != http.StatusUnauthorized {
		t.Fatalf("missing credential status = %d, want %d", res.Code, http.StatusUnauthorized)
	}
	request := bearerRequestWithBody(http.MethodPost, "/v1/me/recent-auth", "chalk_sk_not-a-login", `{"password":"password","action":"api_key.create"}`)
	res = requestWithOptionsAndRequest(t, request, authenticatedOptions(t, httpapi.Options{
		RecentAuth: recentAuthService{issue: func(context.Context, recentauth.IssueInput) (recentauth.Proof, error) {
			t.Fatal("api-key credential must not issue proof")
			return recentauth.Proof{}, nil
		}},
	}))
	if res.Code != http.StatusUnauthorized {
		t.Fatalf("api-key credential status = %d, want %d", res.Code, http.StatusUnauthorized)
	}
}

func TestRecentAuthEndpointMapsPasswordFailureAndInvalidResource(t *testing.T) {
	res := authenticatedRequestWithOptionsAndBody(t, http.MethodPost, "/v1/me/recent-auth", `{"password":"wrong","action":"api_key.create"}`, httpapi.Options{
		RecentAuth: recentAuthService{issue: func(context.Context, recentauth.IssueInput) (recentauth.Proof, error) {
			return recentauth.Proof{}, recentauth.ErrPasswordInvalid
		}},
	})
	if res.Code != http.StatusUnauthorized {
		t.Fatalf("password failure status = %d, want %d", res.Code, http.StatusUnauthorized)
	}
	assertErrorCode(t, res, "auth.invalid_recent_auth")

	res = authenticatedRequestWithOptionsAndBody(t, http.MethodPost, "/v1/me/recent-auth", `{"password":"password","action":"api_key.create","resource_id":"not-an-id"}`, httpapi.Options{
		RecentAuth: recentAuthService{issue: func(context.Context, recentauth.IssueInput) (recentauth.Proof, error) {
			t.Fatal("invalid resource must fail before service")
			return recentauth.Proof{}, nil
		}},
	})
	if res.Code != http.StatusBadRequest {
		t.Fatalf("invalid resource status = %d, want %d", res.Code, http.StatusBadRequest)
	}
}

func TestRecentAuthEndpointForwardsProviderCredential(t *testing.T) {
	var got recentauth.IssueInput
	res := authenticatedRequestWithOptionsAndBody(t, http.MethodPost, "/v1/me/recent-auth", `{"provider":"google","provider_state":"state-1","provider_code":"code-1","action":"api_key.create"}`, httpapi.Options{
		RecentAuth: recentAuthService{issue: func(_ context.Context, input recentauth.IssueInput) (recentauth.Proof, error) {
			got = input
			return recentauth.Proof{Value: "provider-proof", ExpiresAt: time.Date(2026, 8, 4, 12, 0, 0, 0, time.UTC)}, nil
		}},
	})
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}
	if got.Provider != "google" || got.ProviderState != "state-1" || got.ProviderCode != "code-1" || got.Password != "" || got.Action != "api_key.create" {
		t.Fatalf("provider issue input = %#v", got)
	}
}

func TestRecentAuthGoogleStartAndCallbackBindChallengeServerSide(t *testing.T) {
	accountID := mustID(t, "11111111-1111-4111-8111-111111111111")
	resourceID := mustID(t, "33333333-3333-4333-8333-333333333333")
	var startAccountID utilities.ID
	var startAction string
	var startResourceID utilities.ID
	startAuthentication := authenticationService{
		authenticateAccountCredential: func(context.Context, string) (authentication.SessionUser, error) {
			return authSessionUser(t), nil
		},
		startGoogleReauthentication: func(_ context.Context, gotAccountID utilities.ID, gotAction string, gotResourceID utilities.ID) (authentication.GoogleReauthenticationStart, error) {
			startAccountID, startAction, startResourceID = gotAccountID, gotAction, gotResourceID
			return authentication.GoogleReauthenticationStart{AuthorizationURL: "https://accounts.google.test/oauth", State: "opaque-state"}, nil
		},
	}
	res := requestWithOptionsAndRequest(t, bearerRequestWithBody(http.MethodGet, "/v1/me/recent-auth/google/start?action=api_key.create&resource_id="+resourceID.String(), authenticatedFixtureToken(), ""), httpapi.Options{
		Authentication: startAuthentication,
	})
	if res.Code != http.StatusOK {
		t.Fatalf("start status = %d, want %d", res.Code, http.StatusOK)
	}
	if startAccountID != accountID || startAction != "api_key.create" || startResourceID != resourceID {
		t.Fatalf("start binding = %s/%q/%s", startAccountID, startAction, startResourceID)
	}
	if res.Header().Get("Cache-Control") != "no-store" || res.Header().Get("Pragma") != "no-cache" {
		t.Fatalf("start cache headers = %#v", res.Header())
	}

	var callbackAccountID utilities.ID
	var callbackProvider, callbackState, callbackCode string
	res = requestWithOptionsAndRequest(t, bearerRequestWithBody(http.MethodGet, "/v1/me/recent-auth/google/callback?state=opaque-state&code=code-1", authenticatedFixtureToken(), ""), authenticatedOptions(t, httpapi.Options{
		RecentAuth: recentAuthService{challenge: func(_ context.Context, gotAccountID utilities.ID, gotProvider string, gotState string, gotCode string) (recentauth.Proof, error) {
			callbackAccountID, callbackProvider, callbackState, callbackCode = gotAccountID, gotProvider, gotState, gotCode
			return recentauth.Proof{Value: "callback-proof", ExpiresAt: time.Date(2026, 8, 4, 12, 0, 0, 0, time.UTC)}, nil
		}},
	}))
	if res.Code != http.StatusOK {
		t.Fatalf("callback status = %d, want %d", res.Code, http.StatusOK)
	}
	if callbackAccountID != accountID || callbackProvider != "google" || callbackState != "opaque-state" || callbackCode != "code-1" {
		t.Fatalf("callback binding = %s/%q/%q/%q", callbackAccountID, callbackProvider, callbackState, callbackCode)
	}
	if res.Header().Get("Cache-Control") != "no-store" || res.Header().Get("Pragma") != "no-cache" {
		t.Fatalf("callback cache headers = %#v", res.Header())
	}
}

func mustID(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatalf("parse test id: %v", err)
	}
	return id
}
