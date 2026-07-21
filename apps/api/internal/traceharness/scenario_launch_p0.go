package traceharness

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/apikeys"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/mediapublications"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/participantaccess"
	"github.com/q9labs/chalk/apps/api/internal/rooms"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const (
	RouteAPIKeyCustomerFlowScenario      = "route:api-key-customer-flow"
	EdgeAPIKeyRejectedScopeScenario      = "edge:api-key-rejected-scope"
	RouteParticipantMediaSFUAuthScenario = "route:participant-media-sfu-auth"
	EdgeParticipantMediaAudienceScenario = "edge:participant-media-wrong-audience"
)

func runRouteAPIKeyCustomerFlow(ctx context.Context) (ScenarioResult, error) {
	return runAPIKeyRoute(ctx, RouteAPIKeyCustomerFlowScenario, []authentication.Scope{authentication.ScopeTenantsRead}, http.StatusOK)
}

func runEdgeAPIKeyRejectedScope(ctx context.Context) (ScenarioResult, error) {
	return runAPIKeyRoute(ctx, EdgeAPIKeyRejectedScopeScenario, []authentication.Scope{authentication.ScopeRoomsRead}, http.StatusForbidden)
}

func runAPIKeyRoute(ctx context.Context, name string, scopes []authentication.Scope, expectedStatus int) (ScenarioResult, error) {
	now := deterministicClock()
	recorder := NewRecorder(now)
	rawKey, record := traceAPIKey(now(), scopes)
	repository := &tracedAPIKeyRepository{recorder: recorder, record: record}
	authenticator := tracedAPIKeyAuthenticator{
		recorder: recorder,
		next:     apikeys.NewService(repository, apikeys.Config{Now: now}),
	}
	policy := tracedAPIKeyPolicy{recorder: recorder, next: authorization.NewTenantPolicy(nil)}
	handler := httpapi.NewRouter(httpapi.Options{
		RateLimit:            noRateLimits(now),
		APIKeyAuthentication: authenticator,
		TenantAuthz:          policy,
		Tenants: tracedTenantService{
			recorder: recorder,
			next:     tenants.NewService(tracedTenantRepository{recorder: recorder, now: now}),
		},
	})
	recorder.Add("correlation", "HTTP propagation", "preserve the incoming journey and W3C trace context through authentication and policy", map[string]any{
		"journey_header": "present", "traceparent": "present",
	})
	return runRouteTrace(ctx, routeTraceConfig{
		Name:          name,
		Recorder:      recorder,
		Handler:       handler,
		Method:        http.MethodGet,
		Path:          "/v1/tenants/" + tenantID().String(),
		Authorization: "Bearer " + rawKey,
		Headers: map[string]string{
			"x-chalk-journey-id": "88888888-8888-4888-8888-888888888888",
			"traceparent":        "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
		},
		ExpectedStatus: expectedStatus,
	})
}

func runRouteParticipantMediaSFUAuth(ctx context.Context) (ScenarioResult, error) {
	return runParticipantMediaRoute(ctx, RouteParticipantMediaSFUAuthScenario, false, http.StatusOK)
}

func runEdgeParticipantMediaAudience(ctx context.Context) (ScenarioResult, error) {
	return runParticipantMediaRoute(ctx, EdgeParticipantMediaAudienceScenario, true, http.StatusUnauthorized)
}

