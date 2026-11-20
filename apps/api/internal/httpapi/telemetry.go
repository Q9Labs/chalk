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

// telemetrySourceCost is what each predecessor source a version 2 batch names costs the budget on
// top of its bytes, because the batch may create a ledger row for each. The batch's own source is
// not charged: every batch names it, and a source costs at most one row.
const telemetrySourceCost = 4096

// telemetryCharge prices a request in bytes of the participant's budget, plus telemetrySourceCost
// per predecessor source a version 2 batch names. A body that was too large to read costs the
// largest body.
func telemetryCharge(request telemetryRequest) (ratelimit.Policy, bool) {
	policy := telemetryBudget
	policy.Cost = request.Bytes
	if request.Frame == "" && request.Batch.Version == sdktelemetry.LedgerVersion {
		if sources, err := telemetrydelivery.Sources(request.Batch); err == nil {
			policy.Cost += telemetrySourceCost * (len(sources) - 1)
		}
	}
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

// TelemetryLedger admits a version 2 batch against the stored ledger. It calls write with the
// records that are new after it has admitted the batch and before it commits, so an error from
// either leaves the ledger as it was. See telemetrydelivery.MemoryLedger and
// postgres.TelemetryLedger.
type TelemetryLedger interface {
	Admit(ctx context.Context, identity telemetrydelivery.Identity, batch sdktelemetry.Request, received time.Time, write telemetrydelivery.SinkWrite) (telemetrydelivery.Admission, error)
}

// A still-valid signed credential is enough, and it keeps being enough after the
// participant leaves: the last events are sent as the client goes, and the
// credential only stamps rows, so the byte budget is all it needs to be safe. The credential is the
// telemetry token, or the media credential for a client that has no telemetry token yet.
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
			return logTelemetry(ctx, subject, request.Batch, request.Origin), nil
		}).Auth(APIAuthParticipantTelemetry).Middleware(requireTelemetryCredential(telemetry, media)).RateLimitFor(telemetryBudget, telemetryCharge).
		Parameters(tenantIDParameter()).
		RequestBodyWithLimit("TelemetryRequest", sdktelemetry.Request{}, sdktelemetry.BodyLimit).
		Responds(http.StatusOK, "TelemetryResponse", sdktelemetry.Response{}).
		Errors(apiErrorInvalidTenantID, apiErrorForbidden, apiErrorInvalidRequest, apiErrorPayloadTooLarge, apiErrorUnauthenticated, apiErrorRateLimited, apiErrorServiceUnavailable, apiErrorInternal)
}

// admitTelemetry settles a version 2 batch in the ledger. The sink rows of the records the ledger
// calls new are written inside the ledger's transaction, so a retry of a batch whose answer was
// lost writes nothing again. When the ledger fails nothing is acked and the client retries the
// same batch.
func admitTelemetry(ctx context.Context, ledger TelemetryLedger, subject accessgrants.Subject, request telemetryRequest) (sdktelemetry.Response, error) {
	if ledger == nil {
		return sdktelemetry.Response{}, apiErrorServiceUnavailableRetry
	}
	identity := telemetrydelivery.Identity{TenantID: subject.TenantID, EpisodeID: subject.EpisodeID, ParticipantID: subject.ParticipantID}
	written := sdktelemetry.Response{Acks: []sdktelemetry.SeqRange{}, Rejections: []sdktelemetry.Rejection{}}
	admission, err := ledger.Admit(ctx, identity, request.Batch, time.Now(), func(ctx context.Context, admission telemetrydelivery.Admission) error {
		fresh := request.Batch
		fresh.Events = admission.New
		written = logTelemetry(ctx, subject, fresh, request.Origin)
		return nil
	})
	switch {
	case errors.Is(err, telemetrydelivery.ErrLedgerFull):
		return sdktelemetry.Response{}, rejectTelemetry(ctx, subject, "ledger_full")
	case errors.Is(err, telemetrydelivery.ErrSourceBound):
		// 400 like ledger_full: the client drops the batch as refused and never retries it.
		return sdktelemetry.Response{}, rejectTelemetry(ctx, subject, "source_bound", "source_id", request.Batch.SourceID)
	case errors.Is(err, telemetrydelivery.ErrBatch):
		return sdktelemetry.Response{}, rejectTelemetry(ctx, subject, "schema")
	case err != nil:
		observability.RequestLogger(ctx).With(telemetryStamp(subject, nil)...).ErrorContext(ctx, "Telemetry ledger failed",
			"event", "sdk.telemetry.ledger_failed", "source_id", request.Batch.SourceID, "batch_id", request.Batch.BatchID, "error", err)
		return sdktelemetry.Response{}, apiErrorServiceUnavailableRetry
	}
	written.Duplicates = admission.Duplicates
	written.Acks = telemetrydelivery.Acks(request.Batch, admission.Settled)
	return written, nil
}

// logTelemetry writes the rows of a batch. The credential names the tenant, Space, Episode,
// participant and provider; the client names nothing of that. provider and provider_session_id
// join a row to the media plane's own logs for the same connection.
func logTelemetry(ctx context.Context, subject accessgrants.Subject, batch sdktelemetry.Request, origin []any, extra ...any) sdktelemetry.Response {
	return sdktelemetry.Log(ctx, observability.RequestLogger(ctx), batch, time.Now(), append(telemetryStamp(subject, origin), extra...)...)
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

// legacySessionID is the session the old routes' baggage names, or empty when it is not a valid id,
// so the free text of an old client's header cannot reach a log row.
func legacySessionID(ctx context.Context) string {
	id, valid := observability.SessionIDFromContext(ctx)
	if !valid {
		return ""
	}
	return id
}
