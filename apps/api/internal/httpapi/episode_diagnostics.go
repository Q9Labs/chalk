package httpapi

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/episodediagnostics"
)

const (
	diagnosticMaxRequestBodyBytes = 1 << 20
	diagnosticMaxFilterBytes      = 64 << 10
	diagnosticDefaultHeartbeat    = 15 * time.Second
	diagnosticDefaultStreamLimit  = 30 * time.Minute
	diagnosticDefaultPollInterval = 500 * time.Millisecond
	diagnosticDefaultBatchSize    = 128
)

// EpisodeDiagnosticsService is deliberately narrower than the concrete
// service. Keeping the HTTP boundary on this port makes the diagnostics
// routes independently testable and prevents normal user-authentication
// contexts from becoming an accidental operator authorization path.
type EpisodeDiagnosticsService interface {
	Append(context.Context, episodediagnostics.ProducerPrincipal, episodediagnostics.AppendDiagnosticEventsRequest) (episodediagnostics.AppendDiagnosticEventsResult, error)
	Resolve(context.Context, episodediagnostics.OperatorPrincipal, string) (episodediagnostics.DiagnosticResolverResponseV1, error)
	AlternateReference(context.Context, episodediagnostics.OperatorPrincipal, string, string) (episodediagnostics.DiagnosticReference, error)
	Snapshot(context.Context, episodediagnostics.OperatorPrincipal, string, episodediagnostics.DiagnosticFilterV1) (episodediagnostics.DiagnosticSnapshotV1, error)
	PrepareFilter(episodediagnostics.DiagnosticFilterV1) (episodediagnostics.DiagnosticFilterV1, error)
	Events(context.Context, episodediagnostics.OperatorPrincipal, string, episodediagnostics.DiagnosticFilterV1, *int64, *int64, int) (episodediagnostics.DiagnosticEventPageV1, error)
	Operations(context.Context, episodediagnostics.OperatorPrincipal, string, episodediagnostics.DiagnosticFilterV1, *int64, int) (episodediagnostics.DiagnosticOperationPageV1, error)
	Changes(context.Context, episodediagnostics.OperatorPrincipal, string, int64, int) (episodediagnostics.EpisodeDiagnostic, []episodediagnostics.ProjectionChange, error)
	Brief(context.Context, episodediagnostics.OperatorPrincipal, string, string, int64, string) (episodediagnostics.AgentBriefResponseV1, error)
	CreateExport(context.Context, episodediagnostics.OperatorPrincipal, string, int64, *int64) (episodediagnostics.DiagnosticExportJob, error)
	Export(context.Context, episodediagnostics.OperatorPrincipal, string, string) (episodediagnostics.DiagnosticExportJob, error)
	CancelExport(context.Context, episodediagnostics.OperatorPrincipal, string, string) (episodediagnostics.DiagnosticExportJob, error)
	Download(context.Context, episodediagnostics.OperatorPrincipal, string, string) (episodediagnostics.ExportArtifact, error)
}

// EpisodeDiagnosticsParticipantVerifier verifies the short-lived credential
// minted for a Participant's diagnostics intake. A normal media credential or
// a normal user/API-key principal must never satisfy this interface.
type EpisodeDiagnosticsParticipantVerifier interface {
	Verify(context.Context, string) (accessgrants.DiagnosticsSubject, error)
}

// EpisodeDiagnosticsServiceVerifier verifies a purpose-scoped credential for
// hosted Sync, API, provider, and worker intake sources. Static Sync tokens are
// accepted only by the localhost mode.
type EpisodeDiagnosticsServiceVerifier interface {
	Verify(context.Context, string) (accessgrants.DiagnosticsServiceSubject, error)
}

// EpisodeDiagnosticsOperatorVerifier verifies the dedicated operator token
// used by the hosted diagnostics boundary. It intentionally has no relation
// to the normal user/request authentication interfaces.
type EpisodeDiagnosticsOperatorVerifier interface {
	Verify(context.Context, string) (accessgrants.DiagnosticsOperatorSubject, error)
}

// EpisodeDiagnosticsAccountScope is the bounded authorization result that a
// Dashboard gateway supplies after authenticating its existing account
// account credential. The gateway adapter must derive AuthorizedTenantIDs from the same
// account/tenant-access policy used by normal Dashboard API routes; a global
// environment token is not an acceptable substitute.
type EpisodeDiagnosticsAccountScope struct {
	SubjectHash         string
	AuthorizedTenantIDs []string
	Capabilities        map[string]struct{}
}

// EpisodeDiagnosticsAccountAuthorizer is the narrow gateway seam for
// Dashboard access. The router/gateway must first attach the normal user
// authentication.Principal to the request context, then the adapter must
// enforce account tenant access and return only the bounded tenant scope.
type EpisodeDiagnosticsAccountAuthorizer interface {
	AuthorizeEpisodeDiagnosticsAccount(context.Context, authentication.Principal) (EpisodeDiagnosticsAccountScope, error)
}

// EpisodeDiagnosticsCredentialVerifier is kept as a descriptive alias for
// composition roots that call the verifier a credential verifier.
type EpisodeDiagnosticsCredentialVerifier = EpisodeDiagnosticsParticipantVerifier

// EpisodeDiagnosticsHTTPOptions controls the diagnostics-only internal HTTP
// surface. Mode is "off", "localhost", or "hosted". The zero value is off.
type EpisodeDiagnosticsHTTPOptions struct {
	Mode                 string
	Environment          episodediagnostics.Environment
	Service              EpisodeDiagnosticsService
	ProducerToken        string
	OperatorToken        string
	OperatorVerifier     EpisodeDiagnosticsOperatorVerifier
	AccountAuthorizer    EpisodeDiagnosticsAccountAuthorizer
	ParticipantVerifier  EpisodeDiagnosticsParticipantVerifier
	ServiceVerifier      EpisodeDiagnosticsServiceVerifier
	OperatorCapabilities map[string]struct{}
	// OperatorTenantIDs is the explicit scope for the separate localhost/CLI
	// operator credential path. Hosted credentials carry their scope in the
	// verified tenant_ids JWT claim instead.
	OperatorTenantIDs []string

	// Stream bounds are configurable so local proofs can use short deadlines;
	// production defaults remain bounded even when a caller omits them.
	StreamHeartbeatInterval time.Duration
	StreamDeadline          time.Duration
	StreamPollInterval      time.Duration
	StreamBatchSize         int
}

