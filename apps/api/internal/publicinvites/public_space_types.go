package publicinvites

import (
	"context"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type PublicSpace struct {
	MaximumEpisodeDurationSeconds int32
	TenantID                      utilities.ID
	SpaceID                       utilities.ID
	Name                          string
	Slug                          string
	AdmissionMode                 AdmissionMode
	Archived                      bool
}

type ManagedInvite struct {
	Invite
	CanonicalURL string
}

type Space interface {
	CreatePublicSpace(context.Context, CreatePublicSpaceInput) (PublicSpace, error)
	GetPublicSpace(context.Context, utilities.ID, utilities.ID) (PublicSpace, error)
}

type Links interface {
	InviteURL(string) (string, error)
	LegacyInviteURL(string, string) (string, error)
}

type Access interface {
	GrantPublicAccess(context.Context, PublicAccessInput) (PublicAccessGrant, error)
	RefreshPublicAccess(context.Context, PublicAccessInput) (PublicAccessGrant, error)
	RevokePublicAccess(context.Context, PublicAccessInput) error
	DiscardPublicAccess(context.Context, PublicAccessGrant) error
}

type Accounts interface {
	AuthorizePublicAccount(context.Context, utilities.ID, utilities.ID) (bool, error)
}

type SpacePort = Space

type LifecyclePort = Lifecycle

type AccessPort = Access

type AccountsPort = Accounts

type PublicAccessInput struct {
	RequireKnock           bool
	Admission              *AdmissionBinding
	Arrival                Arrival
	MediaProof             string
	ReplaceMediaConnection bool
	// MediaClients is what the guest's SDK can run.
	MediaClients mediaplane.ClientProviders
}

type PublicSpaceCreated struct {
	Presentation   PublicSpacePresentation
	InviteLink     string
	LifecycleUntil time.Time
	Arrival        PublicSpaceArrival
	// GuestCredential is recoverable on an idempotent replay when the first
	// response was lost.
	GuestCredential string
}

type PublicSpacePresentation struct {
	MaximumEpisodeDurationSeconds int32
	Name                          string
	Slug                          string
	AdmissionMode                 AdmissionMode
}

type PublicSpaceArrival struct {
	State           ArrivalState
	Presentation    *PublicSpacePresentation
	Identity        IdentityMode
	ArrivalHandle   string
	RetryAfter      int
	Access          *PublicAccessGrant
	GuestCredential string
}

type PublicAccessGrant struct {
	SyncToken             string
	MediaToken            string
	ExpiresAt             time.Time
	TenantID              utilities.ID
	SpaceID               utilities.ID
	EpisodeID             utilities.ID
	StartedAt             *time.Time
	ParticipantID         utilities.ID
	ParticipantGeneration int64
	Provider              string
	ProviderSubject       string
	ClientPayload         PublicAccessClientPayload
}

type PublicAccessClientPayload struct {
	ConnectionID    string
	StunServer      string
	ICEServers      []mediaplane.ICEServer
	ProviderSubject string
	Token           string
	// EpisodeRef, ICEServers and Capabilities describe the own SFU. Cloudflare sets none of them but ICEServers.
	EpisodeRef   string
	Capabilities PublicAccessCapabilities
}

// PublicAccessCapabilities is what the own SFU can do for one connection.
type PublicAccessCapabilities struct {
	ServerLayerAdaptation bool
	SubscriptionState     bool
	ICERestart            bool
	PullPublished         bool
	// UnifiedSignaling says the SDK may send every signalling call to the single signal route.
	UnifiedSignaling bool
	MuteInPlace      bool
	// KeepsIdleSession says an unused connection stays valid until the SFU reports it gone, so the SDK keeps it for its first offer.
	KeepsIdleSession bool
	// DirectSignalingURL is the origin of the direct door for signalling; empty when off.
	DirectSignalingURL string
}

type SpacePublicInvite = ManagedInvite

type PublicAdmissionRequestPage = AdmissionRequestPage

type CreatePublicSpaceResult = PublicSpaceCreated

type PublicInviteArrivalResult = PublicSpaceArrival

type UpdateSpacePublicInviteInput struct {
	TenantID utilities.ID
	SpaceID  utilities.ID
	Enabled  bool
	ActorID  utilities.ID
}

type RotateSpacePublicInviteInput struct {
	TenantID   utilities.ID
	SpaceID    utilities.ID
	ActorID    utilities.ID
	RequestKey string
}

type ListPublicAdmissionRequestsInput struct {
	TenantID utilities.ID
	SpaceID  utilities.ID
	State    string
	PageSize int32
}

type AdmissionRequestPage struct {
	Requests []AdmissionRequest
}

type DecidePublicAdmissionRequestInput struct {
	TenantID      utilities.ID
	SpaceID       utilities.ID
	RequestHandle string
	RequestKey    string
	ActorID       utilities.ID
}

type CreatePublicSpaceInput struct {
	DisplayName string
	RequestKey  string
	Native      bool
	// LegacyInviteLink supports shipped native builds that predate invite codes.
	LegacyInviteLink bool
	MediaClients     mediaplane.ClientProviders
}

type PublicInviteArrivalInput struct {
	Token         string
	DisplayName   string
	RequestKey    string
	ArrivalHandle string
	// GuestCredential is optional for a new guest arrival. Runtime derives a
	// server-bound credential from the invite and request key when it is absent.
	GuestCredential   string
	AccountID         utilities.ID
	AccountAuthorized bool
	Native            bool
	MediaClients      mediaplane.ClientProviders
}

type PublicInviteArrivalStatusInput struct {
	ArrivalHandle   string
	GuestCredential string
	AccountID       utilities.ID
	Native          bool
	MediaClients    mediaplane.ClientProviders
}

type PublicInviteRefreshInput struct {
	ArrivalHandle          string
	GuestCredential        string
	AccountID              utilities.ID
	Native                 bool
	MediaProof             string
	ReplaceMediaConnection bool
	MediaClients           mediaplane.ClientProviders
}

type PublicInviteLeaveInput struct {
	ArrivalHandle   string
	GuestCredential string
	AccountID       utilities.ID
	Native          bool
}
