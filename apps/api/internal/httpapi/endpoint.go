package httpapi

import (
	"context"
	"errors"
	"net/http"
	"reflect"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/ratelimit"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type RouteEndpoint interface {
	Mount(r chi.Router, limits RateLimitOptions)
	RouteContract() APIRouteContract
}

type EndpointDecoder[Request any] func(r *http.Request) (Request, error)
type EndpointHandler[Request any, Response any] func(ctx context.Context, request Request) (Response, error)
type EndpointErrorMapper func(err error) (APIError, bool)
type EndpointWriter[Response any] func(w http.ResponseWriter, r *http.Request, status int, response Response)

type Endpoint[Request any, Response any] struct {
	contract       APIRouteContract
	decode         EndpointDecoder[Request]
	handle         EndpointHandler[Request, Response]
	mapError       EndpointErrorMapper
	middlewares    []func(http.Handler) http.Handler
	afterRateLimit []func(http.Handler) http.Handler
	write          EndpointWriter[Response]
	// limitFor picks the quota for a decoded request. A route that serves several
	// operations from one URL uses it so each operation keeps its own policy.
	limitFor func(Request) (ratelimit.Policy, bool)
	limits   RateLimitOptions
	// needs are the services the route cannot run without, and authorizer
	// enforces contract.Permission. Both answer 503 when absent.
	needs      []any
	authorizer TenantAuthorizer
}

func Get[Request any, Response any](path string, operationID string, decode EndpointDecoder[Request], handle EndpointHandler[Request, Response]) Endpoint[Request, Response] {
	return newEndpoint(http.MethodGet, path, operationID, decode, handle)
}

func Post[Request any, Response any](path string, operationID string, decode EndpointDecoder[Request], handle EndpointHandler[Request, Response]) Endpoint[Request, Response] {
	return newEndpoint(http.MethodPost, path, operationID, decode, handle)
}

func Put[Request any, Response any](path string, operationID string, decode EndpointDecoder[Request], handle EndpointHandler[Request, Response]) Endpoint[Request, Response] {
	return newEndpoint(http.MethodPut, path, operationID, decode, handle)
}

func Patch[Request any, Response any](path string, operationID string, decode EndpointDecoder[Request], handle EndpointHandler[Request, Response]) Endpoint[Request, Response] {
	return newEndpoint(http.MethodPatch, path, operationID, decode, handle)
}

func Delete[Request any, Response any](path string, operationID string, decode EndpointDecoder[Request], handle EndpointHandler[Request, Response]) Endpoint[Request, Response] {
	return newEndpoint(http.MethodDelete, path, operationID, decode, handle)
}

func newEndpoint[Request any, Response any](method string, path string, operationID string, decode EndpointDecoder[Request], handle EndpointHandler[Request, Response]) Endpoint[Request, Response] {
	return Endpoint[Request, Response]{
		contract: APIRouteContract{
			OperationID: operationID,
			Method:      method,
			Path:        path,
		},
		decode: decode,
		handle: handle,
	}
}

func (e Endpoint[Request, Response]) Description(description string) Endpoint[Request, Response] {
	e.contract.Description = description
	return e
}

func (e Endpoint[Request, Response]) Auth(auth APIAuth) Endpoint[Request, Response] {
	e.contract.Auth = auth
	return e
}

func (e Endpoint[Request, Response]) UserAuth() Endpoint[Request, Response] {
	return e.Auth(APIAuthSessionOrBearer)
}

// Needs lists the services the route cannot run without. When one is nil, the
// route answers 503 once the request decodes and passes its rate limit.
func (e Endpoint[Request, Response]) Needs(services ...any) Endpoint[Request, Response] {
	e.needs = append(e.needs, services...)
	return e
}

// Permission makes the route require permission on the Tenant named by its
// {tenant_id} path parameter. The route checks it after the request decodes,
// so the contract and the enforcement are the same declaration.
func (e Endpoint[Request, Response]) Permission(authorizer TenantAuthorizer, permission authorization.TenantPermission) Endpoint[Request, Response] {
	if !strings.Contains(e.contract.Path, "{tenant_id}") {
		panic("httpapi: " + e.contract.OperationID + " declares a Tenant permission but its path has no {tenant_id}")
	}
	e.authorizer = authorizer
	e.contract.Permission = &permission
	return e
}