func runParticipantMediaRoute(ctx context.Context, name string, wrongAudience bool, expectedStatus int) (ScenarioResult, error) {
	now := deterministicClock()
	recorder := NewRecorder(now)
	issuer, verifier, subject := participantMediaFixtures(now)
	credential, err := issuer.Issue(ctx, subject)
	if err != nil {
		return ScenarioResult{}, err
	}
	if wrongAudience {
		credential.Token, err = participantCredentialWithAudience(credential.Token, traceParticipantPrivateKey(), "chalk-sync")
		if err != nil {
			return ScenarioResult{}, err
		}
	}
	resolver := &tracedSFUResolver{recorder: recorder, now: now}
	active := &tracedActiveParticipant{recorder: recorder}
	publications := &tracedMediaPublicationRegistry{recorder: recorder}
	handler := httpapi.NewRouter(httpapi.Options{
		RateLimit: noRateLimits(now),
		Rooms: participantMediaRoomService{tracedRoomService: tracedRoomService{
			recorder: recorder, next: rooms.NewService(tracedRoomRepository{recorder: recorder, now: now}),
		}, now: now},
		Tenants:                tracedTenantService{recorder: recorder, next: tenants.NewService(tracedTenantRepository{recorder: recorder, now: now})},
		MediaPlane:             resolver,
		MediaPublications:      publications,
		ParticipantMediaVerify: tracedParticipantMediaVerifier{recorder: recorder, next: verifier},
		ParticipantMediaActive: active,
	})
	body := json.RawMessage(`{"connection_id":"connection_trace","tracks":[{"location":"local","mid":"0","trackName":"camera-track","source":"camera"}]}`)
	result, runErr := runRouteTrace(ctx, routeTraceConfig{
		Name: name, Recorder: recorder, Handler: handler,
		Method: http.MethodPost,
		Path:   "/v1/tenants/" + tenantID().String() + "/rooms/" + roomID().String() + "/sessions/" + roomSessionID().String() + "/participants/" + participantID().String() + "/media/sfu/tracks",
		Body:   body, DisplayBody: json.RawMessage(`{"connection_id":"[bound]","track_count":1,"session_description":"[absent]"}`), Authorization: "Bearer " + credential.Token,
		Headers: map[string]string{
			"x-chalk-journey-id": "88888888-8888-4888-8888-888888888888",
			"traceparent":        "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
		},
		ExpectedStatus: expectedStatus,
	})
	if runErr != nil {
		return result, runErr
	}
	if wrongAudience && (active.calls != 0 || resolver.calls != 0) {
		return result, errors.New("wrong-audience participant credential reached active-participant or media adapter boundary")
	}
	if !wrongAudience && (active.calls != 1 || resolver.calls != 1 || resolver.addTrackCalls != 1) {
		return result, errors.New("valid participant credential did not reach the Cloudflare SFU signaling boundary")
	}
	if !wrongAudience {
		var response mediaplane.TracksResponse
		if err := json.Unmarshal(result.Body, &response); err != nil {
			return result, err
		}
		if publications.calls != 1 || len(response.Tracks) != 1 || response.Tracks[0].Location != "local" || response.Tracks[0].PublicationID == "" {
			return result, errors.New("published SFU track response did not restore the authoritative local location and publication reference")
		}
	}
	return result, nil
}

type tracedAPIKeyAuthenticator struct {
	recorder *Recorder
	next     apikeys.Service
}

func (a tracedAPIKeyAuthenticator) Authenticate(ctx context.Context, input apikeys.AuthenticateInput) (authentication.Principal, error) {
	span := a.recorder.Start("auth", "apikeys.Service.Authenticate", "parse the API-key namespace and verify the full credential in constant time", map[string]any{
		"credential": "[redacted]",
	})
	principal, err := a.next.Authenticate(ctx, input)
	span.End("return tenant API-key principal", map[string]any{
		"principal_kind": principal.Kind, "tenant_attributed": !principal.TenantID.IsZero(),
	}, err)
	return principal, err
}

type tracedAPIKeyPolicy struct {
	recorder *Recorder
	next     authorization.TenantPolicy
}

func (p tracedAPIKeyPolicy) AuthorizeTenant(ctx context.Context, principal authentication.Principal, tenantID utilities.ID, permission authorization.TenantPermission) error {
	span := p.recorder.Start("policy", "authorization.TenantPolicy.AuthorizeTenant", "require the tenant-read permission without trusting the route tenant id", map[string]any{
		"principal_kind": principal.Kind, "tenant_match": principal.TenantID == tenantID,
	})
	err := p.next.AuthorizeTenant(ctx, principal, tenantID, permission)
	decision := "allow"
	if err != nil {
		decision = "deny_missing_permission"
	}
	span.End("return bounded authorization decision", map[string]any{"decision": decision}, err)
	return err
}

type tracedAPIKeyRepository struct {
	recorder *Recorder
	record   apikeys.Record
}

func (r *tracedAPIKeyRepository) GetByPrefix(context.Context, string) (apikeys.Record, error) {
	r.recorder.Add("database", "SELECT active api_keys by key_prefix", "load the active credential record without exposing prefix or hash material", map[string]any{"credential_material": "[redacted]"})
	return r.record, nil
}

func (r *tracedAPIKeyRepository) TouchLastUsed(context.Context, apikeys.Usage) error {
	r.recorder.Add("database", "UPDATE api_keys last_used_at", "record best-effort usage without exposing identity or network attributes", nil)
	return nil
}

func (*tracedAPIKeyRepository) Create(context.Context, apikeys.CreateRecordInput) (apikeys.Record, error) {
	return apikeys.Record{}, errors.New("unexpected API-key create")
}

