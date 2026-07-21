package mediaplane

import (
	"context"
	"errors"
	"strings"
	"time"
)

var (
	ErrInvalidProvider          = errors.New("invalid media plane provider")
	ErrInvalidSessionKey        = errors.New("invalid media session key")
	ErrInvalidSessionRef        = errors.New("invalid media session ref")
	ErrInvalidParticipantName   = errors.New("invalid media participant name")
	ErrInvalidParticipantRef    = errors.New("invalid media participant ref")
	ErrInvalidParticipantPreset = errors.New("invalid media participant preset")
	ErrInvalidConnectionRef     = errors.New("invalid media connection ref")
	ErrPlaneUnavailable         = errors.New("media plane unavailable")
	ErrUnsupportedOperation     = errors.New("media plane operation unsupported")
	ErrSessionNotFound          = errors.New("media session not found")
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
	EnsureSession(ctx context.Context, input EnsureSessionInput) (Session, error)
	CreateJoin(ctx context.Context, input CreateJoinInput) (Join, error)
	RemoveParticipant(ctx context.Context, input RemoveParticipantInput) error
	EndSession(ctx context.Context, input EndSessionInput) error
	SessionUsage(ctx context.Context, input SessionUsageInput) (Usage, error)
}

type JoinResumer interface {
	ResumeJoin(ctx context.Context, input ResumeJoinInput) (Join, error)
}

type Service struct {
	plane    Plane
	provider Provider
}

type EnsureSessionInput struct {
	Provider   Provider
	SessionKey string
	Title      string
	Metadata   map[string]string
}

type CreateJoinInput struct {
	Provider              Provider
	Session               Session
	ParticipantName       string
	ExternalParticipantID string
	ParticipantPreset     string
	Metadata              map[string]string
}

type ResumeJoinInput struct {
	Provider              Provider
	Session               Session
	ExternalParticipantID string
	ConnectionRef         string
}

type RemoveParticipantInput struct {
	Provider       Provider
	SessionRef     string
	ParticipantRef string
}

type EndSessionInput struct {
	Provider   Provider
	SessionRef string
}

type SessionUsageInput struct {
	Provider   Provider
	SessionRef string
}

type Session struct {
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

func (s Service) EnsureSession(ctx context.Context, input EnsureSessionInput) (Session, error) {
	if s.plane == nil {
		return Session{}, ErrPlaneUnavailable
	}
	if err := requireSessionBootstrapInput(&input); err != nil {
		return Session{}, err
	}

	return s.plane.EnsureSession(ctx, input)
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

func (s Service) EndSession(ctx context.Context, input EndSessionInput) error {
	if s.plane == nil {
		return ErrPlaneUnavailable
	}
	if err := requireSessionEndInput(&input); err != nil {
		return err
	}

	return s.plane.EndSession(ctx, input)
}

func (s Service) SessionUsage(ctx context.Context, input SessionUsageInput) (Usage, error) {
	if s.plane == nil {
		return Usage{}, ErrPlaneUnavailable
	}
	if err := requireSessionUsageInput(&input); err != nil {
		return Usage{}, err
	}

	return s.plane.SessionUsage(ctx, input)
}

func requireSessionBootstrapInput(input *EnsureSessionInput) error {
	if !validProvider(input.Provider) {
		return ErrInvalidProvider
	}

	key, err := requiredString(input.SessionKey)
	if err != nil {
		return ErrInvalidSessionKey
	}
	input.SessionKey = key

	if input.Title != "" {
		title, err := requiredString(input.Title)
		if err != nil {
			return ErrInvalidSessionKey
		}
		input.Title = title
	}

	return nil
}

func requireJoinInput(input *CreateJoinInput) error {
	if !validProvider(input.Provider) || input.Session.Provider != input.Provider {
		return ErrInvalidProvider
	}

	sessionRef, err := requiredString(input.Session.Ref)
	if err != nil {
		return ErrInvalidSessionRef
	}
	input.Session.Ref = sessionRef

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
	if !validProvider(input.Provider) || input.Session.Provider != input.Provider || (provider != "" && input.Provider != provider) {
		return ErrInvalidProvider
	}

	sessionRef, err := requiredString(input.Session.Ref)
	if err != nil {
		return ErrInvalidSessionRef
	}
	input.Session.Ref = sessionRef

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

	sessionRef, err := requiredString(input.SessionRef)
	if err != nil {
		return ErrInvalidSessionRef
	}
	input.SessionRef = sessionRef

	participantRef, err := requiredString(input.ParticipantRef)
	if err != nil {
		return ErrInvalidParticipantRef
	}
	input.ParticipantRef = participantRef

	return nil
}

func requireSessionEndInput(input *EndSessionInput) error {
	if !validProvider(input.Provider) {
		return ErrInvalidProvider
	}

	sessionRef, err := requiredString(input.SessionRef)
	if err != nil {
		return ErrInvalidSessionRef
	}
	input.SessionRef = sessionRef

	return nil
}

func requireSessionUsageInput(input *SessionUsageInput) error {
	if !validProvider(input.Provider) {
		return ErrInvalidProvider
	}

	sessionRef, err := requiredString(input.SessionRef)
	if err != nil {
		return ErrInvalidSessionRef
	}
	input.SessionRef = sessionRef

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
