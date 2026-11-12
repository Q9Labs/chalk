package publicinviteapp

import (
	"errors"
	"net/url"

	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
)

var ErrInvalidLink = errors.New("invalid public invite link")

// NewLinkPort builds canonical public invite URLs from the separately
// configured web origin.
func NewLinkPort(origin publicinvites.WebOrigin) publicinvites.Links {
	return linkPort{origin: string(origin)}
}

type linkPort struct {
	origin string
}

func (l linkPort) InviteURL(code string) (string, error) {
	canonical, ok := publicinvites.ParseInviteCode(code)
	if !ok {
		return "", ErrInvalidLink
	}
	return l.origin + "/" + publicinvites.FormatInviteCode(canonical), nil
}

func (l linkPort) LegacyInviteURL(slug, token string) (string, error) {
	if slug == "" || token == "" {
		return "", ErrInvalidLink
	}
	return l.origin + "/space/" + url.PathEscape(slug) + "#spaceInviteToken=" + url.QueryEscape(token), nil
}

var _ publicinvites.Links = linkPort{}
