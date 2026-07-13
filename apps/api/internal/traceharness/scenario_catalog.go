package traceharness

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/email"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/memberships"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/ratelimit"
	"github.com/q9labs/chalk/apps/api/internal/regions"
	"github.com/q9labs/chalk/apps/api/internal/rooms"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"github.com/q9labs/chalk/apps/api/internal/users"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const (
	RouteAuthRegisterScenario           = "route:auth-register"
	RouteAuthLoginScenario              = "route:auth-login"
	RouteAuthLogoutScenario             = "route:auth-logout"
	RouteAuthGoogleStartScenario        = "route:auth-google-start"
	RouteAuthGoogleCallbackScenario     = "route:auth-google-callback"
	RouteMeScenario                     = "route:me"
	RouteTenantCreateScenario           = "route:tenant-create"
	RouteTenantListSystemScenario       = "route:tenant-list-system"
	RouteTenantGetAuthorizedScenario    = "route:tenant-get-authorized"
	RouteTenantUpdateAuthorizedScenario = "route:tenant-update-authorized"
	RouteRegionsListScenario            = "route:regions-list"
	RouteUserCreateScenario             = "route:user-create"
	RouteUserListSystemScenario         = "route:user-list-system"
	RouteUserGetScenario                = "route:user-get"
	RouteMembershipCreateOwnerScenario  = "route:membership-create-owner"
	RouteMembershipListViewerScenario   = "route:membership-list-viewer"
	RouteMembershipUpdateOwnerScenario  = "route:membership-update-owner"
	RouteRoomCreateMemberScenario       = "route:room-create-member"
	RouteSessionCreateMemberScenario    = "route:session-create-member"
	RouteSessionEndMemberScenario       = "route:session-end-member"
	RouteSessionSyncTokenScenario       = "route:session-sync-token"
	RouteRecordingTranscribeScenario    = "route:recording-transcribe"
	RouteJourneyEventIntakeScenario     = "route:telemetry-journey-event-intake"

	PolicyTenantSystemAllowScenario = "policy:tenant-system-allow"
	PolicyTenantAPIKeyScopeScenario = "policy:tenant-api-key-scope"
	PolicyTenantUserRoleScenario    = "policy:tenant-user-role"

	RateLimitIPDenyScenario        = "ratelimit:ip-deny"
	RateLimitPrincipalDenyScenario = "ratelimit:principal-deny"

	AdapterPostgresTenantCreateScenario   = "adapter:postgres-tenant-create"
	AdapterRedisRateLimitScenario         = "adapter:redis-rate-limit"
	AdapterCloudflareR2SignedURLScenario  = "adapter:cloudflare-r2-signed-url"
	AdapterCloudflareSFUBootstrapScenario = "adapter:cloudflare-sfu-bootstrap"
	AdapterCloudflareRTKJoinScenario      = "adapter:cloudflare-rtk-join"
	AdapterResendSendEmailScenario        = "adapter:resend-send-email"

	EdgeUnauthenticatedRouteScenario = "edge:unauthenticated-route"
	EdgeForbiddenTenantRouteScenario = "edge:forbidden-tenant-route"
	EdgeInvalidRouteIDScenario       = "edge:invalid-route-id"
)

// ScenarioNames returns every scenario accepted by Run, in review order.
func ScenarioNames() []string {
	return []string{
		CreateTenantScenario,
		ExecuteIntegrationActionScenario,
		RouteAuthRegisterScenario,
		RouteAuthLoginScenario,
		RouteAuthLogoutScenario,
		RouteAuthGoogleStartScenario,
		RouteAuthGoogleCallbackScenario,
		RouteMeScenario,
		RouteTenantCreateScenario,
		RouteTenantListSystemScenario,
		RouteTenantGetAuthorizedScenario,
		RouteTenantUpdateAuthorizedScenario,
		RouteRegionsListScenario,
		RouteUserCreateScenario,
		RouteUserListSystemScenario,
		RouteUserGetScenario,
		RouteMembershipCreateOwnerScenario,
		RouteMembershipListViewerScenario,
		RouteMembershipUpdateOwnerScenario,
		RouteRoomCreateMemberScenario,
		RouteSessionCreateMemberScenario,
		RouteSessionEndMemberScenario,
		RouteSessionSyncTokenScenario,
		RouteRecordingTranscribeScenario,
		RouteJourneyEventIntakeScenario,
		PolicyTenantSystemAllowScenario,
		PolicyTenantAPIKeyScopeScenario,
		PolicyTenantUserRoleScenario,
		RateLimitIPDenyScenario,
		RateLimitPrincipalDenyScenario,
		AdapterPostgresTenantCreateScenario,
		AdapterRedisRateLimitScenario,
		AdapterCloudflareR2SignedURLScenario,
		AdapterCloudflareSFUBootstrapScenario,
		AdapterCloudflareRTKJoinScenario,
		AdapterResendSendEmailScenario,
		EdgeUnauthenticatedRouteScenario,
		EdgeForbiddenTenantRouteScenario,
		EdgeInvalidRouteIDScenario,
		WebhookDeliveryAttemptScenario,
	}
}

func runRouteAuthRegister(ctx context.Context) (ScenarioResult, error) {
	now := deterministicClock()
	recorder := NewRecorder(now)
	auth := newTracedAuthenticationService(recorder, now)
	body := json.RawMessage(`{"name":"  Ada Trace  ","email":" ADA@EXAMPLE.TEST ","password":"correct horse battery"}`)

	return runRouteTrace(ctx, routeTraceConfig{
		Name:     RouteAuthRegisterScenario,
		Recorder: recorder,
		Handler: httpapi.NewRouter(httpapi.Options{
			RateLimit:      noRateLimits(now),
			Authentication: auth,
			SessionCookie:  httpapi.SessionCookieOptions{Secure: true},
		}),
		Method:         http.MethodPost,
		Path:           "/v1/auth/register",
		Body:           body,
		ExpectedStatus: http.StatusCreated,
	})
}

func runRouteAuthLogin(ctx context.Context) (ScenarioResult, error) {
	now := deterministicClock()
	recorder := NewRecorder(now)
	auth := newTracedAuthenticationService(recorder, now)
	auth.repository.passwordIdentity = authentication.PasswordIdentity{
		User:         authUserFixture(now),
		PasswordHash: "bcrypt$trace-password",
	}
	body := json.RawMessage(`{"email":" TRACE-REVIEWER@EXAMPLE.TEST ","password":"correct horse battery"}`)

	return runRouteTrace(ctx, routeTraceConfig{
		Name:     RouteAuthLoginScenario,
		Recorder: recorder,
		Handler: httpapi.NewRouter(httpapi.Options{
			RateLimit:      noRateLimits(now),
			Authentication: auth,
			SessionCookie:  httpapi.SessionCookieOptions{Secure: true},
		}),
		Method:         http.MethodPost,
		Path:           "/v1/auth/login",
		Body:           body,
		ExpectedStatus: http.StatusOK,
	})
}

func runRouteAuthLogout(ctx context.Context) (ScenarioResult, error) {
	now := deterministicClock()
	recorder := NewRecorder(now)
	auth := newTracedAuthenticationService(recorder, now)
	auth.repository.sessionUser = sessionUserFixture(now)

	return runRouteTrace(ctx, routeTraceConfig{
		Name:     RouteAuthLogoutScenario,
		Recorder: recorder,
		Handler: httpapi.NewRouter(httpapi.Options{
			RateLimit:      noRateLimits(now),
			Authentication: auth,
			SessionCookie:  httpapi.SessionCookieOptions{Secure: true},
		}),
		Method:         http.MethodPost,
		Path:           "/v1/auth/logout",
		Authorization:  "Bearer trace-session-token",
		ExpectedStatus: http.StatusOK,
	})
}

func runRouteAuthGoogleStart(ctx context.Context) (ScenarioResult, error) {
	now := deterministicClock()
	recorder := NewRecorder(now)
	auth := newTracedAuthenticationService(recorder, now)

	return runRouteTrace(ctx, routeTraceConfig{
		Name:     RouteAuthGoogleStartScenario,
		Recorder: recorder,
		Handler: httpapi.NewRouter(httpapi.Options{
			RateLimit:      noRateLimits(now),
			Authentication: auth,
		}),
		Method:         http.MethodGet,
		Path:           "/v1/auth/google/start",
		ExpectedStatus: http.StatusFound,
	})
}

func runRouteAuthGoogleCallback(ctx context.Context) (ScenarioResult, error) {
	now := deterministicClock()
	recorder := NewRecorder(now)
	auth := newTracedAuthenticationService(recorder, now)
	auth.repository.authIdentityErr = authentication.ErrIdentityNotFound
	auth.repository.userByEmailErr = authentication.ErrUserNotFound

	return runRouteTrace(ctx, routeTraceConfig{
		Name:     RouteAuthGoogleCallbackScenario,
		Recorder: recorder,
		Handler: httpapi.NewRouter(httpapi.Options{
			RateLimit:      noRateLimits(now),
			Authentication: auth,
			SessionCookie:  httpapi.SessionCookieOptions{Secure: true},
		}),
		Method:         http.MethodGet,
		Path:           "/v1/auth/google/callback?state=trace-oauth-state&code=trace-auth-code",
		ExpectedStatus: http.StatusOK,
	})
}

func runRouteMe(ctx context.Context) (ScenarioResult, error) {
	now := deterministicClock()
	recorder := NewRecorder(now)
	auth := staticAuthentication{
		recorder:    recorder,
		now:         now,
		principal:   userPrincipal(),
		sessionUser: sessionUserFixture(now),
	}

	return runRouteTrace(ctx, routeTraceConfig{
		Name:     RouteMeScenario,
		Recorder: recorder,
		Handler: httpapi.NewRouter(httpapi.Options{
			RateLimit:      noRateLimits(now),
			Authentication: auth,
		}),
		Method:         http.MethodGet,
		Path:           "/v1/me",
		Authorization:  "Bearer trace-session-token",
		ExpectedStatus: http.StatusOK,
	})
}

func runRouteTenantListSystem(ctx context.Context) (ScenarioResult, error) {
	now := deterministicClock()
	recorder := NewRecorder(now)

	return runRouteTrace(ctx, routeTraceConfig{
		Name:     RouteTenantListSystemScenario,
		Recorder: recorder,
		Handler: routerWithCoreServices(recorder, now, coreOptions{
			Principal: systemPrincipal(),
		}),
		Method:         http.MethodGet,
		Path:           "/v1/tenants?page_size=2",
		Authorization:  "Bearer trace-system-token",
		ExpectedStatus: http.StatusOK,
	})
}

func runRouteTenantGetAuthorized(ctx context.Context) (ScenarioResult, error) {
	now := deterministicClock()
	recorder := NewRecorder(now)

	return runRouteTrace(ctx, routeTraceConfig{
		Name:     RouteTenantGetAuthorizedScenario,
		Recorder: recorder,
		Handler: routerWithCoreServices(recorder, now, coreOptions{
			Principal:  userPrincipal(),
			PolicyRole: memberships.RoleViewer,
		}),
		Method:         http.MethodGet,
		Path:           "/v1/tenants/" + tenantID().String(),
		Authorization:  "Bearer trace-session-token",
		ExpectedStatus: http.StatusOK,
	})
}

func runRouteTenantUpdateAuthorized(ctx context.Context) (ScenarioResult, error) {
	now := deterministicClock()
	recorder := NewRecorder(now)
	body := json.RawMessage(`{"name":"  Chalk Studio  ","default_region":"sg","website":null}`)

	return runRouteTrace(ctx, routeTraceConfig{
		Name:     RouteTenantUpdateAuthorizedScenario,
		Recorder: recorder,
		Handler: routerWithCoreServices(recorder, now, coreOptions{
			Principal:  userPrincipal(),
			PolicyRole: memberships.RoleAdmin,
		}),
		Method:         http.MethodPatch,
		Path:           "/v1/tenants/" + tenantID().String(),
		Body:           body,
		Authorization:  "Bearer trace-session-token",
		ExpectedStatus: http.StatusOK,
	})
}

func runRouteRegionsList(ctx context.Context) (ScenarioResult, error) {
	now := deterministicClock()
	recorder := NewRecorder(now)

	return runRouteTrace(ctx, routeTraceConfig{
		Name:     RouteRegionsListScenario,
		Recorder: recorder,
		Handler: routerWithCoreServices(recorder, now, coreOptions{
			Principal: userPrincipal(),
		}),
		Method:         http.MethodGet,
		Path:           "/v1/regions",
		Authorization:  "Bearer trace-session-token",
		ExpectedStatus: http.StatusOK,
	})
}

func runRouteUserCreate(ctx context.Context) (ScenarioResult, error) {
	now := deterministicClock()
	recorder := NewRecorder(now)
	body := json.RawMessage(`{"name":"  Grace Trace  ","email":" GRACE@EXAMPLE.TEST "}`)

	return runRouteTrace(ctx, routeTraceConfig{
		Name:     RouteUserCreateScenario,
		Recorder: recorder,
		Handler: routerWithCoreServices(recorder, now, coreOptions{
			Principal: userPrincipal(),
		}),
		Method:         http.MethodPost,
		Path:           "/v1/users",
		Body:           body,
		Authorization:  "Bearer trace-session-token",
		ExpectedStatus: http.StatusCreated,
	})
}

