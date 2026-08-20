package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/auditlogs"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	tracenoop "go.opentelemetry.io/otel/trace/noop"
)

type publicInviteHTTPService struct {
	managed    publicinvites.ManagedInvite
	created    publicinvites.PublicSpaceCreated
	arrived    publicinvites.PublicSpaceArrival
	arriveErr  error
	status     publicinvites.PublicSpaceArrival
	grant      publicinvites.PublicAccessGrant
	pending    publicinvites.AdmissionRequestPage
	updateErr  error
	rotateErr  error
	approveErr error
	denyErr    error
	statusIn   publicinvites.PublicInviteArrivalStatusInput
	arriveIn   publicinvites.PublicInviteArrivalInput
}

func (s *publicInviteHTTPService) GetInvite(context.Context, utilities.ID, utilities.ID) (publicinvites.ManagedInvite, error) {
	return s.managed, nil
}

func (s *publicInviteHTTPService) UpdateInvite(context.Context, publicinvites.UpdateSpacePublicInviteInput) (publicinvites.ManagedInvite, error) {
	return s.managed, s.updateErr
}

func (s *publicInviteHTTPService) RotateInvite(context.Context, publicinvites.RotateSpacePublicInviteInput) (publicinvites.ManagedInvite, error) {
	return s.managed, s.rotateErr
}

func (s *publicInviteHTTPService) ListAdmissionRequests(context.Context, publicinvites.ListPublicAdmissionRequestsInput) (publicinvites.AdmissionRequestPage, error) {
	return s.pending, nil
}

func (s *publicInviteHTTPService) ApproveAdmissionRequest(context.Context, publicinvites.DecidePublicAdmissionRequestInput) (publicinvites.AdmissionRequest, error) {
	return publicinvites.AdmissionRequest{}, s.approveErr
}

func (s *publicInviteHTTPService) DenyAdmissionRequest(context.Context, publicinvites.DecidePublicAdmissionRequestInput) (publicinvites.AdmissionRequest, error) {
	return publicinvites.AdmissionRequest{}, s.denyErr
}

type publicInviteAuditWriter struct {
	inputs []auditlogs.CreateInput
}

func (w *publicInviteAuditWriter) Create(_ context.Context, input auditlogs.CreateInput) (auditlogs.AuditLog, error) {
	w.inputs = append(w.inputs, input)
	return auditlogs.AuditLog{}, nil
}

func (s *publicInviteHTTPService) CreatePublicSpace(context.Context, publicinvites.CreatePublicSpaceInput) (publicinvites.PublicSpaceCreated, error) {
	return s.created, nil
}

func (s *publicInviteHTTPService) Arrive(_ context.Context, input publicinvites.PublicInviteArrivalInput) (publicinvites.PublicSpaceArrival, error) {
	s.arriveIn = input
	return s.arrived, s.arriveErr
}

func (s *publicInviteHTTPService) Status(_ context.Context, input publicinvites.PublicInviteArrivalStatusInput) (publicinvites.PublicSpaceArrival, error) {
	s.statusIn = input
	return s.status, nil
}

func (s *publicInviteHTTPService) RefreshAccess(context.Context, publicinvites.PublicInviteRefreshInput) (publicinvites.PublicAccessGrant, error) {
	return s.grant, nil
}

func (s *publicInviteHTTPService) Leave(context.Context, publicinvites.PublicInviteLeaveInput) error {
	return nil
}

func TestPublicInviteManagementRequiresAuthentication(t *testing.T) {
	options := httpapi.Options{
		PublicInvites: &publicInviteHTTPService{},
		Authentication: authenticationService{authenticateAccountCredential: func(context.Context, string) (authentication.SessionUser, error) {
			return authentication.SessionUser{}, errors.New("invalid credential")
		}},
	}
	req := httptest.NewRequest(http.MethodGet, "/v1/tenants/11111111-1111-4111-8111-111111111111/spaces/22222222-2222-4222-8222-222222222222/public-invite", nil)
	response := httptest.NewRecorder()
	httpapi.NewRouter(options).ServeHTTP(response, req)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusUnauthorized)
	}
}

