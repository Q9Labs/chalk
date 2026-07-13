package webhooks

import (
	"net"
	"net/netip"
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

func PublicAddress(address netip.Addr) bool {
	address = address.Unmap()
	if !address.IsValid() || address.IsLoopback() || address.IsPrivate() || address.IsLinkLocalUnicast() || address.IsLinkLocalMulticast() || address.IsMulticast() || address.IsUnspecified() {
		return false
	}
	if address.Is6() && !globalIPv6Prefix.Contains(address) {
		return false
	}
	for _, prefix := range blockedPrefixes {
		if prefix.Contains(address) {
			return false
		}
	}
	return true
}

var globalIPv6Prefix = netip.MustParsePrefix("2000::/3")

var blockedPrefixes = mustPrefixes(
	"0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24", "198.18.0.0/15",
	"192.88.99.0/24", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4",
	"::/96", "64:ff9b::/96", "64:ff9b:1::/48", "100::/64", "2001::/23", "2001:db8::/32",
	"2002::/16", "3fff::/20", "5f00::/16", "fc00::/7", "fe80::/10", "ff00::/8",
)

func mustPrefixes(values ...string) []netip.Prefix {
	result := make([]netip.Prefix, 0, len(values))
	for _, value := range values {
		result = append(result, netip.MustParsePrefix(value))
	}
	return result
}
