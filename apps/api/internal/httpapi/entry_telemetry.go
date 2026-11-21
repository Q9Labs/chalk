package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/ratelimit"
)

// entryBodyLimit bounds one entry-events envelope: a whole pre-admission trail is a few
// dozen small records.
const entryBodyLimit = 64 << 10

const entryEventLimit = 50

// entryBudget bounds each client session's entry records per day; pre-admission sends have no
// credential yet, so the client IP is the budget key the limiter supplies.
var entryBudget = ratelimit.Policy{Name: "v1.entry.intake", Limit: 4 << 20, Window: 24 * time.Hour, Cost: 1}

var (
	entryIDPattern   = regexp.MustCompile(`^[a-z]{2,4}_[A-Za-z0-9_-]{4,64}$`)
	entryNamePattern = regexp.MustCompile(`^[a-z]+(\.[a-z_]+)+$`)
	entryKindPattern = regexp.MustCompile(`^(fact|op|decision|surface|transition)$`)
)

var apiErrorEntryInvalid = APIError{Status: http.StatusBadRequest, Code: "entry.invalid", Message: "Invalid entry events envelope"}
var apiErrorEntryTooLarge = APIError{Status: http.StatusRequestEntityTooLarge, Code: "entry.too_large", Message: "Entry events body too large"}

// entryEventRequest is one client record inside an entry envelope: kind is the record kind the
// client kernel emitted (fact, op, decision, surface, transition); fields carry the event's own
// attribute bag. seq is the client session's own sequence; the reader reconstructs per-session
// order and completeness from it.
type entryEventRequest struct {
	Kind        string         `json:"kind"`
	Name        string         `json:"name"`
	Seq         int            `json:"seq"`
	EstServerMs int64          `json:"est_server_ms"`
	Fields      map[string]any `json:"fields"`
}

// entryRequest is the credential-free first-party envelope of C3: the client session and device
// ids are self-minted before authentication, which is exactly why this route exists.
type entryRequest struct {
	Version         int                 `json:"v"`
	ClientSessionID string              `json:"client_session_id"`
	DeviceID        string              `json:"device_id"`
	EphemeralDevice bool                `json:"ephemeral_device"`
	BuildID         string              `json:"build_id"`
	JourneyID       string              `json:"journey_id"`
	Events          []entryEventRequest `json:"events"`
	BodyBytes       int                 `json:"-"`
}

func decodeEntryRequest(r *http.Request) (entryRequest, error) {
	body, err := io.ReadAll(http.MaxBytesReader(nil, r.Body, entryBodyLimit))
	request := entryRequest{BodyBytes: len(body)}
	if err != nil {
		if errors.As(err, new(*http.MaxBytesError)) {
			return request, apiErrorEntryTooLarge
		}
		return request, apiErrorEntryInvalid
	}
	if err := json.Unmarshal(body, &request); err != nil {
		return request, apiErrorEntryInvalid
	}
	if request.Version != 1 || len(request.Events) == 0 || len(request.Events) > entryEventLimit ||
		!entryIDPattern.MatchString(request.ClientSessionID) {
		return request, apiErrorEntryInvalid
	}
	for _, event := range request.Events {
		if !entryNamePattern.MatchString(event.Name) || !entryKindPattern.MatchString(event.Kind) || len(event.Name) > 64 {
			return request, apiErrorEntryInvalid
		}
	}
	return request, nil
}

// entryTelemetryEndpoint accepts pre-admission and dashboard entry records with no credential:
// the point of the path is that the client has nothing yet. Each record lands in the api log as
// an `entry.<name>` row carrying the client's own source id and sequence so the diagnose reader
// can order it inside its session.
func entryTelemetryEndpoint(origin func(http.Handler) http.Handler) Endpoint[entryRequest, struct{}] {
	endpoint := Post("/v1/public/entry", "uploadEntryEvents", decodeEntryRequest,
		func(ctx context.Context, request entryRequest) (struct{}, error) {
			stamp := time.Now().UnixMilli()
			for _, event := range request.Events {
				attrs := []slog.Attr{
					slog.String("event", "entry."+event.Name),
					slog.Bool("entry_event", true),
					slog.String("kind", event.Kind),
					slog.String("client_session_id", request.ClientSessionID),
					slog.Int("seq", event.Seq),
					slog.Int64("est_server_ms", event.EstServerMs),
					slog.String("device_id", request.DeviceID),
					slog.Bool("ephemeral_device", request.EphemeralDevice),
					slog.Int64("ingested_at_ms", stamp),
				}
				if request.BuildID != "" {
					attrs = append(attrs, slog.String("build_id", request.BuildID))
				}
				if request.JourneyID != "" {
					attrs = append(attrs, slog.String("journey_id", request.JourneyID))
				}
				for field, value := range event.Fields {
					switch v := value.(type) {
					case string:
						attrs = append(attrs, slog.String(field, v))
					case bool:
						attrs = append(attrs, slog.Bool(field, v))
					case float64:
						attrs = append(attrs, slog.Float64(field, v))
					case nil:
					default:
						attrs = append(attrs, slog.String(field, fmt.Sprint(v)))
					}
				}
				slog.Default().LogAttrs(ctx, slog.LevelInfo, "entry event", attrs...)
			}
			return struct{}{}, nil
		}).RateLimitFor(entryBudget, func(request entryRequest) (ratelimit.Policy, bool) {
		policy := entryBudget
		policy.Cost = request.BodyBytes
		return policy, true
	}).Responds(http.StatusAccepted, "Empty", struct{}{})
	if origin != nil {
		endpoint = endpoint.Middleware(origin)
	}
	return endpoint
}