func (*tracedAPIKeyRepository) Get(context.Context, utilities.ID, utilities.ID) (apikeys.Record, error) {
	return apikeys.Record{}, errors.New("unexpected API-key get")
}

func (*tracedAPIKeyRepository) List(context.Context, utilities.ID, pagination.PageRequest) (apikeys.RecordList, error) {
	return apikeys.RecordList{}, errors.New("unexpected API-key list")
}

func (*tracedAPIKeyRepository) Rotate(context.Context, apikeys.RotateRecordInput) (apikeys.Record, error) {
	return apikeys.Record{}, errors.New("unexpected API-key rotate")
}

func (*tracedAPIKeyRepository) Revoke(context.Context, utilities.ID, utilities.ID, time.Time) error {
	return errors.New("unexpected API-key revoke")
}

type tracedParticipantMediaVerifier struct {
	recorder *Recorder
	next     participantaccess.Verifier
}

type participantMediaRoomService struct {
	tracedRoomService
	now func() time.Time
}

func (s participantMediaRoomService) GetRoom(context.Context, utilities.ID, utilities.ID) (rooms.Room, error) {
	room := roomFixture(s.now)
	room.MediaPlane = string(mediaplane.ProviderCloudflareSFU)
	s.recorder.Add("service", "rooms.Service.GetRoom", "load the room configured for Cloudflare SFU", map[string]any{"media_plane": room.MediaPlane})
	return room, nil
}

func (v tracedParticipantMediaVerifier) Verify(ctx context.Context, credential string) (participantaccess.Subject, error) {
	span := v.recorder.Start("auth", "participantaccess.Verifier.Verify", "verify EdDSA signature and exact chalk-media audience without recording the credential", map[string]any{
		"credential": "[redacted]", "required_audience": participantaccess.Audience,
	})
	subject, err := v.next.Verify(ctx, credential)
	outcome := "accepted"
	reason := "none"
	if errors.Is(err, participantaccess.ErrInvalidAudience) {
		outcome = "rejected"
		reason = "invalid_audience"
	} else if err != nil {
		outcome = "failed"
		reason = "verification_failed"
	}
	span.End("return bounded media-auth result", map[string]any{"outcome": outcome, "reason": reason}, err)
	return subject, err
}

type tracedActiveParticipant struct {
	recorder *Recorder
	calls    int
}

func (a *tracedActiveParticipant) AuthorizeActiveParticipant(context.Context, participantaccess.Subject) (bool, error) {
	a.calls++
	a.recorder.Add("policy", "participantaccess.ActiveAuthorizer", "confirm the exact participant generation is active and admitted", map[string]any{"decision": "allow"})
	return true, nil
}

type tracedSFUResolver struct {
	recorder      *Recorder
	now           func() time.Time
	calls         int
	addTrackCalls int
}

func (r *tracedSFUResolver) Resolve(context.Context, tenants.Tenant, rooms.Room) (*mediaplane.Service, error) {
	r.calls++
	r.recorder.Add("resolver", "MediaPlaneResolver.Resolve", "select the configured Cloudflare SFU adapter after media authentication", map[string]any{"provider": mediaplane.ProviderCloudflareSFU})
	plane := &tracedSFUSignalingPlane{tracedMediaPlane: tracedMediaPlane{recorder: r.recorder, now: r.now}, recorder: r.recorder, calls: &r.addTrackCalls}
	service := mediaplane.NewServiceForProvider(mediaplane.ProviderCloudflareSFU, plane)
	return &service, nil
}

type tracedSFUSignalingPlane struct {
	tracedMediaPlane
	recorder *Recorder
	calls    *int
}

func (p *tracedSFUSignalingPlane) AddTracks(_ context.Context, input mediaplane.TracksRequest) (mediaplane.TracksResponse, error) {
	*p.calls++
	span := p.recorder.Start("adapter", "cloudflare.sfu.Adapter.AddTracks", "map the authenticated signaling request to Cloudflare without recording SDP", map[string]any{
		"track_count": len(input.Tracks), "has_session_description": input.SessionDescription != nil,
	})
	p.recorder.Add("provider", "POST Cloudflare SFU tracks/new", "send the bounded signaling operation", map[string]any{"track_count": len(input.Tracks)})
	tracks := append([]mediaplane.Track(nil), input.Tracks...)
	for index := range tracks {
		tracks[index].Location = ""
	}
	response := mediaplane.TracksResponse{Tracks: tracks}
	span.End("return Cloudflare SFU track result", map[string]any{"track_count": len(input.Tracks)}, nil)
	return response, nil
}

