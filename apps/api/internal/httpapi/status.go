package httpapi

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	statusdomain "github.com/q9labs/chalk/apps/api/internal/status"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const opsIngestTokenHeader = "X-Ops-Ingest-Token"

type StatusIngestionService interface {
	Ingest(context.Context, statusdomain.MonitorResult) (statusdomain.IngestResult, error)
}

type StatusSnapshotService interface {
	Snapshot(context.Context) (statusdomain.PublicSnapshot, error)
}

type statusIngestRequestBody struct {
	ResultKey       string         `json:"result_key"`
	RunIdentifier   string         `json:"run_id" schema:"StatusMonitorIdentifier"`
	MonitorKey      string         `json:"monitor_key"`
	Status          string         `json:"status"`
	CheckedAt       string         `json:"checked_at"`
	EventAt         string         `json:"event_at"`
	LatencyMS       int64          `json:"latency_ms"`
	HTTPStatus      *int           `json:"http_status,omitempty"`
	ErrorCode       string         `json:"error_code,omitempty"`
	ErrorMessage    string         `json:"error_message,omitempty"`
	ResponseExcerpt string         `json:"response_excerpt,omitempty"`
	ReportedSource  string         `json:"reported_source"`
	ReportedEmitter string         `json:"reported_emitter_id" schema:"StatusMonitorIdentifier"`
	Metadata        map[string]any `json:"metadata,omitempty"`
	Details         map[string]any `json:"details,omitempty"`
}

type statusIngestRequest struct {
	Result statusdomain.MonitorResult
}

type statusIngestResponse struct {
	Accepted  bool `json:"accepted"`
	Duplicate bool `json:"duplicate"`
}

type publicStatusResponse struct {
	SchemaVersion int                     `json:"schema_version"`
	GeneratedAt   string                  `json:"generated_at"`
	Overall       string                  `json:"overall"`
	Components    []publicStatusComponent `json:"components"`
}

type publicStatusComponent struct {
	ComponentKey  string  `json:"id" schema:"StatusComponentId"`
	Name          string  `json:"name"`
	Description   string  `json:"description"`
	State         string  `json:"state"`
	CheckedAt     *string `json:"checked_at"`
	LastChangedAt *string `json:"last_changed_at"`
}

func mountStatusRoutes(r chi.Router, options Options) {
	r.Get("/status", getPublicStatusEndpoint(options.StatusSnapshot))
	endpoint := ingestMonitorResultEndpoint(options.StatusIngestion)
	r.With(requireOpsIngestToken(options.OpsIngestToken), rateLimit(options.RateLimit, telemetryIntakeRateLimit)).Method(http.MethodPost, "/ops/ingest/monitor-results", endpoint)
}

func statusEndpoints(ingestion StatusIngestionService, snapshot StatusSnapshotService) []RouteEndpoint {
	return []RouteEndpoint{
		ingestMonitorResultEndpoint(ingestion),
		getPublicStatusContractEndpoint(snapshot),
	}
}

func ingestMonitorResultEndpoint(service StatusIngestionService) Endpoint[statusIngestRequest, statusIngestResponse] {
	return Post("/v1/ops/ingest/monitor-results", "/ops/ingest/monitor-results", "ingestMonitorResult", decodeStatusIngestRequest, func(ctx context.Context, request statusIngestRequest) (statusIngestResponse, error) {
		if service == nil {
			return statusIngestResponse{}, statusdomain.ErrStatusUnavailable
		}
		result, err := service.Ingest(ctx, request.Result)
		if err != nil {
			return statusIngestResponse{}, err
		}
		return statusIngestResponse{Accepted: true, Duplicate: result.Duplicate}, nil
	}).
		Auth(APIAuthOpsToken).
		RateLimit(telemetryIntakeRateLimit).
		RequestBody("StatusMonitorResult", statusIngestRequestBody{}).
		Responds(http.StatusAccepted, "StatusMonitorResultAccepted", statusIngestResponse{}).
		Errors(apiErrorInvalidStatusResult, apiErrorStatusUnavailable, apiErrorRateLimited, apiErrorPayloadTooLarge, apiErrorUnauthenticated, apiErrorInternal).
		MapErrors(statusAPIError)
}

func getPublicStatusEndpoint(service StatusSnapshotService) http.HandlerFunc {
	endpoint := getPublicStatusContractEndpoint(service)
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		endpoint.ServeHTTP(w, r)
	}
}