type episodeDiagnosticsOperatorSubjectContextKey struct{}

type diagnosticSnapshotWire struct {
	episodediagnostics.DiagnosticSnapshotV1
	FilterFingerprint string `json:"filterFingerprint"`
}

type diagnosticExportRequest struct {
	SchemaVersion string `json:"schemaVersion"`
	CursorTo      *int64 `json:"cursorTo,omitempty"`
}

func mountEpisodeDiagnosticsRoutes(r chi.Router, options Options) {
	cfg := options.EpisodeDiagnostics
	if !diagnosticsHTTPEnabled(cfg) {
		return
	}

	r.Post("/_internal/episode-diagnostic-events", episodeDiagnosticAppendHandler(cfg))
	mountEpisodeDiagnosticsReadRoutes(r, cfg, options.Authentication)
}

func mountEpisodeDiagnosticsReadRoutes(r chi.Router, options EpisodeDiagnosticsHTTPOptions, authenticationService AuthenticationService) {
	mount := func(router chi.Router) {
		router.Get("/_internal/episode-diagnostics/resolve/{alternateReference}", episodeDiagnosticAlternateReferenceHandler(options))
		// Keep the slash form explicit because chi's single path parameter does not
		// capture a second segment. The handler accepts both this form and the
		// compact class:value form above.
		router.Get("/_internal/episode-diagnostics/resolve/{alternateClass}/{alternateValue}", episodeDiagnosticAlternateReferenceHandler(options))
		router.Get("/_internal/episode-diagnostics/{reference}", episodeDiagnosticSnapshotHandler(options))
		router.Get("/_internal/episode-diagnostics/{reference}/snapshot", episodeDiagnosticSnapshotHandler(options))
		router.Get("/_internal/episode-diagnostics/{reference}/brief", episodeDiagnosticBriefHandler(options))
		router.Get("/_internal/episode-diagnostics/{reference}/events", episodeDiagnosticEventsHandler(options))
		router.Get("/_internal/episode-diagnostics/{reference}/operations", episodeDiagnosticOperationsHandler(options))
		for _, projection := range []string{"graph", "flame", "participants", "epilogue"} {
			router.Get("/_internal/episode-diagnostics/{reference}/"+projection, episodeDiagnosticProjectionHandler(options, projection))
		}
		router.Get("/_internal/episode-diagnostics/{reference}/stream", episodeDiagnosticStreamHandler(options))
		router.Post("/_internal/episode-diagnostics/{reference}/export-jobs", episodeDiagnosticCreateExportHandler(options))
		router.Get("/_internal/episode-diagnostics/{reference}/export-jobs/{jobID}", episodeDiagnosticExportStatusHandler(options))
		router.Delete("/_internal/episode-diagnostics/{reference}/export-jobs/{jobID}", episodeDiagnosticCancelExportHandler(options))
		router.Get("/_internal/episode-diagnostics/{reference}/export-jobs/{jobID}/download", episodeDiagnosticDownloadHandler(options))
	}
	if options.AccountAuthorizer == nil {
		mount(r)
		return
	}
	r.Group(func(group chi.Router) {
		group.Use(requireEpisodeDiagnosticsAccountAuthentication(options, authenticationService))
		mount(group)
	})
}

// requireEpisodeDiagnosticsAccountAuthentication keeps the normal Dashboard
// account boundary in front of AccountAuthorizer while leaving the dedicated
// localhost/hosted operator credentials on their separate path. A bearer
// credential is treated as an operator credential only after the dedicated
// verifier accepts it; otherwise the normal account authenticator gets the
// same request as every other Dashboard route.
func requireEpisodeDiagnosticsAccountAuthentication(options EpisodeDiagnosticsHTTPOptions, authenticationService AuthenticationService) func(http.Handler) http.Handler {
	accountAuthentication := func(next http.Handler) http.Handler {
		return rejectTenantAPIKeyCredential(requireAuthentication(authenticationService)(next))
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if principal, ok := authentication.PrincipalFromContext(r.Context()); ok {
				if principal.IsAuthenticated() {
					next.ServeHTTP(w, r)
					return
				}
			}

			if ctx, ok := episodeDiagnosticsOperatorCredentialContext(r, options); ok {
				next.ServeHTTP(w, r.WithContext(ctx))
				return
			}
			accountAuthentication(next).ServeHTTP(w, r)
		})
	}
}

func episodeDiagnosticsOperatorCredentialContext(r *http.Request, options EpisodeDiagnosticsHTTPOptions) (context.Context, bool) {
	// A Dashboard cookie is unambiguously an account request. Do not let an
	// unrelated Authorization header turn a failed account credential into an
	// operator request.
	if len(r.Cookies()) > 0 {
		return r.Context(), false
	}
	token, ok := bearerToken(r.Header.Get("Authorization"))
	if !ok {
		return r.Context(), false
	}
	if strings.EqualFold(strings.TrimSpace(options.Mode), "localhost") && staticDiagnosticTokenMatches(token, options.OperatorToken) {
		return r.Context(), true
	}
	if !strings.EqualFold(strings.TrimSpace(options.Mode), "hosted") || options.OperatorVerifier == nil {
		return r.Context(), false
	}
	subject, err := options.OperatorVerifier.Verify(r.Context(), token)
	if err != nil {
		return r.Context(), false
	}
	return context.WithValue(r.Context(), episodeDiagnosticsOperatorSubjectContextKey{}, subject), true
}

