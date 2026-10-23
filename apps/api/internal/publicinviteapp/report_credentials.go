package publicinviteapp

import (
	"context"
	"errors"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
)

// ReportCredentials reconstructs the current call invite without exposing it
// to the report delivery port. The report service has already bound the subject
// to a real participant before consulting this source.
type ReportCredentials struct{ Service publicinvites.Service }

func (r ReportCredentials) Credentials(ctx context.Context, subject accessgrants.Subject) ([]string, error) {
	invite, err := r.Service.GetInvite(ctx, subject.TenantID, subject.SpaceID)
	if errors.Is(err, publicinvites.ErrInviteNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	token, err := r.Service.IssueInviteToken(invite)
	if err != nil {
		return nil, err
	}
	return []string{token}, nil
}
