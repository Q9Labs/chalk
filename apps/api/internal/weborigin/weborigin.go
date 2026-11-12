package weborigin

import (
	"errors"
	"net/url"
	"strings"
)

// ErrInvalid is returned for a web origin that cannot anchor invite links.
var ErrInvalid = errors.New("web origin must be an absolute http or https origin with no credentials, path, query, or fragment")

// Origin is the validated origin that public invite links hang off. Parse it
// once at the edge; a path or credential-bearing URL can never become a link.
type Origin string

// Parse trims and validates raw as a scheme-and-host origin.
func Parse(raw string) (Origin, error) {
	origin := strings.TrimSpace(raw)
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Hostname() == "" || parsed.Opaque != "" || parsed.User != nil ||
		parsed.Path != "" || parsed.RawPath != "" || parsed.RawQuery != "" || parsed.ForceQuery ||
		parsed.Fragment != "" || strings.Contains(origin, "#") {
		return "", ErrInvalid
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", ErrInvalid
	}
	return Origin(origin), nil
}

// Secure reports whether links under the origin use https.
func (o Origin) Secure() bool { return strings.HasPrefix(string(o), "https://") }