func (*tracedSFUSignalingPlane) Renegotiate(context.Context, mediaplane.RenegotiateRequest) error {
	return errors.New("unexpected SFU renegotiation")
}

type tracedMediaPublicationRegistry struct {
	recorder *Recorder
	calls    int
}

func (r *tracedMediaPublicationRegistry) RecordPublishedTracks(_ context.Context, input mediapublications.RecordInput) ([]mediapublications.PublishedReference, error) {
	r.calls++
	r.recorder.Add("service", "mediapublications.Registry.RecordPublishedTracks", "assign an opaque Chalk publication reference and restore local track semantics at the API boundary", map[string]any{"track_count": len(input.Tracks)})
	return []mediapublications.PublishedReference{{Source: "camera", MID: "0", TrackName: "camera-track", PublicationID: "chalk-publication-trace"}}, nil
}

func (*tracedMediaPublicationRegistry) PrepareClose(context.Context, mediapublications.CloseInput) (mediapublications.CloseDecision, error) {
	return mediapublications.CloseDecision{}, errors.New("unexpected publication close preparation")
}

func (*tracedMediaPublicationRegistry) RecordClosedPublication(context.Context, mediapublications.CloseInput) error {
	return errors.New("unexpected publication close")
}

func (*tracedMediaPublicationRegistry) Latest(context.Context, utilities.ID, utilities.ID) (mediapublications.Snapshot, error) {
	return mediapublications.Snapshot{}, errors.New("unexpected publication lookup")
}

func traceAPIKey(now time.Time, scopes []authentication.Scope) (string, apikeys.Record) {
	prefix := base64.RawURLEncoding.EncodeToString(make([]byte, 9))
	secret := base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	raw := "chalk_sk_" + prefix + "." + secret
	digest := sha256.Sum256([]byte(raw))
	return raw, apikeys.Record{
		KeyHash: hex.EncodeToString(digest[:]),
		Key: apikeys.Key{
			ID: mustID("77777777-7777-4777-8777-777777777777"), TenantID: tenantID(), Name: "trace customer", Scopes: scopes,
			Prefix: prefix, ExpiresAt: now.Add(time.Hour), CreatedAt: now, UpdatedAt: now,
		},
	}
}

func participantMediaFixtures(now func() time.Time) (participantaccess.Issuer, participantaccess.Verifier, participantaccess.Subject) {
	privateKey := traceParticipantPrivateKey()
	issuer, err := participantaccess.NewIssuer(participantaccess.IssuerConfig{Issuer: "https://api.chalk.test", KeyID: "trace-media-key", PrivateKey: privateKey, Now: now})
	if err != nil {
		panic(err)
	}
	verifier, err := participantaccess.NewVerifier(participantaccess.VerifierConfig{
		Issuer: "https://api.chalk.test", VerificationKeys: map[string]ed25519.PublicKey{"trace-media-key": privateKey.Public().(ed25519.PublicKey)}, Now: now,
	})
	if err != nil {
		panic(err)
	}
	return issuer, verifier, participantaccess.Subject{
		TenantID: tenantID(), RoomID: roomID(), SessionID: roomSessionID(), ParticipantSessionID: participantID(), ParticipantGeneration: 1,
		Provider: participantaccess.ProviderCloudflareSFU, CloudflareConnectionID: "connection_trace",
	}
}

func traceParticipantPrivateKey() ed25519.PrivateKey {
	return ed25519.NewKeyFromSeed(bytesOf(32, 42))
}

func participantCredentialWithAudience(token string, privateKey ed25519.PrivateKey, audience string) (string, error) {
	parts := splitJWT(token)
	if len(parts) != 3 {
		return "", errors.New("unexpected participant credential shape")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", err
	}
	var claims map[string]any
	if err := json.Unmarshal(payload, &claims); err != nil {
		return "", err
	}
	claims["aud"] = audience
	payload, err = json.Marshal(claims)
	if err != nil {
		return "", err
	}
	signingInput := parts[0] + "." + base64.RawURLEncoding.EncodeToString(payload)
	signature := ed25519.Sign(privateKey, []byte(signingInput))
	return signingInput + "." + base64.RawURLEncoding.EncodeToString(signature), nil
}

func splitJWT(token string) []string {
	parts := make([]string, 0, 3)
	start := 0
	for index, character := range token {
		if character == '.' {
			parts = append(parts, token[start:index])
			start = index + 1
		}
	}
	return append(parts, token[start:])
}

func bytesOf(size int, value byte) []byte {
	result := make([]byte, size)
	for index := range result {
		result[index] = value
	}
	return result
}
