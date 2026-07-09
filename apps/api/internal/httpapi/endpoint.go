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
type EndpointWriter[Response any] func(w http.ResponseWriter, r *http.Request, status int, response Response)

type Endpoint[Request any, Response any] struct {
	contract    APIRouteContract
	decode      EndpointDecoder[Request]
	handle      EndpointHandler[Request, Response]
	mapError    EndpointErrorMapper
	middlewares []func(http.Handler) http.Handler
	write       EndpointWriter[Response]
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
	e.contract.BodyLimitBytes = maxRequestBodyBytes
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
	e.contract.Errors = append(e.contract.Errors, errors...)
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

func (e Endpoint[Request, Response]) WriteWith(writer EndpointWriter[Response]) Endpoint[Request, Response] {
	e.write = writer
	return e
}

func (e Endpoint[Request, Response]) Mount(r chi.Router, limits RateLimitOptions) {
	var handler http.Handler = e
	if e.contract.RateLimit.Name != "" {
		handler = rateLimit(limits, e.contract.RateLimit)(handler)
	}
	for i := len(e.middlewares) - 1; i >= 0; i-- {
		handler = e.middlewares[i](handler)
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

	e.writeResponse(w, r, response)
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

	writeJSON(w, e.successStatus(), response)
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
