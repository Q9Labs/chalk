package httpapi

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/presenting"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	apiErrorPresentingInvalid          = APIError{Status: http.StatusBadRequest, Code: "presenting.invalid_request", Message: "Invalid presenting request"}
	apiErrorPresentingUnsupported      = APIError{Status: http.StatusUnprocessableEntity, Code: "presenting.unsupported_type", Message: "This file type cannot be presented"}
	apiErrorPresentingDocumentMissing  = APIError{Status: http.StatusNotFound, Code: "presenting.document_not_found", Message: "Presented document not found"}
	apiErrorPresentingPageMissing      = APIError{Status: http.StatusNotFound, Code: "presenting.page_not_found", Message: "Presented document page not found"}
	apiErrorPresentingDocumentNotReady = APIError{Status: http.StatusConflict, Code: "presenting.document_not_ready", Message: "Presented document is not ready"}
	apiErrorPresentingZoomNotReady     = APIError{Status: http.StatusConflict, Code: "presenting.zoom_not_ready", Message: "Zoom render is still preparing"}
	apiErrorPresentingRenderer         = APIError{Status: http.StatusServiceUnavailable, Code: "presenting.renderer_unavailable", Message: "Document renderer unavailable"}
)

type PresentingService interface {
	Create(context.Context, presenting.Subject, utilities.ID) (presenting.Document, error)
	Manifest(context.Context, presenting.Subject, utilities.ID) (presenting.Document, []presenting.Page, error)
	Zoom(context.Context, presenting.Subject, utilities.ID, int) (string, time.Time, error)
	ClaimRender(context.Context, utilities.ID) (presenting.ControlAssignment, bool, error)
	HeartbeatRender(context.Context, presenting.RenderLease) error
	CompleteInventory(context.Context, presenting.InventoryReport) error
	MarkPageReady(context.Context, presenting.RenderLease, int) error
	CompleteRender(context.Context, presenting.RenderLease) error
	FailRender(context.Context, presenting.RenderLease, presenting.RenderFailure) error
	CompleteZoomRender(context.Context, presenting.RenderLease) error
}

type presentingSubjectContextKey struct{}

type createPresentingDocumentBody struct {
	AttachmentID string `json:"attachmentId"`
}
type createPresentingDocumentRequest struct{ Body createPresentingDocumentBody }
type presentingDocumentRequest struct{ DocumentID utilities.ID }
type presentingZoomRequest struct {
	DocumentID utilities.ID
	Page       int
}

type createPresentingDocumentResponse struct {
	DocumentID string `json:"documentId"`
	Status     string `json:"status"`
}

type presentingFailureResponse struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}
type presentingPageResponse struct {
	Page         int    `json:"page"`
	Width        int    `json:"width"`
	Height       int    `json:"height"`
	Status       string `json:"status"`
	ImageURL     string `json:"imageUrl,omitempty"`
	ThumbnailURL string `json:"thumbnailUrl,omitempty"`
}
type presentingManifestResponse struct {
	DocumentID   string                     `json:"documentId"`
	AttachmentID string                     `json:"attachmentId"`
	FileName     string                     `json:"fileName"`
	Status       string                     `json:"status"`
	Failure      *presentingFailureResponse `json:"failure,omitempty"`
	PageCount    int                        `json:"pageCount,omitempty"`
	Pages        []presentingPageResponse   `json:"pages"`
}
type presentingZoomResponse struct {
	ImageURL  string `json:"imageUrl"`
	ExpiresAt string `json:"expiresAt"`
}

func presentingEndpoints(service PresentingService, verifier ChatParticipantVerifier, enabled func(context.Context) bool) []RouteEndpoint {
	auth := requireSyncParticipant(verifier, presentingSubjectContextKey{})
	feature := requirePresentingEnabled(enabled)
	return []RouteEndpoint{
		createPresentingDocumentEndpoint(service).Middleware(auth, feature),
		getPresentingDocumentEndpoint(service).Middleware(auth, feature),
		getPresentingZoomEndpoint(service).Middleware(auth, feature),
	}
}