func TestPublicInviteManagementAuditsMutationsWithRedactedDetails(t *testing.T) {
	tenantID, _ := utilities.ParseID("11111111-1111-4111-8111-111111111111")
	spaceID, _ := utilities.ParseID("22222222-2222-4222-8222-222222222222")
	requestID, _ := utilities.ParseID("33333333-3333-4333-8333-333333333333")
	audits := &publicInviteAuditWriter{}
	service := &publicInviteHTTPService{}
	auth := authenticationService{authenticateAccountCredential: func(context.Context, string) (authentication.SessionUser, error) {
		return authSessionUser(t), nil
	}}
	authorizer := tenantAuthorizer{authorizeTenant: func(context.Context, authentication.Principal, utilities.ID, authorization.TenantPermission) error {
		return nil
	}}
	options := httpapi.Options{
		PublicInvites:      service,
		PublicInviteAudits: audits,
		Authentication:     auth,
		TenantAuthz:        authorizer,
		CORS:               httpapi.CORSOptions{AllowedOrigins: []string{"https://app.example"}},
	}

	update := httptest.NewRequest(http.MethodPatch, "/v1/tenants/"+tenantID.String()+"/spaces/"+spaceID.String()+"/public-invite", strings.NewReader(`{"enabled":false}`))
	update.Header.Set("Authorization", "Bearer session-token")
	update.Header.Set("Origin", "https://app.example")
	updateResponse := httptest.NewRecorder()
	httpapi.NewRouter(options).ServeHTTP(updateResponse, update)
	if updateResponse.Code != http.StatusOK {
		t.Fatalf("update status = %d, want %d: %s", updateResponse.Code, http.StatusOK, updateResponse.Body.String())
	}

	rotate := httptest.NewRequest(http.MethodPost, "/v1/tenants/"+tenantID.String()+"/spaces/"+spaceID.String()+"/public-invite/rotations", nil)
	rotate.Header.Set("Authorization", "Bearer session-token")
	rotate.Header.Set("Origin", "https://app.example")
	rotate.Header.Set("Idempotency-Key", "rotate-public-invite-0001")
	rotateResponse := httptest.NewRecorder()
	httpapi.NewRouter(options).ServeHTTP(rotateResponse, rotate)
	if rotateResponse.Code != http.StatusCreated {
		t.Fatalf("rotate status = %d, want %d: %s", rotateResponse.Code, http.StatusCreated, rotateResponse.Body.String())
	}

	for _, action := range []string{"approval", "denial"} {
		decision := httptest.NewRequest(http.MethodPost, "/v1/tenants/"+tenantID.String()+"/spaces/"+spaceID.String()+"/public-admission-requests/"+requestID.String()+"/"+action, nil)
		decision.Header.Set("Authorization", "Bearer session-token")
		decision.Header.Set("Origin", "https://app.example")
		decision.Header.Set("Idempotency-Key", "decision-public-invite-"+action+"-0001")
		response := httptest.NewRecorder()
		httpapi.NewRouter(options).ServeHTTP(response, decision)
		if response.Code != http.StatusOK {
			t.Fatalf("%s status = %d, want %d: %s", action, response.Code, http.StatusOK, response.Body.String())
		}
	}

	if len(audits.inputs) != 4 {
		t.Fatalf("audit records = %d, want 4", len(audits.inputs))
	}
	wantActions := []string{
		"space_public_invite.disabled",
		"space_public_invite.rotated",
		"space_public_admission_request.approved",
		"space_public_admission_request.denied",
	}
	userID := authUser(t).ID
	for index, input := range audits.inputs {
		if input.TenantID != tenantID || input.ActorType != auditlogs.ActorUser || input.ActorUserID != userID || input.Outcome != auditlogs.OutcomeSuccess {
			t.Fatalf("audit[%d] identity/resource = %#v", index, input)
		}
		if input.Action != wantActions[index] {
			t.Fatalf("audit[%d] action = %q, want %q", index, input.Action, wantActions[index])
		}
		if index < 2 && (input.ResourceType == nil || *input.ResourceType != "space_public_invite" || input.ResourceID != spaceID) {
			t.Fatalf("audit[%d] invite resource = %#v", index, input)
		}
		if index >= 2 && (input.ResourceType == nil || *input.ResourceType != "public_admission_request" || input.ResourceID != requestID) {
			t.Fatalf("audit[%d] request resource = %#v", index, input)
		}
		var details map[string]string
		if err := json.Unmarshal(input.Details, &details); err != nil {
			t.Fatalf("audit[%d] details: %v", index, err)
		}
		if details["space_id"] != spaceID.String() {
			t.Fatalf("audit[%d] space detail = %#v", index, details)
		}
		encoded, _ := json.Marshal(details)
		for _, forbidden := range []string{"https://app.example", "invite-token", "guest-credential", "Ada"} {
			if strings.Contains(string(encoded), forbidden) {
				t.Fatalf("audit[%d] details exposed %q: %s", index, forbidden, encoded)
			}
		}
	}
}

