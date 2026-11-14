package httpapi

import (
	"context"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/chatattachments"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	apiErrorChatAttachmentInvalid       = APIError{Status: http.StatusBadRequest, Code: "chat.invalid_attachment", Message: "Invalid chat attachment request"}
	apiErrorChatAttachmentIDConflict    = APIError{Status: http.StatusConflict, Code: "chat.attachment_id_conflict", Message: "Client attachment id conflicts with an earlier upload"}
	apiErrorChatAttachmentQuota         = APIError{Status: http.StatusConflict, Code: "chat.attachment_quota_exceeded", Message: "Chat attachment quota exceeded"}
	apiErrorChatAttachmentUploadMissing = APIError{Status: http.StatusNotFound, Code: "chat.upload_not_found", Message: "Chat attachment upload not found"}
	apiErrorChatAttachmentUploadExpired = APIError{Status: http.StatusGone, Code: "chat.upload_expired", Message: "Chat attachment upload expired"}
	apiErrorChatAttachmentUploadPending = APIError{Status: http.StatusConflict, Code: "chat.upload_not_ready", Message: "Chat attachment upload is not ready"}
	apiErrorChatAttachmentMissing       = APIError{Status: http.StatusNotFound, Code: "chat.attachment_not_found", Message: "Chat attachment not found"}
	apiErrorChatAttachmentTransfer      = APIError{Status: http.StatusBadGateway, Code: "chat.attachment_transfer_failed", Message: "Chat attachment transfer failed"}
	apiErrorChatAttachmentStorage       = APIError{Status: http.StatusServiceUnavailable, Code: "chat.storage_unavailable", Message: "Chat attachment storage unavailable"}
)

type ChatAttachmentService interface {
	Initiate(context.Context, chatattachments.InitiateInput) (chatattachments.UploadInstructions, error)
	Finalize(context.Context, chatattachments.Subject, utilities.ID) (chatattachments.Attachment, error)
	Download(context.Context, chatattachments.Subject, utilities.ID) (chatattachments.Download, error)
}

type ChatParticipantVerifier interface {
	VerifyParticipant(context.Context, string) (chatattachments.Subject, bool, error)
}

type initiateChatAttachmentBody struct {
	ClientAttachmentID string `json:"clientAttachmentId"`
	FileName           string `json:"fileName"`
	MIMEType           string `json:"mimeType"`
	ByteLength         int64  `json:"byteLength"`
	SHA256             string `json:"sha256"`
}

type initiateChatAttachmentRequest struct {
	Body initiateChatAttachmentBody
}

type finalizeChatAttachmentRequest struct {
	UploadID utilities.ID
}

type downloadChatAttachmentRequest struct {
	AttachmentID utilities.ID
}

type chatAttachmentResponse struct {
	AttachmentID string `json:"attachmentId"`
	FileName     string `json:"fileName"`
	MIMEType     string `json:"mimeType"`
	ByteLength   int64  `json:"byteLength"`
}

type chatAttachmentUploadResponse struct {
	AttachmentID string            `json:"attachmentId"`
	UploadID     string            `json:"uploadId"`
	Method       string            `json:"method"`
	UploadURL    string            `json:"uploadUrl"`
	Headers      map[string]string `json:"headers"`
	ExpiresAt    string            `json:"expiresAt"`
}

type chatAttachmentDownloadResponse struct {
	DownloadURL string `json:"downloadUrl"`
	ExpiresAt   string `json:"expiresAt"`
}

type chatSubjectContextKey struct{}

func chatAttachmentEndpoints(service ChatAttachmentService, verifier ChatParticipantVerifier) []RouteEndpoint {
	auth := requireChatParticipant(verifier)
	return []RouteEndpoint{
		initiateChatAttachmentEndpoint(service).Middleware(auth),
		finalizeChatAttachmentEndpoint(service).Middleware(auth),
		downloadChatAttachmentEndpoint(service).Middleware(auth),
	}
}

