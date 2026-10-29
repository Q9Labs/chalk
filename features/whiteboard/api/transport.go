package whiteboardfiles

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/platform/httpcontract"
	"github.com/q9labs/chalk/platform/objectstorage"
)

var (
	apiErrorWhiteboardInvalidFile        = httpcontract.APIError{Status: http.StatusBadRequest, Code: "whiteboard.invalid_file", Message: "Invalid whiteboard file request"}
	apiErrorWhiteboardFileNotFound       = httpcontract.APIError{Status: http.StatusNotFound, Code: "whiteboard.file_not_found", Message: "Whiteboard file not found"}
	apiErrorWhiteboardFileTransfer       = httpcontract.APIError{Status: http.StatusBadGateway, Code: "whiteboard.file_transfer_failed", Message: "Whiteboard file transfer failed"}
	apiErrorWhiteboardStorageUnavailable = httpcontract.APIError{Status: http.StatusServiceUnavailable, Code: "whiteboard.storage_unavailable", Message: "Whiteboard file storage unavailable"}
)

type WhiteboardFileService interface {
	Download(context.Context, Subject, string) (Download, error)
}

type WhiteboardParticipantVerifier interface {
	VerifyWhiteboardParticipant(context.Context, string) (Subject, bool, error)
}

type downloadWhiteboardFileRequest struct {
	FileID string
}

type whiteboardFileDownloadResponse struct {
	DownloadURL string `json:"downloadUrl"`
	ExpiresAt   string `json:"expiresAt"`
}

type whiteboardSubjectContextKey struct{}

func FileEndpoint(service WhiteboardFileService, verifier WhiteboardParticipantVerifier) httpcontract.EndpointSpec[downloadWhiteboardFileRequest, whiteboardFileDownloadResponse] {
	return httpcontract.EndpointSpec[downloadWhiteboardFileRequest, whiteboardFileDownloadResponse]{
		Contract: httpcontract.APIRouteContract{
			Method: http.MethodGet, Path: "/v1/whiteboard/files/{fileId}/download", MountPath: "/whiteboard/files/{fileId}/download", OperationID: "getWhiteboardFileDownload",
			Auth: httpcontract.APIAuthParticipantSync, Parameters: []httpcontract.APIParameterContract{whiteboardFileIDParameter()},
			Responses: []httpcontract.APIResponseContract{{Status: http.StatusOK, Schema: &httpcontract.APISchemaRef{Name: "WhiteboardFileDownload", Type: whiteboardFileDownloadResponse{}}}},
			Errors:    whiteboardFileErrors(),
		},
		Decode: decodeDownloadWhiteboardFileRequest,
		Handle: func(ctx context.Context, request downloadWhiteboardFileRequest) (whiteboardFileDownloadResponse, error) {
			subject, ok := whiteboardSubject(ctx)
			if !ok {
				return whiteboardFileDownloadResponse{}, httpcontract.ErrorUnauthenticated
			}
			if service == nil {
				return whiteboardFileDownloadResponse{}, httpcontract.ErrorServiceUnavailable
			}
			result, err := service.Download(ctx, subject, request.FileID)
			if err != nil {
				return whiteboardFileDownloadResponse{}, err
			}
			return whiteboardFileDownloadResponse{DownloadURL: result.URL, ExpiresAt: result.ExpiresAt.UTC().Format(time.RFC3339)}, nil
		},
		MapErrors:   whiteboardFileAPIError,
		Middlewares: []func(http.Handler) http.Handler{requireWhiteboardParticipant(verifier)},
	}
}

func requireWhiteboardParticipant(verifier WhiteboardParticipantVerifier) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
			if verifier == nil {
				httpcontract.WriteAPIError(response, httpcontract.ErrorServiceUnavailable)
				return
			}
			token, ok := httpcontract.BearerToken(request.Header.Get("Authorization"))
			if !ok {
				httpcontract.WriteAPIError(response, httpcontract.ErrorUnauthenticated)
				return
			}
			subject, valid, err := verifier.VerifyWhiteboardParticipant(request.Context(), token)
			if err != nil {
				httpcontract.WriteAPIError(response, httpcontract.ErrorServiceUnavailable)
				return
			}
			if !valid {
				httpcontract.WriteAPIError(response, httpcontract.ErrorUnauthenticated)
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

func whiteboardSubject(ctx context.Context) (Subject, bool) {
	subject, ok := ctx.Value(whiteboardSubjectContextKey{}).(Subject)
	return subject, ok
}

func whiteboardFileIDParameter() httpcontract.APIParameterContract {
	return httpcontract.APIParameterContract{Name: "fileId", In: "path", Type: "string", Required: true, MinLength: 1, MaxLength: 128}
}

func whiteboardFileErrors() []httpcontract.APIError {
	return []httpcontract.APIError{
		httpcontract.ErrorUnauthenticated, httpcontract.ErrorForbidden, apiErrorWhiteboardInvalidFile,
		apiErrorWhiteboardFileNotFound,
		apiErrorWhiteboardFileTransfer, apiErrorWhiteboardStorageUnavailable,
		httpcontract.ErrorRateLimited, httpcontract.ErrorServiceUnavailable,
	}
}

func whiteboardFileAPIError(err error) (httpcontract.APIError, bool) {
	switch {
	case errors.Is(err, ErrInvalidInput):
		return apiErrorWhiteboardInvalidFile, true
	case errors.Is(err, ErrPermissionDenied):
		return httpcontract.ErrorForbidden, true
	case errors.Is(err, ErrFileNotFound):
		return apiErrorWhiteboardFileNotFound, true
	case errors.Is(err, ErrFileTransferFailed), errors.Is(err, objectstorage.ErrObjectNotFound), errors.Is(err, objectstorage.ErrObjectAlreadyExists):
		return apiErrorWhiteboardFileTransfer, true
	case errors.Is(err, objectstorage.ErrStoreUnavailable), errors.Is(err, objectstorage.ErrProviderFailed):
		return apiErrorWhiteboardStorageUnavailable, true
	default:
		return httpcontract.APIError{}, false
	}
}