func TestPublicInviteAuthorizationFailureIsAuditedWithoutSecrets(t *testing.T) {
	tenantID, _ := utilities.ParseID("11111111-1111-4111-8111-111111111111")
	spaceID, _ := utilities.ParseID("22222222-2222-4222-8222-222222222222")
	audits := &publicInviteAuditWriter{}
	options := httpapi.Options{
		PublicInvites:      &publicInviteHTTPService{},
		PublicInviteAudits: audits,
		Authentication: authenticationService{authenticateAccountCredential: func(context.Context, string) (authentication.SessionUser, error) {
			return authSessionUser(t), nil
		}},
		TenantAuthz: tenantAuthorizer{authorizeTenant: func(context.Context, authentication.Principal, utilities.ID, authorization.TenantPermission) error {
			return authorization.ErrForbidden
		}},
		CORS: httpapi.CORSOptions{AllowedOrigins: []string{"https://app.example"}},
	}
	request := httptest.NewRequest(http.MethodPatch, "/v1/tenants/"+tenantID.String()+"/spaces/"+spaceID.String()+"/public-invite", strings.NewReader(`{"enabled":true}`))
	request.Header.Set("Authorization", "Bearer session-token")
	request.Header.Set("Origin", "https://app.example")
	response := httptest.NewRecorder()
	httpapi.NewRouter(options).ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusForbidden)
	}
	if len(audits.inputs) != 1 {
		t.Fatalf("audit records = %d, want 1", len(audits.inputs))
	}
	input := audits.inputs[0]
	if input.Outcome != auditlogs.OutcomeFailure || input.ErrorCode == nil || *input.ErrorCode != "access.forbidden" {
		t.Fatalf("authorization audit = %#v", input)
	}
	if input.TenantID != tenantID || input.ResourceID != spaceID || input.ResourceType == nil || *input.ResourceType != "space_public_invite" {
		t.Fatalf("authorization audit resource = %#v", input)
	}
	if strings.Contains(string(input.Details), "invite-token") || strings.Contains(string(input.Details), "guest-credential") {
		t.Fatalf("authorization audit exposed secret details: %s", input.Details)
	}
}

