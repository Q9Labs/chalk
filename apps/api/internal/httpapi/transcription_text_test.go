package httpapi

import (
	"bytes"
	"context"
	"io"
	"mime"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestTranscriptTextRouteAuthorizationAndAttachment(t *testing.T) {
	tenantID := documentTestID(t, "11111111-1111-4111-8111-111111111111")
	transcriptID := documentTestID(t, "22222222-2222-4222-8222-222222222222")
	foreignTenant := documentTestID(t, "33333333-3333-4333-8333-333333333333")
	for _, test := range []struct {
		name      string
		principal *authentication.Principal
		status    int
	}{
		{"anonymous", nil, http.StatusUnauthorized},
		{"wrong scope", &authentication.Principal{Kind: authentication.PrincipalAPIKey, APIKeyID: transcriptID, TenantID: tenantID, Scopes: []authentication.Scope{authentication.ScopeRecordingsRead}}, http.StatusForbidden},
		{"foreign tenant", &authentication.Principal{Kind: authentication.PrincipalAPIKey, APIKeyID: transcriptID, TenantID: foreignTenant, Scopes: []authentication.Scope{authentication.ScopeTranscriptionsRead}}, http.StatusForbidden},
		{"transcription scope alone", &authentication.Principal{Kind: authentication.PrincipalAPIKey, APIKeyID: transcriptID, TenantID: tenantID, Scopes: []authentication.Scope{authentication.ScopeTranscriptionsRead}}, http.StatusOK},
	} {
		t.Run(test.name, func(t *testing.T) {
			key, contentType := "fixture/transcript.json", "application/json"
			body := []byte(validHTTPDocumentJSON)
			size := int64(len(body))
			service := documentTranscriptServiceStub{transcript: transcripts.Transcript{ID: transcriptID, TenantID: tenantID, Status: transcripts.StatusComplete, Languages: []string{"en", "ur"}, ArtifactKey: &key, ArtifactSize: &size, ArtifactContentType: &contentType}}
			objects := &documentObjectServiceStub{object: objectstorage.ObjectReader{Object: objectstorage.Object{Key: key, Size: size, ContentType: contentType}, Body: io.NopCloser(bytes.NewReader(body))}}
			endpoint := transcriptTextEndpoint(service, objects, textMetadataStub{}, authorization.NewTenantPolicy(nil, nil))
			router := chi.NewRouter()
			endpoint.Mount(router, RateLimitOptions{})
			request := httptest.NewRequest(http.MethodGet, "/tenants/"+tenantID.String()+"/transcripts/"+transcriptID.String()+"/text", nil)
			if test.principal != nil {
				request = request.WithContext(authentication.ContextWithPrincipal(request.Context(), *test.principal))
			}
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			if response.Code != test.status {
				t.Fatalf("response = %d %s", response.Code, response.Body.String())
			}
			if test.status != http.StatusOK {
				if objects.calls != 0 {
					t.Fatal("unauthorized request read artifact")
				}
				return
			}
			if response.Header().Get("Content-Type") != "text/plain; charset=utf-8" || response.Header().Get("Cache-Control") != "private, no-store" {
				t.Fatalf("headers = %v", response.Header())
			}
			if response.Header().Get("Content-Disposition") != `attachment; filename="Release-planning-2026-11-01.txt"` {
				t.Fatalf("filename = %q", response.Header().Get("Content-Disposition"))
			}
			if response.Body.String() != "Release planning · 1 Nov 2026 · 42 min\nLanguages: English, Urdu\n\n[00:00:00] Speaker One: Cobalt marker\n" {
				t.Fatalf("body = %q", response.Body.String())
			}
		})
	}
}

func TestTranscriptTextFilenameSanitization(t *testing.T) {
	date := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	for _, title := range []string{"Release / planning\r\n\";", "اردو اجتماع", "日本語 / planning", strings.Repeat("a", 1000)} {
		disposition := transcriptTextDisposition(title, date)
		if strings.ContainsAny(disposition, "\r\n") || len(disposition) > 1500 {
			t.Fatalf("unsafe disposition = %q", disposition)
		}
		kind, params, err := mime.ParseMediaType(disposition)
		if err != nil || kind != "attachment" || !strings.HasSuffix(params["filename"], "-2026-11-01.txt") {
			t.Fatalf("disposition = %q, parsed %v, %v", disposition, params, err)
		}
		if title == "اردو اجتماع" && (!strings.Contains(disposition, `filename="transcript-2026-11-01.txt"`) || params["filename"] != "اردو اجتماع-2026-11-01.txt") {
			t.Fatalf("non-ASCII filename lost: %q", disposition)
		}
	}
}

type textMetadataStub struct{}

func (textMetadataStub) GetTextMetadata(context.Context, utilities.ID, utilities.ID) (transcripts.TextMetadata, error) {
	return transcripts.TextMetadata{SpaceTitle: "Release planning", StartedAt: time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC), Duration: 42 * time.Minute}, nil
}
