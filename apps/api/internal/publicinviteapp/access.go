package publicinviteapp

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/mediaplaneproviders"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/synctokens"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	ErrAccessUnavailable = errors.New("public access adapter unavailable")
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
	Resolve(context.Context, tenants.Tenant, spaces.Space) (*mediaplane.Service, error)
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

type AccessConfig struct {
	Episodes      PublicJoinService
	Spaces        SpaceLookup
	Tenants       TenantLookup
	MediaResolver MediaResolver
	SyncTokens    SyncIssuer
	MediaTokens   MediaIssuer
	MediaProof    MediaProofVerifier
	ReadyTimeout  time.Duration
	PollInterval  time.Duration
}

type accessPort struct {
	episodes      PublicJoinService
	spaces        SpaceLookup
	tenants       TenantLookup
	mediaResolver MediaResolver
	syncTokens    SyncIssuer
	mediaTokens   MediaIssuer
	mediaProof    MediaProofVerifier
	readyTimeout  time.Duration
	pollInterval  time.Duration
}

func NewAccessPort(config AccessConfig) (publicinvites.Access, error) {
	if config.Episodes == nil || config.Spaces == nil || config.Tenants == nil || config.MediaResolver == nil || config.SyncTokens == nil || config.MediaTokens == nil {
		return nil, ErrInvalidAccess
	}
	if config.ReadyTimeout <= 0 {
		config.ReadyTimeout = 2 * time.Second
	}
	if config.PollInterval <= 0 {
		config.PollInterval = 20 * time.Millisecond
	}
	if config.PollInterval >= config.ReadyTimeout {
		return nil, ErrInvalidAccess
	}
	return accessPort{
		episodes: config.Episodes, spaces: config.Spaces, tenants: config.Tenants, mediaResolver: config.MediaResolver,
		syncTokens: config.SyncTokens, mediaTokens: config.MediaTokens, mediaProof: config.MediaProof,
		readyTimeout: config.ReadyTimeout, pollInterval: config.PollInterval,
	}, nil
}

func (a accessPort) GrantPublicAccess(ctx context.Context, input publicinvites.PublicAccessInput) (publicinvites.PublicAccessGrant, error) {
	arrival := input.Arrival
	result, err := a.episodes.JoinPublic(ctx, episodes.PublicJoinInput{
		TenantID: arrival.TenantID, SpaceID: arrival.SpaceID, AccountID: arrival.AccountID,
		IdentityMode: string(arrival.IdentityMode), DisplayName: arrival.DisplayName,
		Role:    publicinvites.PublicRoleCollaborator,
		Request: episodes.Request{Key: arrival.IdempotencyKey, Fingerprint: arrival.IdempotencyFingerprint},
	})
	if err != nil {
		return publicinvites.PublicAccessGrant{}, err
	}
	ready, err := a.waitReady(ctx, result)
	if err != nil {
		return publicinvites.PublicAccessGrant{}, err
	}
	return a.issue(ctx, arrival, ready, false)
}

func (a accessPort) RefreshPublicAccess(ctx context.Context, input publicinvites.PublicAccessInput) (publicinvites.PublicAccessGrant, error) {
	arrival := input.Arrival
	if arrival.Provider == "" || arrival.ProviderSubject == "" {
		return publicinvites.PublicAccessGrant{}, ErrAccessUnavailable
	}
	if input.MediaProof != "" {
		if a.mediaProof == nil {
			return publicinvites.PublicAccessGrant{}, ErrAccessUnavailable
		}
		proof, err := a.mediaProof.Verify(ctx, input.MediaProof)
		if err != nil || !sameMediaSubject(proof, arrival) {
			return publicinvites.PublicAccessGrant{}, ErrAccessUnavailable
		}
	}
	result, err := a.episodes.FindPublic(ctx, episodes.PublicAccessInput{
		TenantID: arrival.TenantID, SpaceID: arrival.SpaceID, EpisodeID: arrival.EpisodeID,
		ParticipantID: arrival.ParticipantID, ParticipantGeneration: arrival.ParticipantGeneration,
		AccountID: arrival.AccountID, IdentityMode: string(arrival.IdentityMode),
	})
	if err != nil {
		return publicinvites.PublicAccessGrant{}, err
	}
	ready, err := a.waitReady(ctx, result)
	if err != nil {
		return publicinvites.PublicAccessGrant{}, err
	}
	return a.issue(ctx, arrival, ready, true)
}

