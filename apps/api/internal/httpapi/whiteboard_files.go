package httpapi

import (
	"context"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/whiteboardfiles"
)

var (
	apiErrorWhiteboardFileConflict       = APIError{Status: http.StatusConflict, Code: "whiteboard.file_conflict", Message: "Whiteboard file ID is already reserved or the upload expired"}
	apiErrorWhiteboardInvalidFile        = APIError{Status: http.StatusBadRequest, Code: "whiteboard.invalid_file", Message: "Invalid whiteboard file request"}
	apiErrorWhiteboardFileNotFound       = APIError{Status: http.StatusNotFound, Code: "whiteboard.file_not_found", Message: "Whiteboard file not found"}
	apiErrorWhiteboardFileTransfer       = APIError{Status: http.StatusBadGateway, Code: "whiteboard.file_transfer_failed", Message: "Whiteboard file transfer failed"}
	apiErrorWhiteboardStorageUnavailable = APIError{Status: http.StatusServiceUnavailable, Code: "whiteboard.storage_unavailable", Message: "Whiteboard file storage unavailable"}
)

type WhiteboardFileService interface {
	Initiate(context.Context, whiteboardfiles.InitiateInput) (whiteboardfiles.UploadInstructions, error)
	Finalize(context.Context, whiteboardfiles.FileRequest, string) error
	Download(context.Context, whiteboardfiles.Subject, string) (whiteboardfiles.Download, error)
}

type WhiteboardParticipantVerifier interface {
	VerifyParticipant(context.Context, string) (whiteboardfiles.Subject, bool, error)
}

type downloadWhiteboardFileRequest struct {
	FileID string
}

type whiteboardFileDownloadResponse struct {
	DownloadURL string `json:"downloadUrl"`
	ExpiresAt   string `json:"expiresAt"`
}

type whiteboardSubjectContextKey struct{}

func whiteboardFileEndpoints(service WhiteboardFileService, verifier WhiteboardParticipantVerifier) []RouteEndpoint {
	auth := requireWhiteboardParticipant(verifier)
	return []RouteEndpoint{
		downloadWhiteboardFileEndpoint(service).Middleware(auth),
		initiateWhiteboardFileEndpoint(service).Middleware(auth),
		finalizeWhiteboardFileEndpoint(service).Middleware(auth),
	}
}

func downloadWhiteboardFileEndpoint(service WhiteboardFileService) Endpoint[downloadWhiteboardFileRequest, whiteboardFileDownloadResponse] {
	return Get(
		"/v1/whiteboard/files/{fileId}/download",
		"getWhiteboardFileDownload",
		decodeDownloadWhiteboardFileRequest,
		func(ctx context.Context, request downloadWhiteboardFileRequest) (whiteboardFileDownloadResponse, error) {
			subject, ok := whiteboardSubject(ctx)
			if !ok {
				return whiteboardFileDownloadResponse{}, apiErrorUnauthenticated
			}
			result, err := service.Download(ctx, subject, request.FileID)
			if err != nil {
				return whiteboardFileDownloadResponse{}, err
			}
			return whiteboardFileDownloadResponse{
				DownloadURL: result.URL,
				ExpiresAt:   result.ExpiresAt.UTC().Format(time.RFC3339),
			}, nil
		},
	).
		Needs(service).
		Auth(APIAuthParticipantSync).
		Parameters(whiteboardFileIDParameter()).
		Responds(http.StatusOK, "WhiteboardFileDownload", whiteboardFileDownloadResponse{}).
		Errors(whiteboardFileErrors()...).
		ErrorRules(whiteboardFileRules)
}

func requireWhiteboardParticipant(verifier WhiteboardParticipantVerifier) func(http.Handler) http.Handler {
	return requireSyncParticipant(verifier, whiteboardSubjectContextKey{})
}

func decodeDownloadWhiteboardFileRequest(request *http.Request) (downloadWhiteboardFileRequest, error) {
	fileID := chi.URLParam(request, "fileId")
	if request.URL.RawPath != "" {
		var err error
		fileID, err = url.PathUnescape(fileID)
		if err != nil {
			return downloadWhiteboardFileRequest{}, apiErrorWhiteboardInvalidFile
		}
	}
	if strings.TrimSpace(fileID) == "" || len(fileID) > 128 {
		return downloadWhiteboardFileRequest{}, apiErrorWhiteboardInvalidFile
	}
	return downloadWhiteboardFileRequest{FileID: fileID}, nil
}

func whiteboardSubject(ctx context.Context) (whiteboardfiles.Subject, bool) {
	subject, ok := ctx.Value(whiteboardSubjectContextKey{}).(whiteboardfiles.Subject)
	return subject, ok
}

func whiteboardFileIDParameter() APIParameterContract {
	return APIParameterContract{Name: "fileId", In: "path", Type: "string", Required: true, MinLength: 1, MaxLength: 128}
}

func whiteboardFileErrors() []APIError {
	return []APIError{
		apiErrorUnauthenticated, apiErrorForbidden, apiErrorWhiteboardInvalidFile,
		apiErrorWhiteboardFileNotFound,
		apiErrorWhiteboardFileTransfer, apiErrorWhiteboardStorageUnavailable,
		apiErrorRateLimited, apiErrorServiceUnavailable,
	}
}

