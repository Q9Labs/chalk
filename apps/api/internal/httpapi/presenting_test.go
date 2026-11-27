package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/presenting"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestPresentingDocumentRoutes(t *testing.T) {
	participant, err := utilities.ParseID("12345678-1234-4234-8234-123456789abc")
	if err != nil {
		t.Fatal(err)
	}
	service := &presentingRouteProbe{}
	router := chi.NewRouter()
	for _, endpoint := range presentingEndpoints(service, presentingParticipantProbe{participant: participant}, nil) {
		endpoint.Mount(router, RateLimitOptions{})
	}
	for _, tc := range []struct {
		name, method, path, token, body string
		err                             error
		want                            int
	}{
		{"missing token", http.MethodPost, "/presenting/documents", "", `{}`, nil, http.StatusUnauthorized},
		{"permission denied", http.MethodPost, "/presenting/documents", "sync", `{"attachmentId":"12345678-1234-4234-8234-123456789abc"}`, presenting.ErrPermissionDenied, http.StatusForbidden},
		{"unsupported", http.MethodPost, "/presenting/documents", "sync", `{"attachmentId":"12345678-1234-4234-8234-123456789abc"}`, presenting.ErrUnsupportedType, http.StatusUnprocessableEntity},
		{"create", http.MethodPost, "/presenting/documents", "sync", `{"attachmentId":"12345678-1234-4234-8234-123456789abc"}`, nil, http.StatusOK},
		{"manifest", http.MethodGet, "/presenting/documents/12345678-1234-4234-8234-123456789abc", "sync", ``, nil, http.StatusOK},
		{"zoom missing", http.MethodGet, "/presenting/documents/12345678-1234-4234-8234-123456789abc/pages/2/zoom", "sync", ``, presenting.ErrZoomNotReady, http.StatusConflict},
	} {
		t.Run(tc.name, func(t *testing.T) {
			*service = presentingRouteProbe{err: tc.err}
			request := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
			request.Header.Set("content-type", "application/json")
			if tc.token != "" {
				request.Header.Set("authorization", "Bearer "+tc.token)
			}
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			if response.Code != tc.want {
				t.Fatalf("status = %d, want %d: %s", response.Code, tc.want, response.Body.String())
			}
			if tc.want == http.StatusUnauthorized && service.calls != 0 {
				t.Fatal("unauthenticated request reached service")
			}
		})
	}
}

type presentingParticipantProbe struct{ participant utilities.ID }

func (p presentingParticipantProbe) VerifyParticipant(_ context.Context, token string) (presenting.Subject, bool, error) {
	return presenting.Subject{ParticipantID: p.participant, ParticipantGeneration: 1}, token == "sync", nil
}

type presentingRouteProbe struct {
	calls int
	err   error
}

func (p *presentingRouteProbe) Create(context.Context, presenting.Subject, utilities.ID) (presenting.Document, error) {
	p.calls++
	id, _ := utilities.ParseID("12345678-1234-4234-8234-123456789abc")
	return presenting.Document{DocumentID: id, AttachmentID: id, FileName: "deck.pdf", Status: "preparing"}, p.err
}
func (p *presentingRouteProbe) Manifest(context.Context, presenting.Subject, utilities.ID) (presenting.Document, []presenting.Page, error) {
	p.calls++
	id, _ := utilities.ParseID("12345678-1234-4234-8234-123456789abc")
	return presenting.Document{DocumentID: id, AttachmentID: id, FileName: "deck.pdf", Status: "preparing"}, nil, p.err
}
func (p *presentingRouteProbe) Zoom(context.Context, presenting.Subject, utilities.ID, int) (string, time.Time, error) {
	p.calls++
	return "https://example.invalid/zoom", time.Now(), p.err
}
func (p *presentingRouteProbe) ClaimRender(context.Context, presenting.RenderCapability) (presenting.ControlAssignment, bool, error) {
	panic("unused")
}
func (p *presentingRouteProbe) HeartbeatRender(context.Context, presenting.RenderLease) error {
	panic("unused")
}
func (p *presentingRouteProbe) CompleteInventory(context.Context, presenting.InventoryReport) error {
	panic("unused")
}
func (p *presentingRouteProbe) MarkPageReady(context.Context, presenting.RenderLease, int) error {
	panic("unused")
}
func (p *presentingRouteProbe) CompleteRender(context.Context, presenting.RenderLease) error {
	panic("unused")
}
func (p *presentingRouteProbe) FailRender(context.Context, presenting.RenderLease, presenting.RenderFailure) error {
	panic("unused")
}
func (p *presentingRouteProbe) CompleteZoomRender(context.Context, presenting.RenderLease) error {
	panic("unused")
}