func (a accessPort) RevokePublicAccess(ctx context.Context, input publicinvites.PublicAccessInput) error {
	arrival := input.Arrival
	if arrival.EpisodeID.IsZero() || arrival.ParticipantID.IsZero() || arrival.ParticipantGeneration <= 0 {
		return ErrAccessUnavailable
	}
	_, err := a.episodes.LeavePublic(ctx, episodes.PublicLeaveInput{
		TenantID: arrival.TenantID, SpaceID: arrival.SpaceID, EpisodeID: arrival.EpisodeID,
		ParticipantID: arrival.ParticipantID, ParticipantGeneration: arrival.ParticipantGeneration,
		Request: episodes.Request{Key: "public-leave-" + arrival.ArrivalHandle.String(), Fingerprint: arrival.IdempotencyFingerprint},
	})
	if err != nil {
		return err
	}

	// The lifecycle request is durable. Provider removal is deliberately best
	// effort so a provider outage cannot undo that request or keep the arrival
	// in its admitted state.
	service, episode, err := a.resolveMedia(ctx, arrival.TenantID, arrival.SpaceID, arrival.EpisodeID, arrival.Provider)
	if err != nil {
		return nil
	}
	_ = service.RemoveParticipant(ctx, mediaplane.RemoveParticipantInput{
		Provider: service.Provider(), EpisodeRef: episode.Ref, ParticipantRef: arrival.ProviderSubject,
	})
	return nil
}

func (a accessPort) waitReady(ctx context.Context, result episodes.PublicJoinResult) (episodes.PublicJoinResult, error) {
	readyContext, cancel := context.WithTimeout(ctx, a.readyTimeout)
	defer cancel()
	key := episodes.PublicParticipantKey{
		TenantID: result.Participant.TenantID, SpaceID: result.Participant.SpaceID,
		EpisodeID: result.Participant.EpisodeID, ParticipantID: result.Participant.ID,
		ParticipantGeneration: result.Participant.Generation,
	}
	for {
		ready, err := a.episodes.WaitPublicParticipantReady(readyContext, key)
		if err == nil {
			return ready, nil
		}
		if !errors.Is(err, episodes.ErrPublicParticipantNotReady) {
			return episodes.PublicJoinResult{}, err
		}
		timer := time.NewTimer(a.pollInterval)
		select {
		case <-readyContext.Done():
			if errors.Is(readyContext.Err(), context.DeadlineExceeded) {
				return episodes.PublicJoinResult{}, fmt.Errorf("%w: participant readiness timed out", ErrAccessUnavailable)
			}
			return episodes.PublicJoinResult{}, readyContext.Err()
		case <-timer.C:
		}
	}
}

func (a accessPort) issue(ctx context.Context, arrival publicinvites.Arrival, result episodes.PublicJoinResult, refresh bool) (publicinvites.PublicAccessGrant, error) {
	service, episode, err := a.resolveMedia(ctx, arrival.TenantID, arrival.SpaceID, result.Episode.ID, arrival.Provider)
	if err != nil {
		return publicinvites.PublicAccessGrant{}, err
	}
	var join mediaplane.Join
	if refresh {
		join, err = service.ResumeJoin(ctx, mediaplane.ResumeJoinInput{
			Provider: service.Provider(), Episode: episode, ExternalParticipantID: result.Participant.ID.String(), ConnectionRef: arrival.ProviderSubject,
		})
	} else {
		join, err = service.CreateJoin(ctx, mediaplane.CreateJoinInput{
			Provider: service.Provider(), Episode: episode,
			ParticipantName: arrival.DisplayName, ExternalParticipantID: result.Participant.ID.String(), ParticipantPreset: "contributor",
			Metadata: map[string]string{"tenant_id": arrival.TenantID.String(), "space_id": arrival.SpaceID.String()},
		})
	}
	if err != nil {
		return publicinvites.PublicAccessGrant{}, err
	}
	providerSubject, clientPayload, err := publicJoinPayload(service.Provider(), join)
	if err != nil {
		return publicinvites.PublicAccessGrant{}, err
	}
	if refresh && providerSubject != arrival.ProviderSubject {
		return publicinvites.PublicAccessGrant{}, ErrAccessUnavailable
	}
	syncToken, err := a.syncTokens.IssueForParticipant(ctx, synctokens.SubjectKey{TenantID: arrival.TenantID, SpaceID: arrival.SpaceID, EpisodeID: result.Episode.ID, ParticipantID: result.Participant.ID})
	if err != nil {
		return publicinvites.PublicAccessGrant{}, err
	}
	provider := string(service.Provider())
	mediaSubject := accessgrants.Subject{
		TenantID: arrival.TenantID, SpaceID: arrival.SpaceID, EpisodeID: result.Episode.ID,
		ParticipantID: result.Participant.ID, ParticipantGeneration: result.Participant.Generation,
		Provider: provider,
	}
	if service.Provider() == mediaplane.ProviderCloudflareSFU {
		mediaSubject.CloudflareConnectionID = providerSubject
	} else {
		mediaSubject.ProviderSubject = providerSubject
	}
	mediaToken, err := a.mediaTokens.Issue(ctx, mediaSubject)
	if err != nil {
		return publicinvites.PublicAccessGrant{}, err
	}
	expiresAt := syncToken.ExpiresAt
	if !mediaToken.ExpiresAt.IsZero() && mediaToken.ExpiresAt.Before(expiresAt) {
		expiresAt = mediaToken.ExpiresAt
	}
	return publicinvites.PublicAccessGrant{
		SyncToken: syncToken.Value, MediaToken: mediaToken.Token, ExpiresAt: expiresAt,
		TenantID: arrival.TenantID, SpaceID: arrival.SpaceID, EpisodeID: result.Episode.ID,
		ParticipantID: result.Participant.ID, ParticipantGeneration: result.Participant.Generation,
		Provider: provider, ProviderSubject: providerSubject, ClientPayload: clientPayload,
	}, nil
}