func runRouteUserListSystem(ctx context.Context) (ScenarioResult, error) {
	now := deterministicClock()
	recorder := NewRecorder(now)

	return runRouteTrace(ctx, routeTraceConfig{
		Name:     RouteUserListSystemScenario,
		Recorder: recorder,
		Handler: routerWithCoreServices(recorder, now, coreOptions{
			Principal: systemPrincipal(),
		}),
		Method:         http.MethodGet,
		Path:           "/v1/users?page_size=2",
		Authorization:  "Bearer trace-system-token",
		ExpectedStatus: http.StatusOK,
	})
}

func runRouteUserGet(ctx context.Context) (ScenarioResult, error) {
	now := deterministicClock()
	recorder := NewRecorder(now)

	return runRouteTrace(ctx, routeTraceConfig{
		Name:     RouteUserGetScenario,
		Recorder: recorder,
		Handler: routerWithCoreServices(recorder, now, coreOptions{
			Principal: userPrincipal(),
		}),
		Method:         http.MethodGet,
		Path:           "/v1/users/" + userID().String(),
		Authorization:  "Bearer trace-session-token",
		ExpectedStatus: http.StatusOK,
	})
}

func runRouteMembershipCreateOwner(ctx context.Context) (ScenarioResult, error) {
	now := deterministicClock()
	recorder := NewRecorder(now)
	body := json.RawMessage(`{"user_id":"` + userID().String() + `","role":"member"}`)

	return runRouteTrace(ctx, routeTraceConfig{
		Name:     RouteMembershipCreateOwnerScenario,
		Recorder: recorder,
		Handler: routerWithCoreServices(recorder, now, coreOptions{
			Principal:  userPrincipal(),
			PolicyRole: memberships.RoleOwner,
		}),
		Method:         http.MethodPost,
		Path:           "/v1/tenants/" + tenantID().String() + "/memberships",
		Body:           body,
		Authorization:  "Bearer trace-session-token",
		ExpectedStatus: http.StatusCreated,
	})
}

func runRouteMembershipListViewer(ctx context.Context) (ScenarioResult, error) {
	now := deterministicClock()
	recorder := NewRecorder(now)

	return runRouteTrace(ctx, routeTraceConfig{
		Name:     RouteMembershipListViewerScenario,
		Recorder: recorder,
		Handler: routerWithCoreServices(recorder, now, coreOptions{
			Principal:  userPrincipal(),
			PolicyRole: memberships.RoleViewer,
		}),
		Method:         http.MethodGet,
		Path:           "/v1/tenants/" + tenantID().String() + "/memberships?page_size=2",
		Authorization:  "Bearer trace-session-token",
		ExpectedStatus: http.StatusOK,
	})
}

func runRouteMembershipUpdateOwner(ctx context.Context) (ScenarioResult, error) {
	now := deterministicClock()
	recorder := NewRecorder(now)
	body := json.RawMessage(`{"role":"admin"}`)

	return runRouteTrace(ctx, routeTraceConfig{
		Name:     RouteMembershipUpdateOwnerScenario,
		Recorder: recorder,
		Handler: routerWithCoreServices(recorder, now, coreOptions{
			Principal:  userPrincipal(),
			PolicyRole: memberships.RoleOwner,
		}),
		Method:         http.MethodPatch,
		Path:           "/v1/tenants/" + tenantID().String() + "/memberships/" + membershipID().String(),
		Body:           body,
		Authorization:  "Bearer trace-session-token",
		ExpectedStatus: http.StatusOK,
	})
}

func runRouteRoomCreateMember(ctx context.Context) (ScenarioResult, error) {
	now := deterministicClock()
	recorder := NewRecorder(now)
	body := json.RawMessage(`{"name":"  Daily Review  ","status":"active","slug":"daily-review","media_plane":"cf_rtk","metadata":{"purpose":"review"}}`)

	return runRouteTrace(ctx, routeTraceConfig{
		Name:     RouteRoomCreateMemberScenario,
		Recorder: recorder,
		Handler: routerWithCoreServices(recorder, now, coreOptions{
			Principal:  userPrincipal(),
			PolicyRole: memberships.RoleMember,
		}),
		Method:         http.MethodPost,
		Path:           "/v1/tenants/" + tenantID().String() + "/rooms",
		Body:           body,
		Authorization:  "Bearer trace-session-token",
		ExpectedStatus: http.StatusCreated,
	})
}

func runRouteRecordingTranscribe(ctx context.Context) (ScenarioResult, error) {
	now := deterministicClock()
	recorder := NewRecorder(now)
	body := json.RawMessage(`{"idempotency_key":"trace-transcript-1","language":"en"}`)

	return runRouteTrace(ctx, routeTraceConfig{
		Name:     RouteRecordingTranscribeScenario,
		Recorder: recorder,
		Handler: httpapi.NewRouter(httpapi.Options{
			RateLimit: noRateLimits(now),
			Authentication: staticAuthentication{
				recorder:    recorder,
				now:         now,
				principal:   userPrincipal(),
				sessionUser: sessionUserFixture(now),
			},
			TenantAuthz: authorization.NewTenantPolicy(tracedMembershipRepository{
				recorder:   recorder,
				now:        now,
				policyRole: memberships.RoleMember,
			}),
			TranscriptArtifacts: tracedTranscriptArtifactService{recorder: recorder, now: now},
		}),
		Method:         http.MethodPost,
		Path:           "/v1/tenants/" + tenantID().String() + "/recordings/" + recordingID().String() + "/transcripts",
		Body:           body,
		Authorization:  "Bearer trace-session-token",
		ExpectedStatus: http.StatusAccepted,
	})
}

func runPolicyTenantSystemAllow(ctx context.Context) (ScenarioResult, error) {
	now := deterministicClock()
	recorder := NewRecorder(now)
	policy := authorization.NewTenantPolicy(tracedMembershipRepository{recorder: recorder, now: now})
	permission := authorization.TenantPermission{Scope: authentication.ScopeTenantsWrite, MinimumRole: memberships.RoleAdmin}
	span := recorder.Start("policy", "TenantPolicy.AuthorizeTenant", "authorize system principal for tenant write", map[string]any{
		"principal":  principalFields(systemPrincipal()),
		"tenant_id":  tenantID().String(),
		"permission": tenantPermissionFields(permission),
	})
	err := policy.AuthorizeTenant(ctx, systemPrincipal(), tenantID(), permission)
	span.End("policy allowed system principal", map[string]any{"allowed": err == nil}, err)
	return directResult(PolicyTenantSystemAllowScenario, http.StatusOK, recorder, map[string]any{"allowed": err == nil}, err)
}

func runPolicyTenantAPIKeyScope(ctx context.Context) (ScenarioResult, error) {
	now := deterministicClock()
	recorder := NewRecorder(now)
	principal := authentication.Principal{
		Kind:     authentication.PrincipalAPIKey,
		TenantID: tenantID(),
		APIKeyID: apiKeyID(),
		Scopes:   []authentication.Scope{authentication.ScopeTenantsRead},
	}
	policy := authorization.NewTenantPolicy(nil)
	permission := authorization.TenantPermission{Scope: authentication.ScopeTenantsRead, MinimumRole: memberships.RoleViewer}
	span := recorder.Start("policy", "TenantPolicy.AuthorizeTenant", "authorize tenant api key by tenant and scope", map[string]any{
		"principal":  principalFields(principal),
		"tenant_id":  tenantID().String(),
		"permission": tenantPermissionFields(permission),
	})
	err := policy.AuthorizeTenant(ctx, principal, tenantID(), permission)
	span.End("policy allowed api key principal", map[string]any{"allowed": err == nil}, err)
	return directResult(PolicyTenantAPIKeyScopeScenario, http.StatusOK, recorder, map[string]any{"allowed": err == nil}, err)
}

func runPolicyTenantUserRole(ctx context.Context) (ScenarioResult, error) {
	now := deterministicClock()
	recorder := NewRecorder(now)
	policy := authorization.NewTenantPolicy(tracedMembershipRepository{
		recorder:   recorder,
		now:        now,
		policyRole: memberships.RoleAdmin,
	})
	permission := authorization.TenantPermission{Scope: authentication.ScopeTenantsWrite, MinimumRole: memberships.RoleAdmin}
	span := recorder.Start("policy", "TenantPolicy.AuthorizeTenant", "authorize user by tenant membership role", map[string]any{
		"principal":  principalFields(userPrincipal()),
		"tenant_id":  tenantID().String(),
		"permission": tenantPermissionFields(permission),
	})
	err := policy.AuthorizeTenant(ctx, userPrincipal(), tenantID(), permission)
	span.End("policy allowed user principal", map[string]any{"allowed": err == nil}, err)
	return directResult(PolicyTenantUserRoleScenario, http.StatusOK, recorder, map[string]any{"allowed": err == nil}, err)
}

func runRateLimitIPDeny(ctx context.Context) (ScenarioResult, error) {
	now := deterministicClock()
	recorder := NewRecorder(now)
	body := json.RawMessage(`{"email":"probe@example.test","password":"correct horse battery"}`)
	limiter := tracedDenyLimiter{recorder: recorder, retryAfter: 42 * time.Second}

	return runRouteTrace(ctx, routeTraceConfig{
		Name:     RateLimitIPDenyScenario,
		Recorder: recorder,
		Handler: httpapi.NewRouter(httpapi.Options{
			RateLimit: httpapi.RateLimitOptions{
				Limiter: limiter,
				Now:     now,
			},
			Authentication: newTracedAuthenticationService(recorder, now),
		}),
		Method:         http.MethodPost,
		Path:           "/v1/auth/login",
		Body:           body,
		RemoteAddr:     "203.0.113.10:53921",
		ExpectedStatus: http.StatusTooManyRequests,
	})
}

func runRateLimitPrincipalDeny(ctx context.Context) (ScenarioResult, error) {
	now := deterministicClock()
	recorder := NewRecorder(now)
	auth := staticAuthentication{
		recorder:    recorder,
		now:         now,
		principal:   userPrincipal(),
		sessionUser: sessionUserFixture(now),
	}
	limiter := tracedDenyLimiter{recorder: recorder, retryAfter: 17 * time.Second}

	return runRouteTrace(ctx, routeTraceConfig{
		Name:     RateLimitPrincipalDenyScenario,
		Recorder: recorder,
		Handler: httpapi.NewRouter(httpapi.Options{
			RateLimit: httpapi.RateLimitOptions{
				Limiter: limiter,
				Now:     now,
			},
			Authentication: auth,
		}),
		Method:         http.MethodGet,
		Path:           "/v1/me",
		Authorization:  "Bearer trace-session-token",
		ExpectedStatus: http.StatusTooManyRequests,
	})
}

func runAdapterPostgresTenantCreate(ctx context.Context) (ScenarioResult, error) {
	now := deterministicClock()
	recorder := NewRecorder(now)
	service := tracedTenantService{
		recorder: recorder,
		next:     tenants.NewService(tracedTenantRepository{recorder: recorder, now: now}),
	}
	input := tenants.CreateTenantInput{
		Name:          "  Postgres Trace Workspace  ",
		DefaultRegion: stringPtr("us"),
		Website:       stringPtr(" https://chalkmeet.com "),
	}
	span := recorder.Start("service", "tenants.Service.CreateTenant", "normalize tenant then call postgres repository adapter", map[string]any{
		"input": tenantCreateInputFields(input),
	})
	tenant, err := service.CreateTenant(ctx, input)
	span.End("tenant create adapter trace completed", map[string]any{"tenant": tenantFields(tenant)}, err)
	return directResult(AdapterPostgresTenantCreateScenario, http.StatusOK, recorder, tenantFields(tenant), err)
}

func runAdapterRedisRateLimit(ctx context.Context) (ScenarioResult, error) {
	now := deterministicClock()
	recorder := NewRecorder(now)
	limiter := tracedRedisRateLimiter{recorder: recorder}
	policy := ratelimit.Policy{Name: "auth.login", Limit: 10, Window: time.Minute}
	span := recorder.Start("adapter", "redis.RateLimiter.Allow", "evaluate redis-backed token bucket script", map[string]any{
		"key":    "ip:203.0.113.10",
		"policy": policyFields(policy),
	})
	decision := limiter.Allow(ctx, "ip:203.0.113.10", policy, now())
	span.End("redis rate limiter returned decision", map[string]any{"decision": decisionFields(decision)}, nil)
	return directResult(AdapterRedisRateLimitScenario, http.StatusOK, recorder, map[string]any{"decision": decisionFields(decision)}, nil)
}

func runAdapterCloudflareR2SignedURL(ctx context.Context) (ScenarioResult, error) {
	now := deterministicClock()
	recorder := NewRecorder(now)
	service := objectstorage.NewService(tracedObjectStore{recorder: recorder, now: now})
	input := objectstorage.CreateUploadURLInput{
		Key:         "tenant-assets/logos/chalk.png",
		ContentType: " image/png ",
		ExpiresIn:   15 * time.Minute,
	}
	span := recorder.Start("service", "objectstorage.Service.CreateUploadURL", "validate upload url request before r2 adapter", map[string]any{
		"input": uploadURLInputFields(input),
	})
	url, err := service.CreateUploadURL(ctx, input)
	span.End("object storage service returned signed upload url", map[string]any{"signed_url": signedURLFields(url)}, err)
	return directResult(AdapterCloudflareR2SignedURLScenario, http.StatusOK, recorder, signedURLFields(url), err)
}

