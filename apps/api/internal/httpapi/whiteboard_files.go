package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/whiteboardfiles"
)

var (
	apiErrorWhiteboardInvalidFile        = APIError{Status: http.StatusBadRequest, Code: "invalid_whiteboard_file", Message: "Invalid whiteboard file request"}
	apiErrorWhiteboardSceneChanged       = APIError{Status: http.StatusConflict, Code: "whiteboard_scene_changed", Message: "Whiteboard scene changed"}
	apiErrorWhiteboardFileExists         = APIError{Status: http.StatusConflict, Code: "whiteboard_file_exists", Message: "Whiteboard file already exists"}
	apiErrorWhiteboardUploadNotFound     = APIError{Status: http.StatusNotFound, Code: "whiteboard_upload_not_found", Message: "Whiteboard upload not found"}
	apiErrorWhiteboardUploadExpired      = APIError{Status: http.StatusGone, Code: "whiteboard_upload_expired", Message: "Whiteboard upload expired"}
	apiErrorWhiteboardUploadNotReady     = APIError{Status: http.StatusConflict, Code: "whiteboard_upload_not_ready", Message: "Whiteboard upload is not ready"}
	apiErrorWhiteboardFileNotFound       = APIError{Status: http.StatusNotFound, Code: "whiteboard_file_not_found", Message: "Whiteboard file not found"}
	apiErrorWhiteboardFileTransfer       = APIError{Status: http.StatusBadGateway, Code: "whiteboard_file_transfer_failed", Message: "Whiteboard file transfer failed"}
	apiErrorWhiteboardStorageUnavailable = APIError{Status: http.StatusServiceUnavailable, Code: "whiteboard_storage_unavailable", Message: "Whiteboard file storage unavailable"}
)

type WhiteboardFileService interface {
	Initiate(context.Context, whiteboardfiles.InitiateInput) (whiteboardfiles.UploadInstructions, error)
	Finalize(context.Context, whiteboardfiles.Subject, utilities.ID) error
	Download(context.Context, whiteboardfiles.Subject, string) (whiteboardfiles.Download, error)
}

type WhiteboardParticipantVerifier interface {
	VerifyWhiteboardParticipant(context.Context, string) (whiteboardfiles.Subject, bool, error)
}

type initiateWhiteboardFileUploadBody struct {
	SceneID    string `json:"sceneId"`
	FileID     string `json:"fileId"`
	MIMEType   string `json:"mimeType"`
	ByteLength int64  `json:"byteLength"`
	SHA256     string `json:"sha256"`
}

type initiateWhiteboardFileUploadRequest struct {
	Body initiateWhiteboardFileUploadBody
}

type finalizeWhiteboardFileUploadRequest struct {
	UploadID utilities.ID
}

type downloadWhiteboardFileRequest struct {
	FileID string
}

type whiteboardFileUploadResponse struct {
	UploadID  string            `json:"uploadId"`
	Method    string            `json:"method"`
	UploadURL string            `json:"uploadUrl"`
	Headers   map[string]string `json:"headers"`
	ExpiresAt string            `json:"expiresAt"`
}

type whiteboardFileDownloadResponse struct {
	DownloadURL string `json:"downloadUrl"`
	ExpiresAt   string `json:"expiresAt"`
}

type whiteboardSubjectContextKey struct{}

func mountWhiteboardFileRoutes(r chi.Router, service WhiteboardFileService, verifier WhiteboardParticipantVerifier, limits RateLimitOptions) {
	for _, endpoint := range whiteboardFileEndpoints(service, verifier) {
		endpoint.Mount(r, limits)
	}
}

func whiteboardFileEndpoints(service WhiteboardFileService, verifier WhiteboardParticipantVerifier) []RouteEndpoint {
	auth := requireWhiteboardParticipant(verifier)
	return []RouteEndpoint{
		initiateWhiteboardFileUploadEndpoint(service).Middleware(auth),
		finalizeWhiteboardFileUploadEndpoint(service).Middleware(auth),
		downloadWhiteboardFileEndpoint(service).Middleware(auth),
	}
}

