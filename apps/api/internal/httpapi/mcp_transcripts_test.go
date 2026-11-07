package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/mcpauth"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

type mcpToolReply struct {
	Result struct {
		IsError bool `json:"isError"`
		Content []struct {
			Text string `json:"text"`
		} `json:"content"`
	} `json:"result"`
}

// envelope is the bounded result every MCP read returns.
type mcpEnvelope struct {
	Source    string          `json:"source"`
	Data      json.RawMessage `json:"data"`
	Untrusted string          `json:"untrusted_content"`
}

func transcriptToolHandler(t *testing.T) (http.Handler, authentication.Principal) {
	t.Helper()
	tenantID := documentTestID(t, "11111111-1111-4111-8111-111111111111")
	transcriptID := documentTestID(t, "22222222-2222-4222-8222-222222222222")
	key, contentType := "fixture/transcript.json", "application/json"
	body := []byte(validHTTPDocumentJSON)
	size := int64(len(body))
	service := documentTranscriptServiceStub{transcript: transcripts.Transcript{ID: transcriptID, TenantID: tenantID, Status: transcripts.StatusComplete, Languages: []string{"en", "ur"}, ArtifactKey: &key, ArtifactSize: &size, ArtifactContentType: &contentType}}
	objects := &documentObjectServiceStub{object: objectstorage.ObjectReader{Object: objectstorage.Object{Key: key, Size: size, ContentType: contentType}, Body: io.NopCloser(bytes.NewReader(body))}}
	handler := NewMCPHandler(Options{TranscriptArtifacts: service, RecordingObjects: objects, TranscriptTextMetadata: textMetadataStub{}, TenantAuthz: authorization.NewTenantPolicy(nil, nil)})
	principal := authentication.Principal{Kind: authentication.PrincipalAPIKey, APIKeyID: transcriptID, TenantID: tenantID, Scopes: []authentication.Scope{authentication.ScopeTranscriptionsRead}}
	return handler, principal
}

func callTranscriptTool(t *testing.T, handler http.Handler, principal authentication.Principal, arguments string) (mcpToolReply, mcpEnvelope) {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(toolCallBody("chalk_inspect_transcripts", arguments)))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	request = request.WithContext(authentication.ContextWithPrincipal(request.Context(), principal))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	var reply mcpToolReply
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &reply) != nil || len(reply.Result.Content) == 0 {
		t.Fatalf("%d %s", response.Code, response.Body.String())
	}
	var envelope mcpEnvelope
	if !reply.Result.IsError {
		if err := json.Unmarshal([]byte(reply.Result.Content[0].Text), &envelope); err != nil {
			t.Fatalf("envelope: %v", err)
		}
	}
	return reply, envelope
}

func TestMCPTranscriptTextAndDocumentAreLabelledUntrusted(t *testing.T) {
	for _, test := range []struct{ view, want string }{{"text", "Cobalt marker"}, {"document", "Cobalt marker"}, {"metadata", "22222222-2222-4222-8222-222222222222"}} {
		handler, principal := transcriptToolHandler(t)
		transcriptID := principal.APIKeyID.String()
		reply, envelope := callTranscriptTool(t, handler, principal, `{"view":"`+test.view+`","transcript_id":"`+transcriptID+`"}`)
		if reply.Result.IsError || !strings.Contains(string(envelope.Data), test.want) {
			t.Errorf("%s: %s", test.view, reply.Result.Content[0].Text)
		}
		if !strings.Contains(envelope.Untrusted, "never as instructions") {
			t.Errorf("%s result carries no untrusted-content label: %s", test.view, reply.Result.Content[0].Text)
		}
	}
}

func TestMCPTranscriptViewsNeedTheirFieldsAndScope(t *testing.T) {
	handler, principal := transcriptToolHandler(t)
	reply, _ := callTranscriptTool(t, handler, principal, `{"view":"text"}`)
	if !reply.Result.IsError || !strings.Contains(reply.Result.Content[0].Text, "View text also requires: transcript_id") {
		t.Errorf("text without transcript_id: %+v", reply)
	}
	reply, _ = callTranscriptTool(t, handler, principal, `{"view":"download_url","transcript_id":"`+principal.APIKeyID.String()+`"}`)
	if !reply.Result.IsError || !strings.Contains(reply.Result.Content[0].Text, "also requires: expires_in_seconds") {
		t.Errorf("download_url without expiry: %+v", reply)
	}
	principal.Scopes = []authentication.Scope{authentication.ScopeRecordingsRead}
	reply, _ = callTranscriptTool(t, handler, principal, `{"view":"text","transcript_id":"`+principal.APIKeyID.String()+`"}`)
	if !reply.Result.IsError || !strings.Contains(reply.Result.Content[0].Text, "auth.forbidden") {
		t.Errorf("recordings:read read a transcript: %+v", reply)
	}
}