func runAdapterCloudflareSFUBootstrap(ctx context.Context) (ScenarioResult, error) {
	now := deterministicClock()
	recorder := NewRecorder(now)
	service := mediaplane.NewService(tracedMediaPlane{recorder: recorder, now: now})
	input := mediaplane.EnsureSessionInput{
		Provider:   mediaplane.ProviderCloudflareSFU,
		SessionKey: " room:demo ",
		Title:      " Chalk Demo ",
		Metadata:   map[string]string{"tenant_id": tenantID().String()},
	}
	span := recorder.Start("service", "mediaplane.Service.EnsureSession", "validate session bootstrap before sfu adapter", map[string]any{
		"input": ensureSessionInputFields(input),
	})
	session, err := service.EnsureSession(ctx, input)
	span.End("media plane service returned sfu session metadata", map[string]any{"session": mediaSessionFields(session)}, err)
	return directResult(AdapterCloudflareSFUBootstrapScenario, http.StatusOK, recorder, mediaSessionFields(session), err)
}

func runAdapterCloudflareRTKJoin(ctx context.Context) (ScenarioResult, error) {
	now := deterministicClock()
	recorder := NewRecorder(now)
	service := mediaplane.NewService(tracedMediaPlane{recorder: recorder, now: now})
	input := mediaplane.CreateJoinInput{
		Provider:              mediaplane.ProviderCloudflareRTK,
		Session:               mediaplane.Session{Provider: mediaplane.ProviderCloudflareRTK, Ref: "rtk-session-123"},
		ParticipantName:       " Trace Reviewer ",
		ExternalParticipantID: " user-111 ",
		ParticipantPreset:     " contributor ",
		Metadata:              map[string]string{"tenant_id": tenantID().String()},
	}
	span := recorder.Start("service", "mediaplane.Service.CreateJoin", "validate participant join before rtk adapter", map[string]any{
		"input": createJoinInputFields(input),
	})
	join, err := service.CreateJoin(ctx, input)
	span.End("media plane service returned rtk join payload", map[string]any{"join": mediaJoinFields(join)}, err)
	return directResult(AdapterCloudflareRTKJoinScenario, http.StatusOK, recorder, mediaJoinFields(join), err)
}

func runAdapterResendSendEmail(ctx context.Context) (ScenarioResult, error) {
	now := deterministicClock()
	recorder := NewRecorder(now)
	service := email.NewService(tracedEmailSender{recorder: recorder})
	input := email.SendEmailInput{
		From:           "Chalk <hello@chalkmeet.com>",
		To:             []string{" Trace Reviewer <trace@example.test> "},
		Subject:        "  Welcome to Chalk  ",
		TextBody:       "Your workspace is ready.",
		Tags:           []email.Tag{{Name: "tenant", Value: "trace"}},
		IdempotencyKey: "tenant-welcome:" + tenantID().String(),
	}
	span := recorder.Start("service", "email.Service.SendEmail", "validate outbound email before resend adapter", map[string]any{
		"input": sendEmailInputFields(input),
	})
	result, err := service.SendEmail(ctx, input)
	span.End("email service returned provider message id", map[string]any{"result": sendEmailResultFields(result)}, err)
	return directResult(AdapterResendSendEmailScenario, http.StatusOK, recorder, sendEmailResultFields(result), err)
}

func runEdgeUnauthenticatedRoute(ctx context.Context) (ScenarioResult, error) {
	now := deterministicClock()
	recorder := NewRecorder(now)
	auth := staticAuthentication{recorder: recorder, now: now, principal: userPrincipal(), sessionUser: sessionUserFixture(now)}

	return runRouteTrace(ctx, routeTraceConfig{
		Name:     EdgeUnauthenticatedRouteScenario,
		Recorder: recorder,
		Handler: routerWithCoreServices(recorder, now, coreOptions{
			Auth:       auth,
			Principal:  userPrincipal(),
			PolicyRole: memberships.RoleViewer,
		}),
		Method:         http.MethodGet,
		Path:           "/v1/tenants/" + tenantID().String(),
		ExpectedStatus: http.StatusUnauthorized,
	})
}

func runEdgeForbiddenTenantRoute(ctx context.Context) (ScenarioResult, error) {
	now := deterministicClock()
	recorder := NewRecorder(now)
	body := json.RawMessage(`{"name":"  Forbidden Studio  "}`)

	return runRouteTrace(ctx, routeTraceConfig{
		Name:     EdgeForbiddenTenantRouteScenario,
		Recorder: recorder,
		Handler: routerWithCoreServices(recorder, now, coreOptions{
			Principal:  userPrincipal(),
			PolicyRole: memberships.RoleViewer,
		}),
		Method:         http.MethodPatch,
		Path:           "/v1/tenants/" + tenantID().String(),
		Body:           body,
		Authorization:  "Bearer trace-session-token",
		ExpectedStatus: http.StatusForbidden,
	})
}

func runEdgeInvalidRouteID(ctx context.Context) (ScenarioResult, error) {
	now := deterministicClock()
	recorder := NewRecorder(now)

	return runRouteTrace(ctx, routeTraceConfig{
		Name:     EdgeInvalidRouteIDScenario,
		Recorder: recorder,
		Handler: routerWithCoreServices(recorder, now, coreOptions{
			Principal:  userPrincipal(),
			PolicyRole: memberships.RoleViewer,
		}),
		Method:         http.MethodGet,
		Path:           "/v1/tenants/not-a-uuid",
		Authorization:  "Bearer trace-session-token",
		ExpectedStatus: http.StatusBadRequest,
	})
}

type routeTraceConfig struct {
	Name           string
	Recorder       *Recorder
	Handler        http.Handler
	Method         string
	Path           string
	Body           json.RawMessage
	DisplayBody    json.RawMessage
	Authorization  string
	Headers        map[string]string
	RemoteAddr     string
	ExpectedStatus int
}

func runRouteTrace(ctx context.Context, cfg routeTraceConfig) (ScenarioResult, error) {
	var bodyReader io.Reader = http.NoBody
	if len(cfg.Body) > 0 {
		bodyReader = bytes.NewReader(cfg.Body)
	}
	displayBody := cfg.Body
	if len(cfg.DisplayBody) > 0 {
		displayBody = cfg.DisplayBody
	}
	cfg.Recorder.Add("scenario", cfg.Name, "boot router and issue request", map[string]any{
		"request": map[string]any{
			"method": cfg.Method,
			"path":   cfg.Path,
			"body":   decodedBody(displayBody),
		},
	})

	request, err := http.NewRequestWithContext(ctx, cfg.Method, cfg.Path, bodyReader)
	if err != nil {
		return ScenarioResult{}, fmt.Errorf("create request: %w", err)
	}
	if len(cfg.Body) > 0 {
		request.Header.Set("Content-Type", "application/json")
	}
	if cfg.Authorization != "" {
		request.Header.Set("Authorization", cfg.Authorization)
	}
	for name, value := range cfg.Headers {
		request.Header.Set(name, value)
	}
	if cfg.RemoteAddr != "" {
		request.RemoteAddr = cfg.RemoteAddr
	}

	response := httptest.NewRecorder()
	span := cfg.Recorder.Start("http", cfg.Method+" "+request.URL.Path, "router received request", map[string]any{
		"headers":     tracedHeaders(request),
		"query":       request.URL.RawQuery,
		"remote_addr": request.RemoteAddr,
	})
	cfg.Handler.ServeHTTP(response, request)
	span.End("router returned response", map[string]any{
		"status":  response.Code,
		"headers": tracedResponseHeaders(response),
		"body":    mustDecode(response.Body.Bytes()),
	}, nil)

	result := ScenarioResult{
		Name:       cfg.Name,
		StatusCode: response.Code,
		Body:       resultBody(response.Body.Bytes()),
		Events:     cfg.Recorder.Events(),
	}
	if response.Code != cfg.ExpectedStatus {
		return result, fmt.Errorf("scenario returned HTTP %d, want %d", response.Code, cfg.ExpectedStatus)
	}

	return result, nil
}

type coreOptions struct {
	Auth       httpapi.AuthenticationService
	Principal  authentication.Principal
	PolicyRole memberships.Role
}

func routerWithCoreServices(recorder *Recorder, now func() time.Time, options coreOptions) http.Handler {
	auth := options.Auth
	if auth == nil {
		principal := options.Principal
		if !principal.IsAuthenticated() {
			principal = userPrincipal()
		}
		auth = staticAuthentication{
			recorder:    recorder,
			now:         now,
			principal:   principal,
			sessionUser: sessionUserFixture(now),
		}
	}
	membershipRepository := tracedMembershipRepository{
		recorder:   recorder,
		now:        now,
		policyRole: options.PolicyRole,
	}
	if membershipRepository.policyRole == "" {
		membershipRepository.policyRole = memberships.RoleViewer
	}

	return httpapi.NewRouter(httpapi.Options{
		RateLimit:      noRateLimits(now),
		Authentication: auth,
		TenantAuthz:    authorization.NewTenantPolicy(membershipRepository),
		Tenants: tracedTenantService{
			recorder: recorder,
			next:     tenants.NewService(tracedTenantRepository{recorder: recorder, now: now}),
		},
		Users: tracedUserService{
			recorder: recorder,
			next:     users.NewService(tracedUserRepository{recorder: recorder, now: now}),
		},
		Memberships: tracedMembershipService{
			recorder: recorder,
			next:     memberships.NewService(membershipRepository),
		},
		Rooms: tracedRoomService{
			recorder: recorder,
			next:     rooms.NewService(tracedRoomRepository{recorder: recorder, now: now}),
		},
	})
}

func directResult(name string, status int, recorder *Recorder, body any, err error) (ScenarioResult, error) {
	raw, marshalErr := json.Marshal(body)
	if marshalErr != nil {
		return ScenarioResult{}, marshalErr
	}
	result := ScenarioResult{
		Name:       name,
		StatusCode: status,
		Body:       raw,
		Events:     recorder.Events(),
	}
	if err != nil {
		return result, err
	}
	return result, nil
}

type tracedAuthenticationService struct {
	recorder   *Recorder
	next       authentication.Service
	repository *tracedAuthenticationRepository
}

func newTracedAuthenticationService(recorder *Recorder, now func() time.Time) *tracedAuthenticationService {
	repository := &tracedAuthenticationRepository{recorder: recorder, now: now}
	return &tracedAuthenticationService{
		recorder:   recorder,
		repository: repository,
		next: authentication.NewService(
			repository,
			tracedPasswordHasher{recorder: recorder},
			tracedGoogleProvider{recorder: recorder},
			tracedOAuthStateStore{recorder: recorder},
			authentication.Config{
				Now:           now,
				SessionTTL:    time.Hour,
				OAuthStateTTL: 10 * time.Minute,
			},
		),
	}
}

func (s *tracedAuthenticationService) Register(ctx context.Context, input authentication.RegisterInput) (authentication.AuthResult, error) {
	span := s.recorder.Start("service", "authentication.Service.Register", "validate register request and create password identity", map[string]any{
		"input": registerInputFields(input),
	})
	result, err := s.next.Register(ctx, input)
	span.End("authentication service returned auth result", map[string]any{"auth_result": authResultFields(result)}, err)
	return result, err
}

func (s *tracedAuthenticationService) Login(ctx context.Context, input authentication.LoginInput) (authentication.AuthResult, error) {
	span := s.recorder.Start("service", "authentication.Service.Login", "canonicalize credentials and verify password identity", map[string]any{
		"input": loginInputFields(input),
	})
	result, err := s.next.Login(ctx, input)
	span.End("authentication service returned auth result", map[string]any{"auth_result": authResultFields(result)}, err)
	return result, err
}

func (s *tracedAuthenticationService) AuthenticateSession(ctx context.Context, rawToken string) (authentication.SessionUser, error) {
	span := s.recorder.Start("service", "authentication.Service.AuthenticateSession", "hash bearer token and load active session", map[string]any{
		"token": "[redacted]",
	})
	sessionUser, err := s.next.AuthenticateSession(ctx, rawToken)
	span.End("authentication service returned session user", map[string]any{"session_user": sessionUserFields(sessionUser)}, err)
	return sessionUser, err
}

func (s *tracedAuthenticationService) PrincipalForSession(session authentication.Session) authentication.Principal {
	principal := s.next.PrincipalForSession(session)
	s.recorder.Add("auth", "PrincipalForSession", "attach principal to request context", map[string]any{
		"principal": principalFields(principal),
	})
	return principal
}

func (s *tracedAuthenticationService) Logout(ctx context.Context, principal authentication.Principal) error {
	span := s.recorder.Start("service", "authentication.Service.Logout", "revoke authenticated session", map[string]any{
		"principal": principalFields(principal),
	})
	err := s.next.Logout(ctx, principal)
	span.End("authentication service revoked session", nil, err)
	return err
}