func initiateWhiteboardFileUploadEndpoint(service WhiteboardFileService) Endpoint[initiateWhiteboardFileUploadRequest, whiteboardFileUploadResponse] {
	return Post(
		"/v1/whiteboard/files/uploads",
		"/whiteboard/files/uploads",
		"initiateWhiteboardFileUpload",
		decodeInitiateWhiteboardFileUploadRequest,
		func(ctx context.Context, request initiateWhiteboardFileUploadRequest) (whiteboardFileUploadResponse, error) {
			subject, ok := whiteboardSubject(ctx)
			if !ok {
				return whiteboardFileUploadResponse{}, apiErrorUnauthenticated
			}
			if service == nil {
				return whiteboardFileUploadResponse{}, apiErrorServiceUnavailable
			}
			sceneID, err := utilities.ParseID(request.Body.SceneID)
			if err != nil {
				return whiteboardFileUploadResponse{}, apiErrorWhiteboardInvalidFile
			}
			result, err := service.Initiate(ctx, whiteboardfiles.InitiateInput{
				Subject: subject, SceneID: sceneID, FileID: request.Body.FileID,
				MIMEType: request.Body.MIMEType, ByteLength: request.Body.ByteLength, SHA256: request.Body.SHA256,
			})
			if err != nil {
				return whiteboardFileUploadResponse{}, err
			}
			return whiteboardFileUploadResponse{
				UploadID: result.UploadID.String(), Method: result.Method, UploadURL: result.URL,
				Headers: result.Headers, ExpiresAt: result.ExpiresAt.UTC().Format(time.RFC3339),
			}, nil
		},
	).
		Auth(APIAuthParticipantSync).
		RateLimit(authenticatedWriteRateLimit).
		RequestBody("InitiateWhiteboardFileUploadRequest", initiateWhiteboardFileUploadBody{}).
		Responds(http.StatusCreated, "WhiteboardFileUpload", whiteboardFileUploadResponse{}).
		Errors(whiteboardFileErrors()...).
		MapErrors(whiteboardFileAPIError)
}

func finalizeWhiteboardFileUploadEndpoint(service WhiteboardFileService) Endpoint[finalizeWhiteboardFileUploadRequest, noResponse] {
	return Post(
		"/v1/whiteboard/files/uploads/{uploadId}/finalize",
		"/whiteboard/files/uploads/{uploadId}/finalize",
		"finalizeWhiteboardFileUpload",
		decodeFinalizeWhiteboardFileUploadRequest,
		func(ctx context.Context, request finalizeWhiteboardFileUploadRequest) (noResponse, error) {
			subject, ok := whiteboardSubject(ctx)
			if !ok {
				return noResponse{}, apiErrorUnauthenticated
			}
			if service == nil {
				return noResponse{}, apiErrorServiceUnavailable
			}
			return noResponse{}, service.Finalize(ctx, subject, request.UploadID)
		},
	).
		Auth(APIAuthParticipantSync).
		RateLimit(authenticatedWriteRateLimit).
		Parameters(whiteboardUploadIDParameter()).
		RespondsNoBody(http.StatusNoContent).
		Errors(whiteboardFileErrors()...).
		MapErrors(whiteboardFileAPIError)
}

func downloadWhiteboardFileEndpoint(service WhiteboardFileService) Endpoint[downloadWhiteboardFileRequest, whiteboardFileDownloadResponse] {
	return Get(
		"/v1/whiteboard/files/{fileId}/download",
		"/whiteboard/files/{fileId}/download",
		"getWhiteboardFileDownload",
		decodeDownloadWhiteboardFileRequest,
		func(ctx context.Context, request downloadWhiteboardFileRequest) (whiteboardFileDownloadResponse, error) {
			subject, ok := whiteboardSubject(ctx)
			if !ok {
				return whiteboardFileDownloadResponse{}, apiErrorUnauthenticated
			}
			if service == nil {
				return whiteboardFileDownloadResponse{}, apiErrorServiceUnavailable
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
		Auth(APIAuthParticipantSync).
		Parameters(whiteboardFileIDParameter()).
		Responds(http.StatusOK, "WhiteboardFileDownload", whiteboardFileDownloadResponse{}).
		Errors(whiteboardFileErrors()...).
		MapErrors(whiteboardFileAPIError)
}

func requireWhiteboardParticipant(verifier WhiteboardParticipantVerifier) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
			if verifier == nil {
				writeServiceUnavailable(response)
				return
			}
			token, ok := bearerToken(request.Header.Get("Authorization"))
			if !ok {
				writeUnauthenticated(response)
				return
			}
			subject, valid, err := verifier.VerifyWhiteboardParticipant(request.Context(), token)
			if err != nil {
				writeServiceUnavailable(response)
				return
			}
			if !valid {
				writeUnauthenticated(response)
				return
			}
			ctx := context.WithValue(request.Context(), whiteboardSubjectContextKey{}, subject)
			next.ServeHTTP(response, request.WithContext(ctx))
		})
	}
}

