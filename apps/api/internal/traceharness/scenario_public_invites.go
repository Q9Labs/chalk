package traceharness

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const RoutePublicInviteObservabilityScenario = "route:public-invite-observability"

const RoutePublicInviteAccessRecoveryScenario = "route:public-invite-access-recovery"

func runRoutePublicInviteAccessRecovery(ctx context.Context) (ScenarioResult, error) {
	current := time.Date(2026, time.July, 6, 1, 0, 0, 0, time.UTC)
	recorder := NewRecorder(func() time.Time { return current })
	privateKey := ed25519.NewKeyFromSeed(make([]byte, ed25519.SeedSize))
	publicKey := privateKey.Public().(ed25519.PublicKey)
	subject := accessgrants.Subject{
		TenantID: mustID("11111111-1111-4111-8111-111111111111"), SpaceID: mustID("22222222-2222-4222-8222-222222222222"),
		EpisodeID: mustID("33333333-3333-4333-8333-333333333333"), ParticipantID: mustID("44444444-4444-4444-8444-444444444444"),
		ParticipantGeneration: 1, Provider: accessgrants.ProviderCloudflareSFU, CloudflareConnectionID: "trace-connection",
	}
	verifier, err := accessgrants.NewVerifier(accessgrants.VerifierConfig{Issuer: "https://api.chalk.test", VerificationKeys: map[string]ed25519.PublicKey{"trace": publicKey}, Now: func() time.Time { return current }})
	if err != nil {
		return ScenarioResult{}, err
	}
	issue := func(offset time.Duration) (string, error) {
		issuer, issuerErr := accessgrants.NewIssuer(accessgrants.IssuerConfig{Issuer: "https://api.chalk.test", KeyID: "trace", PrivateKey: privateKey, Now: func() time.Time { return current.Add(offset) }})
		if issuerErr != nil {
			return "", issuerErr
		}
		credential, issueErr := issuer.Issue(ctx, subject)
		return credential.Token, issueErr
	}
	restore := recorder.Start("service", "publicinvites.Runtime.restoreAdmittedAccess", "collect initial access for an authenticated admitted arrival", map[string]any{
		"arrival_state": "admitted", "participant_binding": "persisted", "media_proof": "not required",
	})
	recorder.Add("access", "publicinviteapp.Access.RestorePublicAccess", "resume the persisted provider binding without replacing the media connection", map[string]any{
		"participant": "matched", "provider_binding": "matched", "credentials": "[redacted]",
	})
	restore.End("initial access restored", map[string]any{"provider_binding": "unchanged", "credentials": "[redacted]"}, nil)

	recentlyExpired, err := issue(-6 * time.Minute)
	if err != nil {
		return ScenarioResult{}, err
	}
	replacement := recorder.Start("service", "publicinvites.Runtime.RefreshAccess", "replace an expired media connection for an admitted arrival", map[string]any{
		"arrival_state": "admitted", "replace_media_connection": true, "media_proof": "[redacted]",
	})
	verify := recorder.Start("accessgrants", "Verifier.VerifyForRecovery", "verify the signed proof within the recovery grace", map[string]any{
		"signature": "checked", "subject_binding": "persisted participant", "credential": "[redacted]",
	})
	_, err = verifier.VerifyForRecovery(ctx, recentlyExpired)
	verify.End("expired proof accepted within recovery grace", map[string]any{"recovery_grace_seconds": int(accessgrants.RecoveryGrace / time.Second)}, err)
	if err != nil {
		replacement.End("replacement rejected", nil, err)
		return ScenarioResult{}, err
	}
	recorder.Add("service", "publicinvites.Access.issue", "issue replacement access and participant diagnostics credentials", map[string]any{
		"media_connection": "new provider binding", "diagnostics": "issued", "tokens": "[redacted]",
	})
	replacement.End("replacement access committed", map[string]any{"diagnostics": "present", "credentials": "[redacted]"}, nil)

	outsideGrace, err := issue(-8 * time.Minute)
	if err != nil {
		return ScenarioResult{}, err
	}
	rejected := recorder.Start("accessgrants", "Verifier.VerifyForRecovery", "reject an expired proof outside the recovery grace", map[string]any{
		"credential": "[redacted]", "secret_material": "omitted",
	})
	_, err = verifier.VerifyForRecovery(ctx, outsideGrace)
	if !errors.Is(err, accessgrants.ErrExpired) {
		rejected.End("unexpected recovery result", nil, err)
		return ScenarioResult{}, err
	}
	rejected.End("expired proof rejected outside recovery grace", map[string]any{"reason": "expired"}, err)
	return directResult(RoutePublicInviteAccessRecoveryScenario, http.StatusOK, recorder, map[string]any{
		"initial_restore": "succeeded", "replacement": "succeeded", "diagnostics": "issued", "outside_grace": "rejected",
	}, nil)
}

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
	span := s.recorder.Start("service", "publicinvites.Runtime.Arrive", "resolve the public invite and create a knock arrival", map[string]any{
		"identity":     "guest",
		"invite_token": "[redacted]",
		"display_name": "[redacted]",
		"credential":   "[redacted]",
	})
	arrival := s.recorder.Start("repository", "PublicInviteRepository.CreateArrival", "persist the idempotent pending arrival", map[string]any{
		"request_key": "public-invite-trace-0001",
	})
	arrival.End("pending arrival committed", map[string]any{
		"state": string(publicinvites.ArrivalPending),
	}, nil)
	admission := s.recorder.Start("repository", "PublicInviteRepository.CreateAdmissionRequest", "lock the arrival and derive its Tenant and Space scope", map[string]any{
		"scope_source": "locked_arrival",
	})
	admission.End("admission request committed", map[string]any{
		"state":    string(publicinvites.AdmissionRequestPending),
		"replayed": false,
	}, nil)
	span.End("public arrival is waiting for admission", map[string]any{
		"state":    string(publicinvites.ArrivalPending),
		"identity": string(publicinvites.IdentityGuest),
	}, nil)
	presentation := publicinvites.PublicSpacePresentation{Name: "[redacted]", Slug: "trace-space", AdmissionMode: publicinvites.AdmissionKnock}
	return publicinvites.PublicSpaceArrival{
		State:         publicinvites.ArrivalPending,
		Presentation:  &presentation,
		Identity:      publicinvites.IdentityGuest,
		ArrivalHandle: "44444444-4444-4444-8444-444444444444",
		RetryAfter:    60,
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
