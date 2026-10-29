package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/whiteboardfiles"
)

var (
	apiErrorWhiteboardInvalidFile        = APIError{Status: http.StatusBadRequest, Code: "whiteboard.invalid_file", Message: "Invalid whiteboard file request"}
	apiErrorWhiteboardFileNotFound       = APIError{Status: http.StatusNotFound, Code: "whiteboard.file_not_found", Message: "Whiteboard file not found"}
	apiErrorWhiteboardFileTransfer       = APIError{Status: http.StatusBadGateway, Code: "whiteboard.file_transfer_failed", Message: "Whiteboard file transfer failed"}
	apiErrorWhiteboardStorageUnavailable = APIError{Status: http.StatusServiceUnavailable, Code: "whiteboard.storage_unavailable", Message: "Whiteboard file storage unavailable"}
)

type WhiteboardFileService interface {
	Download(context.Context, whiteboardfiles.Subject, string) (whiteboardfiles.Download, error)
}

type WhiteboardParticipantVerifier interface {
	VerifyWhiteboardParticipant(context.Context, string) (whiteboardfiles.Subject, bool, error)
}

type downloadWhiteboardFileRequest struct {
	FileID string
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
		downloadWhiteboardFileEndpoint(service).Middleware(auth),
	}
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

func whiteboardFileAPIError(err error) (APIError, bool) {
	switch {
	case errors.Is(err, whiteboardfiles.ErrInvalidInput):
		return apiErrorWhiteboardInvalidFile, true
	case errors.Is(err, whiteboardfiles.ErrPermissionDenied):
		return apiErrorForbidden, true
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