var whiteboardFileRules = errorRules{
	ruleFor(apiErrorWhiteboardInvalidFile, whiteboardfiles.ErrInvalidInput),
	ruleFor(apiErrorForbidden, whiteboardfiles.ErrPermissionDenied),
	ruleFor(apiErrorWhiteboardFileConflict, whiteboardfiles.ErrFileConflict),
	ruleFor(apiErrorWhiteboardFileNotFound, whiteboardfiles.ErrFileNotFound),
	ruleFor(apiErrorWhiteboardFileTransfer, whiteboardfiles.ErrFileTransferFailed, objectstorage.ErrObjectNotFound, objectstorage.ErrObjectAlreadyExists),
	ruleFor(apiErrorWhiteboardStorageUnavailable, objectstorage.ErrStoreUnavailable, objectstorage.ErrProviderFailed),
}

type whiteboardFileUploadBody struct {
	MIMEType   string `json:"mimeType"`
	ByteLength int64  `json:"byteLength"`
	SHA256     string `json:"sha256"`
}

type whiteboardFileFinalizeBody struct {
	SHA256 string `json:"sha256"`
}

type whiteboardFileWriteRequest[Body any] struct {
	File whiteboardfiles.FileRequest
	Body Body
}

type whiteboardFileUploadResponse struct {
	Ready     bool              `json:"ready"`
	UploadURL string            `json:"uploadUrl,omitempty"`
	Headers   map[string]string `json:"headers,omitempty"`
	ExpiresAt string            `json:"expiresAt,omitempty"`
}

func initiateWhiteboardFileEndpoint(service WhiteboardFileService) Endpoint[whiteboardFileWriteRequest[whiteboardFileUploadBody], whiteboardFileUploadResponse] {
	return Post(
		"/v1/whiteboard/scenes/{sceneId}/files/{fileId}/upload",
		"initiateWhiteboardFileUpload",
		decodeWhiteboardFileWrite[whiteboardFileUploadBody],
		func(ctx context.Context, request whiteboardFileWriteRequest[whiteboardFileUploadBody]) (whiteboardFileUploadResponse, error) {
			result, err := service.Initiate(ctx, whiteboardfiles.InitiateInput{
				FileRequest: request.File, MIMEType: request.Body.MIMEType,
				ByteLength: request.Body.ByteLength, SHA256: request.Body.SHA256,
			})
			if err != nil {
				return whiteboardFileUploadResponse{}, err
			}
			if result.Ready {
				return whiteboardFileUploadResponse{Ready: true}, nil
			}
			return whiteboardFileUploadResponse{
				UploadURL: result.URL, Headers: result.Headers,
				ExpiresAt: result.ExpiresAt.UTC().Format(time.RFC3339),
			}, nil
		},
	).
		Needs(service).
		Auth(APIAuthParticipantSync).
		RateLimit(authenticatedWriteRateLimit).
		Parameters(whiteboardSceneIDParameter(), whiteboardFileIDParameter()).
		RequestBody("InitiateWhiteboardFileUploadRequest", whiteboardFileUploadBody{}).
		Responds(http.StatusOK, "WhiteboardFileUpload", whiteboardFileUploadResponse{}).
		Errors(append(whiteboardFileErrors(), apiErrorWhiteboardFileConflict)...).
		ErrorRules(whiteboardFileRules)
}

func finalizeWhiteboardFileEndpoint(service WhiteboardFileService) Endpoint[whiteboardFileWriteRequest[whiteboardFileFinalizeBody], struct{}] {
	return Post(
		"/v1/whiteboard/scenes/{sceneId}/files/{fileId}/finalize",
		"finalizeWhiteboardFileUpload",
		decodeWhiteboardFileWrite[whiteboardFileFinalizeBody],
		func(ctx context.Context, request whiteboardFileWriteRequest[whiteboardFileFinalizeBody]) (struct{}, error) {
			return struct{}{}, service.Finalize(ctx, request.File, request.Body.SHA256)
		},
	).
		Needs(service).
		Auth(APIAuthParticipantSync).
		RateLimit(authenticatedWriteRateLimit).
		Parameters(whiteboardSceneIDParameter(), whiteboardFileIDParameter()).
		RequestBody("FinalizeWhiteboardFileUploadRequest", whiteboardFileFinalizeBody{}).
		RespondsNoBody(http.StatusNoContent).
		Errors(append(whiteboardFileErrors(), apiErrorWhiteboardFileConflict)...).
		ErrorRules(whiteboardFileRules)
}

func decodeWhiteboardFileWrite[Body any](request *http.Request) (whiteboardFileWriteRequest[Body], error) {
	subject, ok := whiteboardSubject(request.Context())
	if !ok {
		return whiteboardFileWriteRequest[Body]{}, apiErrorUnauthenticated
	}
	sceneID, err := utilities.ParseID(chi.URLParam(request, "sceneId"))
	if err != nil {
		return whiteboardFileWriteRequest[Body]{}, apiErrorWhiteboardInvalidFile
	}
	file, err := decodeDownloadWhiteboardFileRequest(request)
	if err != nil {
		return whiteboardFileWriteRequest[Body]{}, err
	}
	body, err := decodeJSONBody[Body](request)
	return whiteboardFileWriteRequest[Body]{
		File: whiteboardfiles.FileRequest{Subject: subject, SceneID: sceneID, FileID: file.FileID},
		Body: body,
	}, err
}

func whiteboardSceneIDParameter() APIParameterContract {
	return APIParameterContract{Name: "sceneId", In: "path", Type: "string", Required: true}
}