func episodeDiagnosticAlternateReferenceHandler(options EpisodeDiagnosticsHTTPOptions) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := validateDiagnosticsRequestOrigin(options, r); err != nil {
			writeEpisodeDiagnosticsError(w, err)
			return
		}
		operator, ok := authenticateDiagnosticOperatorToken(w, r, options, "read")
		if !ok {
			return
		}
		if options.Service == nil {
			writeEpisodeDiagnosticsError(w, episodediagnostics.ErrDisabled)
			return
		}
		idClass, value, err := diagnosticAlternateReferenceParts(r)
		if err != nil {
			writeEpisodeDiagnosticsError(w, err)
			return
		}
		reference, err := options.Service.AlternateReference(r.Context(), operator, idClass, value)
		if err != nil {
			writeEpisodeDiagnosticsError(w, err)
			return
		}
		formatted, err := episodediagnostics.FormatReference(reference)
		if err != nil {
			writeEpisodeDiagnosticsError(w, episodediagnostics.ErrNotFound)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"schemaVersion": "DiagnosticReference/v1", "reference": formatted})
	}
}

func diagnosticAlternateReferenceParts(r *http.Request) (string, string, error) {
	query := r.URL.Query()
	idClass := strings.TrimSpace(query.Get("id_class"))
	if idClass == "" {
		idClass = strings.TrimSpace(query.Get("class"))
	}
	value := strings.TrimSpace(query.Get("value"))
	if routeClass := strings.TrimSpace(chi.URLParam(r, "alternateClass")); routeClass != "" {
		if idClass == "" {
			idClass = routeClass
		}
	}
	if routeValue := strings.TrimSpace(chi.URLParam(r, "alternateValue")); routeValue != "" {
		if value == "" {
			value = routeValue
		}
	}
	raw := strings.TrimSpace(chi.URLParam(r, "alternateReference"))
	if unescaped, err := url.PathUnescape(raw); err == nil {
		raw = strings.TrimSpace(unescaped)
	} else {
		return "", "", episodediagnostics.ErrInvalidReference
	}
	if idClass == "" || value == "" {
		if separator := strings.IndexAny(raw, ":/"); separator > 0 {
			if idClass == "" {
				idClass = raw[:separator]
			}
			if value == "" {
				value = raw[separator+1:]
			}
		}
	}
	if !safeDiagnosticClass(idClass) || !episodediagnostics.SafeOpaqueID(value) {
		return "", "", episodediagnostics.ErrInvalidReference
	}
	return idClass, value, nil
}

func safeDiagnosticClass(value string) bool {
	if value == "" || len(value) > 64 {
		return false
	}
	previousDot := false
	for index, character := range value {
		if index == 0 && (character < 'a' || character > 'z') {
			return false
		}
		if character == '.' {
			if index == len(value)-1 || previousDot {
				return false
			}
			previousDot = true
			continue
		}
		if (character < 'a' || character > 'z') && (character < '0' || character > '9') && character != '_' && character != '-' {
			return false
		}
		previousDot = false
	}
	return true
}

func diagnosticsHTTPEnabled(options EpisodeDiagnosticsHTTPOptions) bool {
	mode := strings.ToLower(strings.TrimSpace(options.Mode))
	return mode == "localhost" || mode == "hosted"
}

func diagnosticEnvironment(options EpisodeDiagnosticsHTTPOptions) episodediagnostics.Environment {
	if options.Environment != "" {
		return options.Environment
	}
	if strings.EqualFold(strings.TrimSpace(options.Mode), "localhost") {
		return episodediagnostics.EnvironmentLocalhost
	}
	return episodediagnostics.EnvironmentDevelopment
}

func (options EpisodeDiagnosticsHTTPOptions) operatorCapabilities() map[string]struct{} {
	if len(options.OperatorCapabilities) > 0 {
		copy := make(map[string]struct{}, len(options.OperatorCapabilities))
		for key := range options.OperatorCapabilities {
			copy[key] = struct{}{}
		}
		return copy
	}
	return map[string]struct{}{"read": {}, "stream": {}, "export": {}}
}

func episodeDiagnosticAppendHandler(options EpisodeDiagnosticsHTTPOptions) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := validateDiagnosticsRequestOrigin(options, r); err != nil {
			writeEpisodeDiagnosticsError(w, err)
			return
		}
		var request episodediagnostics.AppendDiagnosticEventsRequest
		if err := decodeEpisodeDiagnosticsJSON(w, r, &request); err != nil {
			writeEpisodeDiagnosticsError(w, err)
			return
		}
		token, tokenOK := bearerToken(r.Header.Get("Authorization"))
		if !tokenOK {
			writeEpisodeDiagnosticsError(w, errDiagnosticProducerAuth)
			return
		}
		principal, err := authenticateDiagnosticProducer(r.Context(), options, token, request)
		if err != nil {
			writeEpisodeDiagnosticsError(w, err)
			return
		}
		if options.Service == nil {
			writeEpisodeDiagnosticsError(w, episodediagnostics.ErrDisabled)
			return
		}
		result, err := options.Service.Append(r.Context(), principal, request)
		if err != nil {
			writeEpisodeDiagnosticsError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, result)
	}
}

