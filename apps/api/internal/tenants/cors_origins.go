package tenants

import (
	"bytes"
	"encoding/json"
	"net"
	"net/url"
	"sort"
	"strings"
	"unicode"
)

const (
	MaxCORSOrigins     = 32
	MaxCORSOriginBytes = 2048
	CORSOriginPattern  = `^(?:[Hh][Tt][Tt][Pp][Ss]://[^/?#@\s]+|[Hh][Tt][Tt][Pp]://(?:[Ll][Oo][Cc][Aa][Ll][Hh][Oo][Ss][Tt]|127(?:\.[0-9]+){0,3}|\[[0-9A-Fa-f:.]+\])(?::[0-9]+)?)$`
)

type OptionalCORSOrigins struct {
	Set   bool
	Value []string
}

func (o *OptionalCORSOrigins) UnmarshalJSON(data []byte) error {
	o.Set = true
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		return ErrInvalidCORSOrigin
	}
	return json.Unmarshal(data, &o.Value)
}

func CORSOrigins(values []string) ([]string, error) {
	if len(values) > MaxCORSOrigins {
		return nil, ErrInvalidCORSOrigin
	}
	unique := make(map[string]struct{}, len(values))
	for _, value := range values {
		origin, err := CORSOrigin(value)
		if err != nil {
			return nil, err
		}
		unique[origin] = struct{}{}
	}
	origins := make([]string, 0, len(unique))
	for origin := range unique {
		origins = append(origins, origin)
	}
	sort.Strings(origins)
	return origins, nil
}

func CORSOrigin(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > MaxCORSOriginBytes || strings.Contains(value, "*") {
		return "", ErrInvalidCORSOrigin
	}
	parsed, err := url.ParseRequestURI(value)
	if err != nil || *parsed != (url.URL{Scheme: parsed.Scheme, Host: parsed.Host}) || parsed.Host == "" {
		return "", ErrInvalidCORSOrigin
	}
	scheme := strings.ToLower(parsed.Scheme)
	hostname, err := browserHostname(strings.ToLower(parsed.Hostname()))
	if err != nil || !allowedOriginHost(scheme, hostname) {
		return "", ErrInvalidCORSOrigin
	}
	port, err := browserPort(scheme, parsed.Port())
	if err != nil {
		return "", err
	}
	if port != "" {
		return scheme + "://" + net.JoinHostPort(hostname, port), nil
	}
	if strings.Contains(hostname, ":") {
		hostname = "[" + hostname + "]"
	}
	return scheme + "://" + hostname, nil
}

// allowedOriginHost admits https for any ASCII host and http only for loopback.
func allowedOriginHost(scheme, hostname string) bool {
	if hostname == "" || strings.IndexFunc(hostname, func(character rune) bool { return character > unicode.MaxASCII }) >= 0 {
		return false
	}
	switch scheme {
	case "https":
		return true
	case "http":
		return loopbackHost(hostname)
	}
	return false
}
