package webhooks

import (
	"net"
	"net/url"
	"strings"
)

func ValidateEndpointURL(raw string) (string, string, error) {
	if len(raw) == 0 || len(raw) > 2048 {
		return "", "", ErrInvalidURL
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.Fragment != "" {
		return "", "", ErrInvalidURL
	}
	if parsed.Port() != "" && parsed.Port() != "443" {
		return "", "", ErrInvalidURL
	}
	host := strings.TrimSuffix(parsed.Hostname(), ".")
	if host == "" || strings.Contains(host, "*") || net.ParseIP(host) != nil {
		return "", "", ErrUnsafeURL
	}
	parsed.Host = strings.ToLower(host)
	if parsed.Port() == "443" {
		parsed.Host += ":443"
	}
	redacted := *parsed
	if redacted.RawQuery != "" {
		redacted.RawQuery = "REDACTED"
	}
	return parsed.String(), redacted.String(), nil
}