func episodeDiagnosticSnapshotHandler(options EpisodeDiagnosticsHTTPOptions) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		operator, reference, ok := authenticateDiagnosticOperator(w, r, options, "read")
		if !ok {
			return
		}
		if options.Service == nil {
			writeEpisodeDiagnosticsError(w, episodediagnostics.ErrDisabled)
			return
		}
		filter, err := diagnosticFilterFromRequest(r)
		if err != nil {
			writeEpisodeDiagnosticsError(w, err)
			return
		}
		reference, err = referenceWithCursor(reference, r.URL.Query().Get("cursor"), r.URL.Query().Get("at_cursor"))
		if err != nil {
			writeEpisodeDiagnosticsError(w, err)
			return
		}
		parsed, err := episodediagnostics.ParseReference(reference)
		if err != nil {
			writeEpisodeDiagnosticsError(w, episodediagnostics.ErrInvalidReference)
			return
		}
		if parsed.Focus != nil {
			resolved, resolveErr := options.Service.Resolve(r.Context(), operator, reference)
			if resolveErr != nil {
				writeEpisodeDiagnosticsError(w, resolveErr)
				return
			}
			// Resolve also returns focus metadata. Refresh its snapshot through the
			// filter-aware service path so the wire fingerprint never labels an
			// unfiltered snapshot as filtered.
			filteredSnapshot, snapshotErr := options.Service.Snapshot(r.Context(), operator, reference, filter)
			if snapshotErr != nil {
				writeEpisodeDiagnosticsError(w, snapshotErr)
				return
			}
			resolved.Snapshot = &filteredSnapshot
			if resolved.Snapshot == nil {
				writeEpisodeDiagnosticsError(w, episodediagnostics.ErrNotFound)
				return
			}
			body := map[string]any{
				"kind":      resolved.Kind,
				"reference": resolved.Reference,
				"snapshot":  snapshotWire(*resolved.Snapshot, filter),
			}
			if resolved.Operation != nil {
				body["operation"] = resolved.Operation
			}
			if resolved.Issue != nil {
				body["issue"] = resolved.Issue
			}
			if resolved.Event != nil {
				body["event"] = resolved.Event
			}
			writeJSON(w, http.StatusOK, body)
			return
		}
		snapshot, snapshotErr := options.Service.Snapshot(r.Context(), operator, reference, filter)
		if snapshotErr != nil {
			writeEpisodeDiagnosticsError(w, snapshotErr)
			return
		}
		writeJSON(w, http.StatusOK, snapshotWire(snapshot, filter))
	}
}

func episodeDiagnosticBriefHandler(options EpisodeDiagnosticsHTTPOptions) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		operator, reference, ok := authenticateDiagnosticOperator(w, r, options, "read")
		if !ok {
			return
		}
		if options.Service == nil {
			writeEpisodeDiagnosticsError(w, episodediagnostics.ErrDisabled)
			return
		}
		format := r.URL.Query().Get("format")
		if format == "" {
			format = "compact"
		}
		if format != "compact" && format != "markdown" {
			writeEpisodeDiagnosticsError(w, fmt.Errorf("invalid Agent Brief format"))
			return
		}
		cursor := r.URL.Query().Get("cursor")
		if cursor != "" {
			var err error
			reference, err = referenceWithCursor(reference, "", cursor)
			if err != nil {
				writeEpisodeDiagnosticsError(w, err)
				return
			}
		}
		aroundSeconds, branchID, err := diagnosticBriefOptions(r)
		if err != nil {
			writeEpisodeDiagnosticsError(w, err)
			return
		}
		brief, err := options.Service.Brief(r.Context(), operator, reference, format, aroundSeconds, branchID)
		if err != nil {
			writeEpisodeDiagnosticsError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, brief)
	}
}

func diagnosticBriefOptions(r *http.Request) (int64, string, error) {
	query := r.URL.Query()
	aroundValue := strings.TrimSpace(query.Get("around_seconds"))
	if aroundValue == "" {
		aroundValue = strings.TrimSpace(query.Get("around"))
	}
	aroundSeconds := int64(0)
	if aroundValue != "" {
		parsed, err := strconv.ParseInt(aroundValue, 10, 64)
		if err != nil || parsed < 0 || parsed > 3600 {
			return 0, "", errors.New("agent brief around window must be between 0 and 3600 seconds")
		}
		aroundSeconds = parsed
	}
	branchID := strings.TrimSpace(query.Get("branch_id"))
	if branchID == "" {
		branchID = strings.TrimSpace(query.Get("branch"))
	}
	if branchID != "" && !episodediagnostics.SafeOpaqueID(branchID) {
		return 0, "", errors.New("agent brief branch is invalid")
	}
	return aroundSeconds, branchID, nil
}

func episodeDiagnosticEventsHandler(options EpisodeDiagnosticsHTTPOptions) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		operator, reference, ok := authenticateDiagnosticOperator(w, r, options, "read")
		if !ok {
			return
		}
		if options.Service == nil {
			writeEpisodeDiagnosticsError(w, episodediagnostics.ErrDisabled)
			return
		}
		filter, err := diagnosticFilterFromRequest(r)
		if err != nil {
			writeEpisodeDiagnosticsError(w, err)
			return
		}
		after, err := optionalDiagnosticCursor(r.URL.Query().Get("after"))
		if err != nil {
			writeEpisodeDiagnosticsError(w, err)
			return
		}
		before, err := optionalDiagnosticCursor(r.URL.Query().Get("before"))
		if err != nil {
			writeEpisodeDiagnosticsError(w, err)
			return
		}
		limit, err := diagnosticPageLimit(r.URL.Query().Get("limit"), episodediagnostics.DefaultPageSize)
		if err != nil {
			writeEpisodeDiagnosticsError(w, err)
			return
		}
		page, err := options.Service.Events(r.Context(), operator, reference, filter, after, before, limit)
		if err != nil {
			writeEpisodeDiagnosticsError(w, err)
			return
		}
		page.SchemaVersion = "DiagnosticEventPage/v1"
		page.Reference = reference
		page.FilterFingerprint = episodediagnostics.FilterFingerprint(filter)
		page.AfterCursor = after
		page.BeforeCursor = before
		writeJSON(w, http.StatusOK, page)
	}
}

func episodeDiagnosticOperationsHandler(options EpisodeDiagnosticsHTTPOptions) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		operator, reference, ok := authenticateDiagnosticOperator(w, r, options, "read")
		if !ok {
			return
		}
		if options.Service == nil {
			writeEpisodeDiagnosticsError(w, episodediagnostics.ErrDisabled)
			return
		}
		filter, err := diagnosticFilterFromRequest(r)
		if err != nil {
			writeEpisodeDiagnosticsError(w, err)
			return
		}
		after, err := optionalDiagnosticCursor(r.URL.Query().Get("after"))
		if err != nil {
			writeEpisodeDiagnosticsError(w, err)
			return
		}
		limit, err := diagnosticPageLimit(r.URL.Query().Get("limit"), episodediagnostics.DefaultPageSize)
		if err != nil {
			writeEpisodeDiagnosticsError(w, err)
			return
		}
		page, err := options.Service.Operations(r.Context(), operator, reference, filter, after, limit)
		if err != nil {
			writeEpisodeDiagnosticsError(w, err)
			return
		}
		page.SchemaVersion = "DiagnosticOperationPage/v1"
		page.Reference = reference
		page.FilterFingerprint = episodediagnostics.FilterFingerprint(filter)
		writeJSON(w, http.StatusOK, page)
	}
}