func TestPublicInviteRouteTelemetryUsesBoundedOutcomesAndRedacts(t *testing.T) {
	spanRecorder := tracetest.NewSpanRecorder()
	traceProvider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(spanRecorder))
	otel.SetTracerProvider(traceProvider)
	t.Cleanup(func() {
		_ = traceProvider.Shutdown(context.Background())
		otel.SetTracerProvider(tracenoop.NewTracerProvider())
	})
	previousLogger := slog.Default()
	var logs bytes.Buffer
	slog.SetDefault(slog.New(slog.NewJSONHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previousLogger) })

	service := &publicInviteHTTPService{arrived: publicinvites.PublicSpaceArrival{State: publicinvites.ArrivalAdmitted}}
	options := httpapi.Options{
		PublicInvites: service,
		CORS:          httpapi.CORSOptions{AllowedOrigins: []string{"https://app.example"}},
	}
	handler := httpapi.NewRouter(options)
	const (
		inviteToken     = "invite-token-private-sentinel"
		guestCredential = "guest-credential-private-sentinel"
		displayName     = "Display Name Private Sentinel"
	)
	arrivalHandle := "33333333-3333-4333-8333-333333333333"
	newRequest := func(method, path, body string, origin bool) *http.Request {
		request := httptest.NewRequest(method, path, strings.NewReader(body))
		if body != "" {
			request.Header.Set("Content-Type", "application/json")
		}
		if origin {
			request.Header.Set("Origin", "https://app.example")
		}
		return request
	}
	requests := []*http.Request{
		newRequest(http.MethodPost, "/v1/public/spaces", `{"display_name":"`+displayName+`"}`, true),
		newRequest(http.MethodPost, "/v1/public/space-invite-arrivals", `{"space_invite_token":"`+inviteToken+`","display_name":"`+displayName+`"}`, true),
		newRequest(http.MethodGet, "/v1/public/space-invite-arrival", "", false),
		newRequest(http.MethodPost, "/v1/public/space-invite-arrival/access-grants", `{"media_proof":"media-proof-private-sentinel"}`, true),
		newRequest(http.MethodDelete, "/v1/public/space-invite-arrival", "", true),
	}
	for index, request := range requests {
		if index < 2 {
			request.Header.Set("Idempotency-Key", "public-invite-telemetry-0001")
		}
		request.Header.Set("X-Chalk-Arrival-Handle", arrivalHandle)
		request.AddCookie(&http.Cookie{Name: "__Host-chalk_space_guest_" + arrivalHandle, Value: guestCredential})
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		wantStatus := http.StatusCreated
		if index == 2 {
			wantStatus = http.StatusOK
		}
		if index == 4 {
			wantStatus = http.StatusNoContent
		}
		if response.Code != wantStatus {
			t.Fatalf("request[%d] status = %d, want %d: %s", index, response.Code, wantStatus, response.Body.String())
		}
	}

	spans := spanRecorder.Ended()
	if len(spans) != len(requests) {
		t.Fatalf("ended spans = %d, want %d", len(spans), len(requests))
	}
	wantOperations := []string{"public.create", "public.arrive", "public.status", "public.refresh", "public.leave"}
	for index, span := range spans {
		if span.Name() != "public_invite."+wantOperations[index] {
			t.Fatalf("span[%d] name = %q", index, span.Name())
		}
		attrs := span.Attributes()
		if value, ok := publicInviteSpanAttribute(attrs, "chalk.public_invite.operation"); !ok || value != wantOperations[index] {
			t.Fatalf("span[%d] operation = %q, want %q", index, value, wantOperations[index])
		}
		if value, ok := publicInviteSpanAttribute(attrs, "chalk.public_invite.outcome"); !ok || value != "succeeded" {
			t.Fatalf("span[%d] outcome = %q, want succeeded", index, value)
		}
		if value, ok := publicInviteSpanAttribute(attrs, "chalk.public_invite.reason"); !ok || value != "none" {
			t.Fatalf("span[%d] reason = %q, want none", index, value)
		}
	}

	service.arriveErr = publicinvites.ErrInviteUnavailable
	failedRequest := newRequest(http.MethodPost, "/v1/public/space-invite-arrivals", `{"space_invite_token":"`+inviteToken+`","display_name":"`+displayName+`"}`, true)
	failedRequest.Header.Set("Idempotency-Key", "public-invite-telemetry-failure-0001")
	failedResponse := httptest.NewRecorder()
	handler.ServeHTTP(failedResponse, failedRequest)
	if failedResponse.Code != http.StatusNotFound {
		t.Fatalf("failed arrival status = %d, want %d", failedResponse.Code, http.StatusNotFound)
	}
	spans = spanRecorder.Ended()
	failed := spans[len(spans)-1]
	if value, ok := publicInviteSpanAttribute(failed.Attributes(), "chalk.public_invite.outcome"); !ok || value != "rejected" {
		t.Fatalf("failed outcome = %q, want rejected", value)
	}
	if value, ok := publicInviteSpanAttribute(failed.Attributes(), "chalk.public_invite.reason"); !ok || value != "not_found" {
		t.Fatalf("failed reason = %q, want not_found", value)
	}

	for _, forbidden := range []string{inviteToken, guestCredential, displayName, "media-proof-private-sentinel", "https://app.example"} {
		if strings.Contains(logs.String(), forbidden) {
			t.Fatalf("logs exposed private value %q: %s", forbidden, logs.String())
		}
	}
}