func (s *tracedAuthenticationService) StartGoogleSignIn(ctx context.Context) (authentication.GoogleStart, error) {
	span := s.recorder.Start("service", "authentication.Service.StartGoogleSignIn", "generate oauth state and verifier", nil)
	start, err := s.next.StartGoogleSignIn(ctx)
	span.End("authentication service returned google redirect target", map[string]any{
		"authorization_url": start.AuthorizationURL,
	}, err)
	return start, err
}

func (s *tracedAuthenticationService) CompleteGoogleSignIn(ctx context.Context, state string, code string, userAgent *string) (authentication.AuthResult, error) {
	span := s.recorder.Start("service", "authentication.Service.CompleteGoogleSignIn", "validate oauth callback and resolve google identity", map[string]any{
		"state":      state,
		"code":       "[redacted]",
		"user_agent": userAgent,
	})
	result, err := s.next.CompleteGoogleSignIn(ctx, state, code, userAgent)
	span.End("authentication service returned oauth auth result", map[string]any{"auth_result": authResultFields(result)}, err)
	return result, err
}

type tracedAuthenticationRepository struct {
	recorder         *Recorder
	now              func() time.Time
	passwordIdentity authentication.PasswordIdentity
	sessionUser      authentication.SessionUser
	authIdentityErr  error
	userByEmailErr   error
}

func (r *tracedAuthenticationRepository) CreatePasswordUser(ctx context.Context, input authentication.CreatePasswordUserInput) (authentication.User, error) {
	_ = ctx
	span := r.recorder.Start("repository", "AuthenticationRepository.CreatePasswordUser", "insert user and password identity", map[string]any{
		"input": createPasswordUserInputFields(input),
	})
	r.recorder.Add("database", "INSERT users, auth_identities, password_credentials", "execute transaction", map[string]any{
		"params": createPasswordUserInputFields(input),
	})
	user := authentication.User{ID: input.UserID, Name: input.Name, Email: input.Email, CreatedAt: r.now(), UpdatedAt: r.now()}
	r.recorder.Add("database", "row result", "database returned created auth user", map[string]any{"row": authUserFields(user)})
	span.End("map database row to authentication user", map[string]any{"user": authUserFields(user)}, nil)
	return user, nil
}

func (r *tracedAuthenticationRepository) CreateGoogleUser(ctx context.Context, input authentication.CreateGoogleUserInput) (authentication.User, error) {
	_ = ctx
	span := r.recorder.Start("repository", "AuthenticationRepository.CreateGoogleUser", "insert user and google identity", map[string]any{
		"input": createGoogleUserInputFields(input),
	})
	r.recorder.Add("database", "INSERT users, auth_identities", "execute transaction", map[string]any{"params": createGoogleUserInputFields(input)})
	user := authentication.User{ID: input.UserID, Name: input.Name, Email: input.Email, CreatedAt: r.now(), UpdatedAt: r.now()}
	r.recorder.Add("database", "row result", "database returned created google user", map[string]any{"row": authUserFields(user)})
	span.End("map database row to authentication user", map[string]any{"user": authUserFields(user)}, nil)
	return user, nil
}

func (r *tracedAuthenticationRepository) GetPasswordIdentityByEmail(ctx context.Context, email string) (authentication.PasswordIdentity, error) {
	_ = ctx
	span := r.recorder.Start("repository", "AuthenticationRepository.GetPasswordIdentityByEmail", "select password identity by canonical email", map[string]any{"email": email})
	identity := r.passwordIdentity
	if identity.User.ID.IsZero() {
		identity = authentication.PasswordIdentity{User: authUserFixture(r.now), PasswordHash: "bcrypt$trace-password"}
	}
	span.End("repository returned password identity with redacted hash", map[string]any{
		"identity": map[string]any{"user": authUserFields(identity.User), "password_hash": "[redacted]"},
	}, nil)
	return identity, nil
}

func (r *tracedAuthenticationRepository) GetUserByAuthIdentity(ctx context.Context, provider string, subject string) (authentication.User, error) {
	_ = ctx
	span := r.recorder.Start("repository", "AuthenticationRepository.GetUserByAuthIdentity", "select user by auth provider identity", map[string]any{
		"provider": provider,
		"subject":  subject,
	})
	if r.authIdentityErr != nil {
		span.End("repository did not find auth identity", nil, r.authIdentityErr)
		return authentication.User{}, r.authIdentityErr
	}
	user := authUserFixture(r.now)
	span.End("repository returned auth identity user", map[string]any{"user": authUserFields(user)}, nil)
	return user, nil
}

func (r *tracedAuthenticationRepository) GetUserByEmail(ctx context.Context, email string) (authentication.User, error) {
	_ = ctx
	span := r.recorder.Start("repository", "AuthenticationRepository.GetUserByEmail", "select user by canonical email", map[string]any{"email": email})
	if r.userByEmailErr != nil {
		span.End("repository did not find email user", nil, r.userByEmailErr)
		return authentication.User{}, r.userByEmailErr
	}
	user := authUserFixture(r.now)
	span.End("repository returned email user", map[string]any{"user": authUserFields(user)}, nil)
	return user, nil
}

func (r *tracedAuthenticationRepository) CreateSession(ctx context.Context, input authentication.CreateSessionInput) (authentication.Session, error) {
	_ = ctx
	span := r.recorder.Start("repository", "AuthenticationRepository.CreateSession", "insert auth session", map[string]any{
		"input": createSessionInputFields(input),
	})
	r.recorder.Add("database", "INSERT sessions RETURNING *", "execute query", map[string]any{"params": createSessionInputFields(input)})
	session := authentication.Session{
		ID:        input.ID,
		UserID:    input.UserID,
		TokenHash: input.TokenHash,
		UserAgent: input.UserAgent,
		ExpiresAt: input.ExpiresAt,
		CreatedAt: r.now(),
		UpdatedAt: r.now(),
	}
	span.End("repository returned created session", map[string]any{"session": authSessionFields(session)}, nil)
	return session, nil
}

func (r *tracedAuthenticationRepository) GetSessionByTokenHash(ctx context.Context, tokenHash string) (authentication.SessionUser, error) {
	_ = ctx
	span := r.recorder.Start("repository", "AuthenticationRepository.GetSessionByTokenHash", "select active session and user by token hash", map[string]any{
		"token_hash": redactHash(tokenHash),
	})
	sessionUser := r.sessionUser
	if sessionUser.Session.ID.IsZero() {
		sessionUser = sessionUserFixture(r.now)
	}
	span.End("repository returned active session user", map[string]any{"session_user": sessionUserFields(sessionUser)}, nil)
	return sessionUser, nil
}

func (r *tracedAuthenticationRepository) RevokeSession(ctx context.Context, sessionID utilities.ID, revokedAt time.Time) error {
	_ = ctx
	span := r.recorder.Start("repository", "AuthenticationRepository.RevokeSession", "mark session revoked", map[string]any{
		"session_id": sessionID.String(),
		"revoked_at": timestamp(revokedAt),
	})
	r.recorder.Add("database", "UPDATE sessions SET revoked_at", "execute query", map[string]any{
		"params": map[string]any{"session_id": sessionID.String(), "revoked_at": timestamp(revokedAt)},
	})
	span.End("repository completed session revoke", nil, nil)
	return nil
}

type tracedPasswordHasher struct {
	recorder *Recorder
}

func (h tracedPasswordHasher) HashPassword(password string) (string, error) {
	h.recorder.Add("adapter", "password.BcryptHasher.HashPassword", "hash prepared password with bcrypt", map[string]any{
		"password": "[redacted]",
		"bytes":    len([]byte(password)),
	})
	return "bcrypt$trace-password", nil
}

func (h tracedPasswordHasher) ComparePassword(hash string, password string) error {
	h.recorder.Add("adapter", "password.BcryptHasher.ComparePassword", "compare prepared password against bcrypt hash", map[string]any{
		"password": "[redacted]",
		"hash":     "[redacted]",
		"bytes":    len([]byte(password)),
	})
	return nil
}

type tracedGoogleProvider struct {
	recorder *Recorder
}

func (p tracedGoogleProvider) NewVerifier() string {
	p.recorder.Add("adapter", "google.Provider.NewVerifier", "generate oauth pkce verifier", map[string]any{"verifier": "[redacted]"})
	return "trace-oauth-verifier"
}

func (p tracedGoogleProvider) AuthCodeURL(state string, verifier string) string {
	p.recorder.Add("adapter", "google.Provider.AuthCodeURL", "build google oauth authorization url", map[string]any{
		"state":    state,
		"verifier": "[redacted]",
	})
	return "https://accounts.google.com/o/oauth2/v2/auth?client_id=trace&state=" + state
}

func (p tracedGoogleProvider) Authenticate(ctx context.Context, code string, verifier string) (authentication.GoogleIdentity, error) {
	_ = ctx
	p.recorder.Add("adapter", "google.Provider.Authenticate", "exchange oauth code and verify google id token", map[string]any{
		"code":     "[redacted]",
		"verifier": "[redacted]",
	})
	return authentication.GoogleIdentity{
		Subject: "google-subject-123",
		Email:   "Trace.Reviewer@Example.Test",
		Name:    "Trace Reviewer",
	}, nil
}

type tracedOAuthStateStore struct {
	recorder *Recorder
}

func (s tracedOAuthStateStore) SaveOAuthState(ctx context.Context, state string, verifier string, ttl time.Duration) error {
	_ = ctx
	s.recorder.Add("adapter", "redis.OAuthStateStore.SaveOAuthState", "store oauth state verifier with ttl", map[string]any{
		"state":    state,
		"verifier": "[redacted]",
		"ttl":      ttl.String(),
	})
	return nil
}

func (s tracedOAuthStateStore) LoadAndDeleteOAuthState(ctx context.Context, state string) (string, error) {
	_ = ctx
	s.recorder.Add("adapter", "redis.OAuthStateStore.LoadAndDeleteOAuthState", "atomically load and delete oauth state verifier", map[string]any{
		"state": state,
	})
	return "trace-oauth-verifier", nil
}

type staticAuthentication struct {
	recorder    *Recorder
	now         func() time.Time
	principal   authentication.Principal
	sessionUser authentication.SessionUser
}

func (a staticAuthentication) AuthenticateSession(ctx context.Context, rawToken string) (authentication.SessionUser, error) {
	_ = ctx
	span := a.recorder.Start("auth", "AuthenticateSession", "validate bearer token", map[string]any{"token": "[redacted]"})
	sessionUser := a.sessionUser
	if sessionUser.Session.ID.IsZero() {
		sessionUser = sessionUserFixture(a.now)
	}
	span.End("session accepted", map[string]any{"session_user": sessionUserFields(sessionUser)}, nil)
	return sessionUser, nil
}

func (a staticAuthentication) PrincipalForSession(session authentication.Session) authentication.Principal {
	principal := a.principal
	if !principal.IsAuthenticated() {
		principal = userPrincipal()
	}
	a.recorder.Add("auth", "PrincipalForSession", "attach principal to request context", map[string]any{
		"principal": principalFields(principal),
	})
	return principal
}

func (staticAuthentication) Register(context.Context, authentication.RegisterInput) (authentication.AuthResult, error) {
	return authentication.AuthResult{}, errors.New("register is not used by this trace scenario")
}

func (staticAuthentication) Login(context.Context, authentication.LoginInput) (authentication.AuthResult, error) {
	return authentication.AuthResult{}, errors.New("login is not used by this trace scenario")
}

func (staticAuthentication) Logout(context.Context, authentication.Principal) error {
	return errors.New("logout is not used by this trace scenario")
}

func (staticAuthentication) StartGoogleSignIn(context.Context) (authentication.GoogleStart, error) {
	return authentication.GoogleStart{}, errors.New("google start is not used by this trace scenario")
}

func (staticAuthentication) CompleteGoogleSignIn(context.Context, string, string, *string) (authentication.AuthResult, error) {
	return authentication.AuthResult{}, errors.New("google callback is not used by this trace scenario")
}

type tracedUserService struct {
	recorder *Recorder
	next     users.Service
}

func (s tracedUserService) CreateUser(ctx context.Context, input users.CreateUserInput) (users.User, error) {
	span := s.recorder.Start("service", "users.Service.CreateUser", "normalize and validate user input", map[string]any{"input": userCreateInputFields(input)})
	user, err := s.next.CreateUser(ctx, input)
	span.End("user service returned domain user", map[string]any{"user": userFields(user)}, err)
	return user, err
}

func (s tracedUserService) GetUser(ctx context.Context, id utilities.ID) (users.User, error) {
	span := s.recorder.Start("service", "users.Service.GetUser", "validate user id and load user", map[string]any{"user_id": id.String()})
	user, err := s.next.GetUser(ctx, id)
	span.End("user service returned domain user", map[string]any{"user": userFields(user)}, err)
	return user, err
}

func (s tracedUserService) ListUsers(ctx context.Context, page pagination.PageRequest) (users.UserList, error) {
	span := s.recorder.Start("service", "users.Service.ListUsers", "load paginated global users", map[string]any{"page": pageRequestFields(page)})
	list, err := s.next.ListUsers(ctx, page)
	span.End("user service returned paginated users", map[string]any{"list": userListFields(list)}, err)
	return list, err
}

