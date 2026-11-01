package mcpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestCodeModeOfficialClientAndSharedPermissions(t *testing.T) {
	var logs bytes.Buffer
	previousLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previousLogger) })
	catalog := NewServer()
	Bind(catalog, ListSpaces, func(ctx context.Context, _ PageInput) (json.RawMessage, error) {
		return json.Marshal(struct {
			Spaces []string `json:"spaces"`
		}{[]string{Connection(ctx).TenantID}})
	})
	Bind(catalog, ListEpisodes, func(ctx context.Context, i SpacePageInput) (json.RawMessage, error) {
		if i.SpaceID != Connection(ctx).TenantID {
			return nil, Error{Code: "space.not_found", Message: "Space not found"}
		}
		return json.RawMessage(`{"episodes":["first","second"]}`), nil
	})
	mutations := 0
	Bind(catalog, DeleteTranscript, func(context.Context, TranscriptInput) (json.RawMessage, error) {
		mutations++
		return json.RawMessage(`{"completed":true}`), nil
	})
	transport := NewHandler(NewCodeServer(catalog), nil)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := WithPrincipal(r.Context(), Principal{TenantID: "11111111-1111-4111-8111-111111111111", Scopes: []string{"spaces:read", "episodes:read"}})
		transport.ServeHTTP(w, r.WithContext(ctx))
	}))
	defer server.Close()
	client := mcp.NewClient(&mcp.Implementation{Name: "code-proof", Version: "1"}, nil)
	session, err := client.Connect(t.Context(), &mcp.StreamableClientTransport{Endpoint: server.URL + "/mcp/code"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	listed, err := session.ListTools(t.Context(), nil)
	if err != nil || len(listed.Tools) != 2 {
		t.Fatalf("tool surface: %+v %v", listed, err)
	}
	result, err := session.CallTool(t.Context(), &mcp.CallToolParams{Name: SearchAPITool, Arguments: map[string]any{"query": "list", "limit": 1}})
	if err != nil || result.IsError {
		t.Fatalf("discovery failed: %+v %v", result, err)
	}
	text := result.Content[0].(*mcp.TextContent).Text
	if !strings.Contains(text, "declare namespace chalk") || !strings.Contains(text, "next_offset") {
		t.Fatalf("missing typed pagination: %s", text)
	}
	for _, test := range []struct{ code, want string }{
		{`const spaces = await chalk.list_spaces({}); const out = []; for (const space_id of spaces.result.data.spaces) { const episodes = await chalk.list_episodes({space_id}); out.push(...episodes.result.data.episodes.filter(x => x === "second")); } console.log("joined"); return out;`, `"value":["second"]`},
		{`return await chalk.delete_transcript({transcript_id:"11111111-1111-4111-8111-111111111111"})`, `"code":"auth.forbidden"`},
		{`return await chalk.list_episodes({space_id:"22222222-2222-4222-8222-222222222222"})`, `"code":"space.not_found"`},
		{`return await chalk.list_spaces({tenant_id:"foreign"})`, `"code":"mcp.invalid_arguments"`},
		{`return await chalk.list_spaces({page_size:51})`, `"code":"mcp.invalid_arguments"`},
		{`console.log("TRANSCRIPT_BODY_SENTINEL"); return {token:"TOKEN_SENTINEL",url:"https://download.example/?signature=SIGNED_URL_SENTINEL"}`, `"token":"TOKEN_SENTINEL"`},
	} {
		result, err := session.CallTool(t.Context(), &mcp.CallToolParams{Name: ExecuteTool, Arguments: executeInput{Code: test.code}})
		if err != nil || result.IsError {
			t.Fatalf("execution failed: %+v %v", result, err)
		}
		text := result.Content[0].(*mcp.TextContent).Text
		if !strings.Contains(text, test.want) {
			t.Fatalf("want %s in %s", test.want, text)
		}
		if _, ok := result.StructuredContent.(map[string]any); !ok {
			t.Fatal("structured result is not an object")
		}
	}
	if mutations != 0 {
		t.Fatal("sandbox bypassed scope checks")
	}
	oversized, err := session.CallTool(t.Context(), &mcp.CallToolParams{Name: ExecuteTool, Arguments: executeInput{Code: `return "<".repeat(12000)`}})
	if err != nil || !oversized.IsError || !strings.Contains(oversized.Content[0].(*mcp.TextContent).Text, "code.output_limit") {
		t.Fatalf("encoded output limit was not enforced: %+v %v", oversized, err)
	}
	lines := strings.Split(strings.TrimSpace(logs.String()), "\n")
	var terminal struct {
		Event   string `json:"event"`
		Outcome string `json:"outcome"`
	}
	if err := json.Unmarshal([]byte(lines[len(lines)-1]), &terminal); err != nil {
		t.Fatal(err)
	}
	if terminal.Event != "mcp.code.completed" || terminal.Outcome != "code.output_limit" {
		t.Fatalf("terminal audit disagrees with response: %+v", terminal)
	}
	for _, secret := range []string{"TRANSCRIPT_BODY_SENTINEL", "TOKEN_SENTINEL", "SIGNED_URL_SENTINEL"} {
		if strings.Contains(logs.String(), secret) {
			t.Fatal("code or output entered audit logs")
		}
	}
}
