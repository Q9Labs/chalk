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
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/synctokens"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

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

func (a accessPort) issue(ctx context.Context, arrival publicinvites.Arrival, result episodes.PublicJoinResult, clients mediaplane.ClientProviders, refresh, replaceMediaConnection bool) (publicinvites.PublicAccessGrant, error) {
	service, episode, err := a.resolveMedia(ctx, arrival.TenantID, arrival.SpaceID, result.Episode.ID, arrival.Provider)
	if err != nil {
		return publicinvites.PublicAccessGrant{}, err
	}
	// The Episode keeps its provider. A guest whose SDK cannot run it is refused
	// here, before any provider work, and needs a newer app.
	if !clients.Runs(service.Provider()) {
		return publicinvites.PublicAccessGrant{}, mediaplane.ErrClientUnsupported
	}
	// Guests of an account's Space inherit that account's relay allowance;
	// anonymous public Spaces have no accountable owner.
	allowRelay := arrival.TenantID != a.managedTenantID
	var join mediaplane.Join
	if refresh && !replaceMediaConnection {
		join, err = service.ResumeJoin(ctx, mediaplane.ResumeJoinInput{
			Provider: service.Provider(), Scope: scopeOf(result.Participant.TenantID, result.Participant.EpisodeID, result.Participant.ID, result.Participant.Generation), Episode: episode, ExternalParticipantID: result.Participant.ID.String(), ConnectionRef: arrival.ProviderSubject,
			AllowRelay: allowRelay,
		})
	} else {
		join, err = service.CreateJoin(ctx, mediaplane.CreateJoinInput{
			Provider: service.Provider(), Scope: scopeOf(result.Participant.TenantID, result.Participant.EpisodeID, result.Participant.ID, result.Participant.Generation), Episode: episode,
			ParticipantName: arrival.DisplayName, ExternalParticipantID: result.Participant.ID.String(), ParticipantPreset: "contributor",
			Metadata:   map[string]string{"tenant_id": arrival.TenantID.String(), "space_id": arrival.SpaceID.String()},
			AllowRelay: allowRelay,
		})
	}
	if err != nil {
		return publicinvites.PublicAccessGrant{}, err
	}
	providerSubject, clientPayload, err := publicJoinPayload(service.Provider(), join)
	if err != nil {
		return publicinvites.PublicAccessGrant{}, err
	}
	if refresh && !replaceMediaConnection && providerSubject != arrival.ProviderSubject {
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
	mediaSubject.ConnectionID = providerSubject
	mediaToken, err := a.mediaTokens.Issue(observability.ContextWithAccessGrantClientProviders(ctx, clients), mediaSubject)
	if err != nil {
		return publicinvites.PublicAccessGrant{}, err
	}
	expiresAt := syncToken.ExpiresAt
	if !mediaToken.ExpiresAt.IsZero() && mediaToken.ExpiresAt.Before(expiresAt) {
		expiresAt = mediaToken.ExpiresAt
	}

	return publicinvites.PublicAccessGrant{
		SyncToken: syncToken.Value, MediaToken: mediaToken.Token, ExpiresAt: expiresAt,
		TenantID: arrival.TenantID, SpaceID: arrival.SpaceID, EpisodeID: result.Episode.ID, StartedAt: syncToken.StartedAt,
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
	service, err := a.mediaResolver.ResolveEpisode(ctx, tenant, space, episodeID)
	if err != nil || service == nil {
		if err != nil {
			return nil, mediaplane.Episode{}, err
		}
		return nil, mediaplane.Episode{}, ErrAccessUnavailable
	}
	if persistedProvider != "" && string(service.Provider()) != persistedProvider {
		return nil, mediaplane.Episode{}, ErrAccessUnavailable
	}
	if !publicProvider(service.Provider()) {
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

// scopeOf names the Participant connection a media call acts for. Chalk SFU
// rejects a call without all four parts; Cloudflare ignores them.
func scopeOf(tenantID, episodeID, participantID utilities.ID, generation int64) mediaplane.Scope {
	return mediaplane.Scope{TenantID: tenantID.String(), EpisodeID: episodeID.String(), ParticipantID: participantID.String(), Generation: generation}
}

// publicProvider reports whether the provider's joins name one connection, which
// the guest's media proof binds to. Both SFU providers do.
func publicProvider(provider mediaplane.Provider) bool {
	return provider == mediaplane.ProviderCloudflareSFU || provider == mediaplane.ProviderChalkSFU
}

func publicJoinPayload(provider mediaplane.Provider, join mediaplane.Join) (string, publicinvites.PublicAccessClientPayload, error) {
	switch provider {
	case mediaplane.ProviderChalkSFU:
		connectionID, ok := join.ClientPayload["connectionId"].(string)
		episodeRef, refOK := join.ClientPayload["episodeRef"].(string)
		if !ok || !refOK || strings.TrimSpace(connectionID) == "" || strings.TrimSpace(episodeRef) == "" {
			return "", publicinvites.PublicAccessClientPayload{}, ErrAccessUnavailable
		}
		iceServers, _ := join.ClientPayload["iceServers"].([]mediaplane.ICEServer)
		flags, _ := join.ClientPayload["capabilities"].(map[string]any)
		capabilities := publicinvites.PublicAccessCapabilities{
			ServerLayerAdaptation: flags["serverLayerAdaptation"] == true,
			SubscriptionState:     flags["subscriptionState"] == true,
			ICERestart:            flags["iceRestart"] == true,
			PullPublished:         flags["pullPublished"] == true,
			UnifiedSignaling:      flags["unifiedSignaling"] == true,
			MuteInPlace:           flags["muteInPlace"] == true,
			KeepsIdleSession:      flags["keepsIdleSession"] == true,
		}
		capabilities.DirectSignalingURL, _ = flags["directSignalingUrl"].(string)
		return connectionID, publicinvites.PublicAccessClientPayload{ConnectionID: connectionID, EpisodeRef: episodeRef, ICEServers: iceServers, Capabilities: capabilities}, nil
	case mediaplane.ProviderCloudflareSFU:
		connectionID, ok := join.ClientPayload["connectionId"].(string)
		stunServer, stunOK := join.ClientPayload["stunServer"].(string)
		if !ok || !stunOK || strings.TrimSpace(connectionID) == "" || strings.TrimSpace(stunServer) == "" {
			return "", publicinvites.PublicAccessClientPayload{}, ErrAccessUnavailable
		}
		iceServers, _ := join.ClientPayload["iceServers"].([]mediaplane.ICEServer)
		return connectionID, publicinvites.PublicAccessClientPayload{ConnectionID: connectionID, StunServer: stunServer, ICEServers: iceServers}, nil

	default:
		return "", publicinvites.PublicAccessClientPayload{}, ErrAccessUnavailable
	}
}

func sameMediaSubject(subject accessgrants.Subject, arrival publicinvites.Arrival) bool {
	if subject.TenantID != arrival.TenantID || subject.SpaceID != arrival.SpaceID || subject.EpisodeID != arrival.EpisodeID || subject.ParticipantID != arrival.ParticipantID || subject.ParticipantGeneration != arrival.ParticipantGeneration || subject.Provider != arrival.Provider {
		return false
	}
	switch arrival.Provider {
	case publicinvites.PublicProviderCloudflareSFU, publicinvites.PublicProviderChalkSFU:
		return subject.ConnectionID == arrival.ProviderSubject && subject.ProviderSubject == ""
	default:
		return false
	}
}