type tracedUserRepository struct {
	recorder *Recorder
	now      func() time.Time
}

func (r tracedUserRepository) CreateUser(ctx context.Context, input users.CreateUserInput) (users.User, error) {
	_ = ctx
	span := r.recorder.Start("repository", "UserRepository.CreateUser", "insert user row", map[string]any{"domain_input": userCreateInputFields(input)})
	r.recorder.Add("database", "INSERT users RETURNING *", "execute query", map[string]any{"params": userCreateInputFields(input)})
	user := users.User{ID: input.ID, Name: input.Name, Email: input.Email, CreatedAt: r.now(), UpdatedAt: r.now()}
	span.End("map database row to domain user", map[string]any{"user": userFields(user)}, nil)
	return user, nil
}

func (r tracedUserRepository) GetUser(ctx context.Context, id utilities.ID) (users.User, error) {
	_ = ctx
	span := r.recorder.Start("repository", "UserRepository.GetUser", "select user by id", map[string]any{"user_id": id.String()})
	r.recorder.Add("database", "SELECT users WHERE id = $1", "execute query", map[string]any{"params": map[string]any{"id": id.String()}})
	user := userFixture(r.now)
	span.End("map database row to domain user", map[string]any{"user": userFields(user)}, nil)
	return user, nil
}

func (r tracedUserRepository) ListUsers(ctx context.Context, page pagination.PageRequest) (users.UserList, error) {
	_ = ctx
	span := r.recorder.Start("repository", "UserRepository.ListUsers", "select paginated users", map[string]any{"page": pageRequestFields(page)})
	r.recorder.Add("database", "SELECT users ORDER BY created_at DESC, id DESC LIMIT $1", "execute query", map[string]any{"params": pageRequestFields(page)})
	list := users.UserList{
		Users: []users.User{userFixture(r.now), {ID: mustID("66666666-6666-4666-8666-666666666666"), Name: "Grace Trace", Email: "grace@example.test", CreatedAt: r.now(), UpdatedAt: r.now()}},
		Page:  pagination.Page{PageSize: page.Size(), HasMore: false},
	}
	span.End("map database rows to domain user list", map[string]any{"list": userListFields(list)}, nil)
	return list, nil
}

type tracedMembershipService struct {
	recorder *Recorder
	next     memberships.Service
}

func (s tracedMembershipService) CreateMembership(ctx context.Context, input memberships.CreateMembershipInput) (memberships.Membership, error) {
	span := s.recorder.Start("service", "memberships.Service.CreateMembership", "validate membership create input", map[string]any{"input": membershipCreateInputFields(input)})
	membership, err := s.next.CreateMembership(ctx, input)
	span.End("membership service returned domain membership", map[string]any{"membership": membershipFields(membership)}, err)
	return membership, err
}

func (s tracedMembershipService) ListTenantMemberships(ctx context.Context, tenantID utilities.ID, page pagination.PageRequest) (memberships.MembershipList, error) {
	span := s.recorder.Start("service", "memberships.Service.ListTenantMemberships", "validate tenant id and load memberships", map[string]any{
		"tenant_id": tenantID.String(),
		"page":      pageRequestFields(page),
	})
	list, err := s.next.ListTenantMemberships(ctx, tenantID, page)
	span.End("membership service returned paginated memberships", map[string]any{"list": membershipListFields(list)}, err)
	return list, err
}

func (s tracedMembershipService) UpdateTenantMembership(ctx context.Context, tenantID utilities.ID, membershipID utilities.ID, input memberships.UpdateMembershipInput) (memberships.Membership, error) {
	span := s.recorder.Start("service", "memberships.Service.UpdateTenantMembership", "validate membership update input", map[string]any{
		"tenant_id":     tenantID.String(),
		"membership_id": membershipID.String(),
		"input":         membershipUpdateInputFields(input),
	})
	membership, err := s.next.UpdateTenantMembership(ctx, tenantID, membershipID, input)
	span.End("membership service returned updated membership", map[string]any{"membership": membershipFields(membership)}, err)
	return membership, err
}

type tracedMembershipRepository struct {
	recorder   *Recorder
	now        func() time.Time
	policyRole memberships.Role
}

func (r tracedMembershipRepository) CreateMembership(ctx context.Context, input memberships.CreateMembershipInput) (memberships.Membership, error) {
	_ = ctx
	span := r.recorder.Start("repository", "MembershipRepository.CreateMembership", "insert tenant membership row", map[string]any{"domain_input": membershipCreateInputFields(input)})
	r.recorder.Add("database", "INSERT memberships RETURNING *", "execute query", map[string]any{"params": membershipCreateInputFields(input)})
	membership := memberships.Membership{ID: input.ID, TenantID: input.TenantID, UserID: input.UserID, Role: input.Role, CreatedAt: r.now(), UpdatedAt: r.now()}
	span.End("map database row to domain membership", map[string]any{"membership": membershipFields(membership)}, nil)
	return membership, nil
}

func (r tracedMembershipRepository) GetTenantMembershipForUser(ctx context.Context, tenantID utilities.ID, userID utilities.ID) (memberships.Membership, error) {
	_ = ctx
	span := r.recorder.Start("repository", "MembershipRepository.GetTenantMembershipForUser", "select membership for tenant policy", map[string]any{
		"tenant_id": tenantID.String(),
		"user_id":   userID.String(),
	})
	r.recorder.Add("database", "SELECT memberships WHERE tenant_id = $1 AND user_id = $2", "execute query", map[string]any{
		"params": map[string]any{"tenant_id": tenantID.String(), "user_id": userID.String()},
	})
	role := r.policyRole
	if role == "" {
		role = memberships.RoleViewer
	}
	membership := memberships.Membership{ID: membershipID(), TenantID: tenantID, UserID: userID, Role: role, CreatedAt: r.now(), UpdatedAt: r.now()}
	span.End("repository returned membership for policy", map[string]any{"membership": membershipFields(membership)}, nil)
	return membership, nil
}

func (r tracedMembershipRepository) ListTenantMemberships(ctx context.Context, tenantID utilities.ID, page pagination.PageRequest) (memberships.MembershipList, error) {
	_ = ctx
	span := r.recorder.Start("repository", "MembershipRepository.ListTenantMemberships", "select paginated tenant memberships", map[string]any{
		"tenant_id": tenantID.String(),
		"page":      pageRequestFields(page),
	})
	r.recorder.Add("database", "SELECT memberships WHERE tenant_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2", "execute query", map[string]any{
		"params": map[string]any{"tenant_id": tenantID.String(), "limit": page.Size()},
	})
	list := memberships.MembershipList{
		Memberships: []memberships.Membership{membershipFixture(r.now, memberships.RoleOwner), membershipFixture(r.now, memberships.RoleViewer)},
		Page:        pagination.Page{PageSize: page.Size(), HasMore: false},
	}
	span.End("map database rows to membership list", map[string]any{"list": membershipListFields(list)}, nil)
	return list, nil
}

func (r tracedMembershipRepository) UpdateTenantMembership(ctx context.Context, tenantID utilities.ID, membershipID utilities.ID, input memberships.UpdateMembershipInput) (memberships.Membership, error) {
	_ = ctx
	span := r.recorder.Start("repository", "MembershipRepository.UpdateTenantMembership", "update tenant membership role", map[string]any{
		"tenant_id":     tenantID.String(),
		"membership_id": membershipID.String(),
		"input":         membershipUpdateInputFields(input),
	})
	r.recorder.Add("database", "UPDATE memberships SET role = $1 RETURNING *", "execute query", map[string]any{
		"params": map[string]any{"tenant_id": tenantID.String(), "membership_id": membershipID.String(), "role": input.Role},
	})
	membership := memberships.Membership{ID: membershipID, TenantID: tenantID, UserID: userID(), Role: input.Role, CreatedAt: r.now(), UpdatedAt: r.now()}
	span.End("map database row to updated membership", map[string]any{"membership": membershipFields(membership)}, nil)
	return membership, nil
}

type tracedTranscriptArtifactService struct {
	recorder *Recorder
	now      func() time.Time
}

func (s tracedTranscriptArtifactService) Request(_ context.Context, input transcripts.RequestInput) (transcripts.Transcript, transcripts.Job, error) {
	span := s.recorder.Start("service", "transcripts.Service.Request", "validate idempotent artifact request and load recorder-owned source", map[string]any{"tenant_id": input.TenantID.String(), "recording_id": input.RecordingID.String(), "idempotency_key": input.IdempotencyKey, "languages": input.Languages})
	s.recorder.Add("database", "SELECT recording_transcription_sources", "load committed manifest and track-aware chunk authority", map[string]any{"recording_id": input.RecordingID.String()})
	s.recorder.Add("database", "BEGIN transcript request", "atomically insert transcript, chunks, and fenced artifact jobs", map[string]any{"idempotency_key": input.IdempotencyKey})
	transcript := transcripts.Transcript{ID: transcriptArtifactID(), TenantID: input.TenantID, RecordingID: input.RecordingID, RoomID: roomID(), SessionID: roomSessionID(), Status: transcripts.StatusPreparing, Languages: []string{"en"}, Generation: 1, CreatedAt: s.now(), UpdatedAt: s.now()}
	job := transcripts.Job{ID: transcriptJobID(), TenantID: input.TenantID, RecordingID: input.RecordingID, TranscriptID: transcript.ID, SessionID: transcript.SessionID, ArtifactKind: "transcription_chunk", PayloadSchemaVersion: 1, State: transcripts.JobStatePending, AttemptLimit: 4, CreatedAt: s.now(), UpdatedAt: s.now()}
	s.recorder.Add("provider", "Lambda Invoke Event", "send loss-tolerant post-commit dispatcher wake hint", map[string]any{"job_id": job.ID.String(), "payload_contains_media": false})
	span.End("transcript request committed", map[string]any{"transcript": transcriptFields(transcript), "job_id": job.ID.String(), "job_state": job.State}, nil)
	return transcript, job, nil
}

func (tracedTranscriptArtifactService) Get(context.Context, utilities.ID, utilities.ID) (transcripts.Transcript, error) {
	return transcripts.Transcript{}, errors.New("get transcript is not used by this trace scenario")
}

func (tracedTranscriptArtifactService) List(context.Context, utilities.ID, utilities.ID, pagination.PageRequest) (transcripts.TranscriptList, error) {
	return transcripts.TranscriptList{}, errors.New("list transcripts is not used by this trace scenario")
}

func (tracedTranscriptArtifactService) Delete(context.Context, utilities.ID, utilities.ID) (transcripts.Transcript, error) {
	return transcripts.Transcript{}, errors.New("delete transcript is not used by this trace scenario")
}

type tracedRoomService struct {
	recorder *Recorder
	next     rooms.Service
}

func (s tracedRoomService) CreateRoom(ctx context.Context, input rooms.CreateRoomInput) (rooms.Room, error) {
	span := s.recorder.Start("service", "rooms.Service.CreateRoom", "validate room create input", map[string]any{"input": roomCreateInputFields(input)})
	room, err := s.next.CreateRoom(ctx, input)
	span.End("room service returned domain room", map[string]any{"room": roomFields(room)}, err)
	return room, err
}

func (s tracedRoomService) GetRoom(ctx context.Context, tenantID utilities.ID, roomID utilities.ID) (rooms.Room, error) {
	span := s.recorder.Start("service", "rooms.Service.GetRoom", "validate room ids and load room", map[string]any{"tenant_id": tenantID.String(), "room_id": roomID.String()})
	room, err := s.next.GetRoom(ctx, tenantID, roomID)
	span.End("room service returned domain room", map[string]any{"room": roomFields(room)}, err)
	return room, err
}

func (s tracedRoomService) ListRooms(ctx context.Context, tenantID utilities.ID, page pagination.PageRequest) (rooms.RoomList, error) {
	span := s.recorder.Start("service", "rooms.Service.ListRooms", "validate tenant id and load rooms", map[string]any{"tenant_id": tenantID.String(), "page": pageRequestFields(page)})
	list, err := s.next.ListRooms(ctx, tenantID, page)
	span.End("room service returned paginated rooms", map[string]any{"list": roomListFields(list)}, err)
	return list, err
}

func (s tracedRoomService) UpdateRoom(ctx context.Context, tenantID utilities.ID, roomID utilities.ID, input rooms.UpdateRoomInput) (rooms.Room, error) {
	span := s.recorder.Start("service", "rooms.Service.UpdateRoom", "validate room patch", map[string]any{"tenant_id": tenantID.String(), "room_id": roomID.String(), "input": roomUpdateInputFields(input)})
	room, err := s.next.UpdateRoom(ctx, tenantID, roomID, input)
	span.End("room service returned updated room", map[string]any{"room": roomFields(room)}, err)
	return room, err
}

func (s tracedRoomService) CreateSession(ctx context.Context, input rooms.CreateSessionInput) (rooms.Session, error) {
	span := s.recorder.Start("service", "rooms.Service.CreateSession", "validate room session create input", map[string]any{"input": roomSessionCreateInputFields(input)})
	session, err := s.next.CreateSession(ctx, input)
	span.End("room service returned domain session", map[string]any{"session": roomSessionFields(session)}, err)
	return session, err
}

