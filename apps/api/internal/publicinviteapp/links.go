package publicinviteapp

import (
	"errors"
	"fmt"
	"net/url"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
)

var (
	ErrLinkPortUnavailable = errors.New("public invite link adapter unavailable")
	ErrInvalidLink         = errors.New("invalid public invite link")
)

// NewLinkPort builds canonical public invite URLs from the separately
// configured web origin. The origin is validated here as well as in config so
// callers cannot accidentally turn a path or credential-bearing URL into a
// shareable link.
func NewLinkPort(origin string) (publicinvites.Links, error) {
	origin = strings.TrimSpace(origin)
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" || parsed.Hostname() == "" || parsed.Opaque != "" || parsed.User != nil || parsed.Path != "" || parsed.RawPath != "" || parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" || strings.Contains(origin, "#") {
		return nil, fmt.Errorf("%w: origin must have only a scheme and host", ErrLinkPortUnavailable)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, fmt.Errorf("%w: origin must use http or https", ErrLinkPortUnavailable)
	}
	return linkPort{origin: origin}, nil
}

type linkPort struct {
	origin string
}

func (l linkPort) SpaceInviteURL(slug, token string) (string, error) {
	if slug == "" || token == "" {
		return "", ErrInvalidLink
	}
	return l.origin + "/space/" + url.PathEscape(slug) + "#spaceInviteToken=" + url.QueryEscape(token), nil
}

var _ publicinvites.Links = linkPort{}
