package httpapi

import (
	"context"
	"net/http"
	"regexp"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/diagnosticuploads"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type DiagnosticUploadService interface {
	Issue(context.Context, accessgrants.Subject, diagnosticuploads.IssueInput) (diagnosticuploads.Issued, error)
	Complete(context.Context, accessgrants.Subject, utilities.ID, diagnosticuploads.CompleteInput) (diagnosticuploads.Completed, error)
}

var (
	apiErrorDiagnosticUploadID             = APIError{Status: http.StatusBadRequest, Code: "diagnostic_uploads.invalid_id", Message: "Invalid diagnostic upload id"}
	apiErrorDiagnosticUploadRequestExpired = APIError{Status: http.StatusConflict, Code: "diagnostic_uploads.request_expired", Message: "The live request expired"}
	apiErrorDiagnosticUploadNotFound       = APIError{Status: http.StatusNotFound, Code: "diagnostic_uploads.not_found", Message: "Diagnostic upload not found"}
	apiErrorDiagnosticUploadTargetMissing  = APIError{Status: http.StatusNotFound, Code: "diagnostic_uploads.target_not_found", Message: "The report or live request was not found"}
	apiErrorDiagnosticUploadConflict       = APIError{Status: http.StatusConflict, Code: "diagnostic_uploads.conflict", Message: "Diagnostic upload cannot be completed"}
	apiErrorDiagnosticUploadStorage        = APIError{Status: http.StatusServiceUnavailable, Code: "diagnostic_uploads.storage_unavailable", Message: "Diagnostic upload storage is unavailable"}
)

type diagnosticUploadIssueBody struct {
	Trigger       string `json:"trigger"`
	ReportID      string `json:"report_id,omitempty"`
	LiveRequestID string `json:"live_request_id,omitempty"`
}

type diagnosticUploadCompleteRequest struct {
	UploadID utilities.ID
	Bytes    int64
	SHA256   string
}

type diagnosticUploadCompleteBody struct {
	Bytes  int64  `json:"bytes"`
	SHA256 string `json:"sha256,omitempty"`
}

type diagnosticUploadIssued struct {
	UploadID  string              `json:"upload_id"`
	URL       string              `json:"url"`
	Headers   map[string][]string `json:"headers"`
	ExpiresAt string              `json:"expires_at"`
}

type diagnosticUploadStored struct {
	Stored bool `json:"stored"`
}

// A bundle is at most 4 MiB; the bodies need only a few small fields.
const diagnosticUploadBodyLimitBytes = 4096

var diagnosticUploadSHA256 = regexp.MustCompile(`^[0-9a-fA-F]{64}$`)