func (a accessPort) resolveMedia(ctx context.Context, tenantID, spaceID, episodeID utilities.ID, persistedProvider string) (*mediaplane.Service, mediaplane.Episode, error) {
	tenant, err := a.tenants.GetTenant(ctx, tenantID)
	if err != nil {
		return nil, mediaplane.Episode{}, err
	}
	space, err := a.spaces.GetSpace(ctx, tenantID, spaceID)
	if err != nil {
		return nil, mediaplane.Episode{}, err
	}
	if tenant.ID != tenantID || space.TenantID != tenantID || space.ID != spaceID {
		return nil, mediaplane.Episode{}, ErrAccessUnavailable
	}
	service, err := a.mediaResolver.Resolve(ctx, tenant, space)
	if err != nil || service == nil {
		if err != nil {
			return nil, mediaplane.Episode{}, err
		}
		return nil, mediaplane.Episode{}, ErrAccessUnavailable
	}
	if persistedProvider != "" && string(service.Provider()) != persistedProvider {
		return nil, mediaplane.Episode{}, ErrAccessUnavailable
	}
	if service.Provider() != mediaplane.ProviderCloudflareRTK && service.Provider() != mediaplane.ProviderCloudflareSFU {
		return nil, mediaplane.Episode{}, ErrAccessUnavailable
	}
	episode, err := service.EnsureEpisode(ctx, mediaplane.EnsureEpisodeInput{
		Provider: service.Provider(), EpisodeKey: episodeID.String(), Title: "public-" + episodeID.String(),
		Metadata: map[string]string{"tenant_id": tenantID.String(), "space_id": spaceID.String(), "episode_id": episodeID.String()},
	})
	if err != nil {
		return nil, mediaplane.Episode{}, err
	}
	if episode.Provider != service.Provider() || strings.TrimSpace(episode.Ref) == "" {
		return nil, mediaplane.Episode{}, ErrAccessUnavailable
	}
	return service, episode, nil
}

func publicJoinPayload(provider mediaplane.Provider, join mediaplane.Join) (string, publicinvites.PublicAccessClientPayload, error) {
	switch provider {
	case mediaplane.ProviderCloudflareSFU:
		connectionID, ok := join.ClientPayload["connectionId"].(string)
		stunServer, stunOK := join.ClientPayload["stunServer"].(string)
		if !ok || !stunOK || strings.TrimSpace(connectionID) == "" || strings.TrimSpace(stunServer) == "" {
			return "", publicinvites.PublicAccessClientPayload{}, ErrAccessUnavailable
		}
		return connectionID, publicinvites.PublicAccessClientPayload{ConnectionID: connectionID, StunServer: stunServer}, nil
	case mediaplane.ProviderCloudflareRTK:
		token, ok := join.ClientPayload["token"].(string)
		if !ok || strings.TrimSpace(join.ParticipantRef) == "" || strings.TrimSpace(token) == "" {
			return "", publicinvites.PublicAccessClientPayload{}, ErrAccessUnavailable
		}
		return join.ParticipantRef, publicinvites.PublicAccessClientPayload{ProviderSubject: join.ParticipantRef, Token: token}, nil
	default:
		return "", publicinvites.PublicAccessClientPayload{}, ErrAccessUnavailable
	}
}

func sameMediaSubject(subject accessgrants.Subject, arrival publicinvites.Arrival) bool {
	if subject.TenantID != arrival.TenantID || subject.SpaceID != arrival.SpaceID || subject.EpisodeID != arrival.EpisodeID || subject.ParticipantID != arrival.ParticipantID || subject.ParticipantGeneration != arrival.ParticipantGeneration || subject.Provider != arrival.Provider {
		return false
	}
	if arrival.Provider == publicinvites.PublicProviderCloudflareSFU {
		return subject.CloudflareConnectionID == arrival.ProviderSubject && subject.ProviderSubject == ""
	}
	return subject.ProviderSubject == arrival.ProviderSubject
}

var _ publicinvites.Access = accessPort{}
var _ mediaplaneproviders.Resolver = (*mediaplaneproviders.Registry)(nil)
