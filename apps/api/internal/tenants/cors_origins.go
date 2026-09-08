package tenants

import (
	"bytes"
	"encoding/json"
	"net"
	"net/url"
	"sort"
	"strconv"
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
	hostname, err := browserHostname(strings.ToLower(parsed.Hostname()))
	if err != nil {
		return "", err
	}
	if hostname == "" || strings.IndexFunc(hostname, func(character rune) bool { return character > unicode.MaxASCII }) >= 0 || (scheme == "http" && !loopbackHost(hostname)) {
		return "", ErrInvalidCORSOrigin
	}
	port, err := browserPort(scheme, parsed.Port())
	if err != nil {
		return "", err
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

func browserHostname(hostname string) (string, error) {
	if ip := net.ParseIP(hostname); ip != nil {
		if strings.Contains(hostname, ":") {
			return ip.String(), nil
		}
		return ip.To4().String(), nil
	}
	if ipv4, numeric := browserIPv4(hostname); numeric {
		if ipv4 == "" {
			return "", ErrInvalidCORSOrigin
		}
		return ipv4, nil
	}
	return hostname, nil
}

func browserIPv4(hostname string) (string, bool) {
	parts := strings.Split(hostname, ".")
	if len(parts) > 1 && parts[len(parts)-1] == "" {
		parts = parts[:len(parts)-1]
	}
	if len(parts) == 0 || len(parts) > 4 {
		return "", false
	}
	numbers := make([]uint64, len(parts))
	for index, part := range parts {
		number, ok := browserIPv4Number(part)
		if !ok {
			return "", false
		}
		numbers[index] = number
	}
	for _, number := range numbers[:len(numbers)-1] {
		if number > 255 {
			return "", true
		}
	}
	lastLimit := uint64(1) << uint(8*(5-len(numbers)))
	if numbers[len(numbers)-1] >= lastLimit {
		return "", true
	}
	value := numbers[len(numbers)-1]
	for index, number := range numbers[:len(numbers)-1] {
		value += number << uint(8*(3-index))
	}
	return net.IPv4(byte(value>>24), byte(value>>16), byte(value>>8), byte(value)).String(), true
}

func browserIPv4Number(value string) (uint64, bool) {
	if value == "" {
		return 0, false
	}
	base := 10
	digits := value
	if len(value) >= 2 && value[:2] == "0x" {
		base = 16
		digits = value[2:]
	} else if len(value) >= 2 && value[0] == '0' {
		base = 8
		digits = value[1:]
	}
	if digits == "" {
		return 0, true
	}
	parsed, err := strconv.ParseUint(digits, base, 32)
	return parsed, err == nil
}

func browserPort(scheme string, value string) (string, error) {
	if value == "" {
		return "", nil
	}
	port, err := strconv.ParseUint(value, 10, 16)
	if err != nil {
		return "", ErrInvalidCORSOrigin
	}
	canonical := strconv.FormatUint(port, 10)
	if (scheme == "http" && canonical == "80") || (scheme == "https" && canonical == "443") {
		return "", nil
	}
	return canonical, nil
}

func loopbackHost(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