func publicInviteSpanAttribute(attrs []attribute.KeyValue, key string) (string, bool) {
	for _, attr := range attrs {
		if string(attr.Key) == key {
			return attr.Value.AsString(), true
		}
	}
	return "", false
}

func TestPublicInviteAdmissionDecisionTelemetryUsesBoundedOutcomes(t *testing.T) {
	spanRecorder := tracetest.NewSpanRecorder()
	traceProvider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(spanRecorder))
	otel.SetTracerProvider(traceProvider)
	t.Cleanup(func() {
		_ = traceProvider.Shutdown(context.Background())
		otel.SetTracerProvider(tracenoop.NewTracerProvider())
	})
	auth := authenticationService{authenticateAccountCredential: func(context.Context, string) (authentication.SessionUser, error) {
		return authSessionUser(t), nil
	}}
	authorizer := tenantAuthorizer{authorizeTenant: func(context.Context, authentication.Principal, utilities.ID, authorization.TenantPermission) error {
		return nil
	}}
	options := httpapi.Options{
		PublicInvites:  &publicInviteHTTPService{},
		Authentication: auth,
		TenantAuthz:    authorizer,
		CORS:           httpapi.CORSOptions{AllowedOrigins: []string{"https://app.example"}},
	}
	for index, action := range []string{"approval", "denial"} {
		path := "/v1/tenants/11111111-1111-4111-8111-111111111111/spaces/22222222-2222-4222-8222-222222222222/public-admission-requests/33333333-3333-4333-8333-333333333333/" + action
		request := httptest.NewRequest(http.MethodPost, path, nil)
		request.Header.Set("Authorization", "Bearer session-token")
		request.Header.Set("Origin", "https://app.example")
		request.Header.Set("Idempotency-Key", []string{"decision-telemetry-approve-0001", "decision-telemetry-deny-0001"}[index])
		response := httptest.NewRecorder()
		httpapi.NewRouter(options).ServeHTTP(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("%s status = %d, want %d: %s", action, response.Code, http.StatusOK, response.Body.String())
		}
	}
	spans := spanRecorder.Ended()
	if len(spans) != 2 {
		t.Fatalf("ended spans = %d, want 2", len(spans))
	}
	for index, decision := range []string{"approve", "deny"} {
		if spans[index].Name() != "public_invite.management.admission_"+decision {
			t.Fatalf("span[%d] name = %q", index, spans[index].Name())
		}
		if value, ok := publicInviteSpanAttribute(spans[index].Attributes(), "chalk.public_invite.outcome"); !ok || value != "succeeded" {
			t.Fatalf("span[%d] outcome = %q, want succeeded", index, value)
		}
		if value, ok := publicInviteSpanAttribute(spans[index].Attributes(), "chalk.public_invite.reason"); !ok || value != "none" {
			t.Fatalf("span[%d] reason = %q, want none", index, value)
		}
	}
}