func (s tracedRoomService) GetSession(ctx context.Context, tenantID utilities.ID, roomID utilities.ID, sessionID utilities.ID) (rooms.Session, error) {
	span := s.recorder.Start("service", "rooms.Service.GetSession", "validate room session ids and load session", map[string]any{"tenant_id": tenantID.String(), "room_id": roomID.String(), "session_id": sessionID.String()})
	session, err := s.next.GetSession(ctx, tenantID, roomID, sessionID)
	span.End("room service returned domain session", map[string]any{"session": roomSessionFields(session)}, err)
	return session, err
}

func (s tracedRoomService) ListSessions(ctx context.Context, tenantID utilities.ID, roomID utilities.ID, page pagination.PageRequest) (rooms.SessionList, error) {
	span := s.recorder.Start("service", "rooms.Service.ListSessions", "validate room ids and load sessions", map[string]any{"tenant_id": tenantID.String(), "room_id": roomID.String(), "page": pageRequestFields(page)})
	list, err := s.next.ListSessions(ctx, tenantID, roomID, page)
	span.End("room service returned paginated sessions", map[string]any{"list": roomSessionListFields(list)}, err)
	return list, err
}

func (s tracedRoomService) UpdateSession(ctx context.Context, tenantID utilities.ID, roomID utilities.ID, sessionID utilities.ID, input rooms.UpdateSessionInput) (rooms.Session, error) {
	span := s.recorder.Start("service", "rooms.Service.UpdateSession", "validate room session patch", map[string]any{"tenant_id": tenantID.String(), "room_id": roomID.String(), "session_id": sessionID.String(), "input": roomSessionUpdateInputFields(input)})
	session, err := s.next.UpdateSession(ctx, tenantID, roomID, sessionID, input)
	span.End("room service returned updated session", map[string]any{"session": roomSessionFields(session)}, err)
	return session, err
}

type tracedRoomRepository struct {
	recorder *Recorder
	now      func() time.Time
}

func (r tracedRoomRepository) CreateRoom(ctx context.Context, input rooms.CreateRoomInput) (rooms.Room, error) {
	_ = ctx
	span := r.recorder.Start("repository", "RoomRepository.CreateRoom", "insert tenant room row", map[string]any{"domain_input": roomCreateInputFields(input)})
	r.recorder.Add("database", "INSERT rooms RETURNING *", "execute query", map[string]any{"params": roomCreateInputFields(input)})
	room := rooms.Room{
		ID:              input.ID,
		Name:            input.Name,
		TenantID:        input.TenantID,
		Status:          input.Status,
		Slug:            input.Slug,
		MediaPlane:      input.MediaPlane,
		Metadata:        input.Metadata,
		RecurringPolicy: input.RecurringPolicy,
		CreatedByUserID: input.CreatedByUserID,
		CreatedAt:       r.now(),
		UpdatedAt:       r.now(),
	}
	span.End("map database row to domain room", map[string]any{"room": roomFields(room)}, nil)
	return room, nil
}

func (r tracedRoomRepository) GetRoom(ctx context.Context, tenantID utilities.ID, roomID utilities.ID) (rooms.Room, error) {
	_ = ctx
	span := r.recorder.Start("repository", "RoomRepository.GetRoom", "select room by tenant and id", map[string]any{"tenant_id": tenantID.String(), "room_id": roomID.String()})
	room := roomFixture(r.now)
	span.End("map database row to domain room", map[string]any{"room": roomFields(room)}, nil)
	return room, nil
}

func (r tracedRoomRepository) ListRooms(ctx context.Context, tenantID utilities.ID, page pagination.PageRequest) (rooms.RoomList, error) {
	_ = ctx
	span := r.recorder.Start("repository", "RoomRepository.ListRooms", "select paginated tenant rooms", map[string]any{"tenant_id": tenantID.String(), "page": pageRequestFields(page)})
	list := rooms.RoomList{Rooms: []rooms.Room{roomFixture(r.now)}, Page: pagination.Page{PageSize: page.Size(), HasMore: false}}
	span.End("map database rows to room list", map[string]any{"list": roomListFields(list)}, nil)
	return list, nil
}

func (r tracedRoomRepository) UpdateRoom(ctx context.Context, tenantID utilities.ID, roomID utilities.ID, input rooms.UpdateRoomInput) (rooms.Room, error) {
	_ = ctx
	span := r.recorder.Start("repository", "RoomRepository.UpdateRoom", "update tenant room row", map[string]any{"tenant_id": tenantID.String(), "room_id": roomID.String(), "input": roomUpdateInputFields(input)})
	room := roomFixture(r.now)
	room.ID = roomID
	room.TenantID = tenantID
	if input.Name.Set && input.Name.Value != nil {
		room.Name = *input.Name.Value
	}
	if input.Status.Set && input.Status.Value != nil {
		room.Status = *input.Status.Value
	}
	room.UpdatedAt = r.now()
	span.End("map database row to updated room", map[string]any{"room": roomFields(room)}, nil)
	return room, nil
}

func (r tracedRoomRepository) CreateSession(ctx context.Context, input rooms.CreateSessionInput) (rooms.Session, error) {
	_ = ctx
	span := r.recorder.Start("repository", "RoomRepository.CreateSession", "insert room session row", map[string]any{"domain_input": roomSessionCreateInputFields(input)})
	session := rooms.Session{ID: input.ID, Status: input.Status, Metadata: input.Metadata, RoomID: input.RoomID, TenantID: input.TenantID, CreatedByUserID: input.CreatedByUserID, StartedAt: input.StartedAt, EndedAt: input.EndedAt, CreatedAt: r.now(), UpdatedAt: r.now()}
	span.End("map database row to domain session", map[string]any{"session": roomSessionFields(session)}, nil)
	return session, nil
}

func (r tracedRoomRepository) GetSession(ctx context.Context, tenantID utilities.ID, roomID utilities.ID, sessionID utilities.ID) (rooms.Session, error) {
	_ = ctx
	span := r.recorder.Start("repository", "RoomRepository.GetSession", "select room session by tenant, room, and id", map[string]any{"tenant_id": tenantID.String(), "room_id": roomID.String(), "session_id": sessionID.String()})
	session := roomSessionFixture(r.now)
	session.ID = sessionID
	session.RoomID = roomID
	session.TenantID = tenantID
	span.End("map database row to domain session", map[string]any{"session": roomSessionFields(session)}, nil)
	return session, nil
}

func (r tracedRoomRepository) ListSessions(ctx context.Context, tenantID utilities.ID, roomID utilities.ID, page pagination.PageRequest) (rooms.SessionList, error) {
	_ = ctx
	span := r.recorder.Start("repository", "RoomRepository.ListSessions", "select paginated room sessions", map[string]any{"tenant_id": tenantID.String(), "room_id": roomID.String(), "page": pageRequestFields(page)})
	list := rooms.SessionList{Sessions: []rooms.Session{roomSessionFixture(r.now)}, Page: pagination.Page{PageSize: page.Size(), HasMore: false}}
	span.End("map database rows to session list", map[string]any{"list": roomSessionListFields(list)}, nil)
	return list, nil
}

func (r tracedRoomRepository) UpdateSession(ctx context.Context, tenantID utilities.ID, roomID utilities.ID, sessionID utilities.ID, input rooms.UpdateSessionInput) (rooms.Session, error) {
	_ = ctx
	span := r.recorder.Start("repository", "RoomRepository.UpdateSession", "update room session row", map[string]any{"tenant_id": tenantID.String(), "room_id": roomID.String(), "session_id": sessionID.String(), "input": roomSessionUpdateInputFields(input)})
	session := roomSessionFixture(r.now)
	session.ID = sessionID
	session.RoomID = roomID
	session.TenantID = tenantID
	if input.Status.Set && input.Status.Value != nil {
		session.Status = *input.Status.Value
	}
	session.UpdatedAt = r.now()
	span.End("map database row to updated session", map[string]any{"session": roomSessionFields(session)}, nil)
	return session, nil
}

type tracedDenyLimiter struct {
	recorder   *Recorder
	retryAfter time.Duration
}

func (l tracedDenyLimiter) Allow(ctx context.Context, key string, policy ratelimit.Policy, now time.Time) ratelimit.Decision {
	_ = ctx
	decision := ratelimit.Decision{Allowed: false, Remaining: 0, RetryAfter: l.retryAfter}
	l.recorder.Add("ratelimit", "Limiter.Allow", "deny request after rate limit policy evaluation", map[string]any{
		"key":      key,
		"policy":   policyFields(policy),
		"now":      timestamp(now),
		"decision": decisionFields(decision),
	})
	return decision
}

type tracedRedisRateLimiter struct {
	recorder *Recorder
}

func (l tracedRedisRateLimiter) Allow(ctx context.Context, key string, policy ratelimit.Policy, now time.Time) ratelimit.Decision {
	_ = ctx
	l.recorder.Add("redis", "EVAL rate_limit.lua", "run token bucket script atomically", map[string]any{
		"keys": []string{"ratelimit:" + policy.Name + ":" + key},
		"args": map[string]any{"limit": policy.Limit, "window_ms": policy.Window.Milliseconds(), "now_ms": now.UnixMilli()},
	})
	decision := ratelimit.Decision{Allowed: true, Remaining: policy.Limit - 1}
	l.recorder.Add("redis", "script result", "redis returned allow decision", map[string]any{"decision": decisionFields(decision)})
	return decision
}

type tracedObjectStore struct {
	recorder *Recorder
	now      func() time.Time
}

func (s tracedObjectStore) PutObject(ctx context.Context, input objectstorage.PutObjectInput) (objectstorage.Object, error) {
	_ = ctx
	s.recorder.Add("adapter", "r2.Store.PutObject", "put object to cloudflare r2", map[string]any{"input": putObjectInputFields(input)})
	return objectstorage.Object{Key: input.Key, ETag: "etag-trace", ContentType: input.ContentType, Size: input.ContentLength}, nil
}

func (s tracedObjectStore) GetObject(ctx context.Context, key string) (objectstorage.ObjectReader, error) {
	_ = ctx
	s.recorder.Add("adapter", "r2.Store.GetObject", "get object from cloudflare r2", map[string]any{"key": key})
	return objectstorage.ObjectReader{Object: objectstorage.Object{Key: key, ETag: "etag-trace", ContentType: "image/png", Size: 12}, Body: io.NopCloser(bytes.NewReader([]byte("trace"))), LastModified: s.now()}, nil
}

func (s tracedObjectStore) DeleteObject(ctx context.Context, key string) error {
	_ = ctx
	s.recorder.Add("adapter", "r2.Store.DeleteObject", "delete object from cloudflare r2", map[string]any{"key": key})
	return nil
}

func (s tracedObjectStore) CreateUploadURL(ctx context.Context, input objectstorage.CreateUploadURLInput) (objectstorage.SignedURL, error) {
	_ = ctx
	span := s.recorder.Start("adapter", "r2.Store.CreateUploadURL", "presign S3-compatible PUT object request", map[string]any{"input": uploadURLInputFields(input)})
	s.recorder.Add("provider", "S3 PresignPutObject", "build r2 presigned upload operation", map[string]any{
		"bucket":       "chalk-trace",
		"key":          input.Key,
		"content_type": input.ContentType,
		"expires_in":   input.ExpiresIn.String(),
	})
	signed := objectstorage.SignedURL{
		Method:       http.MethodPut,
		URL:          "https://trace.r2.cloudflarestorage.com/chalk-trace/" + input.Key + "?X-Amz-Signature=redacted",
		SignedAt:     s.now(),
		ExpiresAt:    s.now().Add(input.ExpiresIn),
		SignedHeader: map[string][]string{"Content-Type": {input.ContentType}},
	}
	span.End("r2 adapter returned signed upload url", map[string]any{"signed_url": signedURLFields(signed)}, nil)
	return signed, nil
}

func (s tracedObjectStore) CreateDownloadURL(ctx context.Context, input objectstorage.CreateDownloadURLInput) (objectstorage.SignedURL, error) {
	_ = ctx
	s.recorder.Add("adapter", "r2.Store.CreateDownloadURL", "presign S3-compatible GET object request", map[string]any{"input": downloadURLInputFields(input)})
	return objectstorage.SignedURL{Method: http.MethodGet, URL: "https://trace.r2.cloudflarestorage.com/chalk-trace/" + input.Key + "?X-Amz-Signature=redacted", SignedAt: s.now(), ExpiresAt: s.now().Add(input.ExpiresIn)}, nil
}

func (s tracedObjectStore) CreateDeleteURL(ctx context.Context, input objectstorage.CreateDeleteURLInput) (objectstorage.SignedURL, error) {
	_ = ctx
	s.recorder.Add("adapter", "r2.Store.CreateDeleteURL", "presign S3-compatible DELETE object request", map[string]any{"input": deleteURLInputFields(input)})
	return objectstorage.SignedURL{Method: http.MethodDelete, URL: "https://trace.r2.cloudflarestorage.com/chalk-trace/" + input.Key + "?X-Amz-Signature=redacted", SignedAt: s.now(), ExpiresAt: s.now().Add(input.ExpiresIn)}, nil
}

type tracedMediaPlane struct {
	recorder *Recorder
	now      func() time.Time
}

