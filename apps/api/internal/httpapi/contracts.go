package httpapi

import "github.com/q9labs/chalk/apps/api/internal/ratelimit"

// apiPrefix is where the public API mounts; every route Path starts with it.
const apiPrefix = "/v1"

type APIAuth string

const (
	APIAuthSessionOrBearer  APIAuth = "session_or_bearer"
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
	ContentType string
	Status      int
	Schema      *APISchemaRef
	Headers     []APIHeaderContract
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
	Auth           APIAuth
	RateLimit      ratelimit.Policy
	BodyLimitBytes int64
	Parameters     []APIParameterContract
	Request        *APISchemaRef
	Responses      []APIResponseContract
	Errors         []APIError
}

// PreviewRouteContracts lists the contract of every public route by building the
// router's route groups without services.
func PreviewRouteContracts() []APIRouteContract {
	var endpoints []RouteEndpoint
	for _, group := range v1RouteGroups(Options{}) {
		endpoints = append(endpoints, group.endpoints...)
	}
	return routeContracts(endpoints)
}

func routeContracts(endpoints []RouteEndpoint) []APIRouteContract {
	contracts := make([]APIRouteContract, 0, len(endpoints))
	for _, endpoint := range endpoints {
		contracts = append(contracts, endpoint.RouteContract())
	}
	return contracts
}
