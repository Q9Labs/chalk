package mcpauth

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// OAuth Client ID Metadata Documents (CIMD): a client_id that is an https URL
// names a JSON document the client hosts. Chalk fetches it at /authorize, so a
// client needs no registration. The document can name only redirect URIs that
// pass the same allowlist as dynamic registration, so a hostile document cannot
// send a code anywhere new.
const (
	maxMetadataBytes   = 5 << 10
	maxClientIDLength  = 512
	metadataFetchLimit = 5 * time.Second
)

// MetadataFetcher returns the bytes of the document at an https client_id URL.
type MetadataFetcher interface {
	Fetch(ctx context.Context, clientID string) ([]byte, error)
}

// WithMetadataFetcher replaces the fetcher, for tests that must not use the network.
func (s Service) WithMetadataFetcher(fetcher MetadataFetcher) Service {
	s.metadata = fetcher
	return s
}

// IsMetadataClientID says whether a client_id names a metadata document.
func IsMetadataClientID(clientID string) bool { return strings.HasPrefix(clientID, "https://") }

type clientMetadata struct {
	ClientID                string   `json:"client_id"`
	ClientName              string   `json:"client_name"`
	RedirectURIs            []string `json:"redirect_uris"`
	TokenEndpointAuthMethod string   `json:"token_endpoint_auth_method"`
	// TokenEndpointAuthMethods is the client's full list; the singular field is its legacy preference.
	TokenEndpointAuthMethods []string `json:"token_endpoint_auth_methods_supported"`
	GrantTypes               []string `json:"grant_types"`
	ResponseTypes            []string `json:"response_types"`
	ClientSecret             *string  `json:"client_secret"`
}

// canAuthenticateAsPublicClient says whether the client can use the one method
// Chalk advertises, "none". A client may list several methods and prefer another
// one (ChatGPT prefers private_key_jwt and also lists none); it then uses a method
// the server advertises. A document with no method at all means none, per RFC 7591.
// Shared-secret methods never qualify: the CIMD draft forbids them.
func (d clientMetadata) canAuthenticateAsPublicClient() bool {
	methods := slices.Concat(d.TokenEndpointAuthMethods, []string{d.TokenEndpointAuthMethod})
	if slices.ContainsFunc(methods, func(m string) bool { return strings.HasPrefix(m, "client_secret") }) {
		return false
	}
	if len(d.TokenEndpointAuthMethods) > 0 {
		return slices.Contains(d.TokenEndpointAuthMethods, "none")
	}
	return d.TokenEndpointAuthMethod == "" || d.TokenEndpointAuthMethod == "none"
}

// metadataClient fetches and validates the document for clientID and makes sure
// a stored client row exists for it, so grants and requests can reference it.
// The returned client carries the document's current name and redirect URIs.
func (s Service) metadataClient(ctx context.Context, clientID string) (Client, *Error) {
	invalid := func(description string) (Client, *Error) {
		return Client{}, oauthError(400, "invalid_request", "client metadata document: "+description)
	}
	if err := validMetadataURL(clientID); err != nil {
		return invalid("client_id is not an allowed URL")
	}
	raw, err := s.metadata.Fetch(ctx, clientID)
	if err != nil {
		return invalid("could not be fetched")
	}
	var doc clientMetadata
	if json.Unmarshal(raw, &doc) != nil {
		return invalid("is not a JSON object")
	}
	if description := s.metadataProblem(doc, clientID); description != "" {
		return invalid(description)
	}
	client := Client{ClientID: clientID, Name: strings.TrimSpace(doc.ClientName), RedirectURIs: slices.Clone(doc.RedirectURIs)}
	return s.ensureStoredClient(ctx, client)
}

// metadataProblem names the first rule the document breaks, or returns "".
func (s Service) metadataProblem(doc clientMetadata, clientID string) string {
	name := strings.TrimSpace(doc.ClientName)
	switch {
	case doc.ClientID != clientID:
		return "client_id does not match its URL"
	case doc.ClientSecret != nil || !doc.canAuthenticateAsPublicClient():
		return "the client must support token_endpoint_auth_method=none: Chalk only issues tokens to public clients"
	case len(doc.GrantTypes) > 0 && !slices.Contains(doc.GrantTypes, "authorization_code"):
		return "grant_types must include authorization_code"
	case len(doc.ResponseTypes) > 0 && !slices.Contains(doc.ResponseTypes, "code"):
		return "response_types must include code"
	case name == "" || utf8.RuneCountInString(name) > maxClientNameRunes || !utf8.ValidString(name):
		return "client_name is required and must be at most 100 characters"
	case len(doc.RedirectURIs) == 0 || len(doc.RedirectURIs) > maxRedirectURIs:
		return "redirect_uris must list between 1 and 5 URIs"
	case slices.ContainsFunc(doc.RedirectURIs, func(uri string) bool { return !s.config.validRedirectURI(uri) }):
		return "a redirect URI is not allowed for this server"
	}
	return ""
}

