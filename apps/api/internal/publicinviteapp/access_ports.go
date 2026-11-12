package publicinviteapp

import (
	"context"
	"errors"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/synctokens"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	ErrAccessUnavailable = publicinvites.ErrAccessUnavailable
	ErrInvalidAccess     = errors.New("invalid public access adapter configuration")
)

type PublicJoinService interface {
	JoinPublic(context.Context, episodes.PublicJoinInput) (episodes.PublicJoinResult, error)
	FindPublic(context.Context, episodes.PublicAccessInput) (episodes.PublicJoinResult, error)
	LeavePublic(context.Context, episodes.PublicLeaveInput) (episodes.PublicLeaveResult, error)
	WaitPublicParticipantReady(context.Context, episodes.PublicParticipantKey) (episodes.PublicJoinResult, error)
}

type SpaceLookup interface {
	GetSpace(context.Context, utilities.ID, utilities.ID) (spaces.Space, error)
}

type TenantLookup interface {
	GetTenant(context.Context, utilities.ID) (tenants.Tenant, error)
}

type MediaResolver interface {
	ResolveEpisode(context.Context, tenants.Tenant, spaces.Space, utilities.ID) (*mediaplane.Service, error)
}

type SyncIssuer interface {
	IssueForParticipant(context.Context, synctokens.SubjectKey) (synctokens.Token, error)
}

type MediaIssuer interface {
	Issue(context.Context, accessgrants.Subject) (accessgrants.MediaCredential, error)
}

type MediaProofVerifier interface {
	Verify(context.Context, string) (accessgrants.Subject, error)
}

type MediaProofRecoveryVerifier interface {
	VerifyForRecovery(context.Context, string) (accessgrants.Subject, error)
}

type AccessConfig struct {
	Episodes           PublicJoinService
	Spaces             SpaceLookup
	Tenants            TenantLookup
	MediaResolver      MediaResolver
	SyncTokens         SyncIssuer
	MediaTokens        MediaIssuer
	MediaProof         MediaProofVerifier
	MediaProofRecovery MediaProofRecoveryVerifier
	// ManagedTenantID owns the anonymous public Spaces. Its guests have no
	// accountable owner, so they never receive relay (TURN) credentials.
	ManagedTenantID utilities.ID

	ReadyTimeout time.Duration
	PollInterval time.Duration
}
