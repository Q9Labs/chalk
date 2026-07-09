package httpapi

import "github.com/q9labs/chalk/apps/api/internal/ratelimit"

type APIAuth string

const (
	APIAuthSessionOrBearer APIAuth = "session_or_bearer"
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
	Name     string
	In       string
	Type     string
	Required bool
}

type APIRouteContract struct {
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

func PreviewRouteContracts() []APIRouteContract {
	endpoints := make([]RouteEndpoint, 0)
	endpoints = append(endpoints, authEndpoints(nil, SessionCookieOptions{})...)
	endpoints = append(endpoints, meEndpoints(nil)...)
	endpoints = append(endpoints, tenantEndpoints(nil, nil)...)
	endpoints = append(endpoints, userEndpoints(nil)...)
	endpoints = append(endpoints, membershipEndpoints(nil, nil)...)
	endpoints = append(endpoints, roomEndpoints(nil, nil)...)
	endpoints = append(endpoints, recordingEndpoints(nil, nil, nil)...)
	endpoints = append(endpoints, transcriptEndpoints(nil, nil, nil, nil, nil, nil)...)
	endpoints = append(endpoints, auditLogEndpoints(nil, nil)...)
	endpoints = append(endpoints, integrationEndpoints(nil, nil, integrationRouteOptions{})...)
	return routeContracts(endpoints)
}

func routeContracts(endpoints []RouteEndpoint) []APIRouteContract {
	contracts := make([]APIRouteContract, 0, len(endpoints))
	for _, endpoint := range endpoints {
		contracts = append(contracts, endpoint.RouteContract())
	}
	return contracts
}