func initiateChatAttachmentEndpoint(service ChatAttachmentService) Endpoint[initiateChatAttachmentRequest, chatAttachmentUploadResponse] {
	return Post(
		"/v1/chat/attachments/uploads",
		"initiateChatAttachmentUpload",
		decodeInitiateChatAttachmentRequest,
		func(ctx context.Context, request initiateChatAttachmentRequest) (chatAttachmentUploadResponse, error) {
			subject, ok := chatSubject(ctx)
			if !ok {
				return chatAttachmentUploadResponse{}, apiErrorUnauthenticated
			}
			result, err := service.Initiate(ctx, chatattachments.InitiateInput{
				Subject: subject, ClientAttachmentID: request.Body.ClientAttachmentID,
				FileName: request.Body.FileName, MIMEType: request.Body.MIMEType,
				ByteLength: request.Body.ByteLength, SHA256: request.Body.SHA256,
			})
			if err != nil {
				return chatAttachmentUploadResponse{}, err
			}
			return chatAttachmentUploadResponse{
				AttachmentID: result.AttachmentID.String(), UploadID: result.UploadID.String(),
				Method: result.Method, UploadURL: result.URL, Headers: result.Headers,
				ExpiresAt: result.ExpiresAt.UTC().Format(time.RFC3339),
			}, nil
		},
	).
		Needs(service).
		Auth(APIAuthParticipantSync).
		RateLimit(authenticatedWriteRateLimit).
		RequestBody("InitiateChatAttachmentUploadRequest", initiateChatAttachmentBody{}).
		Responds(http.StatusCreated, "ChatAttachmentUpload", chatAttachmentUploadResponse{}).
		Errors(chatAttachmentErrors()...).
		ErrorRules(chatAttachmentRules)
}

func finalizeChatAttachmentEndpoint(service ChatAttachmentService) Endpoint[finalizeChatAttachmentRequest, chatAttachmentResponse] {
	return Post(
		"/v1/chat/attachments/uploads/{uploadId}/finalize",
		"finalizeChatAttachmentUpload",
		decodeFinalizeChatAttachmentRequest,
		func(ctx context.Context, request finalizeChatAttachmentRequest) (chatAttachmentResponse, error) {
			subject, ok := chatSubject(ctx)
			if !ok {
				return chatAttachmentResponse{}, apiErrorUnauthenticated
			}
			attachment, err := service.Finalize(ctx, subject, request.UploadID)
			if err != nil {
				return chatAttachmentResponse{}, err
			}
			return newChatAttachmentResponse(attachment), nil
		},
	).
		Needs(service).
		Auth(APIAuthParticipantSync).
		RateLimit(authenticatedWriteRateLimit).
		Parameters(chatUploadIDParameter()).
		Responds(http.StatusOK, "ChatAttachment", chatAttachmentResponse{}).
		Errors(chatAttachmentErrors()...).
		ErrorRules(chatAttachmentRules)
}

func downloadChatAttachmentEndpoint(service ChatAttachmentService) Endpoint[downloadChatAttachmentRequest, chatAttachmentDownloadResponse] {
	return Get(
		"/v1/chat/attachments/{attachmentId}/download",
		"getChatAttachmentDownload",
		decodeDownloadChatAttachmentRequest,
		func(ctx context.Context, request downloadChatAttachmentRequest) (chatAttachmentDownloadResponse, error) {
			subject, ok := chatSubject(ctx)
			if !ok {
				return chatAttachmentDownloadResponse{}, apiErrorUnauthenticated
			}
			result, err := service.Download(ctx, subject, request.AttachmentID)
			if err != nil {
				return chatAttachmentDownloadResponse{}, err
			}
			return chatAttachmentDownloadResponse{
				DownloadURL: result.URL,
				ExpiresAt:   result.ExpiresAt.UTC().Format(time.RFC3339),
			}, nil
		},
	).
		Needs(service).
		Auth(APIAuthParticipantSync).
		Parameters(chatAttachmentIDParameter()).
		Responds(http.StatusOK, "ChatAttachmentDownload", chatAttachmentDownloadResponse{}).
		Errors(chatAttachmentErrors()...).
		ErrorRules(chatAttachmentRules)
}

