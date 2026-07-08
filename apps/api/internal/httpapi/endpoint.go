package httpapi

import (
	"context"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/ratelimit"
)

type RouteEndpoint interface {
	Mount(r chi.Router, limits RateLimitOptions)
	RouteContract() APIRouteContract
}

type EndpointDecoder[Request any] func(r *http.Request) (Request, error)
type EndpointHandler[Request any, Response any] func(ctx context.Context, request Request) (Response, error)
type EndpointErrorMapper func(err error) (APIError, bool)

type Endpoint[Request any, Response any] struct {
	contract APIRouteContract
	decode   EndpointDecoder[Request]
	handle   EndpointHandler[Request, Response]
	mapError EndpointErrorMapper
}

func Get[Request any, Response any](path string, mountPath string, operationID string, decode EndpointDecoder[Request], handle EndpointHandler[Request, Response]) Endpoint[Request, Response] {
	return newEndpoint(http.MethodGet, path, mountPath, operationID, decode, handle)
}

func Post[Request any, Response any](path string, mountPath string, operationID string, decode EndpointDecoder[Request], handle EndpointHandler[Request, Response]) Endpoint[Request, Response] {
	return newEndpoint(http.MethodPost, path, mountPath, operationID, decode, handle)
}

func Patch[Request any, Response any](path string, mountPath string, operationID string, decode EndpointDecoder[Request], handle EndpointHandler[Request, Response]) Endpoint[Request, Response] {
	return newEndpoint(http.MethodPatch, path, mountPath, operationID, decode, handle)
}

func newEndpoint[Request any, Response any](method string, path string, mountPath string, operationID string, decode EndpointDecoder[Request], handle EndpointHandler[Request, Response]) Endpoint[Request, Response] {
	return Endpoint[Request, Response]{
		contract: APIRouteContract{
			OperationID: operationID,
			Method:      method,
			Path:        path,
			MountPath:   mountPath,
		},
		decode: decode,
		handle: handle,
	}
}

func (e Endpoint[Request, Response]) Auth(auth APIAuth) Endpoint[Request, Response] {
	e.contract.Auth = auth
	return e
}

func (e Endpoint[Request, Response]) RateLimit(policy ratelimit.Policy) Endpoint[Request, Response] {
	e.contract.RateLimit = policy
	return e
}

func (e Endpoint[Request, Response]) RequestBody(name string, sample any) Endpoint[Request, Response] {
	e.contract.Request = &APISchemaRef{Name: name, Type: sample}
	return e
}

func (e Endpoint[Request, Response]) Responds(status int, name string, sample any) Endpoint[Request, Response] {
	e.contract.Responses = []APIResponseContract{
		{
			Status: status,
			Schema: APISchemaRef{Name: name, Type: sample},
		},
	}
	return e
}

func (e Endpoint[Request, Response]) Parameters(parameters ...APIParameterContract) Endpoint[Request, Response] {
	e.contract.Parameters = append(e.contract.Parameters, parameters...)
	return e
}

func (e Endpoint[Request, Response]) Errors(errors ...APIError) Endpoint[Request, Response] {
	e.contract.Errors = append(e.contract.Errors, errors...)
	return e
}

func (e Endpoint[Request, Response]) MapErrors(mapper EndpointErrorMapper) Endpoint[Request, Response] {
	e.mapError = mapper
	return e
}

func (e Endpoint[Request, Response]) Mount(r chi.Router, limits RateLimitOptions) {
	var handler http.Handler = e
	if e.contract.RateLimit.Name != "" {
		handler = rateLimit(limits, e.contract.RateLimit)(handler)
	}
	r.Method(e.contract.Method, e.contract.MountPath, handler)
}

func (e Endpoint[Request, Response]) RouteContract() APIRouteContract {
	return e.contract
}

func (e Endpoint[Request, Response]) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	request, err := e.decode(r)
	if err != nil {
		writeAPIError(w, e.apiError(err))
		return
	}

	response, err := e.handle(r.Context(), request)
	if err != nil {
		writeAPIError(w, e.apiError(err))
		return
	}

	writeJSON(w, e.successStatus(), response)
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

func errorAsAPIError(err error) (APIError, bool) {
	var apiErr APIError
	if errors.As(err, &apiErr) {
		return apiErr, true
	}
	return APIError{}, false
}

type noRequest struct{}

func decodeNoRequest(r *http.Request) (noRequest, error) {
	_ = r
	return noRequest{}, nil
}

func decodeJSONBody[Request any](r *http.Request) (Request, error) {
	var request Request
	if err := decodeRequest(r, &request); err != nil {
		return request, apiErrorInvalidRequest
	}
	return request, nil
}
