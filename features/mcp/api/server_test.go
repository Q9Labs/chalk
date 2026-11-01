package mcpapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestTransportBoundsAndOrigin(t *testing.T) {
	server := NewServer()
	payload, _ := json.Marshal(struct {
		Text string `json:"text"`
	}{strings.Repeat("untrusted 🖍️ ", 10000)})
	Bind(server, ListSpaces, func(context.Context, PageInput) (json.RawMessage, error) { return payload, nil })
	transport := NewHandler(server, []string{"https://trusted.example"})
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		transport.ServeHTTP(w, r.WithContext(WithPrincipal(r.Context(), Principal{TenantID: "fixture-tenant", Scopes: []string{"spaces:read"}})))
	})
	instance := httptest.NewServer(handler)
	defer instance.Close()
	client := mcp.NewClient(&mcp.Implementation{Name: "bounds-proof", Version: "1"}, nil)
	session, err := client.Connect(t.Context(), &mcp.StreamableClientTransport{Endpoint: instance.URL}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	var collected strings.Builder
	offset := 0
	for {
		result, err := session.CallTool(t.Context(), &mcp.CallToolParams{Name: "chalk_list_spaces", Arguments: PageInput{ReadInput: ReadInput{ResultOffset: offset}}})
		if err != nil {
			t.Fatal(err)
		}
		if result.IsError {
			t.Fatalf("read fragment failed: %#v", result.Content)
		}
		if _, ok := result.StructuredContent.(map[string]any); !ok {
			t.Fatal("structured result must be a JSON object, not base64-encoded bytes")
		}
		block := result.Content[0].(*mcp.TextContent)
		var envelope boundedResult
		if err := json.Unmarshal([]byte(block.Text), &envelope); err != nil {
			t.Fatal(err)
		}
		if envelope.JSONFragment == nil || len(*envelope.JSONFragment) > MaxResultBytes {
			t.Fatal("result chunk is not bounded")
		}
		collected.WriteString(*envelope.JSONFragment)
		if envelope.NextOffset == nil {
			break
		}
		if *envelope.NextOffset <= offset {
			t.Fatal("continuation made no progress")
		}
		offset = *envelope.NextOffset
	}
	if collected.String() != string(payload) {
		t.Fatal("continuation lost UTF-8 content")
	}
	for _, origin := range []string{"https://evil.example", "null", "https://trusted.example/path", "https://trusted.example?query=x", "https://trusted.example#fragment"} {
		request := httptest.NewRequest(http.MethodPost, "http://server/mcp", strings.NewReader(`{}`))
		request.Header.Set("Origin", origin)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusForbidden || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("Origin %q accepted: %d", origin, response.Code)
		}
	}
	request := httptest.NewRequest(http.MethodGet, "http://server/mcp", nil)
	request.Header.Set("Accept", "text/event-stream")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusMethodNotAllowed {
		t.Fatal("standalone SSE must be unavailable")
	}
	request = httptest.NewRequest(http.MethodPost, "http://server/mcp", strings.NewReader(strings.Repeat("x", (1<<20)+1)))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusRequestEntityTooLarge {
		body, _ := io.ReadAll(response.Result().Body)
		t.Fatalf("oversized body: %d %s", response.Code, body)
	}
}