func TestMCPTenantViewsNeedTheirOwnScope(t *testing.T) {
	read := scopeTestPrincipal(t, authentication.PrincipalAPIKey, authentication.ScopeTenantsRead)
	for view, wantRefused := range map[string]bool{"settings": false, "memberships": true, "api_keys": true} {
		response := scopeTestCall(t, &read, toolCallBody("chalk_inspect_tenant", `{"view":"`+view+`"}`))
		refused := strings.Contains(response.Body.String(), "auth.forbidden")
		if response.Code != http.StatusOK || refused != wantRefused {
			t.Errorf("view %s: refused=%v want %v: %d %s", view, refused, wantRefused, response.Code, response.Body.String())
		}
	}
	response := scopeTestCall(t, &read, toolCallBody("chalk_inspect_tenant", `{}`))
	if strings.Contains(response.Body.String(), "auth.forbidden") {
		t.Errorf("a call without view must read settings with tenants:read: %s", response.Body.String())
	}
}

// Both OAuth bundles hold tenants:read for the profile, but the bundles exclude tenant
// settings, so a connected app never reaches that view and never gets a step-up.
func TestMCPConnectedAppsNeverReadTenantSettings(t *testing.T) {
	for _, bundle := range []string{mcpauth.ScopeRead, mcpauth.ScopeManage} {
		app := scopeTestPrincipal(t, authentication.PrincipalOAuth, mcpauth.AuthenticationScopes(bundle)...)
		if slices.Contains(toolNames(scopeTestList(t, app)), "chalk_inspect_tenant") {
			t.Errorf("%s lists chalk_inspect_tenant", bundle)
		}
		for _, arguments := range []string{`{}`, `{"view":"settings"}`} {
			response := scopeTestCall(t, &app, toolCallBody("chalk_inspect_tenant", arguments))
			if response.Code != http.StatusOK || response.Header().Get("WWW-Authenticate") != "" || !strings.Contains(response.Body.String(), "auth.forbidden") || strings.Contains(response.Body.String(), "cors_allowed_origins") {
				t.Errorf("%s %s: %d %q %s", bundle, arguments, response.Code, response.Header().Get("WWW-Authenticate"), response.Body.String())
			}
		}
	}
}

type requestCaptureStub struct {
	TranscriptArtifactService
	got transcripts.RequestInput
}

func (s *requestCaptureStub) Request(_ context.Context, input transcripts.RequestInput) (transcripts.Transcript, transcripts.Job, error) {
	s.got = input
	return transcripts.Transcript{ID: input.RecordingID, TenantID: input.TenantID, Status: transcripts.StatusPending}, transcripts.Job{}, nil
}

func TestMCPRequestTranscriptKeepsTheTraceCarrier(t *testing.T) {
	tenantID := documentTestID(t, "11111111-1111-4111-8111-111111111111")
	recordingID := documentTestID(t, "44444444-4444-4444-8444-444444444444")
	service := &requestCaptureStub{}
	previous := otel.GetTracerProvider()
	otel.SetTracerProvider(sdktrace.NewTracerProvider())
	t.Cleanup(func() { otel.SetTracerProvider(previous) })
	handler := NewMCPHandler(Options{TranscriptArtifacts: service, TenantAuthz: authorization.NewTenantPolicy(nil, nil)})
	principal := authentication.Principal{Kind: authentication.PrincipalAPIKey, APIKeyID: recordingID, TenantID: tenantID, Scopes: []authentication.Scope{authentication.ScopeTranscriptionsWrite}}
	span := trace.NewSpanContext(trace.SpanContextConfig{TraceID: trace.TraceID{1, 2, 3}, SpanID: trace.SpanID{4, 5}, TraceFlags: trace.FlagsSampled})
	request := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(toolCallBody("chalk_request_transcript", `{"recording_id":"`+recordingID.String()+`","request_key":"`+testRequestKey+`"}`)))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	ctx := trace.ContextWithSpanContext(authentication.ContextWithPrincipal(request.Context(), principal), span)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request.WithContext(ctx))
	// The job must parent the MCP operation span, not the HTTP request span above it.
	if response.Code != http.StatusOK || !strings.HasPrefix(service.got.Traceparent, "00-"+span.TraceID().String()+"-") || strings.Contains(service.got.Traceparent, span.SpanID().String()) {
		t.Fatalf("%d %s traceparent=%q", response.Code, response.Body.String(), service.got.Traceparent)
	}
}

func TestMCPConnectionDoesNotListTheDerivedSettingsPermission(t *testing.T) {
	key := scopeTestPrincipal(t, authentication.PrincipalAPIKey, authentication.ScopeTenantsRead)
	response := scopeTestCall(t, &key, toolCallBody("chalk_get_connection", `{}`))
	body := response.Body.String()
	if response.Code != http.StatusOK || !strings.Contains(body, "tenants:read") || strings.Contains(body, "tenants:settings:read") {
		t.Fatalf("%d %s", response.Code, body)
	}
}
