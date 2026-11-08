//go:build mcp_eval

package postgres

import (
	"context"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type admissionProofAccounts struct{ publicinvites.Accounts }

type directAdmissionMedia struct {
	service mediaplane.Service
	binding mediaplane.Binding
}

func (m directAdmissionMedia) ResolveEpisode(context.Context, tenants.Tenant, spaces.Space, utilities.ID) (*mediaplane.Service, error) {
	return &m.service, nil
}

func (m directAdmissionMedia) ResolveBinding(context.Context, tenants.Tenant, spaces.Space, mediaplane.ClientProviders) (*mediaplane.Binding, error) {
	return &m.binding, nil
}

// mcpInviteLinks gives the invite view a canonical URL; the shared proof stub has no links.
type mcpInviteLinks struct{ publicinvites.Links }

func (mcpInviteLinks) InviteURL(code string) (string, error) {
	return "https://invite.example/" + code, nil
}

type terminalAdmissionAccess struct {
	publicinvites.Access
	grant     func(context.Context, publicinvites.PublicAccessInput) (publicinvites.PublicAccessGrant, error)
	discarded int
}

func (a *terminalAdmissionAccess) GrantPublicAccess(ctx context.Context, input publicinvites.PublicAccessInput) (publicinvites.PublicAccessGrant, error) {
	return a.grant(ctx, input)
}

func (a *terminalAdmissionAccess) DiscardPublicAccess(context.Context, publicinvites.PublicAccessGrant) error {
	a.discarded++
	return nil
}