func getPublicStatusContractEndpoint(service StatusSnapshotService) Endpoint[noRequest, publicStatusResponse] {
	return Get("/v1/status", "/status", "getPublicStatus", decodeNoRequest, func(ctx context.Context, _ noRequest) (publicStatusResponse, error) {
		if service == nil {
			return publicStatusResponse{}, statusdomain.ErrStatusUnavailable
		}
		snapshot, err := service.Snapshot(ctx)
		if err != nil {
			return publicStatusResponse{}, err
		}
		return newPublicStatusResponse(snapshot), nil
	}).
		Responds(http.StatusOK, "PublicStatus", publicStatusResponse{}).
		ResponseHeaders(APIHeaderContract{Name: "Cache-Control", Type: "string", Required: true}).
		Errors(apiErrorStatusUnavailable, apiErrorInternal).
		MapErrors(statusAPIError)
}

func decodeStatusIngestRequest(r *http.Request) (statusIngestRequest, error) {
	body, err := decodeJSONBody[statusIngestRequestBody](r)
	if err != nil {
		return statusIngestRequest{}, err
	}
	checkedAt, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(body.CheckedAt))
	if err != nil {
		return statusIngestRequest{}, statusdomain.ErrInvalidResult
	}
	eventAt, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(body.EventAt))
	if err != nil {
		return statusIngestRequest{}, statusdomain.ErrInvalidResult
	}
	return statusIngestRequest{Result: statusdomain.MonitorResult{
		ResultKey:         body.ResultKey,
		RunID:             body.RunIdentifier,
		MonitorKey:        body.MonitorKey,
		Status:            body.Status,
		CheckedAt:         checkedAt,
		EventAt:           eventAt,
		LatencyMS:         body.LatencyMS,
		HTTPStatus:        body.HTTPStatus,
		ErrorCode:         body.ErrorCode,
		ErrorMessage:      body.ErrorMessage,
		ResponseExcerpt:   body.ResponseExcerpt,
		ReportedSource:    body.ReportedSource,
		ReportedEmitterID: body.ReportedEmitter,
		Metadata:          marshalStatusObject(body.Metadata),
		Details:           marshalStatusObject(body.Details),
	}}, nil
}

func requireOpsIngestToken(expected string) func(http.Handler) http.Handler {
	expected = strings.TrimSpace(expected)
	expectedDigest := sha256.Sum256([]byte(expected))
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			providedDigest := sha256.Sum256([]byte(strings.TrimSpace(r.Header.Get(opsIngestTokenHeader))))
			matched := subtle.ConstantTimeCompare(expectedDigest[:], providedDigest[:])
			if expected == "" || matched != 1 {
				writeUnauthenticated(w)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func newPublicStatusResponse(snapshot statusdomain.PublicSnapshot) publicStatusResponse {
	definitions := make(map[string]statusdomain.ComponentDefinition)
	for _, definition := range statusdomain.ComponentCatalog() {
		definitions[definition.ID] = definition
	}
	components := make([]publicStatusComponent, 0, len(snapshot.Components))
	for _, component := range snapshot.Components {
		definition, ok := definitions[component.ID]
		if !ok {
			continue
		}
		state := component.State
		if state != statusdomain.StateOperational && state != statusdomain.StateDegraded && state != statusdomain.StateOutage && state != statusdomain.StateUnknown {
			state = statusdomain.StateUnknown
		}
		components = append(components, publicStatusComponent{
			ComponentKey:  definition.ID,
			Name:          definition.Name,
			Description:   definition.Description,
			State:         state,
			CheckedAt:     formatOptionalTimestamp(component.CheckedAt),
			LastChangedAt: formatOptionalTimestamp(component.LastChangedAt),
		})
	}
	overall := snapshot.Overall
	if overall != statusdomain.StateOperational && overall != statusdomain.StateDegraded && overall != statusdomain.StateOutage && overall != statusdomain.StateUnknown {
		overall = statusdomain.StateUnknown
	}
	return publicStatusResponse{
		SchemaVersion: statusdomain.SchemaVersion,
		GeneratedAt:   utilities.FormatTimestamp(snapshot.GeneratedAt),
		Overall:       overall,
		Components:    components,
	}
}

func marshalStatusObject(value map[string]any) json.RawMessage {
	if value == nil {
		return nil
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return json.RawMessage(`null`)
	}
	return encoded
}

func formatOptionalTimestamp(value *time.Time) *string {
	if value == nil {
		return nil
	}
	formatted := utilities.FormatTimestamp(*value)
	return &formatted
}

func statusAPIError(err error) (APIError, bool) {
	switch {
	case errors.Is(err, statusdomain.ErrInvalidResult):
		return apiErrorInvalidStatusResult, true
	case errors.Is(err, statusdomain.ErrStatusUnavailable):
		return apiErrorStatusUnavailable, true
	default:
		// The public status surface fails closed. It never turns a backing-store
		// failure into a misleading 200 or exposes adapter details.
		return apiErrorStatusUnavailable, true
	}
}
