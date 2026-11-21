package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/whiteboardfiles"
)

func TestWhiteboardFileWriteRoutes(t *testing.T) {
	scene, err := utilities.ParseID("12345678-1234-4234-8234-123456789abc")
	if err != nil {
		t.Fatal(err)
	}
	service := &writeWhiteboardFileProbe{}
	router := chi.NewRouter()
	for _, endpoint := range whiteboardFileEndpoints(service, whiteboardParticipantProbe{subject: whiteboardfiles.Subject{ParticipantID: scene}}) {
		endpoint.Mount(router, RateLimitOptions{})
	}

	path := "/whiteboard/scenes/" + scene.String() + "/files/frame/"
	for _, tc := range []struct {
		name, action, token, body string
		error                     error
		want                      int
	}{
		{"missing token", "upload", "", "{}", nil, http.StatusUnauthorized},
		{"invalid token", "finalize", "invalid", "{}", nil, http.StatusUnauthorized},
		{"permission denied", "upload", "sync", "{}", whiteboardfiles.ErrPermissionDenied, http.StatusForbidden},
		{"invalid metadata", "upload", "sync", "{}", whiteboardfiles.ErrInvalidInput, http.StatusBadRequest},
		{"content conflict", "upload", "sync", "{}", whiteboardfiles.ErrFileConflict, http.StatusConflict},
		{"upload", "upload", "sync", `{"mimeType":"image/png","byteLength":100,"sha256":"digest"}`, nil, http.StatusOK},
		{"finalize", "finalize", "sync", `{"sha256":"digest"}`, nil, http.StatusNoContent},
	} {
		t.Run(tc.name, func(t *testing.T) {
			*service = writeWhiteboardFileProbe{err: tc.error}
			request := httptest.NewRequest(http.MethodPost, path+tc.action, strings.NewReader(tc.body))
			request.Header.Set("Content-Type", "application/json")
			if tc.token != "" {
				request.Header.Set("Authorization", "Bearer "+tc.token)
			}
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			if response.Code != tc.want {
				t.Fatalf("status = %d, want %d: %s", response.Code, tc.want, response.Body.String())
			}
			if tc.want == http.StatusUnauthorized {
				if service.request.FileID != "" {
					t.Fatal("unauthenticated request reached service")
				}
			} else if service.request.Subject.ParticipantID != scene || service.request.SceneID != scene || service.request.FileID != "frame" {
				t.Fatalf("service request = %+v", service.request)
			}
			if tc.want < 300 && service.digest != "digest" {
				t.Fatalf("digest = %q", service.digest)
			}
		})
	}
}

type whiteboardParticipantProbe struct{ subject whiteboardfiles.Subject }

func (p whiteboardParticipantProbe) VerifyParticipant(_ context.Context, token string) (whiteboardfiles.Subject, bool, error) {
	return p.subject, token == "sync", nil
}

type writeWhiteboardFileProbe struct {
	WhiteboardFileService
	request whiteboardfiles.FileRequest
	digest  string
	err     error
}

func (p *writeWhiteboardFileProbe) Initiate(_ context.Context, input whiteboardfiles.InitiateInput) (whiteboardfiles.UploadInstructions, error) {
	p.request, p.digest = input.FileRequest, input.SHA256
	return whiteboardfiles.UploadInstructions{Ready: true}, p.err
}

func (p *writeWhiteboardFileProbe) Finalize(_ context.Context, request whiteboardfiles.FileRequest, digest string) error {
	p.request, p.digest = request, digest
	return p.err
}
