package traceharness

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const RoutePublicInviteObservabilityScenario = "route:public-invite-observability"

func runRoutePublicInviteObservability(ctx context.Context) (ScenarioResult, error) {
	now := deterministicClock()
	recorder := NewRecorder(now)
	service := tracedPublicInviteService{recorder: recorder}

	return runRouteTrace(ctx, routeTraceConfig{
		Name:        RoutePublicInviteObservabilityScenario,
		Recorder:    recorder,
		Handler:     publicInviteTraceRouter(service, now),
		Method:      http.MethodPost,
		Path:        "/v1/public/space-invite-arrivals",
		Body:        json.RawMessage(`{"space_invite_token":"space-invite-private-sentinel","display_name":"Private Display Name"}`),
		DisplayBody: json.RawMessage(`{"space_invite_token":"[redacted]","display_name":"[redacted]"}`),
		Headers: map[string]string{
			"Origin":          "https://app.example",
			"Idempotency-Key": "public-invite-trace-0001",
		},
		ExpectedStatus: http.StatusCreated,
	})
}

func publicInviteTraceRouter(service tracedPublicInviteService, now func() time.Time) http.Handler {
	return httpapi.NewRouter(httpapi.Options{
		RateLimit:     noRateLimits(now),
		PublicInvites: service,
		CORS:          httpapi.CORSOptions{AllowedOrigins: []string{"https://app.example"}},
	})
}

type tracedPublicInviteService struct {
	recorder *Recorder
}

func (s tracedPublicInviteService) GetInvite(context.Context, utilities.ID, utilities.ID) (publicinvites.ManagedInvite, error) {
	return publicinvites.ManagedInvite{}, nil
}

func (s tracedPublicInviteService) UpdateInvite(context.Context, publicinvites.UpdateSpacePublicInviteInput) (publicinvites.ManagedInvite, error) {
	return publicinvites.ManagedInvite{}, nil
}

func (s tracedPublicInviteService) RotateInvite(context.Context, publicinvites.RotateSpacePublicInviteInput) (publicinvites.ManagedInvite, error) {
	return publicinvites.ManagedInvite{}, nil
}

func (s tracedPublicInviteService) ListAdmissionRequests(context.Context, publicinvites.ListPublicAdmissionRequestsInput) (publicinvites.AdmissionRequestPage, error) {
	return publicinvites.AdmissionRequestPage{}, nil
}

func (s tracedPublicInviteService) ApproveAdmissionRequest(context.Context, publicinvites.DecidePublicAdmissionRequestInput) (publicinvites.AdmissionRequest, error) {
	return publicinvites.AdmissionRequest{}, nil
}

func (s tracedPublicInviteService) DenyAdmissionRequest(context.Context, publicinvites.DecidePublicAdmissionRequestInput) (publicinvites.AdmissionRequest, error) {
	return publicinvites.AdmissionRequest{}, nil
}

func (s tracedPublicInviteService) CreatePublicSpace(context.Context, publicinvites.CreatePublicSpaceInput) (publicinvites.PublicSpaceCreated, error) {
	return publicinvites.PublicSpaceCreated{}, nil
}

func (s tracedPublicInviteService) Arrive(_ context.Context, _ publicinvites.PublicInviteArrivalInput) (publicinvites.PublicSpaceArrival, error) {
	span := s.recorder.Start("service", "publicinvites.Runtime.Arrive", "resolve the public invite and admit the Guest", map[string]any{
		"identity":     "guest",
		"invite_token": "[redacted]",
		"display_name": "[redacted]",
		"credential":   "[redacted]",
		"outcome":      "succeeded",
	})
	span.End("public arrival admitted", map[string]any{
		"state":    string(publicinvites.ArrivalAdmitted),
		"identity": string(publicinvites.IdentityGuest),
	}, nil)
	presentation := publicinvites.PublicSpacePresentation{Name: "[redacted]", Slug: "trace-space", AdmissionMode: publicinvites.AdmissionOpen}
	return publicinvites.PublicSpaceArrival{
		State:         publicinvites.ArrivalAdmitted,
		Presentation:  &presentation,
		Identity:      publicinvites.IdentityGuest,
		ArrivalHandle: "44444444-4444-4444-8444-444444444444",
	}, nil
}

func (s tracedPublicInviteService) Status(context.Context, publicinvites.PublicInviteArrivalStatusInput) (publicinvites.PublicSpaceArrival, error) {
	return publicinvites.PublicSpaceArrival{}, nil
}

func (s tracedPublicInviteService) RefreshAccess(context.Context, publicinvites.PublicInviteRefreshInput) (publicinvites.PublicAccessGrant, error) {
	return publicinvites.PublicAccessGrant{}, nil
}

func (s tracedPublicInviteService) Leave(context.Context, publicinvites.PublicInviteLeaveInput) error {
	return nil
}
