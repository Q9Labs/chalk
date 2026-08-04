package mediaplane

import (
	"context"
	"errors"
	"strings"
	"time"
)

var (
	ErrInvalidProvider          = errors.New("invalid media plane provider")
	ErrInvalidEpisodeKey        = errors.New("invalid media episode key")
	ErrInvalidEpisodeRef        = errors.New("invalid media episode ref")
	ErrInvalidParticipantName   = errors.New("invalid media participant name")
	ErrInvalidParticipantRef    = errors.New("invalid media participant ref")
	ErrInvalidParticipantPreset = errors.New("invalid media participant preset")
	ErrInvalidConnectionRef     = errors.New("invalid media connection ref")
	ErrPlaneUnavailable         = errors.New("media plane unavailable")
	ErrUnsupportedOperation     = errors.New("media plane operation unsupported")
	ErrEpisodeNotFound          = errors.New("media episode not found")
	ErrConnectionNotFound       = errors.New("media connection not found")
	ErrParticipantNotFound      = errors.New("media participant not found")
	ErrProviderUnauthorized     = errors.New("media provider unauthorized")
	ErrProviderRateLimited      = errors.New("media provider rate limited")
	ErrProviderFailed           = errors.New("media provider failed")
	ErrCredentialNotApplicable  = errors.New("credential is not a media plane credential")
	ErrInvalidCredential        = errors.New("invalid media plane credential")
)

type Provider string

const (
	ProviderCloudflareRTK Provider = "cloudflare_rtk"
	ProviderCloudflareSFU Provider = "cloudflare_sfu"
)

type Plane interface {
	EnsureEpisode(ctx context.Context, input EnsureEpisodeInput) (Episode, error)
	CreateJoin(ctx context.Context, input CreateJoinInput) (Join, error)
	RemoveParticipant(ctx context.Context, input RemoveParticipantInput) error
	EndEpisode(ctx context.Context, input EndEpisodeInput) error
	EpisodeUsage(ctx context.Context, input EpisodeUsageInput) (Usage, error)
}

type JoinResumer interface {
	ResumeJoin(ctx context.Context, input ResumeJoinInput) (Join, error)
}

type Service struct {
	plane    Plane
	provider Provider
}

type EnsureEpisodeInput struct {
	Provider   Provider
	EpisodeKey string
	Title      string
	Metadata   map[string]string
}

type CreateJoinInput struct {
	Provider              Provider
	Episode               Episode
	ParticipantName       string
	ExternalParticipantID string
	ParticipantPreset     string
	Metadata              map[string]string
}

type ResumeJoinInput struct {
	Provider              Provider
	Episode               Episode
	ExternalParticipantID string
	ConnectionRef         string
}

type RemoveParticipantInput struct {
	Provider       Provider
	EpisodeRef     string
	ParticipantRef string
}

type EndEpisodeInput struct {
	Provider   Provider
	EpisodeRef string
}

type EpisodeUsageInput struct {
	Provider   Provider
	EpisodeRef string
}

type Episode struct {
	Provider Provider
	Ref      string
	Metadata map[string]string
}

type Join struct {
	Provider       Provider
	ParticipantRef string
	ClientPayload  map[string]any
	ExpiresAt      time.Time
	Metadata       map[string]string
}

type Usage struct {
	ParticipantMinutes int64
	EgressBytes        int64
	IngressBytes       int64
	Metadata           map[string]string
}

func NewService(plane Plane) Service {
	return Service{plane: plane}
}

func NewServiceForProvider(provider Provider, plane Plane) Service {
	return Service{plane: plane, provider: provider}
}

func (s Service) Provider() Provider {
	return s.provider
}

func (s Service) EnsureEpisode(ctx context.Context, input EnsureEpisodeInput) (Episode, error) {
	if s.plane == nil {
		return Episode{}, ErrPlaneUnavailable
	}
	if err := requireEpisodeBootstrapInput(&input); err != nil {
		return Episode{}, err
	}

	return s.plane.EnsureEpisode(ctx, input)
}

func (s Service) CreateJoin(ctx context.Context, input CreateJoinInput) (Join, error) {
	if s.plane == nil {
		return Join{}, ErrPlaneUnavailable
	}
	if err := requireJoinInput(&input); err != nil {
		return Join{}, err
	}

	return s.plane.CreateJoin(ctx, input)
}

func (s Service) ResumeJoin(ctx context.Context, input ResumeJoinInput) (Join, error) {
	if s.plane == nil {
		return Join{}, ErrPlaneUnavailable
	}
	resumer, ok := s.plane.(JoinResumer)
	if !ok {
		return Join{}, ErrUnsupportedOperation
	}
	if err := requireResumeJoinInput(&input, s.provider); err != nil {
		return Join{}, err
	}

	return resumer.ResumeJoin(ctx, input)
}

