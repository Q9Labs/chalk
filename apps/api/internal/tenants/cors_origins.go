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
	if value == "" || len([]byte(value)) > MaxCORSOriginBytes || strings.Contains(value, "*") {
		return "", ErrInvalidCORSOrigin
	}
	parsed, err := url.ParseRequestURI(value)
	if err != nil || parsed.Opaque != "" || parsed.User != nil || parsed.Host == "" || parsed.Path != "" || parsed.RawPath != "" || parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" {
		return "", ErrInvalidCORSOrigin
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "http" && scheme != "https" {
		return "", ErrInvalidCORSOrigin
	}
	hostname := strings.ToLower(parsed.Hostname())
	if hostname == "" || strings.IndexFunc(hostname, func(character rune) bool { return character > unicode.MaxASCII }) >= 0 || (scheme == "http" && !loopbackHost(hostname)) {
		return "", ErrInvalidCORSOrigin
	}
	port := parsed.Port()
	if (scheme == "http" && port == "80") || (scheme == "https" && port == "443") {
		port = ""
	}
	host := hostname
	if strings.Contains(hostname, ":") {
		host = "[" + hostname + "]"
	}
	if port != "" {
		host = net.JoinHostPort(hostname, port)
	}
	return scheme + "://" + host, nil
}

func loopbackHost(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
