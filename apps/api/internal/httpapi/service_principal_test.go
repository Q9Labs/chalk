package httpapi

import (
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
)

func TestServiceRateLimitIdentitySurvivesRotationAndSeparatesServices(t *testing.T) {
	first := authentication.Principal{Kind: authentication.PrincipalService, ServiceID: "dashboard"}
	rotated := authentication.Principal{Kind: authentication.PrincipalService, ServiceID: "dashboard"}
	other := authentication.Principal{Kind: authentication.PrincipalService, ServiceID: "other"}
	if principalRateLimitKey(first) != "service:dashboard" || principalRateLimitKey(first) != principalRateLimitKey(rotated) || principalRateLimitKey(first) == principalRateLimitKey(other) || principalRateLimitKey(first) == principalRateLimitKey(authentication.Principal{Kind: authentication.PrincipalSystem}) {
		t.Fatal("service rate-limit identities are not isolated and stable")
	}
}