func (s Service) RemoveParticipant(ctx context.Context, input RemoveParticipantInput) error {
	if s.plane == nil {
		return ErrPlaneUnavailable
	}
	if err := requireParticipantRemovalInput(&input); err != nil {
		return err
	}

	return s.plane.RemoveParticipant(ctx, input)
}

func (s Service) EndEpisode(ctx context.Context, input EndEpisodeInput) error {
	if s.plane == nil {
		return ErrPlaneUnavailable
	}
	if err := requireEpisodeEndInput(&input); err != nil {
		return err
	}

	return s.plane.EndEpisode(ctx, input)
}

func (s Service) EpisodeUsage(ctx context.Context, input EpisodeUsageInput) (Usage, error) {
	if s.plane == nil {
		return Usage{}, ErrPlaneUnavailable
	}
	if err := requireEpisodeUsageInput(&input); err != nil {
		return Usage{}, err
	}

	return s.plane.EpisodeUsage(ctx, input)
}

func requireEpisodeBootstrapInput(input *EnsureEpisodeInput) error {
	if !validProvider(input.Provider) {
		return ErrInvalidProvider
	}

	key, err := requiredString(input.EpisodeKey)
	if err != nil {
		return ErrInvalidEpisodeKey
	}
	input.EpisodeKey = key

	if input.Title != "" {
		title, err := requiredString(input.Title)
		if err != nil {
			return ErrInvalidEpisodeKey
		}
		input.Title = title
	}

	return nil
}

func requireJoinInput(input *CreateJoinInput) error {
	if !validProvider(input.Provider) || input.Episode.Provider != input.Provider {
		return ErrInvalidProvider
	}

	episodeRef, err := requiredString(input.Episode.Ref)
	if err != nil {
		return ErrInvalidEpisodeRef
	}
	input.Episode.Ref = episodeRef

	name, err := requiredString(input.ParticipantName)
	if err != nil {
		return ErrInvalidParticipantName
	}
	input.ParticipantName = name

	if input.ExternalParticipantID != "" {
		externalID, err := requiredString(input.ExternalParticipantID)
		if err != nil {
			return ErrInvalidParticipantRef
		}
		input.ExternalParticipantID = externalID
	}

	preset, err := requiredString(input.ParticipantPreset)
	if err != nil {
		return ErrInvalidParticipantPreset
	}
	input.ParticipantPreset = preset

	return nil
}

func requireResumeJoinInput(input *ResumeJoinInput, provider Provider) error {
	if !validProvider(input.Provider) || input.Episode.Provider != input.Provider || (provider != "" && input.Provider != provider) {
		return ErrInvalidProvider
	}

	episodeRef, err := requiredString(input.Episode.Ref)
	if err != nil {
		return ErrInvalidEpisodeRef
	}
	input.Episode.Ref = episodeRef

	participantID, err := requiredString(input.ExternalParticipantID)
	if err != nil {
		return ErrInvalidParticipantRef
	}
	input.ExternalParticipantID = participantID

	connectionRef, err := requiredString(input.ConnectionRef)
	if err != nil {
		return ErrInvalidConnectionRef
	}
	input.ConnectionRef = connectionRef

	return nil
}

func requireParticipantRemovalInput(input *RemoveParticipantInput) error {
	if !validProvider(input.Provider) {
		return ErrInvalidProvider
	}

	episodeRef, err := requiredString(input.EpisodeRef)
	if err != nil {
		return ErrInvalidEpisodeRef
	}
	input.EpisodeRef = episodeRef

	participantRef, err := requiredString(input.ParticipantRef)
	if err != nil {
		return ErrInvalidParticipantRef
	}
	input.ParticipantRef = participantRef

	return nil
}

func requireEpisodeEndInput(input *EndEpisodeInput) error {
	if !validProvider(input.Provider) {
		return ErrInvalidProvider
	}

	episodeRef, err := requiredString(input.EpisodeRef)
	if err != nil {
		return ErrInvalidEpisodeRef
	}
	input.EpisodeRef = episodeRef

	return nil
}

func requireEpisodeUsageInput(input *EpisodeUsageInput) error {
	if !validProvider(input.Provider) {
		return ErrInvalidProvider
	}

	episodeRef, err := requiredString(input.EpisodeRef)
	if err != nil {
		return ErrInvalidEpisodeRef
	}
	input.EpisodeRef = episodeRef

	return nil
}

func validProvider(provider Provider) bool {
	switch provider {
	case ProviderCloudflareRTK, ProviderCloudflareSFU:
		return true
	default:
		return false
	}
}

func requiredString(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", errors.New("blank string")
	}

	return value, nil
}
