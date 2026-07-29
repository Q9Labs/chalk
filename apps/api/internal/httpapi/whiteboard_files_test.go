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
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/whiteboardfiles"
)

func TestWhiteboardFileEndpointsUseParticipantTokenAndCamelCaseContract(t *testing.T) {
	subject := whiteboardTestSubject(t)
	uploadID := whiteboardTestID(t, "66666666-6666-4666-8666-666666666666")
	service := &whiteboardFileServiceStub{
		upload: whiteboardfiles.UploadInstructions{
			UploadID: uploadID, Method: http.MethodPut, URL: "https://uploads.test/object",
			Headers:   map[string]string{"Content-Type": "image/png", "If-None-Match": "*"},
			ExpiresAt: time.Date(2026, time.July, 29, 12, 10, 0, 0, time.UTC),
		},
	}
	verifier := &whiteboardParticipantVerifierStub{subject: subject, valid: true}
	handler := whiteboardFileTestRouter(service, verifier)
	request := httptest.NewRequest(http.MethodPost, "/v1/whiteboard/files/uploads", strings.NewReader(`{
		"sceneId":"55555555-5555-4555-8555-555555555555",
		"fileId":"image-1",
		"mimeType":"image/png",
		"byteLength":32,
		"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	}`))
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
	if body["uploadId"] != uploadID.String() || body["method"] != http.MethodPut || body["uploadUrl"] != service.upload.URL {
		t.Fatalf("response = %#v", body)
	}
	if _, exists := body["upload_id"]; exists {
		t.Fatalf("response leaked snake_case field: %#v", body)
	}
	if verifier.token != "sync-token" || service.initiate.Subject != subject {
		t.Fatalf("token = %q, initiate = %#v", verifier.token, service.initiate)
	}
}

func TestWhiteboardFileEndpointsFinalizeAndDownloadExactRoutes(t *testing.T) {
	subject := whiteboardTestSubject(t)
	uploadID := whiteboardTestID(t, "66666666-6666-4666-8666-666666666666")
	service := &whiteboardFileServiceStub{
		download: whiteboardfiles.Download{
			URL:       "https://downloads.test/object",
			ExpiresAt: time.Date(2026, time.July, 29, 12, 2, 0, 0, time.UTC),
		},
	}
	handler := whiteboardFileTestRouter(service, &whiteboardParticipantVerifierStub{subject: subject, valid: true})

	finalize := httptest.NewRequest(http.MethodPost, "/v1/whiteboard/files/uploads/"+uploadID.String()+"/finalize", nil)
	finalize.Header.Set("Authorization", "Bearer sync-token")
	finalizeResponse := httptest.NewRecorder()
	handler.ServeHTTP(finalizeResponse, finalize)
	if finalizeResponse.Code != http.StatusNoContent || service.finalized != uploadID {
		t.Fatalf("finalize status = %d, id = %s", finalizeResponse.Code, service.finalized.String())
	}

	download := httptest.NewRequest(http.MethodGet, "/v1/whiteboard/files/image-1/download", nil)
	download.Header.Set("Authorization", "Bearer sync-token")
	downloadResponse := httptest.NewRecorder()
	handler.ServeHTTP(downloadResponse, download)
	if downloadResponse.Code != http.StatusOK || service.fileID != "image-1" {
		t.Fatalf("download status = %d, body = %s", downloadResponse.Code, downloadResponse.Body.String())
	}
	if !strings.Contains(downloadResponse.Body.String(), `"downloadUrl":"https://downloads.test/object"`) {
		t.Fatalf("download body = %s", downloadResponse.Body.String())
	}
}

func TestWhiteboardFileEndpointsRejectMissingOrInvalidParticipantToken(t *testing.T) {
	service := &whiteboardFileServiceStub{}
	handler := whiteboardFileTestRouter(service, &whiteboardParticipantVerifierStub{valid: false})
	for _, authorization := range []string{"", "Bearer invalid"} {
		request := httptest.NewRequest(http.MethodGet, "/v1/whiteboard/files/image-1/download", nil)
		request.Header.Set("Authorization", authorization)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("authorization %q status = %d", authorization, response.Code)
		}
	}
}

type whiteboardFileServiceStub struct {
	upload    whiteboardfiles.UploadInstructions
	download  whiteboardfiles.Download
	initiate  whiteboardfiles.InitiateInput
	finalized utilities.ID
	fileID    string
	err       error
}

func (s *whiteboardFileServiceStub) Initiate(_ context.Context, input whiteboardfiles.InitiateInput) (whiteboardfiles.UploadInstructions, error) {
	s.initiate = input
	return s.upload, s.err
}

func (s *whiteboardFileServiceStub) Finalize(_ context.Context, _ whiteboardfiles.Subject, uploadID utilities.ID) error {
	s.finalized = uploadID
	return s.err
}

func (s *whiteboardFileServiceStub) Download(_ context.Context, _ whiteboardfiles.Subject, fileID string) (whiteboardfiles.Download, error) {
	s.fileID = fileID
	return s.download, s.err
}

type whiteboardParticipantVerifierStub struct {
	subject whiteboardfiles.Subject
	valid   bool
	token   string
	err     error
}

func (v *whiteboardParticipantVerifierStub) VerifyWhiteboardParticipant(_ context.Context, token string) (whiteboardfiles.Subject, bool, error) {
	v.token = token
	return v.subject, v.valid, v.err
}

func whiteboardFileTestRouter(service WhiteboardFileService, verifier WhiteboardParticipantVerifier) http.Handler {
	router := chi.NewRouter()
	router.Route("/v1", func(v1 chi.Router) {
		for _, endpoint := range whiteboardFileEndpoints(service, verifier) {
			endpoint.Mount(v1, RateLimitOptions{})
		}
	})
	return router
}

func whiteboardTestSubject(t *testing.T) whiteboardfiles.Subject {
	t.Helper()
	return whiteboardfiles.Subject{
		TenantID:              whiteboardTestID(t, "11111111-1111-4111-8111-111111111111"),
		RoomID:                whiteboardTestID(t, "22222222-2222-4222-8222-222222222222"),
		SessionID:             whiteboardTestID(t, "33333333-3333-4333-8333-333333333333"),
		ParticipantSessionID:  whiteboardTestID(t, "44444444-4444-4444-8444-444444444444"),
		ParticipantGeneration: 1,
	}
}

func whiteboardTestID(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatal(err)
	}
	return id
}