func (e Endpoint[Request, Response]) RateLimit(policy ratelimit.Policy) Endpoint[Request, Response] {
	e.contract.RateLimit = policy
	return e
}

// RateLimitFor documents policy as the route's quota and charges each request
// the policy limitFor returns for it, or nothing when it reports false. The
// quota is checked after the body decodes, because the request names its policy.
func (e Endpoint[Request, Response]) RateLimitFor(policy ratelimit.Policy, limitFor func(Request) (ratelimit.Policy, bool)) Endpoint[Request, Response] {
	e.contract.RateLimit = policy
	e.limitFor = limitFor
	return e
}

func (e Endpoint[Request, Response]) RequestBody(name string, sample any) Endpoint[Request, Response] {
	return e.RequestBodyWithLimit(name, sample, maxRequestBodyBytes)
}

func (e Endpoint[Request, Response]) RequestBodyWithLimit(name string, sample any, limit int64) Endpoint[Request, Response] {
	e.contract.Request = &APISchemaRef{Name: name, Type: sample}
	e.contract.BodyLimitBytes = limit
	e.contract.Errors = appendAPIError(e.contract.Errors, apiErrorPayloadTooLarge)
	return e
}

func (e Endpoint[Request, Response]) Responds(status int, name string, sample any) Endpoint[Request, Response] {
	e.contract.Responses = []APIResponseContract{
		{
			Status: status,
			Schema: &APISchemaRef{Name: name, Type: sample},
		},
	}
	return e
}

type textResponseBody string

func (e Endpoint[Request, Response]) RespondsText(status int, name string) Endpoint[Request, Response] {
	e = e.Responds(status, name, textResponseBody(""))
	e.contract.Responses[0].ContentType = "text/plain"
	return e
}

func (e Endpoint[Request, Response]) RespondsNoBody(status int) Endpoint[Request, Response] {
	e.contract.Responses = []APIResponseContract{{Status: status}}
	return e
}

func (e Endpoint[Request, Response]) ResponseHeaders(headers ...APIHeaderContract) Endpoint[Request, Response] {
	if len(e.contract.Responses) == 0 {
		return e
	}
	e.contract.Responses[0].Headers = append(e.contract.Responses[0].Headers, headers...)
	return e
}

func (e Endpoint[Request, Response]) Parameters(parameters ...APIParameterContract) Endpoint[Request, Response] {
	e.contract.Parameters = append(e.contract.Parameters, parameters...)
	return e
}

func (e Endpoint[Request, Response]) Errors(errors ...APIError) Endpoint[Request, Response] {
	for _, apiError := range errors {
		e.contract.Errors = appendAPIError(e.contract.Errors, apiError)
	}
	return e
}

func (e Endpoint[Request, Response]) MapErrors(mapper EndpointErrorMapper) Endpoint[Request, Response] {
	e.mapError = mapper
	return e
}

func (e Endpoint[Request, Response]) Middleware(middlewares ...func(http.Handler) http.Handler) Endpoint[Request, Response] {
	e.middlewares = append(e.middlewares, middlewares...)
	return e
}

// AfterRateLimit runs after the endpoint's participant/principal quota succeeds.
func (e Endpoint[Request, Response]) AfterRateLimit(middlewares ...func(http.Handler) http.Handler) Endpoint[Request, Response] {
	e.afterRateLimit = append(e.afterRateLimit, middlewares...)
	return e
}

func (e Endpoint[Request, Response]) WriteWith(writer EndpointWriter[Response]) Endpoint[Request, Response] {
	e.write = writer
	return e
}

func (e Endpoint[Request, Response]) Mount(r chi.Router, limits RateLimitOptions) {
	e.limits = limits
	var handler http.Handler = e
	for i := len(e.afterRateLimit) - 1; i >= 0; i-- {
		handler = e.afterRateLimit[i](handler)
	}
	if e.contract.RateLimit.Name != "" && e.limitFor == nil {
		handler = rateLimit(limits, e.contract.RateLimit)(handler)
	}
	for i := len(e.middlewares) - 1; i >= 0; i-- {
		handler = e.middlewares[i](handler)
	}
	r.Method(e.contract.Method, strings.TrimPrefix(e.contract.Path, apiPrefix), handler)
}

func (e Endpoint[Request, Response]) RouteContract() APIRouteContract {
	return e.contract
}

