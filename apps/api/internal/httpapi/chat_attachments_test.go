package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/chatattachments"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestChatAttachmentEndpointsUseParticipantTokenAndCamelCaseContract(t *testing.T) {
	subject := chatAttachmentHTTPSubject(t)
	attachmentID := chatAttachmentHTTPID(t, "55555555-5555-4555-8555-555555555555")
	uploadID := chatAttachmentHTTPID(t, "66666666-6666-4666-8666-666666666666")
	service := &chatAttachmentServiceStub{
		upload: chatattachments.UploadInstructions{
			AttachmentID: attachmentID,
			UploadID:     uploadID,
			Method:       http.MethodPut,
			URL:          "https://uploads.test/object",
			Headers: map[string]string{
				"Content-Type":                   "image/png",
				"X-Amz-Meta-Chalk-Attachment-Id": attachmentID.String(),
			},
			ExpiresAt: time.Date(2026, time.July, 30, 12, 10, 0, 0, time.UTC),
		},
	}
	verifier := &chatParticipantVerifierStub{subject: subject, valid: true}
	handler := chatAttachmentTestRouter(service, verifier)
	request := httptest.NewRequest(
		http.MethodPost,
		"/v1/chat/attachments/uploads",
		strings.NewReader(`{
			"clientAttachmentId":"chat-file-client-0001",
			"fileName":"diagram.png",
			"mimeType":"image/png",
			"byteLength":32,
			"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
		}`),
	)
	request.Header.Set("Authorization", "Bearer sync-token")
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["attachmentId"] != attachmentID.String() ||
		body["uploadId"] != uploadID.String() ||
		body["uploadUrl"] != service.upload.URL {
		t.Fatalf("response = %#v", body)
	}
	if _, exists := body["attachment_id"]; exists {
		t.Fatalf("response leaked snake_case field: %#v", body)
	}
	if verifier.token != "sync-token" || service.initiate.Subject != subject {
		t.Fatalf("token = %q, initiate = %#v", verifier.token, service.initiate)
	}
}

func TestChatAttachmentEndpointsFinalizeAndDownloadExactRoutes(t *testing.T) {
	subject := chatAttachmentHTTPSubject(t)
	attachmentID := chatAttachmentHTTPID(t, "55555555-5555-4555-8555-555555555555")
	uploadID := chatAttachmentHTTPID(t, "66666666-6666-4666-8666-666666666666")
	service := &chatAttachmentServiceStub{
		attachment: chatattachments.Attachment{
			AttachmentID: attachmentID,
			FileName:     "diagram.png",
			MIMEType:     "image/png",
			ByteLength:   32,
		},
		download: chatattachments.Download{
			URL:       "https://downloads.test/object",
			ExpiresAt: time.Date(2026, time.July, 30, 12, 2, 0, 0, time.UTC),
		},
	}
	handler := chatAttachmentTestRouter(
		service,
		&chatParticipantVerifierStub{subject: subject, valid: true},
	)

	finalize := httptest.NewRequest(
		http.MethodPost,
		"/v1/chat/attachments/uploads/"+uploadID.String()+"/finalize",
		nil,
	)
	finalize.Header.Set("Authorization", "Bearer sync-token")
	finalizeResponse := httptest.NewRecorder()
	handler.ServeHTTP(finalizeResponse, finalize)
	if finalizeResponse.Code != http.StatusOK || service.finalized != uploadID {
		t.Fatalf(
			"finalize status = %d, id = %s, body = %s",
			finalizeResponse.Code,
			service.finalized.String(),
			finalizeResponse.Body.String(),
		)
	}

	download := httptest.NewRequest(
		http.MethodGet,
		"/v1/chat/attachments/"+attachmentID.String()+"/download",
		nil,
	)
	download.Header.Set("Authorization", "Bearer sync-token")
	downloadResponse := httptest.NewRecorder()
	handler.ServeHTTP(downloadResponse, download)
	if downloadResponse.Code != http.StatusOK ||
		service.downloaded != attachmentID {
		t.Fatalf(
			"download status = %d, body = %s",
			downloadResponse.Code,
			downloadResponse.Body.String(),
		)
	}
	if !strings.Contains(
		downloadResponse.Body.String(),
		`"downloadUrl":"https://downloads.test/object"`,
	) {
		t.Fatalf("download body = %s", downloadResponse.Body.String())
	}
}

func TestChatAttachmentEndpointsRejectMissingOrInvalidParticipantToken(t *testing.T) {
	service := &chatAttachmentServiceStub{}
	handler := chatAttachmentTestRouter(
		service,
		&chatParticipantVerifierStub{valid: false},
	)
	for _, authorization := range []string{"", "Bearer invalid"} {
		request := httptest.NewRequest(
			http.MethodGet,
			"/v1/chat/attachments/55555555-5555-4555-8555-555555555555/download",
			nil,
		)
		request.Header.Set("Authorization", authorization)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("authorization %q status = %d", authorization, response.Code)
		}
	}
}

type chatAttachmentServiceStub struct {
	upload     chatattachments.UploadInstructions
	attachment chatattachments.Attachment
	download   chatattachments.Download
	initiate   chatattachments.InitiateInput
	finalized  utilities.ID
	downloaded utilities.ID
	err        error
}

func (s *chatAttachmentServiceStub) Initiate(
	_ context.Context,
	input chatattachments.InitiateInput,
) (chatattachments.UploadInstructions, error) {
	s.initiate = input
	return s.upload, s.err
}

func (s *chatAttachmentServiceStub) Finalize(
	_ context.Context,
	_ chatattachments.Subject,
	uploadID utilities.ID,
) (chatattachments.Attachment, error) {
	s.finalized = uploadID
	return s.attachment, s.err
}

func (s *chatAttachmentServiceStub) Download(
	_ context.Context,
	_ chatattachments.Subject,
	attachmentID utilities.ID,
) (chatattachments.Download, error) {
	s.downloaded = attachmentID
	return s.download, s.err
}

type chatParticipantVerifierStub struct {
	subject chatattachments.Subject
	valid   bool
	token   string
	err     error
}

func (v *chatParticipantVerifierStub) VerifyChatParticipant(
	_ context.Context,
	token string,
) (chatattachments.Subject, bool, error) {
	v.token = token
	return v.subject, v.valid, v.err
}

func chatAttachmentTestRouter(
	service ChatAttachmentService,
	verifier ChatParticipantVerifier,
) http.Handler {
	router := chi.NewRouter()
	router.Route("/v1", func(v1 chi.Router) {
		mountChatAttachmentRoutes(v1, service, verifier, RateLimitOptions{})
	})
	return router
}

func chatAttachmentHTTPSubject(t *testing.T) chatattachments.Subject {
	t.Helper()
	return chatattachments.Subject{
		TenantID:              chatAttachmentHTTPID(t, "11111111-1111-4111-8111-111111111111"),
		RoomID:                chatAttachmentHTTPID(t, "22222222-2222-4222-8222-222222222222"),
		SessionID:             chatAttachmentHTTPID(t, "33333333-3333-4333-8333-333333333333"),
		ParticipantSessionID:  chatAttachmentHTTPID(t, "44444444-4444-4444-8444-444444444444"),
		ParticipantGeneration: 1,
	}
}

func chatAttachmentHTTPID(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatal(err)
	}
	return id
}
