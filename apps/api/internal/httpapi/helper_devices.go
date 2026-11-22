package httpapi

import (
	"context"
	"net/http"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/helperaccess"
	"github.com/q9labs/chalk/apps/api/internal/ratelimit"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const (
	helperDeviceBase       = "/v1/screen-annotation/helper/device"
	helperDeviceTenantBase = "/v1/tenants/{tenant_id}/helper-devices"
)

var (
	helperEnrollmentLimit = ratelimit.Policy{Name: "helper_device_enrollment", Limit: 10, Window: time.Minute}
	helperPollLimit       = ratelimit.Policy{Name: "helper_device_poll", Limit: 30, Window: time.Minute}
	helperLookupLimit     = ratelimit.Policy{Name: "helper_device_lookup", Limit: 10, Window: time.Minute}
	helperDeviceErrors    = []APIError{apiErrorInvalidRequest, apiErrorUnauthenticated, apiErrorForbidden, apiErrorInvalidTenantID, apiErrorPayloadTooLarge, apiErrorRateLimited, apiErrorServiceUnavailable}
	helperDeviceRules     = errorRules{
		ruleFor(apiErrorInvalidRequest, helperaccess.ErrInvalid),
		ruleFor(apiErrorForbidden, helperaccess.ErrDeviceUnavailable, helperaccess.ErrShareNotCurrent),
	}
)

type helperRemember struct {
	PublicKey string `json:"publicKey"`
}

type helperCodeStart struct {
	TenantID   string `json:"tenantId"`
	Name       string `json:"name"`
	PublicKey  string `json:"publicKey"`
	Credential string `json:"credential"`
	PollSecret string `json:"pollSecret"`
	Registered bool   `json:"registered"`
}

type helperCodePoll struct {
	PollSecret string `json:"pollSecret"`
}

type helperCodeLookup struct {
	Code string `json:"code"`
}

type helperCodeApproval struct {
	RequestID     string `json:"requestId"`
	MediaProof    string `json:"mediaProof"`
	LayerID       string `json:"layerId"`
	PublicationID string `json:"publicationId"`
	Refresh       bool   `json:"refresh"`
}

type helperRevoke struct {
	DeviceID string `json:"deviceId"`
}

type helperDeviceList struct {
	Devices []helperaccess.Device `json:"devices"`
}

type helperOwnerRequest[Body any] struct {
	tenant utilities.ID
	body   Body
}

func decodeHelperOwnerRequest[Body any](r *http.Request) (helperOwnerRequest[Body], error) {
	tenant, err := tenantIDRequest(r)
	if err != nil {
		return helperOwnerRequest[Body]{}, err
	}
	body, err := decodeJSONBodyWithLimit[Body](r, 8192)
	return helperOwnerRequest[Body]{tenant: tenant, body: body}, err
}

func requireHelperDashboard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, ok := authentication.PrincipalFromContext(r.Context())
		if !ok || principal.Kind != authentication.PrincipalService {
			writeAPIError(w, apiErrorForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func helperNativeEndpoints(service *helperaccess.Service) []RouteEndpoint {
	start := Post(helperDeviceBase+"/start", "startScreenAnnotationHelperDeviceCode", func(r *http.Request) (helperCodeStart, error) {
		return decodeJSONBodyWithLimit[helperCodeStart](r, 1024)
	}, func(ctx context.Context, req helperCodeStart) (helperaccess.DeviceCode, error) {
		if !service.DevicesEnabled() {
			return helperaccess.DeviceCode{}, apiErrorServiceUnavailable
		}
		tenant, err := utilities.ParseID(req.TenantID)
		if err != nil {
			return helperaccess.DeviceCode{}, apiErrorInvalidRequest
		}
		return service.StartDevice(ctx, tenant, req.Name, req.PublicKey, req.Credential, req.PollSecret, req.Registered)
	}).Needs(service).RateLimit(helperEnrollmentLimit).Middleware(noStoreResponses).
		RequestBody("HelperDeviceCodeStart", helperCodeStart{}).Responds(http.StatusOK, "HelperDeviceCode", helperaccess.DeviceCode{}).
		Errors(helperDeviceErrors...).ErrorRules(helperDeviceRules)
	poll := Post(helperDeviceBase+"/poll", "pollScreenAnnotationHelperDeviceCode", func(r *http.Request) (helperCodePoll, error) {
		return decodeJSONBodyWithLimit[helperCodePoll](r, 256)
	}, func(ctx context.Context, req helperCodePoll) (helperaccess.DevicePoll, error) {
		if !service.DevicesEnabled() {
			return helperaccess.DevicePoll{}, apiErrorServiceUnavailable
		}
		return service.PollDevice(ctx, req.PollSecret)
	}).Needs(service).RateLimit(helperPollLimit).Middleware(noStoreResponses).
		RequestBody("HelperDeviceCodePoll", helperCodePoll{}).Responds(http.StatusOK, "HelperDevicePoll", helperaccess.DevicePoll{}).
		Errors(helperDeviceErrors...).ErrorRules(helperDeviceRules)
	return []RouteEndpoint{start, poll}
}

func helperDashboardEndpoints(service *helperaccess.Service, verifier ParticipantMediaVerifier, authorizer TenantAuthorizer) []RouteEndpoint {
	lookup := Post(helperDeviceTenantBase+"/lookup", "lookupScreenAnnotationHelperDeviceCode", decodeHelperOwnerRequest[helperCodeLookup],
		func(ctx context.Context, req helperOwnerRequest[helperCodeLookup]) (helperaccess.DeviceOffer, error) {
			if !service.DevicesEnabled() {
				return helperaccess.DeviceOffer{}, apiErrorServiceUnavailable
			}
			return service.LookupDevice(ctx, req.tenant, req.body.Code)
		}).Needs(service).Permission(authorizer, writeTenantPermission).Auth(APIAuthSessionOrBearer).
		RateLimit(helperLookupLimit).Parameters(tenantIDParameter()).RequestBody("HelperDeviceCodeLookup", helperCodeLookup{}).
		Responds(http.StatusOK, "HelperDeviceOffer", helperaccess.DeviceOffer{}).Errors(helperDeviceErrors...).ErrorRules(helperDeviceRules)
	approve := Post(helperDeviceTenantBase+"/approve", "approveScreenAnnotationHelperDeviceCode", decodeHelperOwnerRequest[helperCodeApproval],
		func(ctx context.Context, req helperOwnerRequest[helperCodeApproval]) (struct{}, error) {
			if !service.DevicesEnabled() {
				return struct{}{}, apiErrorServiceUnavailable
			}
			requestID, reqErr := utilities.ParseID(req.body.RequestID)
			layerID, layerErr := utilities.ParseID(req.body.LayerID)
			if reqErr != nil || layerErr != nil {
				return struct{}{}, apiErrorInvalidRequest
			}
			subject, err := verifier.Verify(ctx, req.body.MediaProof)
			if err != nil {
				if isParticipantMediaCredentialRejection(err) {
					return struct{}{}, apiErrorUnauthenticated
				}
				return struct{}{}, apiErrorServiceUnavailable
			}
			return struct{}{}, service.ApproveDevice(ctx, req.tenant, requestID, subject, layerID, req.body.PublicationID, req.body.Refresh)
		}).Needs(service, verifier).Permission(authorizer, writeTenantPermission).Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedWriteRateLimit).Parameters(tenantIDParameter()).RequestBody("HelperDeviceCodeApproval", helperCodeApproval{}).
		RespondsNoBody(http.StatusNoContent).Errors(helperDeviceErrors...).ErrorRules(helperDeviceRules)
	list := Get(helperDeviceTenantBase, "listScreenAnnotationHelperDevices", tenantIDRequest,
		func(ctx context.Context, tenant utilities.ID) (helperDeviceList, error) {
			if !service.DevicesEnabled() {
				return helperDeviceList{}, apiErrorServiceUnavailable
			}
			devices, err := service.ListDevices(ctx, tenant)
			return helperDeviceList{Devices: devices}, err
		}).Needs(service).Permission(authorizer, readTenantPermission).Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedReadRateLimit).Parameters(tenantIDParameter()).
		Responds(http.StatusOK, "HelperDeviceList", helperDeviceList{}).Errors(helperDeviceErrors...)
	remember := Post(helperDeviceTenantBase+"/remember", "rememberScreenAnnotationHelperDevice", decodeHelperOwnerRequest[helperRemember],
		func(ctx context.Context, req helperOwnerRequest[helperRemember]) (struct{}, error) {
			if !service.DevicesEnabled() {
				return struct{}{}, apiErrorServiceUnavailable
			}
			return struct{}{}, service.RememberLoopbackDevice(ctx, req.tenant, req.body.PublicKey)
		}).Needs(service).Permission(authorizer, writeTenantPermission).Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedWriteRateLimit).Parameters(tenantIDParameter()).RequestBody("HelperDeviceRemember", helperRemember{}).
		RespondsNoBody(http.StatusNoContent).Errors(helperDeviceErrors...).ErrorRules(helperDeviceRules)
	revoke := Post(helperDeviceTenantBase+"/revoke", "revokeScreenAnnotationHelperDevice", decodeHelperOwnerRequest[helperRevoke],
		func(ctx context.Context, req helperOwnerRequest[helperRevoke]) (struct{}, error) {
			if !service.DevicesEnabled() {
				return struct{}{}, apiErrorServiceUnavailable
			}
			id, err := utilities.ParseID(req.body.DeviceID)
			if err != nil {
				return struct{}{}, apiErrorInvalidRequest
			}
			return struct{}{}, service.RevokeDevice(ctx, req.tenant, id)
		}).Needs(service).Permission(authorizer, writeTenantPermission).Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedWriteRateLimit).Parameters(tenantIDParameter()).RequestBody("HelperDeviceRevoke", helperRevoke{}).
		RespondsNoBody(http.StatusNoContent).Errors(helperDeviceErrors...)
	return []RouteEndpoint{lookup, approve, list, remember, revoke}
}
