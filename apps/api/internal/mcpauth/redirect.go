package mcpauth

import (
	"net"
	"net/url"
	"regexp"
	"slices"
	"strings"
)

var chatGPTConnectorPath = regexp.MustCompile(`^/connector/oauth/[A-Za-z0-9_-]{1,128}$`)

// validRedirectURI is the registration allowlist. A client can only register
// redirect URIs that belong to a known hosted connector, a loopback address
// (native apps such as Claude Code), or an exact URI the operator configured.
// Matching at /authorize is then exact against the registered string.
func (c Config) validRedirectURI(raw string) bool {
	if raw == "" || len(raw) > 512 || strings.ContainsAny(raw, "\\ \t\r\n") {
		return false
	}
	if slices.Contains(c.ExtraRedirectURIs, raw) {
		return true
	}
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.Fragment != "" || u.RawQuery != "" || u.ForceQuery || u.Opaque != "" || u.Port() != "" && u.Scheme == "https" {
		return false
	}
	if u.Scheme == "http" {
		return isLoopbackHost(u.Hostname()) && u.Path != "" && !strings.Contains(u.Path, "..") && !strings.Contains(u.Path, "//")
	}
	if u.Scheme != "https" {
		return false
	}
	switch u.Host {
	case "claude.ai", "claude.com":
		return u.Path == "/api/mcp/auth_callback"
	case "api.devin.ai":
		return u.Path == "/mcp/oauth/callback"
	case "chatgpt.com":
		return u.Path == "/connector_platform_oauth_redirect" || chatGPTConnectorPath.MatchString(u.Path)
	default:
		return false
	}
}

func isLoopbackHost(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// DisplayHost is the redirect host a person sees on the consent screen.
func DisplayHost(redirectURI string) string {
	u, err := url.Parse(redirectURI)
	if err != nil {
		return ""
	}
	return u.Host
}
