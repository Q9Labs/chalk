package mcpauth

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
)

type memoryClients struct {
	Repository
	rows map[string]Client
}

func (m *memoryClients) GetClient(_ context.Context, id string) (Client, error) {
	if c, ok := m.rows[id]; ok {
		return c, nil
	}
	return Client{}, ErrClientNotFound
}

func (m *memoryClients) CreateClient(_ context.Context, c Client) error {
	m.rows[c.ClientID] = c
	return nil
}

type fixedDocument struct {
	body  string
	calls int
}

func (f *fixedDocument) Fetch(context.Context, string) ([]byte, error) {
	f.calls++
	return []byte(f.body), nil
}

const cimdID = "https://claude.ai/oauth/mcp-oauth-client-metadata"

func cimdDocument(overrides ...string) string {
	doc := `{"client_id":"` + cimdID + `","client_name":"Claude","redirect_uris":["https://claude.ai/api/mcp/auth_callback","http://localhost:8123/callback"],"token_endpoint_auth_method":"none"`
	return doc + strings.Join(overrides, "") + `}`
}

func TestMetadataClientAcceptsAValidDocumentAndStoresOneRow(t *testing.T) {
	repo := &memoryClients{rows: map[string]Client{}}
	fetcher := &fixedDocument{body: cimdDocument(`,"grant_types":["authorization_code","refresh_token"],"response_types":["code"],"client_uri":"https://claude.ai"`)}
	service := NewService(repo, Config{}).WithMetadataFetcher(fetcher)
	first, failure := service.metadataClient(context.Background(), cimdID)
	if failure != nil || first.Name != "Claude" || len(first.RedirectURIs) != 2 || first.ID.IsZero() {
		t.Fatalf("%+v %+v", first, failure)
	}
	second, failure := service.metadataClient(context.Background(), cimdID)
	if failure != nil || second.ID != first.ID || len(repo.rows) != 1 {
		t.Fatalf("second call must reuse the row: %+v %+v rows=%d", second, failure, len(repo.rows))
	}
}

func TestMetadataClientRefusesUnsafeDocuments(t *testing.T) {
	cases := map[string]string{
		"id mismatch":        strings.Replace(cimdDocument(), cimdID, "https://evil.test/doc", 1),
		"secret client":      cimdDocument(`,"client_secret":"s3cret"`),
		"confidential":       strings.Replace(cimdDocument(), `"none"`, `"client_secret_basic"`, 1),
		"no auth code grant": cimdDocument(`,"grant_types":["client_credentials"]`),
		"foreign redirect":   strings.Replace(cimdDocument(), "https://claude.ai/api/mcp/auth_callback", "https://evil.test/cb", 1),
		"no redirects":       strings.Replace(cimdDocument(), `["https://claude.ai/api/mcp/auth_callback","http://localhost:8123/callback"]`, `[]`, 1),
		"no name":            strings.Replace(cimdDocument(), `"client_name":"Claude",`, ``, 1),
		"not json":           `<html>`,
	}
	for name, body := range cases {
		repo := &memoryClients{rows: map[string]Client{}}
		service := NewService(repo, Config{}).WithMetadataFetcher(&fixedDocument{body: body})
		client, failure := service.metadataClient(context.Background(), cimdID)
		if failure == nil || failure.Status != http.StatusBadRequest || len(repo.rows) != 0 || client.ClientID != "" {
			t.Errorf("%s: accepted %+v %+v rows=%d", name, client, failure, len(repo.rows))
		}
	}
}

func TestMetadataClientIDMustBeAPlainHTTPSURL(t *testing.T) {
	for _, id := range []string{
		"https://claude.ai", "https://claude.ai/", "https://claude.ai:8443/x", "https://user@claude.ai/x", "https://claude.ai/x?a=1",
		"https://claude.ai/x#f", "https://claude.ai/a/../x", "https://127.0.0.1/x", "https://[::1]/x", "https://claude.ai/x y",
		"https://" + strings.Repeat("a", 600) + ".test/x",
	} {
		if validMetadataURL(id) == nil {
			t.Errorf("accepted %q", id)
		}
	}
	for _, id := range []string{cimdID, "https://app.example.test/.well-known/client.json"} {
		if err := validMetadataURL(id); err != nil {
			t.Errorf("refused %q: %v", id, err)
		}
	}
	if IsMetadataClientID("chalk_mcp_abc") || !IsMetadataClientID(cimdID) || IsMetadataClientID("http://claude.ai/x") {
		t.Error("IsMetadataClientID wrong")
	}
}

type fixedResolver []netip.Addr

func (r fixedResolver) LookupNetIP(context.Context, string, string) ([]netip.Addr, error) {
	return r, nil
}

func TestMetadataFetcherRefusesNonPublicAddressesWithoutDialing(t *testing.T) {
	public := netip.MustParseAddr("93.184.216.34")
	for name, answer := range map[string][]netip.Addr{
		"loopback":    {netip.MustParseAddr("127.0.0.1")},
		"private":     {netip.MustParseAddr("10.0.0.5")},
		"metadata":    {netip.MustParseAddr("169.254.169.254")},
		"ipv6 local":  {netip.MustParseAddr("fd00::1")},
		"mixed":       {public, netip.MustParseAddr("192.168.1.1")},
		"mapped ipv4": {netip.MustParseAddr("::ffff:127.0.0.1")},
	} {
		dialed := false
		fetcher := httpsMetadataFetcher{resolver: fixedResolver(answer), dial: func(context.Context, string, string) (net.Conn, error) {
			dialed = true
			return nil, errors.New("must not dial")
		}}
		if _, err := fetcher.Fetch(context.Background(), "https://client.example/doc"); err == nil || dialed {
			t.Errorf("%s: err=%v dialed=%v", name, err, dialed)
		}
	}
}

func TestMetadataFetcherReadsOnlySmallJSONFromThePinnedAddress(t *testing.T) {
	var behavior func(http.ResponseWriter, *http.Request)
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { behavior(w, r) }))
	defer server.Close()
	roots := server.Client().Transport.(*http.Transport).TLSClientConfig.RootCAs
	fetcher := httpsMetadataFetcher{
		resolver: fixedResolver{netip.MustParseAddr("93.184.216.34")},
		roots:    roots,
		dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
		},
	}
	json := func(w http.ResponseWriter, body string) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_, _ = w.Write([]byte(body))
	}
	cases := map[string]struct {
		handler func(http.ResponseWriter, *http.Request)
		wantErr bool
	}{
		"ok": {func(w http.ResponseWriter, _ *http.Request) { json(w, `{"client_id":"x"}`) }, false},
		"redirect": {func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, "https://127.0.0.1/", http.StatusFound)
		}, true},
		"not found": {func(w http.ResponseWriter, _ *http.Request) { http.NotFound(w, nil) }, true},
		"html": {func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "text/html")
			_, _ = w.Write([]byte("{}"))
		}, true},
		"oversized": {func(w http.ResponseWriter, _ *http.Request) {
			json(w, `{"x":"`+strings.Repeat("a", maxMetadataBytes)+`"}`)
		}, true},
	}
	for name, test := range cases {
		behavior = test.handler
		body, err := fetcher.Fetch(context.Background(), "https://example.com/doc")
		if (err != nil) != test.wantErr || err == nil && !strings.Contains(string(body), "client_id") {
			t.Errorf("%s: body=%q err=%v", name, body, err)
		}
	}
}