func TestPublicInviteManagementResponseUsesCanonicalURLAndNoStore(t *testing.T) {
	tenantID, _ := utilities.ParseID("11111111-1111-4111-8111-111111111111")
	spaceID, _ := utilities.ParseID("22222222-2222-4222-8222-222222222222")
	service := &publicInviteHTTPService{managed: publicinvites.ManagedInvite{
		Invite:       publicinvites.Invite{TenantID: tenantID, SpaceID: spaceID, Handle: []byte("internal-handle"), Generation: 1, Enabled: true},
		CanonicalURL: "https://app.example/space/demo#spaceInviteToken=public-token",
	}}
	options := httpapi.Options{
		PublicInvites: service,
		Authentication: authenticationService{authenticateAccountCredential: func(context.Context, string) (authentication.SessionUser, error) {
			return authentication.SessionUser{}, nil
		}},
		TenantAuthz: tenantAuthorizer{authorizeTenant: func(context.Context, authentication.Principal, utilities.ID, authorization.TenantPermission) error {
			return nil
		}},
	}
	request := httptest.NewRequest(http.MethodGet, "/v1/tenants/11111111-1111-4111-8111-111111111111/spaces/22222222-2222-4222-8222-222222222222/public-invite", nil)
	request.Header.Set("Authorization", "Bearer session-token")
	response := httptest.NewRecorder()
	httpapi.NewRouter(options).ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d: %s", response.Code, http.StatusOK, response.Body.String())
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("cache-control = %q, want no-store", response.Header().Get("Cache-Control"))
	}
	if !strings.Contains(response.Body.String(), "canonical_url") || !strings.Contains(response.Body.String(), "public-token") {
		t.Fatalf("response omitted canonical URL: %s", response.Body.String())
	}
	if strings.Contains(response.Body.String(), "internal-handle") || strings.Contains(response.Body.String(), "\"handle\"") {
		t.Fatalf("response leaked invite internals: %s", response.Body.String())
	}
}

func TestPublicInviteCreateCookieAndNativeCredentialSemantics(t *testing.T) {
	service := &publicInviteHTTPService{created: publicinvites.PublicSpaceCreated{
		InviteLink:      "https://app.example/space/ada#spaceInviteToken=cspi1.public-1.payload.signature",
		GuestCredential: "guest-credential-123456",
		Arrival:         publicinvites.PublicSpaceArrival{ArrivalHandle: "33333333-3333-4333-8333-333333333333"},
	}}
	options := httpapi.Options{PublicInvites: service, CORS: httpapi.CORSOptions{AllowedOrigins: []string{"https://app.example"}}}
	router := httpapi.NewRouter(options)

	webRequest := httptest.NewRequest(http.MethodPost, "/v1/public/spaces", strings.NewReader(`{"display_name":"Ada"}`))
	webRequest.Header.Set("Origin", "https://app.example")
	webRequest.Header.Set("Idempotency-Key", "create-public-space-1")
	webResponse := httptest.NewRecorder()
	router.ServeHTTP(webResponse, webRequest)
	if webResponse.Code != http.StatusCreated {
		t.Fatalf("web status = %d, want %d", webResponse.Code, http.StatusCreated)
	}
	if len(webResponse.Result().Cookies()) != 1 || !strings.HasPrefix(webResponse.Result().Cookies()[0].Name, "__Host-chalk_space_guest_") {
		t.Fatalf("web cookies = %#v", webResponse.Result().Cookies())
	}
	if strings.Contains(webResponse.Body.String(), "guest-credential-123456") {
		t.Fatal("web response leaked guest credential")
	}
	if !strings.Contains(webResponse.Body.String(), service.created.InviteLink) {
		t.Fatalf("web response omitted canonical invite link: %s", webResponse.Body.String())
	}

	nativeRequest := httptest.NewRequest(http.MethodPost, "/v1/public/spaces", strings.NewReader(`{"display_name":"Ada"}`))
	nativeRequest.Header.Set("X-Chalk-Client", "react-native")
	nativeRequest.Header.Set("Authorization", "ChalkGuest guest-credential-123456")
	nativeRequest.Header.Set("Idempotency-Key", "create-public-space-2")
	nativeResponse := httptest.NewRecorder()
	router.ServeHTTP(nativeResponse, nativeRequest)
	if nativeResponse.Code != http.StatusCreated {
		t.Fatalf("native status = %d, want %d", nativeResponse.Code, http.StatusCreated)
	}
	if len(nativeResponse.Result().Cookies()) != 0 {
		t.Fatalf("native cookies = %#v, want no cookie", nativeResponse.Result().Cookies())
	}
	if !strings.Contains(nativeResponse.Body.String(), "guest-credential-123456") {
		t.Fatal("native response omitted guest credential")
	}
}

