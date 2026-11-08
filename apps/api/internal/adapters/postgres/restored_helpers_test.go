package postgres

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type admissionProofAccounts struct{ publicinvites.Accounts }

func mustExec(t *testing.T, db sqlc.DBTX, statement string, arguments ...any) {
	t.Helper()
	if _, err := db.Exec(context.Background(), statement, arguments...); err != nil {
		t.Fatal(err)
	}
}

func mcpText(result *mcp.CallToolResult) string {
	var text strings.Builder
	for _, content := range result.Content {
		if c, ok := content.(*mcp.TextContent); ok {
			text.WriteString(c.Text)
		}
	}
	return text.String()
}

func accountTenantIntegrationPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	databaseURL := os.Getenv("CHALK_TENANT_ONBOARDING_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("CHALK_TENANT_ONBOARDING_TEST_DATABASE_URL is not set")
	}
	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

type directAdmissionMedia struct {
	service mediaplane.Service
	binding mediaplane.Binding
}

func (m directAdmissionMedia) ResolveEpisode(context.Context, tenants.Tenant, spaces.Space, utilities.ID) (*mediaplane.Service, error) {
	return &m.service, nil
}

func (m directAdmissionMedia) ResolveBinding(tenants.Tenant, spaces.Space, mediaplane.ClientProviders) (*mediaplane.Binding, error) {
	return &m.binding, nil
}

// mcpInviteLinks gives the invite view a canonical URL; the shared proof stub has no links.
type mcpInviteLinks struct{ publicinvites.Links }

func (mcpInviteLinks) InviteURL(code string) (string, error) {
	return "https://invite.example/" + code, nil
}

func connectMCP(t *testing.T, server *httptest.Server, token, version string) *mcp.ClientSession {
	t.Helper()
	client := mcp.NewClient(&mcp.Implementation{Name: "chalk-integration", Version: "1"}, nil)
	httpClient := &http.Client{Transport: mcpHeaderTransport{token: token, next: server.Client().Transport}}
	session, err := client.Connect(t.Context(), &mcp.StreamableClientTransport{Endpoint: server.URL + "/mcp", HTTPClient: httpClient}, &mcp.ClientSessionOptions{ProtocolVersion: version})
	if err != nil {
		t.Fatalf("MCP initialize (%s): %v", version, err)
	}
	if result := session.InitializeResult(); result.ProtocolVersion != version {
		t.Fatalf("negotiated %s, want %s", result.ProtocolVersion, version)
	}
	t.Cleanup(func() {
		if err := session.Close(); err != nil {
			t.Error(err)
		}
	})
	return session
}

type terminalAdmissionAccess struct {
	publicinvites.Access
	grant     func(context.Context, publicinvites.PublicAccessInput) (publicinvites.PublicAccessGrant, error)
	discarded int
}

func (a *terminalAdmissionAccess) GrantPublicAccess(ctx context.Context, input publicinvites.PublicAccessInput) (publicinvites.PublicAccessGrant, error) {
	return a.grant(ctx, input)
}

func (a *terminalAdmissionAccess) DiscardPublicAccess(context.Context, publicinvites.PublicAccessGrant) error {
	a.discarded++
	return nil
}

func callMCP(t *testing.T, session *mcp.ClientSession, name, args string) *mcp.CallToolResult {
	t.Helper()
	result, err := session.CallTool(t.Context(), &mcp.CallToolParams{Name: "chalk_" + name, Arguments: json.RawMessage(args)})
	if err != nil {
		t.Fatalf("MCP %s protocol failure: %v", name, err)
	}
	return result
}

type mcpHeaderTransport struct {
	token string
	next  http.RoundTripper
}

func (h mcpHeaderTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	clone := r.Clone(r.Context())
	clone.Header = r.Header.Clone()
	clone.Header.Set("Authorization", "Bearer "+h.token)
	return h.next.RoundTrip(clone)
}
