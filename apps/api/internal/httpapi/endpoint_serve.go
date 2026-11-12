package httpapi

import (
	"context"
	"errors"
	"net/http"
	"reflect"

	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

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
	return e.rules.apiError(err)
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

// errorRule says which API error a domain error becomes.
type errorRule struct {
	kind   APIError
	causes []error
}

func ruleFor(kind APIError, causes ...error) errorRule {
	return errorRule{kind: kind, causes: causes}
}

// errorRules is an ordered table: the first rule with a matching cause wins.
type errorRules []errorRule

// apiError returns an APIError found in err as is, then the first matching
// rule, then the authorization error or internal error for anything else.
func (rules errorRules) apiError(err error) APIError {
	if apiErr, ok := errorAsAPIError(err); ok {
		return apiErr
	}
	for _, rule := range rules {
		for _, cause := range rule.causes {
			if errors.Is(err, cause) {
				return rule.kind
			}
		}
	}
	return authorizationAPIError(err)
}