func TestPublicInviteNativeStatusReadsChalkGuestCredential(t *testing.T) {
	service := &publicInviteHTTPService{}
	options := httpapi.Options{PublicInvites: service}
	request := httptest.NewRequest(http.MethodGet, "/v1/public/space-invite-arrival", nil)
	request.Header.Set("X-Chalk-Client", "react-native")
	request.Header.Set("X-Chalk-Arrival-Handle", "33333333-3333-4333-8333-333333333333")
	request.Header.Set("Authorization", "ChalkGuest guest-credential-123456")
	response := httptest.NewRecorder()
	httpapi.NewRouter(options).ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusOK)
	}
	if service.statusIn.GuestCredential != "guest-credential-123456" || service.statusIn.ArrivalHandle == "" || !service.statusIn.Native {
		t.Fatalf("status input = %#v", service.statusIn)
	}
}

func TestPublicInviteNativeRequestsRejectCookies(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/v1/public/space-invite-arrival", nil)
	request.Header.Set("X-Chalk-Client", "react-native")
	request.Header.Set("X-Chalk-Arrival-Handle", "33333333-3333-4333-8333-333333333333")
	request.Header.Set("Authorization", "ChalkGuest guest-credential-123456")
	request.Header.Set("Cookie", "__Host-chalk_space_guest_handle=credential")
	response := httptest.NewRecorder()
	httpapi.NewRouter(httpapi.Options{PublicInvites: &publicInviteHTTPService{}}).ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusForbidden)
	}
}

func TestPublicInviteCredentialFailuresAreNeutral(t *testing.T) {
	service := &publicInviteHTTPService{arriveErr: publicinvites.ErrCredentialMismatch}
	options := httpapi.Options{PublicInvites: service, CORS: httpapi.CORSOptions{AllowedOrigins: []string{"https://app.example"}}}
	request := httptest.NewRequest(http.MethodPost, "/v1/public/space-invite-arrivals", strings.NewReader(`{"space_invite_token":"token","display_name":"Ada"}`))
	request.Header.Set("Origin", "https://app.example")
	request.Header.Set("Idempotency-Key", "arrive-public-space-1")
	request.Header.Set("X-Chalk-Arrival-Handle", "33333333-3333-4333-8333-333333333333")
	request.AddCookie(&http.Cookie{Name: "__Host-chalk_space_guest_33333333-3333-4333-8333-333333333333", Value: "wrong-credential-123456"})
	response := httptest.NewRecorder()
	httpapi.NewRouter(options).ServeHTTP(response, request)
	if response.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusNotFound)
	}
	if strings.Contains(response.Body.String(), "credential mismatch") || strings.Contains(response.Body.String(), "guest") {
		t.Fatalf("response leaked credential detail: %s", response.Body.String())
	}
}

func TestPublicInviteAccessGrantUsesCanonicalResponseShape(t *testing.T) {
	service := &publicInviteHTTPService{grant: publicinvites.PublicAccessGrant{
		SyncToken:       "sync-token",
		MediaToken:      "media-token",
		Provider:        publicinvites.PublicProviderCloudflareRTK,
		ProviderSubject: "participant-ref",
		ClientPayload: publicinvites.PublicAccessClientPayload{
			ProviderSubject: "participant-ref",
			Token:           "rtk-client-token",
		},
	}}
	options := httpapi.Options{PublicInvites: service, CORS: httpapi.CORSOptions{AllowedOrigins: []string{"https://app.example"}}}
	request := httptest.NewRequest(http.MethodPost, "/v1/public/space-invite-arrival/access-grants", strings.NewReader(`{"media_proof":"proof"}`))
	request.Header.Set("Origin", "https://app.example")
	request.Header.Set("X-Chalk-Arrival-Handle", "33333333-3333-4333-8333-333333333333")
	request.AddCookie(&http.Cookie{Name: "__Host-chalk_space_guest_33333333-3333-4333-8333-333333333333", Value: "guest-credential-123456"})
	response := httptest.NewRecorder()
	httpapi.NewRouter(options).ServeHTTP(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusCreated)
	}
	var body map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	for _, key := range []string{"sync", "media", "subject"} {
		if _, ok := body[key]; !ok {
			t.Fatalf("response missing canonical %q object: %s", key, response.Body.String())
		}
	}
	media, ok := body["media"].(map[string]any)
	if !ok || media["provider"] != "cloudflare_rtk" {
		t.Fatalf("media provider = %#v", body["media"])
	}
	clientPayload, ok := media["client_payload"].(map[string]any)
	if !ok || clientPayload["provider_subject"] != "participant-ref" || clientPayload["token"] != "rtk-client-token" {
		t.Fatalf("media client payload = %#v", media["client_payload"])
	}
	if _, ok := body["sync_token"]; ok {
		t.Fatalf("response used flat access grant fields: %s", response.Body.String())
	}
}

