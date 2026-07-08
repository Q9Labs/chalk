package main

import (
	"net/http"
	"testing"
)

func TestRunnerBearerTokenPrefersSessionForProtectedEndpoints(t *testing.T) {
	runner := runner{
		authToken:    "local-system-token",
		sessionToken: "seeded-session-token",
	}

	token := runner.bearerToken(endpoint{Name: "GET /v1/me"})
	if token != "seeded-session-token" {
		t.Fatalf("token = %q, want seeded session token", token)
	}
}

func TestRunnerBearerTokenOmitsPublicEndpoints(t *testing.T) {
	runner := runner{
		authToken:    "local-system-token",
		sessionToken: "seeded-session-token",
	}

	token := runner.bearerToken(endpoint{Name: "GET /healthz", Public: true})
	if token != "" {
		t.Fatalf("token = %q, want empty", token)
	}
}

func TestRunnerBearerTokenFallsBackToLocalSystemToken(t *testing.T) {
	runner := runner{authToken: "local-system-token"}

	token := runner.bearerToken(endpoint{Name: "GET /v1/tenants/{id}", Method: http.MethodGet})
	if token != "local-system-token" {
		t.Fatalf("token = %q, want local system token", token)
	}
}