func episodeDiagnosticProjectionHandler(options EpisodeDiagnosticsHTTPOptions, projection string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		operator, reference, ok := authenticateDiagnosticOperator(w, r, options, "read")
		if !ok {
			return
		}
		if options.Service == nil {
			writeEpisodeDiagnosticsError(w, episodediagnostics.ErrDisabled)
			return
		}
		filter, err := diagnosticFilterFromRequest(r)
		if err != nil {
			writeEpisodeDiagnosticsError(w, err)
			return
		}
		snapshot, err := options.Service.Snapshot(r.Context(), operator, reference, filter)
		if err != nil {
			writeEpisodeDiagnosticsError(w, err)
			return
		}
		body := map[string]any{
			"reference":         reference,
			"committedCursor":   snapshot.CommittedCursor,
			"projectedCursor":   snapshot.ProjectedCursor,
			"filterFingerprint": episodediagnostics.FilterFingerprint(filter),
		}
		switch projection {
		case "graph":
			if snapshot.Graph == nil {
				writeEpisodeDiagnosticsError(w, episodediagnostics.ErrNotFound)
				return
			}
			body[projection] = snapshot.Graph
		case "flame":
			if snapshot.Flame == nil {
				writeEpisodeDiagnosticsError(w, episodediagnostics.ErrNotFound)
				return
			}
			body[projection] = snapshot.Flame
		case "participants":
			body[projection] = snapshot.Participants
		case "epilogue":
			if snapshot.Epilogue == nil {
				writeEpisodeDiagnosticsError(w, episodediagnostics.ErrNotFound)
				return
			}
			body[projection] = snapshot.Epilogue
		default:
			writeEpisodeDiagnosticsError(w, episodediagnostics.ErrNotFound)
			return
		}
		writeJSON(w, http.StatusOK, body)
	}
}

func snapshotWire(snapshot episodediagnostics.DiagnosticSnapshotV1, filter episodediagnostics.DiagnosticFilterV1) diagnosticSnapshotWire {
	return snapshotWireWithFingerprint(snapshot, episodediagnostics.FilterFingerprint(filter))
}

func snapshotWireWithFingerprint(snapshot episodediagnostics.DiagnosticSnapshotV1, filterFingerprint string) diagnosticSnapshotWire {
	if snapshot.SchemaVersion == "" {
		snapshot.SchemaVersion = "DiagnosticSnapshot/v1"
	}
	return diagnosticSnapshotWire{DiagnosticSnapshotV1: snapshot, FilterFingerprint: filterFingerprint}
}

func decodeEpisodeDiagnosticsJSON(w http.ResponseWriter, r *http.Request, target any) error {
	r.Body = http.MaxBytesReader(w, r.Body, diagnosticMaxRequestBodyBytes)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("invalid diagnostic request body: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("invalid diagnostic request body: must contain one JSON value")
		}
		return fmt.Errorf("invalid diagnostic request body: %w", err)
	}
	return nil
}

func diagnosticFilterFromRequest(r *http.Request) (episodediagnostics.DiagnosticFilterV1, error) {
	filter := episodediagnostics.DiagnosticFilterV1{SchemaVersion: "DiagnosticFilter/v1"}
	raw := r.URL.Query().Get("filters")
	if raw == "" {
		return filter, nil
	}
	if len(raw) > diagnosticMaxFilterBytes {
		return filter, errors.New("invalid diagnostic filter: too large")
	}
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&filter); err != nil {
		return filter, fmt.Errorf("invalid diagnostic filter: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return filter, errors.New("invalid diagnostic filter")
	}
	if filter.SchemaVersion == "" {
		filter.SchemaVersion = "DiagnosticFilter/v1"
	}
	if err := episodediagnostics.ValidateFilter(filter); err != nil {
		return filter, err
	}
	return filter, nil
}

func optionalDiagnosticCursor(value string) (*int64, error) {
	if value == "" {
		return nil, nil
	}
	cursor, err := strconv.ParseInt(value, 10, 64)
	if err != nil || cursor < 0 || cursor > episodediagnostics.MaxCursor {
		return nil, errors.New("cursor must be a non-negative safe integer")
	}
	return &cursor, nil
}

func diagnosticPageLimit(value string, fallback int) (int, error) {
	if value == "" {
		return fallback, nil
	}
	limit, err := strconv.Atoi(value)
	if err != nil || limit < 1 || limit > episodediagnostics.MaxPageSize {
		return 0, errors.New("limit must be between 1 and 1000")
	}
	return limit, nil
}

func referenceWithCursor(reference, first, second string) (string, error) {
	if first != "" && second != "" && first != second {
		return "", errors.New("invalid diagnostic cursor: conflicting values")
	}
	value := first
	if value == "" {
		value = second
	}
	if value == "" {
		return reference, nil
	}
	cursor, err := optionalDiagnosticCursor(value)
	if err != nil {
		return "", err
	}
	parsed, err := episodediagnostics.ParseReference(reference)
	if err != nil {
		return "", episodediagnostics.ErrInvalidReference
	}
	parsed.Cursor = cursor
	return episodediagnostics.FormatReference(parsed)
}

func diagnosticReferenceFromRequest(r *http.Request) (string, error) {
	reference, err := url.PathUnescape(chi.URLParam(r, "reference"))
	if err != nil || reference == "" {
		return "", episodediagnostics.ErrInvalidReference
	}
	if _, err := episodediagnostics.ParseReference(reference); err != nil {
		return "", episodediagnostics.ErrInvalidReference
	}
	return reference, nil
}

