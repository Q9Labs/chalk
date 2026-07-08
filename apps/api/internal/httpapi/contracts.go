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

type APIResponseContract struct {
	Status int
	Schema APISchemaRef
}

type APIParameterContract struct {
	Name     string
	In       string
	Type     string
	Required bool
}

type APIRouteContract struct {
	OperationID string
	Method      string
	Path        string
	MountPath   string
	Auth        APIAuth
	RateLimit   ratelimit.Policy
	Parameters  []APIParameterContract
	Request     *APISchemaRef
	Responses   []APIResponseContract
	Errors      []APIError
}

func PreviewRouteContracts() []APIRouteContract {
	return routeContracts(tenantEndpoints(nil, nil))
}

func routeContracts(endpoints []RouteEndpoint) []APIRouteContract {
	contracts := make([]APIRouteContract, 0, len(endpoints))
	for _, endpoint := range endpoints {
		contracts = append(contracts, endpoint.RouteContract())
	}
	return contracts
}