func diagnosticUploadEndpoints(service DiagnosticUploadService, verifier ParticipantMediaVerifier) []RouteEndpoint {
	auth := requireParticipantMediaTenant(verifier)
	issue := Post("/v1/tenants/{tenant_id}/diagnostic-uploads", "issueDiagnosticUpload",
		func(r *http.Request) (diagnosticUploadIssueBody, error) {
			return decodeJSONBodyWithLimit[diagnosticUploadIssueBody](r, diagnosticUploadBodyLimitBytes)
		},
		func(ctx context.Context, body diagnosticUploadIssueBody) (diagnosticUploadIssued, error) {
			subject, ok := accessgrants.SubjectFromContext(ctx)
			if !ok {
				return diagnosticUploadIssued{}, apiErrorUnauthenticated
			}
			input, err := diagnosticUploadIssueInput(body)
			if err != nil {
				return diagnosticUploadIssued{}, err
			}
			issued, err := service.Issue(ctx, subject, input)
			if err != nil {
				return diagnosticUploadIssued{}, err
			}
			return diagnosticUploadIssued{
				UploadID:  issued.UploadID.String(),
				URL:       issued.URL,
				Headers:   issued.Headers,
				ExpiresAt: utilities.FormatTimestamp(issued.ExpiresAt),
			}, nil
		},
	).Auth(APIAuthParticipantMedia).
		Parameters(tenantIDParameter()).
		Needs(service).
		Middleware(auth).
		RateLimit(authenticatedWriteRateLimit).
		RequestBodyWithLimit("DiagnosticUploadIssueRequest", diagnosticUploadIssueBody{}, diagnosticUploadBodyLimitBytes).
		Responds(http.StatusOK, "DiagnosticUploadIssued", diagnosticUploadIssued{}).
		Errors(apiErrorInvalidTenantID, apiErrorUnauthenticated, apiErrorForbidden, apiErrorInvalidRequest, apiErrorPayloadTooLarge, apiErrorRateLimited, apiErrorServiceUnavailable,
			apiErrorDiagnosticUploadRequestExpired, apiErrorDiagnosticUploadTargetMissing, apiErrorDiagnosticUploadConflict, apiErrorDiagnosticUploadStorage, apiErrorInternal).
		ErrorRules(errorRules{
			ruleFor(apiErrorInvalidRequest, diagnosticuploads.ErrInvalidInput),
			ruleFor(apiErrorDiagnosticUploadRequestExpired, diagnosticuploads.ErrRequestExpired),
			ruleFor(apiErrorDiagnosticUploadTargetMissing, diagnosticuploads.ErrTargetMissing),
			ruleFor(apiErrorDiagnosticUploadConflict, diagnosticuploads.ErrUploadExists, diagnosticuploads.ErrNotIssued, diagnosticuploads.ErrSizeMismatch, diagnosticuploads.ErrObjectMissing),
			ruleFor(apiErrorDiagnosticUploadStorage, diagnosticuploads.ErrStorage),
		})
	complete := Post("/v1/tenants/{tenant_id}/diagnostic-uploads/{upload_id}/complete", "completeDiagnosticUpload",
		func(r *http.Request) (diagnosticUploadCompleteRequest, error) {
			uploadID, err := routeID(r, "upload_id", apiErrorDiagnosticUploadID)
			if err != nil {
				return diagnosticUploadCompleteRequest{}, err
			}
			body, err := decodeJSONBodyWithLimit[diagnosticUploadCompleteBody](r, diagnosticUploadBodyLimitBytes)
			if err != nil {
				return diagnosticUploadCompleteRequest{}, err
			}
			if body.Bytes < 0 || (body.SHA256 != "" && !diagnosticUploadSHA256.MatchString(body.SHA256)) {
				return diagnosticUploadCompleteRequest{}, apiErrorInvalidRequest
			}
			return diagnosticUploadCompleteRequest{UploadID: uploadID, Bytes: body.Bytes, SHA256: body.SHA256}, nil
		},
		func(ctx context.Context, request diagnosticUploadCompleteRequest) (diagnosticUploadStored, error) {
			subject, ok := accessgrants.SubjectFromContext(ctx)
			if !ok {
				return diagnosticUploadStored{}, apiErrorUnauthenticated
			}
			if _, err := service.Complete(ctx, subject, request.UploadID, diagnosticuploads.CompleteInput{Bytes: request.Bytes, SHA256: request.SHA256}); err != nil {
				return diagnosticUploadStored{}, err
			}
			return diagnosticUploadStored{Stored: true}, nil
		},
	).Auth(APIAuthParticipantMedia).
		Parameters(tenantIDParameter(), diagnosticUploadIDParameter()).
		Needs(service).
		Middleware(auth).
		RateLimit(authenticatedWriteRateLimit).
		RequestBodyWithLimit("DiagnosticUploadCompleteRequest", diagnosticUploadCompleteBody{}, diagnosticUploadBodyLimitBytes).
		Responds(http.StatusOK, "DiagnosticUploadStored", diagnosticUploadStored{}).
		Errors(apiErrorInvalidTenantID, apiErrorDiagnosticUploadID, apiErrorUnauthenticated, apiErrorForbidden, apiErrorInvalidRequest, apiErrorPayloadTooLarge, apiErrorRateLimited, apiErrorServiceUnavailable,
			apiErrorDiagnosticUploadNotFound, apiErrorDiagnosticUploadRequestExpired, apiErrorDiagnosticUploadConflict, apiErrorDiagnosticUploadStorage, apiErrorInternal).
		ErrorRules(errorRules{
			ruleFor(apiErrorInvalidRequest, diagnosticuploads.ErrInvalidInput),
			ruleFor(apiErrorDiagnosticUploadNotFound, diagnosticuploads.ErrUploadMissing),
			ruleFor(apiErrorDiagnosticUploadRequestExpired, diagnosticuploads.ErrRequestExpired),
			ruleFor(apiErrorDiagnosticUploadConflict, diagnosticuploads.ErrUploadExists, diagnosticuploads.ErrNotIssued, diagnosticuploads.ErrSizeMismatch, diagnosticuploads.ErrObjectMissing),
			ruleFor(apiErrorDiagnosticUploadStorage, diagnosticuploads.ErrStorage),
		})
	return []RouteEndpoint{issue, complete}
}

func diagnosticUploadIDParameter() APIParameterContract {
	return APIParameterContract{Name: "upload_id", In: "path", Type: "string", Required: true}
}

func diagnosticUploadIssueInput(body diagnosticUploadIssueBody) (diagnosticuploads.IssueInput, error) {
	var input diagnosticuploads.IssueInput
	switch body.Trigger {
	case diagnosticuploads.TriggerReport, diagnosticuploads.TriggerLive:
		input.Trigger = body.Trigger
	default:
		return input, apiErrorInvalidRequest
	}
	var err error
	if body.ReportID != "" {
		if input.ReportID, err = utilities.ParseID(body.ReportID); err != nil {
			return input, apiErrorInvalidRequest
		}
	}
	if body.LiveRequestID != "" {
		if input.LiveRequestID, err = utilities.ParseID(body.LiveRequestID); err != nil {
			return input, apiErrorInvalidRequest
		}
	}
	return input, nil
}

// requireParticipantMediaTenant is the same participant-media-credential check
// the problem-report route uses, without the report outcome bookkeeping.
func requireParticipantMediaTenant(verifier ParticipantMediaVerifier) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if verifier == nil {
				writeServiceUnavailable(w)
				return
			}
			credential, ok := bearerToken(r.Header.Get("Authorization"))
			if !ok {
				writeUnauthenticated(w)
				return
			}
			subject, err := verifier.Verify(r.Context(), credential)
			if err != nil {
				if isParticipantMediaCredentialRejection(err) {
					writeUnauthenticated(w)
					return
				}
				writeServiceUnavailable(w)
				return
			}
			tenantID, err := tenantIDRequest(r)
			if err != nil {
				writeAPIError(w, apiErrorInvalidTenantID)
				return
			}
			if tenantID != subject.TenantID {
				writeAPIError(w, apiErrorForbidden)
				return
			}
			ctx := accessgrants.WithSubject(r.Context(), subject)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}