func validateDiagnosticsRequestOrigin(options EpisodeDiagnosticsHTTPOptions, r *http.Request) error {
	if !strings.EqualFold(strings.TrimSpace(options.Mode), "localhost") {
		return nil
	}
	if !diagnosticRemoteIsLoopback(r.RemoteAddr) {
		return errDiagnosticOriginForbidden
	}
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" {
		// Browser fetches carry Fetch Metadata. The resolver CLI is a local
		// server-to-server client and intentionally has no Origin header, so
		// require an Origin whenever the request identifies itself as a browser.
		if r.Header.Get("Sec-Fetch-Site") != "" || r.Header.Get("Sec-Fetch-Mode") != "" {
			return errDiagnosticOriginForbidden
		}
		return nil
	}
	parsed, err := url.Parse(origin)
	if err != nil || parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Scheme != "http" && parsed.Scheme != "https") || !diagnosticHostIsLoopback(parsed.Hostname()) {
		return errDiagnosticOriginForbidden
	}
	return nil
}

func diagnosticRemoteIsLoopback(remote string) bool {
	if remote == "" {
		return false
	}
	host, _, err := net.SplitHostPort(remote)
	if err != nil {
		host = strings.Trim(remote, "[]")
	}
	address, err := netip.ParseAddr(host)
	return err == nil && address.IsLoopback()
}

func diagnosticHostIsLoopback(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	address, err := netip.ParseAddr(strings.Trim(host, "[]"))
	return err == nil && address.IsLoopback()
}

var (
	errDiagnosticOriginForbidden = errors.New("diagnostic origin is forbidden")
	errDiagnosticOperatorAuth    = errors.New("diagnostic operator authorization was denied")
	errDiagnosticProducerAuth    = errors.New("diagnostic producer authorization was denied")
)

func staticDiagnosticTokenMatches(candidate, expected string) bool {
	if candidate == "" || expected == "" {
		return false
	}
	expectedDigest := sha256.Sum256([]byte(expected))
	candidateDigest := sha256.Sum256([]byte(candidate))
	return hmac.Equal(expectedDigest[:], candidateDigest[:])
}

func authenticateDiagnosticOperator(w http.ResponseWriter, r *http.Request, options EpisodeDiagnosticsHTTPOptions, capability string) (episodediagnostics.OperatorPrincipal, string, bool) {
	if err := validateDiagnosticsRequestOrigin(options, r); err != nil {
		writeEpisodeDiagnosticsError(w, err)
		return episodediagnostics.OperatorPrincipal{}, "", false
	}
	reference, err := diagnosticReferenceFromRequest(r)
	if err != nil {
		writeEpisodeDiagnosticsError(w, err)
		return episodediagnostics.OperatorPrincipal{}, "", false
	}
	principal, ok := authenticateDiagnosticOperatorToken(w, r, options, capability)
	if !ok {
		return episodediagnostics.OperatorPrincipal{}, "", false
	}
	return principal, reference, true
}

func authenticateDiagnosticOperatorToken(w http.ResponseWriter, r *http.Request, options EpisodeDiagnosticsHTTPOptions, capability string) (episodediagnostics.OperatorPrincipal, bool) {
	var principal episodediagnostics.OperatorPrincipal
	accountPrincipal, hasAccountPrincipal := authentication.PrincipalFromContext(r.Context())
	if options.AccountAuthorizer != nil && hasAccountPrincipal {
		if accountPrincipal.Kind != authentication.PrincipalUser {
			writeEpisodeDiagnosticsError(w, errDiagnosticOperatorAuth)
			return episodediagnostics.OperatorPrincipal{}, false
		}
		scope, authorizeErr := options.AccountAuthorizer.AuthorizeEpisodeDiagnosticsAccount(r.Context(), accountPrincipal)
		if authorizeErr != nil {
			switch {
			case errors.Is(authorizeErr, authorization.ErrForbidden), errors.Is(authorizeErr, episodediagnostics.ErrForbidden):
				writeEpisodeDiagnosticsError(w, episodediagnostics.ErrForbidden)
			case errors.Is(authorizeErr, authorization.ErrUnauthenticated), errors.Is(authorizeErr, episodediagnostics.ErrUnauthenticated):
				writeEpisodeDiagnosticsError(w, errDiagnosticOperatorAuth)
			default:
				writeEpisodeDiagnosticsError(w, authorizeErr)
			}
			return episodediagnostics.OperatorPrincipal{}, false
		}
		if scope.SubjectHash == "" || len(scope.AuthorizedTenantIDs) == 0 {
			writeEpisodeDiagnosticsError(w, episodediagnostics.ErrForbidden)
			return episodediagnostics.OperatorPrincipal{}, false
		}
		principal = episodediagnostics.OperatorPrincipal{
			SubjectHash:         scope.SubjectHash,
			Environment:         diagnosticEnvironment(options),
			Capabilities:        cloneDiagnosticCapabilities(scope.Capabilities),
			AuthorizedTenantIDs: cloneDiagnosticTenantIDs(scope.AuthorizedTenantIDs),
			TenantScopeRequired: true,
		}
	} else {
		token, ok := bearerToken(r.Header.Get("Authorization"))
		if !ok {
			writeEpisodeDiagnosticsError(w, errDiagnosticOperatorAuth)
			return episodediagnostics.OperatorPrincipal{}, false
		}
		if subject, verified := r.Context().Value(episodeDiagnosticsOperatorSubjectContextKey{}).(accessgrants.DiagnosticsOperatorSubject); verified {
			principal = episodediagnostics.OperatorPrincipal{
				SubjectHash:         subject.SubjectHash,
				Environment:         episodicEnvironment(subject.Environment),
				Capabilities:        cloneDiagnosticCapabilities(subject.Capabilities),
				AuthorizedTenantIDs: cloneDiagnosticTenantIDs(subject.AuthorizedTenantIDs),
				TenantScopeRequired: true,
			}
		} else if strings.EqualFold(strings.TrimSpace(options.Mode), "hosted") {
			if options.OperatorVerifier == nil {
				writeEpisodeDiagnosticsError(w, errDiagnosticOperatorAuth)
				return episodediagnostics.OperatorPrincipal{}, false
			}
			subject, verifyErr := options.OperatorVerifier.Verify(r.Context(), token)
			if verifyErr != nil || subject.SubjectHash == "" || episodicEnvironment(subject.Environment) != diagnosticEnvironment(options) || len(subject.AuthorizedTenantIDs) == 0 {
				writeEpisodeDiagnosticsError(w, errDiagnosticOperatorAuth)
				return episodediagnostics.OperatorPrincipal{}, false
			}
			principal = episodediagnostics.OperatorPrincipal{
				SubjectHash:         subject.SubjectHash,
				Environment:         episodicEnvironment(subject.Environment),
				Capabilities:        cloneDiagnosticCapabilities(subject.Capabilities),
				AuthorizedTenantIDs: cloneDiagnosticTenantIDs(subject.AuthorizedTenantIDs),
				TenantScopeRequired: true,
			}
		} else if !staticDiagnosticTokenMatches(token, options.OperatorToken) {
			writeEpisodeDiagnosticsError(w, errDiagnosticOperatorAuth)
			return episodediagnostics.OperatorPrincipal{}, false
		} else {
			principal = episodediagnostics.OperatorPrincipal{
				SubjectHash:         diagnosticTokenHash(token),
				Environment:         diagnosticEnvironment(options),
				Capabilities:        options.operatorCapabilities(),
				AuthorizedTenantIDs: cloneDiagnosticTenantIDs(options.OperatorTenantIDs),
				TenantScopeRequired: len(options.OperatorTenantIDs) > 0,
			}
		}
	}
	if _, allowed := principal.Capabilities[capability]; !allowed {
		if options.AccountAuthorizer != nil && hasAccountPrincipal {
			writeEpisodeDiagnosticsError(w, episodediagnostics.ErrForbidden)
		} else {
			writeEpisodeDiagnosticsError(w, errDiagnosticOperatorAuth)
		}
		return episodediagnostics.OperatorPrincipal{}, false
	}
	return principal, true
}

