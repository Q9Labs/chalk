package httpapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/ratelimit"
	"github.com/q9labs/chalk/apps/api/internal/sdktelemetry"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// telemetryBudget is the bytes one participant may send for one call: the
// bucket holds a 135-minute, six-person call of events and stats windows, with
// about 1.5 MiB to spare, and refills over the same 135 minutes.
var telemetryBudget = ratelimit.Policy{Name: ratelimit.PolicyNameTelemetryIntake, Limit: 4 << 20, Window: 135 * time.Minute}

type telemetryRequest struct {
	TenantID utilities.ID
	Batch    sdktelemetry.Request
	// Bytes is what the request costs the budget, even when its frame is wrong.
	Bytes  int
	Origin []any
	// Frame is why the whole batch was refused, or empty.
	Frame string
}

// telemetryCharge prices a request in bytes of the participant's budget. A body
// that was too large to read costs the largest body.
func telemetryCharge(request telemetryRequest) (ratelimit.Policy, bool) {
	policy := telemetryBudget
	policy.Cost = request.Bytes
	return policy, true
}

func decodeTelemetry(r *http.Request) (telemetryRequest, error) {
	tenantID, err := tenantIDRequest(r)
	if err != nil {
		return telemetryRequest{}, err
	}
	request := telemetryRequest{TenantID: tenantID, Origin: telemetryOrigin(r)}
	body, err := io.ReadAll(http.MaxBytesReader(nil, r.Body, sdktelemetry.BodyLimit))
	request.Bytes = len(body)
	if err != nil {
		request.Bytes = sdktelemetry.BodyLimit
		request.Frame = "schema"
		if errors.As(err, new(*http.MaxBytesError)) {
			request.Frame = "body_too_large"
		}
		return request, nil
	}
	request.Batch, request.Frame = sdktelemetry.Decode(bytes.NewReader(body))
	return request, nil
}

// A still-valid signed credential is enough, and it keeps being enough after the
// participant leaves: the last events are sent as the client goes, and the
// credential only stamps rows, so the byte budget is all it needs to be safe.
func telemetryEndpoint(verifier ParticipantMediaVerifier) Endpoint[telemetryRequest, sdktelemetry.Response] {
	return Post("/v1/tenants/{tenant_id}/telemetry", "uploadTelemetry", decodeTelemetry,
		func(ctx context.Context, request telemetryRequest) (sdktelemetry.Response, error) {
			subject, ok := accessgrants.SubjectFromContext(ctx)
			if !ok {
				return sdktelemetry.Response{}, apiErrorUnauthenticated
			}
			if subject.TenantID != request.TenantID {
				return sdktelemetry.Response{}, apiErrorForbidden
			}
			if request.Frame != "" {
				return sdktelemetry.Response{}, rejectTelemetry(ctx, subject, request.Frame)
			}
			return logTelemetry(ctx, subject, request.Batch, request.Origin), nil
		}).Auth(APIAuthParticipantMedia).Middleware(requireParticipantMediaCredential(verifier)).RateLimitFor(telemetryBudget, telemetryCharge).
		Parameters(tenantIDParameter()).
		RequestBodyWithLimit("TelemetryRequest", sdktelemetry.Request{}, sdktelemetry.BodyLimit).
		Responds(http.StatusOK, "TelemetryResponse", sdktelemetry.Response{}).
		Errors(apiErrorInvalidTenantID, apiErrorForbidden, apiErrorInvalidRequest, apiErrorPayloadTooLarge, apiErrorUnauthenticated, apiErrorRateLimited, apiErrorServiceUnavailable, apiErrorInternal)
}

// logTelemetry writes the rows of a batch. The credential names the tenant, Space, Episode,
// participant and provider; the client names nothing of that. provider and provider_session_id
// join a row to the media plane's own logs for the same connection.
func logTelemetry(ctx context.Context, subject accessgrants.Subject, batch sdktelemetry.Request, origin []any) sdktelemetry.Response {
	return sdktelemetry.Log(ctx, observability.RequestLogger(ctx), batch, time.Now(), telemetryStamp(subject, origin)...)
}

func telemetryStamp(subject accessgrants.Subject, origin []any) []any {
	return append([]any{
		"tenant_id", subject.TenantID.String(), "space_id", subject.SpaceID.String(), "episode_id", subject.EpisodeID.String(),
		"provider", subject.Provider, "provider_session_id", subject.ConnectionID,
		"participant_id_hash", fmt.Sprintf("%x", sha256.Sum256([]byte(subject.ParticipantID.String()))),
	}, origin...)
}

// Reasons are fixed labels from the checks, never decoder errors or input.
func rejectTelemetry(ctx context.Context, subject accessgrants.Subject, reason string) error {
	observability.RequestLogger(ctx).With(telemetryStamp(subject, nil)...).WarnContext(ctx, "Rejected SDK telemetry batch",
		"event", "sdk.telemetry.rejected", "reason", reason)
	if reason == "body_too_large" {
		return apiErrorPayloadTooLarge
	}
	return apiErrorInvalidRequest
}

var countryCode = regexp.MustCompile(`^[A-Z]{2}$`)

// telemetryOrigin names where the call came from without an address: the edge's
// country code and coarse browser and OS families from the User-Agent.
func telemetryOrigin(r *http.Request) []any {
	country := r.Header.Get("CF-IPCountry")
	if !countryCode.MatchString(country) {
		country = "unknown"
	}
	family, system := clientFamilies(r.UserAgent())
	return []any{"country", country, "client_family", family, "client_os", system}
}

type userAgentMarker struct {
	label string
	parts []string
}

// The first marker found in the User-Agent wins, so order matters: Edge and Opera also say Chrome.
var browserMarkers = []userAgentMarker{
	{"edge", []string{"Edg/", "EdgA/", "EdgiOS/"}},
	{"opera", []string{"OPR/"}},
	{"samsung", []string{"SamsungBrowser/"}},
	{"firefox", []string{"Firefox/", "FxiOS/"}},
	{"chrome", []string{"Chrome/", "CriOS/"}},
	{"safari", []string{"Safari/"}},
	{"native", []string{"CFNetwork", "okhttp", "ReactNative", "Hermes"}},
}

var systemMarkers = []userAgentMarker{
	{"android", []string{"Android", "okhttp"}},
	{"ios", []string{"iPhone", "iPad", "iPod", "CFNetwork"}},
	{"windows", []string{"Windows"}},
	{"chromeos", []string{"CrOS"}},
	{"macos", []string{"Mac OS X", "Macintosh"}},
	{"linux", []string{"Linux", "X11"}},
}

func clientFamilies(userAgent string) (family, system string) {
	return firstMarker(userAgent, browserMarkers), firstMarker(userAgent, systemMarkers)
}

func firstMarker(userAgent string, markers []userAgentMarker) string {
	for _, marker := range markers {
		if slices.ContainsFunc(marker.parts, func(part string) bool { return strings.Contains(userAgent, part) }) {
			return marker.label
		}
	}
	return "other"
}
