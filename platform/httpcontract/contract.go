package httpcontract

import (
	"context"
	"net/http"

	"github.com/q9labs/chalk/platform/ratelimit"
)

type APIError struct {
	Status  int
	Code    string
	Message string
}

func (err APIError) Error() string {
	return err.Code
}

type APIAuth string

const (
	APIAuthCookieOrBearer   APIAuth = "session_or_bearer"
	APIAuthSessionOrBearer          = APIAuthCookieOrBearer
	APIAuthParticipantMedia APIAuth = "participant_media"
	APIAuthParticipantSync  APIAuth = "participant_sync"
)

type APISchemaRef struct {
	Name string
	Type any
}

type APIHeaderContract struct {
	Name     string
	Type     string
	Required bool
}

type APIResponseContract struct {
	Status  int
	Schema  *APISchemaRef
	Headers []APIHeaderContract
}

type APIParameterContract struct {
	Name      string
	In        string
	Type      string
	Required  bool
	Pattern   string
	MinLength int
	MaxLength int
	// CodePointLength marks a length the server counts in Unicode code points, not bytes.
	CodePointLength bool
	ItemsType       string
	Enum            []string
}

type APIRouteContract struct {
	Description    string
	OperationID    string
	Method         string
	Path           string
	MountPath      string
	Auth           APIAuth
	RateLimit      ratelimit.Policy
	BodyLimitBytes int64
	Parameters     []APIParameterContract
	Request        *APISchemaRef
	Responses      []APIResponseContract
	Errors         []APIError
}

// EndpointSpec lets features own their HTTP behavior while apps own mounting.
type EndpointSpec[Request any, Response any] struct {
	Contract    APIRouteContract
	Decode      func(*http.Request) (Request, error)
	Handle      func(context.Context, Request) (Response, error)
	MapErrors   func(error) (APIError, bool)
	Middlewares []func(http.Handler) http.Handler
}