func authenticateDiagnosticProducer(ctx context.Context, options EpisodeDiagnosticsHTTPOptions, token string, request episodediagnostics.AppendDiagnosticEventsRequest) (episodediagnostics.ProducerPrincipal, error) {
	environment := diagnosticEnvironment(options)
	if options.Mode == "localhost" && staticDiagnosticTokenMatches(token, options.ProducerToken) {
		if request.Producer.ID != string(episodediagnostics.SourceSync) || !diagnosticEventsUseSource(request, episodediagnostics.SourceSync) {
			return episodediagnostics.ProducerPrincipal{}, episodediagnostics.ErrForbidden
		}
		return episodediagnostics.ProducerPrincipal{
			Kind:           episodediagnostics.ProducerService,
			ID:             string(episodediagnostics.SourceSync),
			InstanceID:     request.Producer.InstanceID,
			Generation:     request.Producer.Generation,
			Environment:    environment,
			AllowedSources: diagnosticServiceSources(),
		}, nil
	}
	if options.ServiceVerifier != nil {
		subject, verifyErr := options.ServiceVerifier.Verify(ctx, token)
		if verifyErr == nil {
			source, sourceOK := diagnosticServiceSource(string(subject.Source))
			if !sourceOK || subject.Capability != accessgrants.DiagnosticsServiceCapabilityAppend || subject.Environment != string(environment) || subject.Service == "" || subject.InstanceID == "" || subject.Generation <= 0 || source == episodediagnostics.SourceSync && subject.Service != string(episodediagnostics.SourceSync) || request.Producer.ID != string(source) || request.Producer.InstanceID != subject.InstanceID || request.Producer.Generation != subject.Generation || !diagnosticEventsUseSource(request, source) {
				return episodediagnostics.ProducerPrincipal{}, episodediagnostics.ErrForbidden
			}
			return episodediagnostics.ProducerPrincipal{Kind: episodediagnostics.ProducerService, ID: string(source), ServiceID: subject.Service, InstanceID: subject.InstanceID, Generation: subject.Generation, Environment: environment, AllowedSources: map[episodediagnostics.EventSource]struct{}{source: {}}}, nil
		}
	}
	if options.ParticipantVerifier == nil {
		return episodediagnostics.ProducerPrincipal{}, errDiagnosticProducerAuth
	}
	subject, err := options.ParticipantVerifier.Verify(ctx, token)
	if err != nil || subject.Capability != accessgrants.DiagnosticsCapability || episodicEnvironment(subject.Environment) != environment {
		return episodediagnostics.ProducerPrincipal{}, errDiagnosticProducerAuth
	}
	source, sourceOK := diagnosticParticipantSource(request.Producer.ID)
	if !sourceOK || request.Producer.Generation != subject.ParticipantGeneration || !diagnosticEventsUseSource(request, source) {
		return episodediagnostics.ProducerPrincipal{}, episodediagnostics.ErrForbidden
	}
	return episodediagnostics.ProducerPrincipal{
		Kind:                  episodediagnostics.ProducerParticipant,
		ID:                    request.Producer.ID,
		InstanceID:            request.Producer.InstanceID,
		Generation:            request.Producer.Generation,
		Environment:           environment,
		TenantID:              subject.TenantID,
		SpaceID:               subject.SpaceID,
		EpisodeID:             subject.EpisodeID,
		ParticipantID:         subject.ParticipantID,
		ParticipantGeneration: subject.ParticipantGeneration,
		AllowedSources:        map[episodediagnostics.EventSource]struct{}{source: {}},
	}, nil
}

func diagnosticServiceSource(source string) (episodediagnostics.EventSource, bool) {
	parsed := episodediagnostics.EventSource(source)
	switch parsed {
	case episodediagnostics.SourceAPI, episodediagnostics.SourceProvider, episodediagnostics.SourceWorker, episodediagnostics.SourceSync:
		return parsed, true
	default:
		return "", false
	}
}