func decodeInitiateWhiteboardFileUploadRequest(request *http.Request) (initiateWhiteboardFileUploadRequest, error) {
	body, err := decodeJSONBody[initiateWhiteboardFileUploadBody](request)
	return initiateWhiteboardFileUploadRequest{Body: body}, err
}

func decodeFinalizeWhiteboardFileUploadRequest(request *http.Request) (finalizeWhiteboardFileUploadRequest, error) {
	uploadID, err := utilities.ParseID(chi.URLParam(request, "uploadId"))
	if err != nil {
		return finalizeWhiteboardFileUploadRequest{}, apiErrorWhiteboardInvalidFile
	}
	return finalizeWhiteboardFileUploadRequest{UploadID: uploadID}, nil
}

func decodeDownloadWhiteboardFileRequest(request *http.Request) (downloadWhiteboardFileRequest, error) {
	fileID := chi.URLParam(request, "fileId")
	if strings.TrimSpace(fileID) == "" || len(fileID) > 128 {
		return downloadWhiteboardFileRequest{}, apiErrorWhiteboardInvalidFile
	}
	return downloadWhiteboardFileRequest{FileID: fileID}, nil
}

func whiteboardSubject(ctx context.Context) (whiteboardfiles.Subject, bool) {
	subject, ok := ctx.Value(whiteboardSubjectContextKey{}).(whiteboardfiles.Subject)
	return subject, ok
}

func whiteboardUploadIDParameter() APIParameterContract {
	return APIParameterContract{Name: "uploadId", In: "path", Type: "string", Required: true}
}

func whiteboardFileIDParameter() APIParameterContract {
	return APIParameterContract{Name: "fileId", In: "path", Type: "string", Required: true, MinLength: 1, MaxLength: 128}
}

func whiteboardFileErrors() []APIError {
	return []APIError{
		apiErrorUnauthenticated, apiErrorForbidden, apiErrorWhiteboardInvalidFile,
		apiErrorWhiteboardSceneChanged, apiErrorWhiteboardFileExists,
		apiErrorWhiteboardUploadNotFound, apiErrorWhiteboardUploadExpired,
		apiErrorWhiteboardUploadNotReady, apiErrorWhiteboardFileNotFound,
		apiErrorWhiteboardFileTransfer, apiErrorWhiteboardStorageUnavailable,
		apiErrorRateLimited, apiErrorServiceUnavailable,
	}
}

func whiteboardFileAPIError(err error) (APIError, bool) {
	switch {
	case errors.Is(err, whiteboardfiles.ErrInvalidInput):
		return apiErrorWhiteboardInvalidFile, true
	case errors.Is(err, whiteboardfiles.ErrPermissionDenied):
		return apiErrorForbidden, true
	case errors.Is(err, whiteboardfiles.ErrSceneChanged):
		return apiErrorWhiteboardSceneChanged, true
	case errors.Is(err, whiteboardfiles.ErrFileExists):
		return apiErrorWhiteboardFileExists, true
	case errors.Is(err, whiteboardfiles.ErrUploadNotFound):
		return apiErrorWhiteboardUploadNotFound, true
	case errors.Is(err, whiteboardfiles.ErrUploadExpired):
		return apiErrorWhiteboardUploadExpired, true
	case errors.Is(err, whiteboardfiles.ErrUploadNotReady):
		return apiErrorWhiteboardUploadNotReady, true
	case errors.Is(err, whiteboardfiles.ErrFileNotFound):
		return apiErrorWhiteboardFileNotFound, true
	case errors.Is(err, whiteboardfiles.ErrFileTransferFailed), errors.Is(err, objectstorage.ErrObjectNotFound), errors.Is(err, objectstorage.ErrObjectAlreadyExists):
		return apiErrorWhiteboardFileTransfer, true
	case errors.Is(err, objectstorage.ErrStoreUnavailable), errors.Is(err, objectstorage.ErrProviderFailed):
		return apiErrorWhiteboardStorageUnavailable, true
	default:
		return APIError{}, false
	}
}
