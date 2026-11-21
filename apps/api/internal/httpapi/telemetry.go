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

	"go.opentelemetry.io/otel/trace"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/ratelimit"
	"github.com/q9labs/chalk/apps/api/internal/sdktelemetry"
	"github.com/q9labs/chalk/apps/api/internal/telemetrydelivery"
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

// telemetryCharge prices a request in bytes of the participant's budget. A body that was too large
// to read costs the largest body. Rows are bounded apart from bytes: a batch writes only its own
// source, and the ledger caps the sources one participant owns.
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

// TelemetryVerifier verifies the telemetry token, which only the telemetry route accepts.
type TelemetryVerifier interface {
	VerifyTelemetry(context.Context, string) (accessgrants.Subject, error)
}

// TelemetryLedger admits a version 2 batch against the stored ledger and returns only after the
// admission is durable; an error leaves the ledger as it was. Live is the same participant fence
// on its own, for a version 1 batch, which has no ledger row: it returns
// telemetrydelivery.ErrParticipantGone unless the participant's row exists. See
// telemetrydelivery.MemoryLedger and postgres.TelemetryLedger.
type TelemetryLedger interface {
	Admit(ctx context.Context, identity telemetrydelivery.Identity, batch sdktelemetry.Request, received time.Time, stamp sdktelemetry.Stamp) (telemetrydelivery.Admission, error)
	Live(ctx context.Context, identity telemetrydelivery.Identity) error
}

// A still-valid signed credential is enough to send, and it keeps being enough after the
// participant leaves: the last events are sent as the client goes. The credential names who sends,
// so a batch of either version is logged only while that participant's row exists, a version 2
// batch reaches only a source of its own participant, and the byte budget bounds the rest. The
// credential is the telemetry token, or the media credential for a client that has no telemetry
// token yet.
func telemetryEndpoint(telemetry TelemetryVerifier, media ParticipantMediaVerifier, ledger TelemetryLedger) Endpoint[telemetryRequest, sdktelemetry.Response] {
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
			if request.Batch.Version == sdktelemetry.LedgerVersion {
				return admitTelemetry(ctx, ledger, subject, request)
			}
			if err := liveTelemetry(ctx, ledger, subject); err != nil {
				return sdktelemetry.Response{}, refuseTelemetry(ctx, subject, request.Batch, err)
			}
			return logTelemetry(ctx, subject, request.Batch, request.Origin), nil
		}).Auth(APIAuthParticipantTelemetry).Middleware(requireTelemetryCredential(telemetry, media)).Needs(ledger).RateLimitFor(telemetryBudget, telemetryCharge).
		Parameters(tenantIDParameter()).
		RequestBodyWithLimit("TelemetryRequest", sdktelemetry.Request{}, sdktelemetry.BodyLimit).
		Responds(http.StatusOK, "TelemetryResponse", sdktelemetry.Response{}).
		Errors(apiErrorInvalidTenantID, apiErrorForbidden, apiErrorTelemetryRefused, apiErrorPayloadTooLarge, apiErrorUnauthenticated, apiErrorRateLimited, apiErrorServiceUnavailable, apiErrorInternal)
}

// admitTelemetry acknowledges only once the ledger has committed both the ranges and the new payload.
func admitTelemetry(ctx context.Context, ledger TelemetryLedger, subject accessgrants.Subject, request telemetryRequest) (sdktelemetry.Response, error) {
	received := time.Now()
	stamp := sdktelemetry.Stamp{Legacy: telemetryStamp(subject, request.Origin), Record: recordStamp(subject)}
	if span := trace.SpanContextFromContext(ctx); span.IsValid() {
		stamp.Legacy = append(stamp.Legacy, "trace_id", span.TraceID().String(), "span_id", span.SpanID().String())
	}
	admission, err := ledger.Admit(ctx, telemetryIdentity(subject), request.Batch, received, stamp)
	if err != nil {
		return sdktelemetry.Response{}, refuseTelemetry(ctx, subject, request.Batch, err)
	}
	rejected := request.Batch
	rejected.Events = nil
	for _, event := range admission.New {
		if event.Rejection() != "" {
			rejected.Events = append(rejected.Events, event)
		}
	}
	response := sdktelemetry.Log(ctx, observability.RequestLogger(ctx), rejected, received, stamp)
	response.Accepted = len(admission.New) - response.Rejected
	response.Duplicates = admission.Duplicates
	response.Acks = telemetrydelivery.Acks(request.Batch, admission.Settled)
	if admission.EndRejection != "" {
		response.EndRejection = admission.EndRejection
		observability.RequestLogger(ctx).With(telemetryStamp(subject, nil)...).WarnContext(ctx, "Rejected SDK telemetry end",
			"event", "sdk.telemetry.rejected", "reason", admission.EndRejection, "source_id", request.Batch.SourceID, "batch_id", request.Batch.BatchID)
	}
	return response, nil
}