func requireChatParticipant(verifier ChatParticipantVerifier) func(http.Handler) http.Handler {
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
			subject, valid, err := verifier.VerifyParticipant(request.Context(), token)
			if err != nil {
				writeServiceUnavailable(response)
				return
			}
			if !valid {
				writeUnauthenticated(response)
				return
			}
			ctx := context.WithValue(request.Context(), chatSubjectContextKey{}, subject)
			next.ServeHTTP(response, request.WithContext(ctx))
		})
	}
}

func decodeInitiateChatAttachmentRequest(request *http.Request) (initiateChatAttachmentRequest, error) {
	body, err := decodeJSONBody[initiateChatAttachmentBody](request)
	return initiateChatAttachmentRequest{Body: body}, err
}

func decodeFinalizeChatAttachmentRequest(request *http.Request) (finalizeChatAttachmentRequest, error) {
	uploadID, err := utilities.ParseID(chi.URLParam(request, "uploadId"))
	if err != nil {
		return finalizeChatAttachmentRequest{}, apiErrorChatAttachmentInvalid
	}
	return finalizeChatAttachmentRequest{UploadID: uploadID}, nil
}

func decodeDownloadChatAttachmentRequest(request *http.Request) (downloadChatAttachmentRequest, error) {
	attachmentID, err := utilities.ParseID(chi.URLParam(request, "attachmentId"))
	if err != nil {
		return downloadChatAttachmentRequest{}, apiErrorChatAttachmentInvalid
	}
	return downloadChatAttachmentRequest{AttachmentID: attachmentID}, nil
}

func chatSubject(ctx context.Context) (chatattachments.Subject, bool) {
	subject, ok := ctx.Value(chatSubjectContextKey{}).(chatattachments.Subject)
	return subject, ok
}

func newChatAttachmentResponse(attachment chatattachments.Attachment) chatAttachmentResponse {
	return chatAttachmentResponse{
		AttachmentID: attachment.AttachmentID.String(), FileName: attachment.FileName,
		MIMEType: attachment.MIMEType, ByteLength: attachment.ByteLength,
	}
}

func chatUploadIDParameter() APIParameterContract {
	return APIParameterContract{Name: "uploadId", In: "path", Type: "string", Required: true}
}

func chatAttachmentIDParameter() APIParameterContract {
	return APIParameterContract{Name: "attachmentId", In: "path", Type: "string", Required: true}
}

func chatAttachmentErrors() []APIError {
	return []APIError{
		apiErrorUnauthenticated, apiErrorForbidden, apiErrorChatAttachmentInvalid,
		apiErrorChatAttachmentIDConflict, apiErrorChatAttachmentQuota,
		apiErrorChatAttachmentUploadMissing, apiErrorChatAttachmentUploadExpired,
		apiErrorChatAttachmentUploadPending, apiErrorChatAttachmentMissing,
		apiErrorChatAttachmentTransfer, apiErrorChatAttachmentStorage,
		apiErrorRateLimited, apiErrorServiceUnavailable,
	}
}

var chatAttachmentRules = errorRules{
	ruleFor(apiErrorChatAttachmentInvalid, chatattachments.ErrInvalidInput),
	ruleFor(apiErrorForbidden, chatattachments.ErrPermissionDenied),
	ruleFor(apiErrorChatAttachmentIDConflict, chatattachments.ErrClientAttachmentIDConflict),
	ruleFor(apiErrorChatAttachmentQuota, chatattachments.ErrQuotaExceeded),
	ruleFor(apiErrorChatAttachmentUploadMissing, chatattachments.ErrUploadNotFound),
	ruleFor(apiErrorChatAttachmentUploadExpired, chatattachments.ErrUploadExpired),
	ruleFor(apiErrorChatAttachmentUploadPending, chatattachments.ErrUploadNotReady),
	ruleFor(apiErrorChatAttachmentMissing, chatattachments.ErrAttachmentNotFound),
	ruleFor(apiErrorChatAttachmentTransfer, chatattachments.ErrFileTransferFailed, objectstorage.ErrObjectNotFound, objectstorage.ErrObjectAlreadyExists),
	ruleFor(apiErrorChatAttachmentStorage, objectstorage.ErrStoreUnavailable, objectstorage.ErrProviderFailed),
}
