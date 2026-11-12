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
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type accessPort struct {
	episodes           PublicJoinService
	spaces             SpaceLookup
	tenants            TenantLookup
	mediaResolver      MediaResolver
	syncTokens         SyncIssuer
	mediaTokens        MediaIssuer
	mediaProof         MediaProofVerifier
	mediaProofRecovery MediaProofRecoveryVerifier
	managedTenantID    utilities.ID

	readyTimeout time.Duration
	pollInterval time.Duration
}

func NewAccessPort(config AccessConfig) (publicinvites.Access, error) {
	if config.Episodes == nil || config.Spaces == nil || config.Tenants == nil || config.MediaResolver == nil || config.SyncTokens == nil || config.MediaTokens == nil {
		return nil, ErrInvalidAccess
	}
	if config.ManagedTenantID.IsZero() {
		return nil, ErrInvalidAccess
	}
	if config.MediaProofRecovery == nil {
		if recovery, ok := config.MediaProof.(MediaProofRecoveryVerifier); ok {
			config.MediaProofRecovery = recovery
		}
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
		mediaProofRecovery: config.MediaProofRecovery, managedTenantID: config.ManagedTenantID,
		readyTimeout: config.ReadyTimeout, pollInterval: config.PollInterval,
	}, nil
}

func (a accessPort) GrantPublicAccess(ctx context.Context, input publicinvites.PublicAccessInput) (publicinvites.PublicAccessGrant, error) {
	arrival := input.Arrival
	// An authenticated arrival can collect its approved grant before it has a
	// media proof. Reuse the admitted Participant and provider connection.
	if arrival.State == publicinvites.ArrivalAdmitted {
		return a.resumePublicAccess(ctx, arrival, input.MediaClients, false)
	}
	var result episodes.PublicJoinResult
	var err error
	if input.Admission != nil {
		result, err = a.episodes.FindPublic(ctx, episodes.PublicAccessInput{
			TenantID: arrival.TenantID, SpaceID: arrival.SpaceID, AccountID: arrival.AccountID,
			IdentityMode: string(arrival.IdentityMode), EpisodeID: input.Admission.EpisodeID,
			ParticipantID: input.Admission.ParticipantID, ParticipantGeneration: input.Admission.ParticipantGeneration,
		})
		if errors.Is(err, episodes.ErrEpisodeNotActive) || errors.Is(err, episodes.ErrEpisodeNotFound) || errors.Is(err, episodes.ErrParticipantNotActive) {
			return publicinvites.PublicAccessGrant{}, publicinvites.ErrArrivalUnavailable
		}
	} else {
		knockArrivalID := utilities.ID{}
		if input.RequireKnock {
			knockArrivalID = arrival.ArrivalHandle
		}
		result, err = a.episodes.JoinPublic(ctx, episodes.PublicJoinInput{
			KnockArrivalID: knockArrivalID,
			TenantID:       arrival.TenantID, SpaceID: arrival.SpaceID, AccountID: arrival.AccountID,
			IdentityMode: string(arrival.IdentityMode), DisplayName: arrival.DisplayName,
			Role:    publicinvites.PublicRoleCollaborator,
			Request: episodes.Request{Key: arrival.IdempotencyKey, Fingerprint: arrival.IdempotencyFingerprint},

			MediaClients: input.MediaClients,
		})
	}
	if err != nil {
		return publicinvites.PublicAccessGrant{}, err
	}
	ready, err := a.waitReady(ctx, result)
	if err != nil {
		return publicinvites.PublicAccessGrant{}, err
	}
	return a.issue(ctx, arrival, ready, input.MediaClients, false, false)
}