// liveTelemetry fences a version 1 batch the way Admit fences a version 2 one, so a still-valid
// credential of a purged tenant or a removed participant logs nothing.
func liveTelemetry(ctx context.Context, ledger TelemetryLedger, subject accessgrants.Subject) error {
	return ledger.Live(ctx, telemetryIdentity(subject))
}

// telemetryIdentity is who the ledger sees behind a subject's credential.
func telemetryIdentity(subject accessgrants.Subject) telemetrydelivery.Identity {
	return telemetrydelivery.Identity{TenantID: subject.TenantID, EpisodeID: subject.EpisodeID, ParticipantID: subject.ParticipantID}
}

// refuseTelemetry answers a batch the ledger refused as a whole. A refusal the client cannot fix
// by sending again is final: it drops the batch as refused. Any other failure is a retry.
func refuseTelemetry(ctx context.Context, subject accessgrants.Subject, batch sdktelemetry.Request, err error) error {
	switch {
	case errors.Is(err, telemetrydelivery.ErrLedgerFull):
		return rejectTelemetry(ctx, subject, "ledger_full")
	case errors.Is(err, telemetrydelivery.ErrSourceOwned):
		return rejectTelemetry(ctx, subject, telemetrydelivery.ReasonSourceOwned, "source_id", batch.SourceID)
	case errors.Is(err, telemetrydelivery.ErrSourceBudget):
		return rejectTelemetry(ctx, subject, telemetrydelivery.ReasonSourceBudget, "source_id", batch.SourceID)
	case errors.Is(err, telemetrydelivery.ErrParticipantGone):
		return rejectTelemetry(ctx, subject, telemetrydelivery.ReasonParticipantGone)
	case errors.Is(err, telemetrydelivery.ErrBatch):
		return rejectTelemetry(ctx, subject, "schema")
	}
	observability.RequestLogger(ctx).With(telemetryStamp(subject, nil)...).ErrorContext(ctx, "Telemetry ledger failed",
		"event", "sdk.telemetry.ledger_failed", "source_id", batch.SourceID, "batch_id", batch.BatchID)
	return apiErrorServiceUnavailableRetry
}

// logTelemetry writes the rows of a batch. The credential names the tenant, Space, Episode,
// participant and provider; the client names nothing of that. provider and provider_session_id
// join a row to the media plane's own logs for the same connection.
func logTelemetry(ctx context.Context, subject accessgrants.Subject, batch sdktelemetry.Request, origin []any) sdktelemetry.Response {
	stamp := sdktelemetry.Stamp{Legacy: telemetryStamp(subject, origin), Record: recordStamp(subject)}
	return sdktelemetry.Log(ctx, observability.RequestLogger(ctx), batch, time.Now(), stamp)
}

// recordStamp is the credential's trail on a kernel record's row, under registry field names. A
// kernel row names its seat by participant_id, as the server kernels' rows do, so a reader joins the
// seat's client records to its Sync and API records.
func recordStamp(subject accessgrants.Subject) []any {
	stamp := []any{
		"tenant_id", subject.TenantID.String(), "space_id", subject.SpaceID.String(), "episode_id", subject.EpisodeID.String(),
		"participant_id", subject.ParticipantID.String(), "generation", subject.ParticipantGeneration,
	}
	if subject.ConnectionID != "" {
		stamp = append(stamp, "provider_media_id", subject.ConnectionID)
	}
	return stamp
}

func telemetryStamp(subject accessgrants.Subject, origin []any) []any {
	return append([]any{
		"tenant_id", subject.TenantID.String(), "space_id", subject.SpaceID.String(), "episode_id", subject.EpisodeID.String(),
		"provider", subject.Provider, "provider_session_id", subject.ConnectionID,
		"participant_id_hash", fmt.Sprintf("%x", sha256.Sum256([]byte(subject.ParticipantID.String()))),
	}, origin...)
}

// Reasons are fixed labels from the checks, never decoder errors or input.
func rejectTelemetry(ctx context.Context, subject accessgrants.Subject, reason string, extra ...any) error {
	observability.RequestLogger(ctx).With(telemetryStamp(subject, nil)...).WarnContext(ctx, "Rejected SDK telemetry batch",
		append([]any{"event", "sdk.telemetry.rejected", "reason", reason}, extra...)...)
	switch reason {
	case "body_too_large":
		return apiErrorPayloadTooLarge
	case telemetrydelivery.ReasonParticipantGone:
		return apiErrorForbidden
	}
	return apiErrorTelemetryRefused
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
