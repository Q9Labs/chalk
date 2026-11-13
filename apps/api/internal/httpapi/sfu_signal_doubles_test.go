package httpapi

import (
	"context"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/mediapublications"
	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
	"github.com/q9labs/chalk/apps/api/internal/ratelimit"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type signalSpaces struct{ SpaceService }

func (signalSpaces) GetSpace(context.Context, utilities.ID, utilities.ID) (spaces.Space, error) {
	return spaces.Space{}, nil
}

type signalTenants struct{ TenantService }

func (signalTenants) GetTenant(context.Context, utilities.ID) (tenants.Tenant, error) {
	return tenants.Tenant{}, nil
}

type signalEpisodes struct{}

func (signalEpisodes) GetEpisode(context.Context, utilities.ID, utilities.ID, utilities.ID) (episodes.Episode, error) {
	return episodes.Episode{}, nil
}

type signalResolver struct{ service *mediaplane.Service }

func (r signalResolver) ResolveEpisode(context.Context, tenants.Tenant, spaces.Space, utilities.ID) (*mediaplane.Service, error) {
	return r.service, nil
}

// signalPlane answers every signalling call with one canned result, or with err.
type signalPlane struct{ err error }

func (signalPlane) EnsureEpisode(context.Context, mediaplane.EnsureEpisodeInput) (mediaplane.Episode, error) {
	return mediaplane.Episode{}, nil
}

func (signalPlane) CreateJoin(context.Context, mediaplane.CreateJoinInput) (mediaplane.Join, error) {
	return mediaplane.Join{}, nil
}

func (signalPlane) RemoveParticipant(context.Context, mediaplane.RemoveParticipantInput) error {
	return nil
}

func (signalPlane) EndEpisode(context.Context, mediaplane.EndEpisodeInput) error { return nil }

func (signalPlane) EpisodeUsage(context.Context, mediaplane.EpisodeUsageInput) (mediaplane.Usage, error) {
	return mediaplane.Usage{}, nil
}

func (p signalPlane) AddTracks(_ context.Context, input mediaplane.TracksRequest) (mediaplane.TracksResponse, error) {
	if p.err != nil {
		return mediaplane.TracksResponse{}, p.err
	}
	return mediaplane.TracksResponse{
		SessionDescription: &mediaplane.SessionDescription{SDP: "answer-sdp", Type: "answer"},
		Tracks:             []mediaplane.Track{{Location: "local", Mid: input.Tracks[0].Mid, TrackName: input.Tracks[0].TrackName}},
	}, nil
}

func (p signalPlane) Renegotiate(context.Context, mediaplane.RenegotiateRequest) error { return p.err }

func (p signalPlane) UpdateTracks(context.Context, mediaplane.UpdateTracksRequest) (mediaplane.TracksResponse, error) {
	if p.err != nil {
		return mediaplane.TracksResponse{}, p.err
	}
	return mediaplane.TracksResponse{Tracks: []mediaplane.Track{{Location: "remote", Mid: "3", TrackName: "video", SessionID: "session-2"}}}, nil
}

func (p signalPlane) CloseTracks(context.Context, mediaplane.CloseTracksRequest) (mediaplane.CloseTracksResponse, error) {
	if p.err != nil {
		return mediaplane.CloseTracksResponse{}, p.err
	}
	return mediaplane.CloseTracksResponse{SessionDescription: &mediaplane.SessionDescription{SDP: "answer-sdp", Type: "answer"}}, nil
}

func (p signalPlane) SubscriptionStates(context.Context, mediaplane.SubscriptionStatesRequest) ([]mediaplane.SubscriptionState, error) {
	if p.err != nil {
		return nil, p.err
	}
	return []mediaplane.SubscriptionState{{Mid: "3", SessionID: "session-2", TrackName: "video", State: mediaplane.SubscriptionActive, Revision: 4, EffectiveRID: "h"}}, nil
}

type signalRegistry struct{ err error }

func (r signalRegistry) RecordPublishedTracks(_ context.Context, input mediapublications.RecordInput) ([]mediapublications.PublishedReference, error) {
	if r.err != nil {
		return nil, r.err
	}
	return []mediapublications.PublishedReference{{Source: input.Tracks[0].Source, MID: input.Tracks[0].MID, TrackName: input.Tracks[0].TrackName, PublicationID: "publication-1"}}, nil
}

func (signalRegistry) RecordPublicationAvailability(context.Context, mediapublications.AvailabilityInput) error {
	return nil
}

func (r signalRegistry) PrepareClose(context.Context, mediapublications.CloseInput) (mediapublications.CloseDecision, error) {
	return mediapublications.CloseDecision{ProviderCloseRequired: true}, r.err
}

func (r signalRegistry) RecordClosedPublication(context.Context, mediapublications.CloseInput) error {
	return r.err
}

func (r signalRegistry) Latest(context.Context, utilities.ID, utilities.ID) (mediapublications.Snapshot, error) {
	if r.err != nil {
		return mediapublications.Snapshot{}, r.err
	}
	return mediapublications.Snapshot{Incarnation: 2, Sequence: 9, Publications: []provideroperations.Publication{{ParticipantID: signalSubject(nil).ParticipantID, Source: "camera", PublicationID: "publication-1", Enabled: true}}}, nil
}

// signalLimiter records each policy it is asked about and refuses once exhaustAfter calls have passed.
type signalLimiter struct {
	policies     []string
	exhaustAfter int
}

func (l *signalLimiter) Allow(_ context.Context, _ string, policy ratelimit.Policy, _ time.Time) ratelimit.Decision {
	l.policies = append(l.policies, policy.Name)
	if len(l.policies) > l.exhaustAfter {
		return ratelimit.Decision{State: ratelimit.Exhausted, RetryAfter: time.Second}
	}
	return ratelimit.Decision{State: ratelimit.Allowed, Remaining: 1}
}