func (s Service) ensureStoredClient(ctx context.Context, client Client) (Client, *Error) {
	temporary := func() (Client, *Error) {
		return Client{}, oauthError(500, "server_error", "temporary failure")
	}
	stored, err := s.repository.GetClient(ctx, client.ClientID)
	if err == nil {
		client.ID = stored.ID
		return client, nil
	}
	if !errors.Is(err, ErrClientNotFound) {
		return temporary()
	}
	if client.ID, err = utilities.NewID(); err != nil {
		return temporary()
	}
	if err := s.repository.CreateClient(ctx, client); err != nil {
		// A concurrent /authorize may have created the row first.
		stored, lookup := s.repository.GetClient(ctx, client.ClientID)
		if lookup != nil {
			return temporary()
		}
		client.ID = stored.ID
	}
	return client, nil
}

// validMetadataURL applies the CIMD rules for a client_id URL: https, a path, no
// credentials, query, fragment or dot segments, and the default port.
func validMetadataURL(raw string) error {
	if len(raw) > maxClientIDLength || strings.ContainsAny(raw, "\\ \t\r\n") {
		return errUnusableClientID
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.Opaque != "" || u.Port() != "" {
		return errUnusableClientID
	}
	host := strings.TrimSuffix(u.Hostname(), ".")
	if host == "" || net.ParseIP(host) != nil || strings.Contains(host, "*") || u.Path == "" || u.Path == "/" {
		return errUnusableClientID
	}
	if slices.ContainsFunc(strings.Split(u.Path, "/"), func(segment string) bool { return segment == "." || segment == ".." }) {
		return errUnusableClientID
	}
	return nil
}

var errUnusableClientID = errors.New("unusable client_id")

type publicResolver interface {
	LookupNetIP(ctx context.Context, network, host string) ([]netip.Addr, error)
}

// httpsMetadataFetcher fetches over TLS, to public addresses only, without
// redirects, proxies or cookies, with a small body and a short deadline.
type httpsMetadataFetcher struct {
	resolver publicResolver
	dial     func(ctx context.Context, network, address string) (net.Conn, error)
	roots    *x509.CertPool
}

func newHTTPSMetadataFetcher() httpsMetadataFetcher {
	dialer := net.Dialer{Timeout: 3 * time.Second}
	return httpsMetadataFetcher{resolver: net.DefaultResolver, dial: dialer.DialContext}
}

func (f httpsMetadataFetcher) Fetch(ctx context.Context, clientID string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, metadataFetchLimit)
	defer cancel()
	u, err := url.Parse(clientID)
	if err != nil {
		return nil, err
	}
	addresses, err := f.resolver.LookupNetIP(ctx, "ip", u.Hostname())
	if err != nil || len(addresses) == 0 {
		return nil, fmt.Errorf("resolve %s: %w", u.Hostname(), err)
	}
	// One non-public answer rejects the host, so a mixed DNS answer cannot pick the private address.
	for _, address := range addresses {
		if !utilities.PublicAddress(address) {
			return nil, errors.New("host resolves to a non-public address")
		}
	}
	pinned := addresses[0]
	transport := &http.Transport{
		Proxy:           nil,
		TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12, ServerName: u.Hostname(), RootCAs: f.roots},
		DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return f.dial(ctx, network, net.JoinHostPort(pinned.String(), "443"))
		},
		DisableKeepAlives:      true,
		ResponseHeaderTimeout:  metadataFetchLimit,
		MaxResponseHeaderBytes: 16 << 10,
	}
	client := &http.Client{Transport: transport, Timeout: metadataFetchLimit, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	// The request goes to the address that passed the public check; the document's own host stays in the
	// Host header and the TLS server name, so the certificate is still verified against it.
	target := url.URL{Scheme: "https", Host: net.JoinHostPort(pinned.String(), "443"), Path: u.Path, RawPath: u.RawPath}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return nil, err
	}
	request.Host = u.Hostname()
	request.Header.Set("Accept", "application/json")
	request.Header.Set("User-Agent", "Chalk-MCP-OAuth/1.0")
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("status %d", response.StatusCode)
	}
	if mediaType, _, err := mime.ParseMediaType(response.Header.Get("Content-Type")); err != nil || mediaType != "application/json" {
		return nil, errors.New("not application/json")
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxMetadataBytes+1))
	if err != nil {
		return nil, err
	}
	if len(body) > maxMetadataBytes {
		return nil, errors.New("document too large")
	}
	return body, nil
}
