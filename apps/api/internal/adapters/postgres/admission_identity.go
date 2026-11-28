package postgres

import (
	"context"
	"fmt"

	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func resolveAdmissionIdentity(ctx context.Context, queries *sqlc.Queries, input *episodes.AdmitParticipantInput) error {
	if input.IdentityExternalID == "" {
		return nil
	}
	identityID, err := utilities.NewID()
	if err != nil {
		return fmt.Errorf("allocate admission identity: %w", err)
	}
	identity, err := queries.ResolveAdmissionIdentity(ctx, sqlc.ResolveAdmissionIdentityParams{
		ID: uuid(identityID), TenantID: uuid(input.TenantID), Kind: string(input.IdentityKind), ExternalID: input.IdentityExternalID, DisplayName: input.Name,
	})
	if err != nil {
		return fmt.Errorf("resolve admission identity: %w", err)
	}
	if identity.Kind != string(input.IdentityKind) {
		return episodes.ErrIdentityKindConflict
	}
	input.IdentityID = utilities.IDFromBytes(identity.ID.Bytes)
	return nil
}