func TestPublicInviteAccessGrantMapsSFUClientPayload(t *testing.T) {
	service := &publicInviteHTTPService{grant: publicinvites.PublicAccessGrant{
		SyncToken:  "sync-token",
		MediaToken: "media-token",
		Provider:   publicinvites.PublicProviderCloudflareSFU,
		ClientPayload: publicinvites.PublicAccessClientPayload{
			ConnectionID: "connection-123",
			StunServer:   "stun.example.com:3478",
		},
	}}
	options := httpapi.Options{PublicInvites: service, CORS: httpapi.CORSOptions{AllowedOrigins: []string{"https://app.example"}}}
	request := httptest.NewRequest(http.MethodPost, "/v1/public/space-invite-arrival/access-grants", strings.NewReader(`{"media_proof":"proof"}`))
	request.Header.Set("Origin", "https://app.example")
	request.Header.Set("X-Chalk-Arrival-Handle", "33333333-3333-4333-8333-333333333333")
	request.AddCookie(&http.Cookie{Name: "__Host-chalk_space_guest_33333333-3333-4333-8333-333333333333", Value: "guest-credential-123456"})
	response := httptest.NewRecorder()
	httpapi.NewRouter(options).ServeHTTP(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusCreated)
	}
	var body struct {
		Media struct {
			Provider      string         `json:"provider"`
			ClientPayload map[string]any `json:"client_payload"`
		} `json:"media"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body.Media.Provider != publicinvites.PublicProviderCloudflareSFU {
		t.Fatalf("media provider = %q", body.Media.Provider)
	}
	if body.Media.ClientPayload["connectionId"] != "connection-123" || body.Media.ClientPayload["stunServer"] != "stun.example.com:3478" {
		t.Fatalf("media client payload = %#v", body.Media.ClientPayload)
	}
	if _, ok := body.Media.ClientPayload["token"]; ok {
		t.Fatalf("SFU payload exposed RTK token: %#v", body.Media.ClientPayload)
	}
}

func TestPublicInviteAdmissionResponseMinimizesOperatorData(t *testing.T) {
	service := &publicInviteHTTPService{pending: publicinvites.AdmissionRequestPage{Requests: []publicinvites.AdmissionRequest{{DisplayName: "Ada", State: publicinvites.AdmissionRequestPending}}}}
	options := httpapi.Options{
		PublicInvites: service,
		Authentication: authenticationService{authenticateAccountCredential: func(context.Context, string) (authentication.SessionUser, error) {
			return authentication.SessionUser{}, nil
		}},
		TenantAuthz: tenantAuthorizer{authorizeTenant: func(context.Context, authentication.Principal, utilities.ID, authorization.TenantPermission) error {
			return nil
		}},
	}
	request := httptest.NewRequest(http.MethodGet, "/v1/tenants/11111111-1111-4111-8111-111111111111/spaces/22222222-2222-4222-8222-222222222222/public-admission-requests", nil)
	request.Header.Set("Authorization", "Bearer session-token")
	response := httptest.NewRecorder()
	httpapi.NewRouter(options).ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d: %s", response.Code, http.StatusOK, response.Body.String())
	}
	var body struct {
		Requests []map[string]any `json:"requests"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(body.Requests) != 1 {
		t.Fatalf("requests = %#v", body.Requests)
	}
	for _, key := range []string{"arrival_handle", "tenant_id", "space_id"} {
		if _, ok := body.Requests[0][key]; ok {
			t.Fatalf("response leaked %q: %s", key, response.Body.String())
		}
	}
}
