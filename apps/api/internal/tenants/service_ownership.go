package tenants

import (
	"errors"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var ErrServiceOwnershipConflict = errors.New("Tenant missing or already owned by another service")

type AdoptServiceInput struct {
	TenantID   utilities.ID
	ServiceID  string
	ExternalID *string
	Actor      string
	Reason     string
}

func (input AdoptServiceInput) Validate() error {
	if input.TenantID.IsZero() {
		return ErrInvalidTenantID
	}
	if !ValidServiceID(input.ServiceID) || input.ExternalID != nil && !ValidExternalID(*input.ExternalID) || strings.TrimSpace(input.Actor) == "" || strings.TrimSpace(input.Reason) == "" {
		return ErrInvalidTenantField
	}
	return nil
}