func (e Endpoint[Request, Response]) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	request, err := e.decode(r)
	if err != nil {
		e.writeFailure(w, r, err)
		return
	}

	if e.limitFor != nil {
		if policy, limited := e.limitFor(request); limited {
			if err := checkRateLimit(e.limits, policy, w, r); err != nil {
				writeRateLimitError(w, err)
				return
			}
		}
	}

	var tenantID utilities.ID
	if e.contract.Permission != nil {
		if tenantID, err = tenantIDRequest(r); err != nil {
			e.writeFailure(w, r, err)
			return
		}
	}
	response, err := e.guarded(r.Context(), tenantID, request)
	if err != nil {
		e.writeFailure(w, r, err)
		return
	}

	e.writeResponse(w, r, response)
}

// guarded runs the handler once guard passes. The MCP tools call it too,
// because they use the same endpoints.
func (e Endpoint[Request, Response]) guarded(ctx context.Context, tenantID utilities.ID, request Request) (Response, error) {
	if err := e.guard(ctx, tenantID); err != nil {
		var none Response
		return none, err
	}
	return e.handle(ctx, request)
}

// guard rejects a call whose services are missing or whose caller lacks the
// declared permission on tenantID.
func (e Endpoint[Request, Response]) guard(ctx context.Context, tenantID utilities.ID) error {
	for _, service := range e.needs {
		if missingService(service) {
			return apiErrorServiceUnavailable
		}
	}
	if e.contract.Permission == nil {
		return nil
	}
	return authorizeTenant(ctx, e.authorizer, tenantID, *e.contract.Permission)
}

// missingService reports a nil service, including a nil function value, which
// an interface comparison does not see.
func missingService(service any) bool {
	if service == nil {
		return true
	}
	value := reflect.ValueOf(service)
	return value.Kind() == reflect.Func && value.IsNil()
}

func (e Endpoint[Request, Response]) writeFailure(w http.ResponseWriter, r *http.Request, err error) {
	if r.Context().Err() != nil && errors.Is(err, context.Canceled) {
		// 499 records a caller that left, without counting a server failure or
		// attempting to send an API error body to the disconnected client.
		w.WriteHeader(499)
		return
	}
	apiErr := e.apiError(err)
	observability.RecordUpstream(w, err)
	if apiErr.Status >= http.StatusInternalServerError {
		observability.LogHTTPError(r.Context(), e.contract.Method, e.contract.Path, apiErr.Code, err)
	}
	writeAPIError(w, apiErr)
}

func (e Endpoint[Request, Response]) apiError(err error) APIError {
	if apiErr, ok := errorAsAPIError(err); ok {
		return apiErr
	}
	if e.mapError != nil {
		if apiErr, ok := e.mapError(err); ok {
			return apiErr
		}
	}
	return apiErrorInternal
}

func (e Endpoint[Request, Response]) successStatus() int {
	if len(e.contract.Responses) > 0 {
		return e.contract.Responses[0].Status
	}
	return http.StatusOK
}

func (e Endpoint[Request, Response]) writeResponse(w http.ResponseWriter, r *http.Request, response Response) {
	if e.write != nil {
		e.write(w, r, e.successStatus(), response)
		return
	}
	if len(e.contract.Responses) > 0 && e.contract.Responses[0].Schema == nil {
		w.WriteHeader(e.successStatus())
		return
	}

	writeJSON(w, e.successStatus(), response)
}

func errorAsAPIError(err error) (APIError, bool) {
	var apiErr APIError
	if errors.As(err, &apiErr) {
		return apiErr, true
	}
	return APIError{}, false
}

func decodeJSONBody[Request any](r *http.Request) (Request, error) {
	return decodeJSONBodyWithLimit[Request](r, maxRequestBodyBytes)
}

func decodeJSONBodyWithLimit[Request any](r *http.Request, limit int64) (Request, error) {
	var request Request
	if err := decodeRequestWithLimit(r, &request, limit); err != nil {
		var maxBytesErr *http.MaxBytesError
		if errors.As(err, &maxBytesErr) {
			return request, apiErrorPayloadTooLarge
		}
		return request, apiErrorInvalidRequest
	}
	return request, nil
}

func appendAPIError(errors []APIError, apiError APIError) []APIError {
	for _, existing := range errors {
		if existing.Status == apiError.Status && existing.Code == apiError.Code {
			return errors
		}
	}
	return append(errors, apiError)
}