func diagnosticEventsUseSource(request episodediagnostics.AppendDiagnosticEventsRequest, source episodediagnostics.EventSource) bool {
	for _, event := range request.Events {
		if event.Source != source {
			return false
		}
	}
	return len(request.Events) > 0
}

func diagnosticParticipantSource(id string) (episodediagnostics.EventSource, bool) {
	source := episodediagnostics.EventSource(id)
	switch source {
	case episodediagnostics.SourceUI, episodediagnostics.SourceSDK, episodediagnostics.SourceRTC:
		return source, true
	default:
		return "", false
	}
}

func episodicEnvironment(environment string) episodediagnostics.Environment {
	return episodediagnostics.Environment(environment)
}

func diagnosticServiceSources() map[episodediagnostics.EventSource]struct{} {
	return map[episodediagnostics.EventSource]struct{}{
		episodediagnostics.SourceSync: {},
	}
}

func cloneDiagnosticCapabilities(capabilities map[string]struct{}) map[string]struct{} {
	copy := make(map[string]struct{}, len(capabilities))
	for capability := range capabilities {
		switch capability {
		case "read", "stream", "export":
			copy[capability] = struct{}{}
		}
	}
	return copy
}

func cloneDiagnosticTenantIDs(tenantIDs []string) []string {
	if len(tenantIDs) == 0 {
		return nil
	}
	return append([]string(nil), tenantIDs...)
}

func diagnosticTokenHash(token string) string {
	digest := sha256.Sum256([]byte(token))
	return fmt.Sprintf("%x", digest[:])
}

func writeEpisodeDiagnosticsError(w http.ResponseWriter, err error) {
	status, code, message := episodeDiagnosticsError(err)
	if status == http.StatusUnauthorized {
		w.Header().Set("WWW-Authenticate", `Bearer realm="chalk-episode-diagnostics"`)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"code":    code,
		"message": message,
		"error":   map[string]string{"code": code, "message": message},
	})
}

func episodeDiagnosticsError(err error) (int, string, string) {
	var syntaxError *json.SyntaxError
	switch {
	case err == nil:
		return http.StatusInternalServerError, "diagnostic.internal", "Episode Diagnostics request failed"
	case errors.Is(err, errDiagnosticOriginForbidden):
		return http.StatusForbidden, "diagnostic.origin_forbidden", "Episode Diagnostics is restricted to the configured origin"
	case errors.Is(err, errDiagnosticOperatorAuth), errors.Is(err, errDiagnosticProducerAuth), errors.Is(err, episodediagnostics.ErrUnauthenticated):
		return http.StatusUnauthorized, "diagnostic.unauthorized", "Episode Diagnostics authorization was denied"
	case errors.Is(err, episodediagnostics.ErrForbidden):
		return http.StatusForbidden, "diagnostic.forbidden", "Episode Diagnostics authorization was denied"
	case errors.Is(err, episodediagnostics.ErrDiagnosticEnvironmentMismatch):
		return http.StatusForbidden, "diagnostic.environment_forbidden", "Episode Diagnostics authorization was denied"
	case errors.Is(err, episodediagnostics.ErrDiagnosticExpired):
		return http.StatusNotFound, "diagnostic.expired", "Episode Diagnostic was not found"
	case errors.Is(err, episodediagnostics.ErrDiagnosticIntakeClosed):
		return http.StatusGone, "diagnostic.intake_closed", "Episode Diagnostic intake is closed"
	case errors.Is(err, episodediagnostics.ErrNotFound), errors.Is(err, episodediagnostics.ErrExportNotFound):
		return http.StatusNotFound, "diagnostic.not_found", "Episode Diagnostic was not found"
	case errors.Is(err, episodediagnostics.ErrInvalidReference):
		return http.StatusBadRequest, "diagnostic.invalid_reference", "Diagnostic Reference is invalid"
	case errors.Is(err, episodediagnostics.ErrInvalidScope):
		return http.StatusBadRequest, "diagnostic.invalid_scope", "Diagnostic scope is invalid"
	case errors.Is(err, episodediagnostics.ErrConflict):
		return http.StatusConflict, "diagnostic.conflict", "Diagnostic Event conflicts with a retained Event"
	case errors.Is(err, episodediagnostics.ErrCapacity), errors.Is(err, episodediagnostics.ErrExportQuota):
		return http.StatusTooManyRequests, "diagnostic.capacity", "Episode Diagnostics capacity is temporarily exhausted"
	case errors.Is(err, episodediagnostics.ErrExportNotReady):
		return http.StatusConflict, "diagnostic.export_not_ready", "Diagnostic export is not ready"
	case errors.Is(err, episodediagnostics.ErrDisabled):
		return http.StatusServiceUnavailable, "diagnostic.disabled", "Episode Diagnostics is unavailable"
	case errors.Is(err, episodediagnostics.ErrAuditUnavailable):
		return http.StatusServiceUnavailable, "diagnostic.audit_unavailable", "Episode Diagnostics access audit is unavailable"
	case errors.As(err, &syntaxError), errors.Is(err, io.ErrUnexpectedEOF):
		return http.StatusBadRequest, "diagnostic.invalid_request", "Diagnostic request is invalid"
	default:
		var validation *episodediagnostics.ValidationError
		if errors.As(err, &validation) {
			return http.StatusBadRequest, "diagnostic.invalid_request", "Diagnostic request is invalid"
		}
		if strings.Contains(strings.ToLower(err.Error()), "invalid") || strings.Contains(strings.ToLower(err.Error()), "required") || strings.Contains(strings.ToLower(err.Error()), "must be") {
			return http.StatusBadRequest, "diagnostic.invalid_request", "Diagnostic request is invalid"
		}
		if errors.Is(err, errDiagnosticOriginForbidden) {
			return http.StatusForbidden, "diagnostic.origin_forbidden", "Episode Diagnostics is restricted to the configured origin"
		}
		return http.StatusServiceUnavailable, "diagnostic.unavailable", "Episode Diagnostics is temporarily unavailable"
	}
}