func (p tracedMediaPlane) EnsureSession(ctx context.Context, input mediaplane.EnsureSessionInput) (mediaplane.Session, error) {
	_ = ctx
	span := p.recorder.Start("adapter", "cloudflare.sfu.Adapter.EnsureSession", "map bootstrap request to cloudflare sfu session metadata", map[string]any{
		"input": ensureSessionInputFields(input),
	})
	p.recorder.Add("provider", "Cloudflare SFU metadata", "build client bootstrap metadata without creating room server-side", map[string]any{
		"provider":    input.Provider,
		"session_key": input.SessionKey,
	})
	session := mediaplane.Session{Provider: input.Provider, Ref: "sfu-session-123", Metadata: map[string]string{"session_key": input.SessionKey, "tenant_id": input.Metadata["tenant_id"]}}
	span.End("cloudflare sfu adapter returned session", map[string]any{"session": mediaSessionFields(session)}, nil)
	return session, nil
}

func (p tracedMediaPlane) CreateJoin(ctx context.Context, input mediaplane.CreateJoinInput) (mediaplane.Join, error) {
	_ = ctx
	span := p.recorder.Start("adapter", "cloudflare.rtk.Plane.CreateJoin", "map participant join to realtimekit token request", map[string]any{
		"input": createJoinInputFields(input),
	})
	p.recorder.Add("provider", "POST /client/v4/accounts/{account_id}/realtime/apps/{app_id}/sessions/{session}/participants", "create realtimekit participant token", map[string]any{
		"session_ref": input.Session.Ref,
		"name":        input.ParticipantName,
		"preset":      input.ParticipantPreset,
	})
	join := mediaplane.Join{
		Provider:       input.Provider,
		ParticipantRef: "rtk-participant-123",
		ClientPayload:  map[string]any{"auth_token": "[redacted]", "room_name": input.Session.Ref},
		ExpiresAt:      p.now().Add(15 * time.Minute),
		Metadata:       map[string]string{"provider": string(input.Provider)},
	}
	span.End("cloudflare rtk adapter returned join payload", map[string]any{"join": mediaJoinFields(join)}, nil)
	return join, nil
}

func (p tracedMediaPlane) RemoveParticipant(ctx context.Context, input mediaplane.RemoveParticipantInput) error {
	_ = ctx
	p.recorder.Add("adapter", "cloudflare.rtk.Plane.RemoveParticipant", "remove participant", map[string]any{"input": removeParticipantInputFields(input)})
	return nil
}

func (p tracedMediaPlane) EndSession(ctx context.Context, input mediaplane.EndSessionInput) error {
	_ = ctx
	p.recorder.Add("adapter", "cloudflare.rtk.Plane.EndSession", "end media session", map[string]any{"input": endSessionInputFields(input)})
	return nil
}

func (p tracedMediaPlane) SessionUsage(ctx context.Context, input mediaplane.SessionUsageInput) (mediaplane.Usage, error) {
	_ = ctx
	p.recorder.Add("adapter", "cloudflare.rtk.Plane.SessionUsage", "read media session usage", map[string]any{"input": usageInputFields(input)})
	return mediaplane.Usage{ParticipantMinutes: 12, EgressBytes: 2048, IngressBytes: 1024}, nil
}

type tracedEmailSender struct {
	recorder *Recorder
}

func (s tracedEmailSender) SendEmail(ctx context.Context, input email.SendEmailInput) (email.SendEmailResult, error) {
	_ = ctx
	span := s.recorder.Start("adapter", "resend.Sender.SendEmail", "map email request to resend send params", map[string]any{"input": sendEmailInputFields(input)})
	s.recorder.Add("provider", "POST /emails", "send email with resend", map[string]any{
		"from":            input.From,
		"to":              input.To,
		"subject":         input.Subject,
		"idempotency_key": input.IdempotencyKey,
	})
	result := email.SendEmailResult{ProviderMessageID: "resend-trace-message"}
	span.End("resend adapter returned provider message id", map[string]any{"result": sendEmailResultFields(result)}, nil)
	return result, nil
}

func (s tracedTenantService) GetTenant(ctx context.Context, id utilities.ID) (tenants.Tenant, error) {
	span := s.recorder.Start("service", "tenants.Service.GetTenant", "validate tenant id and load tenant", map[string]any{"tenant_id": id.String()})
	tenant, err := s.next.GetTenant(ctx, id)
	span.End("tenant service returned domain tenant", map[string]any{"tenant": tenantFields(tenant)}, err)
	return tenant, err
}

func (s tracedTenantService) ListTenants(ctx context.Context, page pagination.PageRequest) (tenants.TenantList, error) {
	span := s.recorder.Start("service", "tenants.Service.ListTenants", "load paginated global tenants", map[string]any{"page": pageRequestFields(page)})
	list, err := s.next.ListTenants(ctx, page)
	span.End("tenant service returned paginated tenants", map[string]any{"list": tenantListFields(list)}, err)
	return list, err
}

func (s tracedTenantService) UpdateTenant(ctx context.Context, id utilities.ID, input tenants.UpdateTenantInput) (tenants.Tenant, error) {
	span := s.recorder.Start("service", "tenants.Service.UpdateTenant", "normalize and validate tenant patch", map[string]any{
		"tenant_id": id.String(),
		"input":     tenantUpdateInputFields(input),
	})
	tenant, err := s.next.UpdateTenant(ctx, id, input)
	span.End("tenant service returned updated tenant", map[string]any{"tenant": tenantFields(tenant)}, err)
	return tenant, err
}

func (s tracedTenantService) AvailableRegions(ctx context.Context) ([]regions.Region, error) {
	span := s.recorder.Start("service", "tenants.Service.AvailableRegions", "return static supported regions", nil)
	available, err := s.next.AvailableRegions(ctx)
	span.End("tenant service returned available regions", map[string]any{"regions": regionFields(available)}, err)
	return available, err
}

func tenantID() utilities.ID {
	return mustID("33333333-3333-4333-8333-333333333333")
}

func userID() utilities.ID {
	return mustID("11111111-1111-4111-8111-111111111111")
}

func sessionID() utilities.ID {
	return mustID("22222222-2222-4222-8222-222222222222")
}

func membershipID() utilities.ID {
	return mustID("44444444-4444-4444-8444-444444444444")
}

func roomID() utilities.ID {
	return mustID("66666666-6666-4666-8666-666666666666")
}

func roomSessionID() utilities.ID {
	return mustID("77777777-7777-4777-8777-777777777777")
}

func recordingID() utilities.ID {
	return mustID("88888888-8888-4888-8888-888888888888")
}

func transcriptArtifactID() utilities.ID {
	return mustID("99999999-9999-4999-8999-999999999999")
}