func (a accessPort) RefreshPublicAccess(ctx context.Context, input publicinvites.PublicAccessInput) (publicinvites.PublicAccessGrant, error) {
	arrival := input.Arrival
	if arrival.Provider == "" || arrival.ProviderSubject == "" {
		return publicinvites.PublicAccessGrant{}, ErrAccessUnavailable
	}
	if strings.TrimSpace(input.MediaProof) == "" {
		return publicinvites.PublicAccessGrant{}, publicinvites.ErrMediaProofRejected
	}
	if input.ReplaceMediaConnection {
		if arrival.State != publicinvites.ArrivalAdmitted {
			return publicinvites.PublicAccessGrant{}, publicinvites.ErrMediaProofRejected
		}
		if a.mediaProofRecovery == nil {
			return publicinvites.PublicAccessGrant{}, ErrAccessUnavailable
		}
		proof, err := a.mediaProofRecovery.VerifyForRecovery(ctx, input.MediaProof)
		if err != nil {
			if errors.Is(err, accessgrants.ErrExpired) {
				return publicinvites.PublicAccessGrant{}, fmt.Errorf("%w: %v", publicinvites.ErrMediaProofExpired, err)
			}
			return publicinvites.PublicAccessGrant{}, fmt.Errorf("%w: %v", publicinvites.ErrMediaProofRejected, err)
		}
		if !sameMediaSubject(proof, arrival) {
			return publicinvites.PublicAccessGrant{}, publicinvites.ErrMediaProofRejected
		}
	} else {
		if a.mediaProof == nil {
			return publicinvites.PublicAccessGrant{}, ErrAccessUnavailable
		}
		proof, err := a.mediaProof.Verify(ctx, input.MediaProof)
		if err != nil {
			if errors.Is(err, accessgrants.ErrExpired) {
				return publicinvites.PublicAccessGrant{}, fmt.Errorf("%w: %v", publicinvites.ErrMediaProofExpired, err)
			}
			return publicinvites.PublicAccessGrant{}, fmt.Errorf("%w: %v", publicinvites.ErrMediaProofRejected, err)
		}
		if !sameMediaSubject(proof, arrival) {
			return publicinvites.PublicAccessGrant{}, publicinvites.ErrMediaProofRejected
		}
	}
	return a.resumePublicAccess(ctx, arrival, input.MediaClients, input.ReplaceMediaConnection)
}

func (a accessPort) resumePublicAccess(ctx context.Context, arrival publicinvites.Arrival, clients mediaplane.ClientProviders, replaceMediaConnection bool) (publicinvites.PublicAccessGrant, error) {
	if arrival.Provider == "" || arrival.ProviderSubject == "" {
		return publicinvites.PublicAccessGrant{}, ErrAccessUnavailable
	}
	result, err := a.episodes.FindPublic(ctx, episodes.PublicAccessInput{
		TenantID: arrival.TenantID, SpaceID: arrival.SpaceID, EpisodeID: arrival.EpisodeID,
		ParticipantID: arrival.ParticipantID, ParticipantGeneration: arrival.ParticipantGeneration,
		AccountID: arrival.AccountID, IdentityMode: string(arrival.IdentityMode),
	})
	if errors.Is(err, episodes.ErrParticipantNotActive) {
		// A refresh that overlaps Leave finds the participant already leaving. The arrival is about to be Left, so
		// answer as the arrival will a moment later instead of a 500.
		return publicinvites.PublicAccessGrant{}, publicinvites.ErrArrivalUnavailable
	}
	if err != nil {
		return publicinvites.PublicAccessGrant{}, err
	}
	ready, err := a.waitReady(ctx, result)
	if err != nil {
		return publicinvites.PublicAccessGrant{}, err
	}
	if result.Participant.TenantID != arrival.TenantID || result.Participant.SpaceID != arrival.SpaceID || result.Participant.EpisodeID != arrival.EpisodeID || result.Participant.ID != arrival.ParticipantID || result.Participant.Generation != arrival.ParticipantGeneration {
		return publicinvites.PublicAccessGrant{}, publicinvites.ErrMediaProofRejected
	}
	return a.issue(ctx, arrival, ready, clients, true, replaceMediaConnection)
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
		Provider: service.Provider(), Scope: scopeOf(arrival.TenantID, arrival.EpisodeID, arrival.ParticipantID, arrival.ParticipantGeneration),
		EpisodeRef: episode.Ref, ParticipantRef: arrival.ProviderSubject,
	})
	return nil
}

func (a accessPort) DiscardPublicAccess(ctx context.Context, grant publicinvites.PublicAccessGrant) error {
	service, episode, err := a.resolveMedia(ctx, grant.TenantID, grant.SpaceID, grant.EpisodeID, grant.Provider)
	if err != nil {
		return err
	}
	return service.RemoveParticipant(ctx, mediaplane.RemoveParticipantInput{
		Provider: service.Provider(), Scope: scopeOf(grant.TenantID, grant.EpisodeID, grant.ParticipantID, grant.ParticipantGeneration),
		EpisodeRef: episode.Ref, ParticipantRef: grant.ProviderSubject,
	})
}

var _ publicinvites.Access = accessPort{}