func requirePresentingEnabled(enabled func(context.Context) bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if enabled != nil && !enabled(r.Context()) {
				writeError(w, http.StatusForbidden, "presenting.disabled", "Presenting is disabled")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func createPresentingDocumentEndpoint(service PresentingService) Endpoint[createPresentingDocumentRequest, createPresentingDocumentResponse] {
	return Post("/v1/presenting/documents", "createPresentingDocument", decodeCreatePresentingDocumentRequest,
		func(ctx context.Context, request createPresentingDocumentRequest) (createPresentingDocumentResponse, error) {
			subject, ok := presentingSubject(ctx)
			if !ok {
				return createPresentingDocumentResponse{}, apiErrorUnauthenticated
			}
			attachmentID, err := utilities.ParseID(request.Body.AttachmentID)
			if err != nil {
				return createPresentingDocumentResponse{}, apiErrorPresentingInvalid
			}
			document, err := service.Create(ctx, subject, attachmentID)
			if err != nil {
				return createPresentingDocumentResponse{}, err
			}
			return createPresentingDocumentResponse{DocumentID: document.DocumentID.String(), Status: document.Status}, nil
		}).
		Needs(service).Auth(APIAuthParticipantSync).RateLimit(authenticatedWriteRateLimit).
		RequestBody("CreatePresentingDocumentRequest", createPresentingDocumentBody{}).
		Responds(http.StatusOK, "PresentingDocumentCreated", createPresentingDocumentResponse{}).
		Errors(presentingErrors()...).ErrorRules(presentingRules)
}

func getPresentingDocumentEndpoint(service PresentingService) Endpoint[presentingDocumentRequest, presentingManifestResponse] {
	return Get("/v1/presenting/documents/{documentId}", "getPresentingDocument", decodePresentingDocumentRequest,
		func(ctx context.Context, request presentingDocumentRequest) (presentingManifestResponse, error) {
			subject, ok := presentingSubject(ctx)
			if !ok {
				return presentingManifestResponse{}, apiErrorUnauthenticated
			}
			document, pages, err := service.Manifest(ctx, subject, request.DocumentID)
			if err != nil {
				return presentingManifestResponse{}, err
			}
			return presentingManifest(document, pages), nil
		}).
		Needs(service).Auth(APIAuthParticipantSync).
		Parameters(presentingDocumentIDParameter()).
		Responds(http.StatusOK, "PresentingDocumentManifest", presentingManifestResponse{}).
		Errors(presentingErrors()...).ErrorRules(presentingRules)
}

func getPresentingZoomEndpoint(service PresentingService) Endpoint[presentingZoomRequest, presentingZoomResponse] {
	return Get("/v1/presenting/documents/{documentId}/pages/{page}/zoom", "getPresentingDocumentPageZoom", decodePresentingZoomRequest,
		func(ctx context.Context, request presentingZoomRequest) (presentingZoomResponse, error) {
			subject, ok := presentingSubject(ctx)
			if !ok {
				return presentingZoomResponse{}, apiErrorUnauthenticated
			}
			url, expiresAt, err := service.Zoom(ctx, subject, request.DocumentID, request.Page)
			if err != nil {
				return presentingZoomResponse{}, err
			}
			return presentingZoomResponse{ImageURL: url, ExpiresAt: expiresAt.UTC().Format(time.RFC3339)}, nil
		}).
		Needs(service).Auth(APIAuthParticipantSync).
		Parameters(presentingDocumentIDParameter(), APIParameterContract{Name: "page", In: "path", Type: "integer", Required: true}).
		Responds(http.StatusOK, "PresentingDocumentPageZoom", presentingZoomResponse{}).
		Errors(presentingErrors()...).ErrorRules(presentingRules)
}

func decodeCreatePresentingDocumentRequest(request *http.Request) (createPresentingDocumentRequest, error) {
	body, err := decodeJSONBody[createPresentingDocumentBody](request)
	return createPresentingDocumentRequest{Body: body}, err
}

func decodePresentingDocumentRequest(request *http.Request) (presentingDocumentRequest, error) {
	documentID, err := utilities.ParseID(chi.URLParam(request, "documentId"))
	if err != nil {
		return presentingDocumentRequest{}, apiErrorPresentingInvalid
	}
	return presentingDocumentRequest{DocumentID: documentID}, nil
}

func decodePresentingZoomRequest(request *http.Request) (presentingZoomRequest, error) {
	document, err := decodePresentingDocumentRequest(request)
	if err != nil {
		return presentingZoomRequest{}, err
	}
	page, err := strconv.Atoi(chi.URLParam(request, "page"))
	if err != nil || page < 1 || page > presenting.MaxPages {
		return presentingZoomRequest{}, apiErrorPresentingInvalid
	}
	return presentingZoomRequest{DocumentID: document.DocumentID, Page: page}, nil
}

func presentingSubject(ctx context.Context) (presenting.Subject, bool) {
	subject, ok := ctx.Value(presentingSubjectContextKey{}).(presenting.Subject)
	return subject, ok
}

func presentingManifest(document presenting.Document, pages []presenting.Page) presentingManifestResponse {
	response := presentingManifestResponse{
		DocumentID: document.DocumentID.String(), AttachmentID: document.AttachmentID.String(), FileName: document.FileName,
		Status: document.Status, PageCount: document.PageCount, Pages: make([]presentingPageResponse, 0, len(pages)),
	}
	if document.Failure != nil {
		response.Failure = &presentingFailureResponse{Code: document.Failure.Code, Message: document.Failure.Message}
	}
	for _, page := range pages {
		response.Pages = append(response.Pages, presentingPageResponse{Page: page.Page, Width: page.Width, Height: page.Height, Status: page.Status, ImageURL: page.ImageURL, ThumbnailURL: page.ThumbnailURL})
	}
	return response
}

func presentingDocumentIDParameter() APIParameterContract {
	return APIParameterContract{Name: "documentId", In: "path", Type: "string", Required: true}
}

func presentingErrors() []APIError {
	return []APIError{apiErrorUnauthenticated, apiErrorForbidden, apiErrorPresentingInvalid, apiErrorPresentingUnsupported, apiErrorPresentingDocumentMissing, apiErrorPresentingPageMissing, apiErrorPresentingDocumentNotReady, apiErrorPresentingZoomNotReady, apiErrorPresentingRenderer, apiErrorRateLimited, apiErrorServiceUnavailable}
}

var presentingRules = errorRules{
	ruleFor(apiErrorPresentingInvalid, presenting.ErrInvalidInput),
	ruleFor(apiErrorForbidden, presenting.ErrPermissionDenied),
	ruleFor(apiErrorPresentingUnsupported, presenting.ErrUnsupportedType),
	ruleFor(apiErrorPresentingDocumentMissing, presenting.ErrDocumentNotFound),
	ruleFor(apiErrorPresentingPageMissing, presenting.ErrPageNotFound),
	ruleFor(apiErrorPresentingDocumentNotReady, presenting.ErrDocumentNotReady),
	ruleFor(apiErrorPresentingZoomNotReady, presenting.ErrZoomNotReady),
	ruleFor(apiErrorPresentingRenderer, presenting.ErrRenderUnavailable),
}