func transcriptJobID() utilities.ID {
	return mustID("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
}

func apiKeyID() utilities.ID {
	return mustID("55555555-5555-4555-8555-555555555555")
}

func userPrincipal() authentication.Principal {
	return authentication.Principal{Kind: authentication.PrincipalUser, UserID: userID(), SessionID: sessionID()}
}

func systemPrincipal() authentication.Principal {
	return authentication.Principal{Kind: authentication.PrincipalSystem}
}

func authUserFixture(now func() time.Time) authentication.User {
	return authentication.User{ID: userID(), Name: "Trace Reviewer", Email: "trace-reviewer@example.test", CreatedAt: now(), UpdatedAt: now()}
}

func sessionUserFixture(now func() time.Time) authentication.SessionUser {
	return authentication.SessionUser{
		Session: authentication.Session{ID: sessionID(), UserID: userID(), TokenHash: "trace-token-hash", ExpiresAt: now().Add(time.Hour), CreatedAt: now(), UpdatedAt: now()},
		User:    authUserFixture(now),
	}
}

func tenantFixture(now func() time.Time) tenants.Tenant {
	return tenants.Tenant{ID: tenantID(), Name: "Chalk Demo Workspace", DefaultRegion: stringPtr("us"), Website: stringPtr("https://chalkmeet.com"), CreatedAt: now(), UpdatedAt: now()}
}

func userFixture(now func() time.Time) users.User {
	return users.User{ID: userID(), Name: "Trace Reviewer", Email: "trace-reviewer@example.test", CreatedAt: now(), UpdatedAt: now()}
}

func membershipFixture(now func() time.Time, role memberships.Role) memberships.Membership {
	return memberships.Membership{ID: membershipID(), TenantID: tenantID(), UserID: userID(), Role: role, CreatedAt: now(), UpdatedAt: now()}
}

func roomFixture(now func() time.Time) rooms.Room {
	return rooms.Room{
		ID:              roomID(),
		Name:            "Daily Review",
		TenantID:        tenantID(),
		Status:          rooms.StatusActive,
		Slug:            "daily-review",
		MediaPlane:      "cf_rtk",
		Metadata:        json.RawMessage(`{"purpose":"review"}`),
		CreatedByUserID: userID(),
		CreatedAt:       now(),
		UpdatedAt:       now(),
	}
}

func roomSessionFixture(now func() time.Time) rooms.Session {
	startedAt := now()
	return rooms.Session{
		ID:              roomSessionID(),
		Status:          rooms.SessionStatusActive,
		RoomID:          roomID(),
		TenantID:        tenantID(),
		CreatedByUserID: userID(),
		StartedAt:       &startedAt,
		CreatedAt:       now(),
		UpdatedAt:       now(),
	}
}

func transcriptFields(transcript transcripts.Transcript) map[string]any {
	return map[string]any{
		"id":           transcript.ID.String(),
		"tenant_id":    transcript.TenantID.String(),
		"recording_id": transcript.RecordingID.String(),
		"room_id":      transcript.RoomID.String(),
		"session_id":   transcript.SessionID.String(),
		"status":       transcript.Status,
		"provider":     transcript.Provider,
		"model":        transcript.Model,
		"languages":    transcript.Languages,
		"text":         transcript.Text,
		"metadata":     decodedBody(transcript.Metadata),
		"completed_at": optionalTraceTime(transcript.CompletedAt),
		"created_at":   transcript.CreatedAt.UTC().Format(time.RFC3339Nano),
		"updated_at":   transcript.UpdatedAt.UTC().Format(time.RFC3339Nano),
	}
}

func stringPtr(value string) *string {
	return &value
}

func timestamp(value time.Time) string {
	if value.IsZero() {
		return ""
	}
	return value.UTC().Format(time.RFC3339Nano)
}

func decodedBody(body json.RawMessage) any {
	if len(body) == 0 {
		return nil
	}
	return mustDecode(body)
}

func tracedHeaders(r *http.Request) map[string]string {
	headers := map[string]string{}
	if value := r.Header.Get("Authorization"); value != "" {
		headers["authorization"] = "Bearer [redacted]"
	}
	if value := r.Header.Get("Content-Type"); value != "" {
		headers["content-type"] = value
	}
	if value := r.Header.Get("Idempotency-Key"); value != "" {
		headers["idempotency-key"] = value
	}
	return headers
}

func tracedResponseHeaders(response *httptest.ResponseRecorder) map[string]string {
	headers := map[string]string{}
	if value := response.Header().Get("Location"); value != "" {
		headers["location"] = value
	}
	if value := response.Header().Get("Set-Cookie"); value != "" {
		headers["set-cookie"] = "chalk_session=[redacted]"
	}
	if value := response.Header().Get("Retry-After"); value != "" {
		headers["retry-after"] = value
	}
	return headers
}

func redactHash(value string) string {
	if len(value) <= 8 {
		return "[redacted]"
	}
	return value[:8] + "...[redacted]"
}

func principalFields(principal authentication.Principal) map[string]any {
	return map[string]any{
		"kind":       principal.Kind,
		"user_id":    principal.UserID.String(),
		"tenant_id":  principal.TenantID.String(),
		"session_id": principal.SessionID.String(),
		"api_key_id": principal.APIKeyID.String(),
		"scopes":     principal.Scopes,
	}
}

func tenantPermissionFields(permission authorization.TenantPermission) map[string]any {
	return map[string]any{"scope": permission.Scope, "minimum_role": permission.MinimumRole}
}

func pageRequestFields(page pagination.PageRequest) map[string]any {
	fields := map[string]any{"size": page.Size()}
	if cursor := page.Cursor(); cursor != nil {
		fields["cursor"] = map[string]any{"id": cursor.ID.String(), "created_at": timestamp(cursor.CreatedAt)}
	}
	return fields
}

func pageFields(page pagination.Page) map[string]any {
	fields := map[string]any{"page_size": page.PageSize, "has_more": page.HasMore}
	if page.NextCursor != nil {
		fields["next_cursor"] = map[string]any{"id": page.NextCursor.ID.String(), "created_at": timestamp(page.NextCursor.CreatedAt)}
	}
	return fields
}

func authUserFields(user authentication.User) map[string]any {
	return map[string]any{"id": user.ID.String(), "name": user.Name, "email": user.Email, "created_at": timestamp(user.CreatedAt), "updated_at": timestamp(user.UpdatedAt)}
}

func authSessionFields(session authentication.Session) map[string]any {
	return map[string]any{"id": session.ID.String(), "user_id": session.UserID.String(), "token_hash": redactHash(session.TokenHash), "expires_at": timestamp(session.ExpiresAt), "revoked_at": session.RevokedAt, "created_at": timestamp(session.CreatedAt), "updated_at": timestamp(session.UpdatedAt)}
}

func sessionUserFields(sessionUser authentication.SessionUser) map[string]any {
	return map[string]any{"session": authSessionFields(sessionUser.Session), "user": authUserFields(sessionUser.User)}
}

func authResultFields(result authentication.AuthResult) map[string]any {
	return map[string]any{"session_token": "[redacted]", "expires_at": timestamp(result.ExpiresAt), "user": authUserFields(result.User)}
}

func registerInputFields(input authentication.RegisterInput) map[string]any {
	return map[string]any{"name": input.Name, "email": input.Email, "password": "[redacted]", "user_agent": input.UserAgent}
}

func loginInputFields(input authentication.LoginInput) map[string]any {
	return map[string]any{"email": input.Email, "password": "[redacted]", "user_agent": input.UserAgent}
}

func createPasswordUserInputFields(input authentication.CreatePasswordUserInput) map[string]any {
	return map[string]any{"user_id": input.UserID.String(), "identity_id": input.IdentityID.String(), "name": input.Name, "email": input.Email, "password_hash": "[redacted]"}
}

func createGoogleUserInputFields(input authentication.CreateGoogleUserInput) map[string]any {
	return map[string]any{"user_id": input.UserID.String(), "identity_id": input.IdentityID.String(), "name": input.Name, "email": input.Email, "provider_subject": input.ProviderSubject}
}

func createSessionInputFields(input authentication.CreateSessionInput) map[string]any {
	return map[string]any{"id": input.ID.String(), "user_id": input.UserID.String(), "token_hash": redactHash(input.TokenHash), "user_agent": input.UserAgent, "expires_at": timestamp(input.ExpiresAt)}
}

func tenantUpdateInputFields(input tenants.UpdateTenantInput) map[string]any {
	return map[string]any{"name": optionalStringField(input.Name), "default_region": optionalStringField(input.DefaultRegion), "default_media_plane": optionalStringField(input.DefaultMediaPlane), "logo_key": optionalStringField(input.LogoKey), "website": optionalStringField(input.Website)}
}

func optionalStringField(value utilities.OptionalString) map[string]any {
	return map[string]any{"set": value.Set, "value": value.Value}
}

func tenantListFields(list tenants.TenantList) map[string]any {
	tenantValues := make([]map[string]any, 0, len(list.Tenants))
	for _, tenant := range list.Tenants {
		tenantValues = append(tenantValues, tenantFields(tenant))
	}
	return map[string]any{"tenants": tenantValues, "page": pageFields(list.Page)}
}

func userCreateInputFields(input users.CreateUserInput) map[string]any {
	return map[string]any{"id": input.ID.String(), "name": input.Name, "email": input.Email}
}

func userFields(user users.User) map[string]any {
	return map[string]any{"id": user.ID.String(), "name": user.Name, "email": user.Email, "created_at": timestamp(user.CreatedAt), "updated_at": timestamp(user.UpdatedAt)}
}

func userListFields(list users.UserList) map[string]any {
	userValues := make([]map[string]any, 0, len(list.Users))
	for _, user := range list.Users {
		userValues = append(userValues, userFields(user))
	}
	return map[string]any{"users": userValues, "page": pageFields(list.Page)}
}

func membershipCreateInputFields(input memberships.CreateMembershipInput) map[string]any {
	return map[string]any{"id": input.ID.String(), "tenant_id": input.TenantID.String(), "user_id": input.UserID.String(), "role": input.Role}
}

func membershipUpdateInputFields(input memberships.UpdateMembershipInput) map[string]any {
	return map[string]any{"role": input.Role}
}

func membershipFields(membership memberships.Membership) map[string]any {
	return map[string]any{"id": membership.ID.String(), "tenant_id": membership.TenantID.String(), "user_id": membership.UserID.String(), "role": membership.Role, "created_at": timestamp(membership.CreatedAt), "updated_at": timestamp(membership.UpdatedAt)}
}

func membershipListFields(list memberships.MembershipList) map[string]any {
	values := make([]map[string]any, 0, len(list.Memberships))
	for _, membership := range list.Memberships {
		values = append(values, membershipFields(membership))
	}
	return map[string]any{"memberships": values, "page": pageFields(list.Page)}
}

func roomCreateInputFields(input rooms.CreateRoomInput) map[string]any {
	return map[string]any{
		"id":                 input.ID.String(),
		"name":               input.Name,
		"tenant_id":          input.TenantID.String(),
		"status":             input.Status,
		"slug":               input.Slug,
		"media_plane":        input.MediaPlane,
		"metadata":           mustDecode(input.Metadata),
		"recurring_policy":   decodedBody(input.RecurringPolicy),
		"created_by_user_id": input.CreatedByUserID.String(),
	}
}

func roomUpdateInputFields(input rooms.UpdateRoomInput) map[string]any {
	return map[string]any{
		"name":             optionalStringField(input.Name),
		"status":           optionalStringField(input.Status),
		"slug":             optionalStringField(input.Slug),
		"media_plane":      optionalStringField(input.MediaPlane),
		"metadata":         optionalJSONField(input.Metadata),
		"recurring_policy": optionalJSONField(input.RecurringPolicy),
	}
}

func roomFields(room rooms.Room) map[string]any {
	return map[string]any{
		"id":                 room.ID.String(),
		"name":               room.Name,
		"tenant_id":          room.TenantID.String(),
		"status":             room.Status,
		"slug":               room.Slug,
		"media_plane":        room.MediaPlane,
		"metadata":           mustDecode(room.Metadata),
		"recurring_policy":   decodedBody(room.RecurringPolicy),
		"created_by_user_id": room.CreatedByUserID.String(),
		"created_at":         timestamp(room.CreatedAt),
		"updated_at":         timestamp(room.UpdatedAt),
	}
}

func roomListFields(list rooms.RoomList) map[string]any {
	values := make([]map[string]any, 0, len(list.Rooms))
	for _, room := range list.Rooms {
		values = append(values, roomFields(room))
	}
	return map[string]any{"rooms": values, "page": pageFields(list.Page)}
}

func roomSessionCreateInputFields(input rooms.CreateSessionInput) map[string]any {
	return map[string]any{
		"id":                 input.ID.String(),
		"status":             input.Status,
		"metadata":           decodedBody(input.Metadata),
		"room_id":            input.RoomID.String(),
		"tenant_id":          input.TenantID.String(),
		"created_by_user_id": input.CreatedByUserID.String(),
		"started_at":         optionalTimeField(input.StartedAt),
		"ended_at":           optionalTimeField(input.EndedAt),
	}
}

func roomSessionUpdateInputFields(input rooms.UpdateSessionInput) map[string]any {
	return map[string]any{
		"status":     optionalStringField(input.Status),
		"metadata":   optionalJSONField(input.Metadata),
		"started_at": optionalPatchTimeField(input.StartedAt),
		"ended_at":   optionalPatchTimeField(input.EndedAt),
	}
}

func roomSessionFields(session rooms.Session) map[string]any {
	return map[string]any{
		"id":                 session.ID.String(),
		"status":             session.Status,
		"metadata":           decodedBody(session.Metadata),
		"room_id":            session.RoomID.String(),
		"tenant_id":          session.TenantID.String(),
		"created_by_user_id": session.CreatedByUserID.String(),
		"started_at":         optionalTimeField(session.StartedAt),
		"ended_at":           optionalTimeField(session.EndedAt),
		"created_at":         timestamp(session.CreatedAt),
		"updated_at":         timestamp(session.UpdatedAt),
	}
}

func roomSessionListFields(list rooms.SessionList) map[string]any {
	values := make([]map[string]any, 0, len(list.Sessions))
	for _, session := range list.Sessions {
		values = append(values, roomSessionFields(session))
	}
	return map[string]any{"sessions": values, "page": pageFields(list.Page)}
}

func optionalJSONField(value utilities.OptionalJSON) map[string]any {
	return map[string]any{"set": value.Set, "value": decodedBody(value.Value)}
}

func optionalTimeField(value *time.Time) any {
	if value == nil {
		return nil
	}
	return timestamp(*value)
}

func optionalPatchTimeField(value rooms.OptionalTime) map[string]any {
	return map[string]any{"set": value.Set, "value": optionalTimeField(value.Value)}
}

func policyFields(policy ratelimit.Policy) map[string]any {
	return map[string]any{"name": policy.Name, "limit": policy.Limit, "window": policy.Window.String()}
}

func decisionFields(decision ratelimit.Decision) map[string]any {
	return map[string]any{"allowed": decision.Allowed, "remaining": decision.Remaining, "retry_after": decision.RetryAfter.String()}
}

func uploadURLInputFields(input objectstorage.CreateUploadURLInput) map[string]any {
	return map[string]any{"key": input.Key, "content_type": input.ContentType, "expires_in": input.ExpiresIn.String()}
}

func downloadURLInputFields(input objectstorage.CreateDownloadURLInput) map[string]any {
	return map[string]any{"key": input.Key, "expires_in": input.ExpiresIn.String()}
}

func deleteURLInputFields(input objectstorage.CreateDeleteURLInput) map[string]any {
	return map[string]any{"key": input.Key, "expires_in": input.ExpiresIn.String()}
}

func putObjectInputFields(input objectstorage.PutObjectInput) map[string]any {
	return map[string]any{"key": input.Key, "content_type": input.ContentType, "content_length": input.ContentLength, "cache_control": input.CacheControl, "metadata": input.Metadata}
}

func signedURLFields(url objectstorage.SignedURL) map[string]any {
	return map[string]any{"method": url.Method, "url": redactSignedURL(url.URL), "signed_at": timestamp(url.SignedAt), "expires_at": timestamp(url.ExpiresAt), "signed_header": url.SignedHeader}
}

func redactSignedURL(value string) string {
	return value
}

func ensureSessionInputFields(input mediaplane.EnsureSessionInput) map[string]any {
	return map[string]any{"provider": input.Provider, "session_key": input.SessionKey, "title": input.Title, "metadata": input.Metadata}
}

func createJoinInputFields(input mediaplane.CreateJoinInput) map[string]any {
	return map[string]any{"provider": input.Provider, "session": mediaSessionFields(input.Session), "participant_name": input.ParticipantName, "external_participant_id": input.ExternalParticipantID, "participant_preset": input.ParticipantPreset, "metadata": input.Metadata}
}

func removeParticipantInputFields(input mediaplane.RemoveParticipantInput) map[string]any {
	return map[string]any{"provider": input.Provider, "session_ref": input.SessionRef, "participant_ref": input.ParticipantRef}
}

func endSessionInputFields(input mediaplane.EndSessionInput) map[string]any {
	return map[string]any{"provider": input.Provider, "session_ref": input.SessionRef}
}

func usageInputFields(input mediaplane.SessionUsageInput) map[string]any {
	return map[string]any{"provider": input.Provider, "session_ref": input.SessionRef}
}

func mediaSessionFields(session mediaplane.Session) map[string]any {
	return map[string]any{"provider": session.Provider, "ref": session.Ref, "metadata": session.Metadata}
}

func mediaJoinFields(join mediaplane.Join) map[string]any {
	return map[string]any{"provider": join.Provider, "participant_ref": join.ParticipantRef, "client_payload": join.ClientPayload, "expires_at": timestamp(join.ExpiresAt), "metadata": join.Metadata}
}

func sendEmailInputFields(input email.SendEmailInput) map[string]any {
	return map[string]any{"from": input.From, "to": input.To, "subject": input.Subject, "has_text_body": input.TextBody != "", "has_html_body": input.HTMLBody != "", "cc": input.CC, "bcc": input.BCC, "reply_to": input.ReplyTo, "headers": input.Headers, "tags": input.Tags, "idempotency_key": input.IdempotencyKey}
}

func sendEmailResultFields(result email.SendEmailResult) map[string]any {
	return map[string]any{"provider_message_id": result.ProviderMessageID}
}

func regionFields(values []regions.Region) []map[string]any {
	fields := make([]map[string]any, 0, len(values))
	for _, value := range values {
		fields = append(fields, map[string]any{"code": value.Code, "name": value.Name})
	}
	return fields
}

var _ httpapi.AuthenticationService = (*tracedAuthenticationService)(nil)
var _ authentication.Repository = (*tracedAuthenticationRepository)(nil)
var _ authentication.PasswordHasher = tracedPasswordHasher{}
var _ authentication.GoogleProvider = tracedGoogleProvider{}
var _ authentication.OAuthStateStore = tracedOAuthStateStore{}
var _ httpapi.AuthenticationService = staticAuthentication{}
var _ httpapi.UserService = tracedUserService{}
var _ users.UserRepository = tracedUserRepository{}
var _ httpapi.MembershipService = tracedMembershipService{}
var _ memberships.MembershipRepository = tracedMembershipRepository{}
var _ ratelimit.Limiter = tracedDenyLimiter{}
var _ ratelimit.Limiter = tracedRedisRateLimiter{}
var _ objectstorage.Store = tracedObjectStore{}
var _ mediaplane.Plane = tracedMediaPlane{}
var _ email.Sender = tracedEmailSender{}
