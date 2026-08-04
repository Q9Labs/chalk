package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	sfuadapter "github.com/q9labs/chalk/apps/api/internal/adapters/cloudflare/sfu"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

const probeTimeout = 30 * time.Second

const (
	probeEpisodeRef        = "chalk-dev-sfu-probe"
	probeParticipantRef    = "chalk-dev-sfu-probe"
	probeParticipantPreset = "contributor"
)

var (
	ErrInvalidConnectionID = errors.New("invalid sfu connection id")
	ErrProbeUnavailable    = errors.New("sfu probe client unavailable")
)

type Client interface {
	CreateJoin(context.Context, mediaplane.CreateJoinInput) (mediaplane.Join, error)
	VerifyConnectionMetadata(context.Context, string) (sfuadapter.ConnectionMetadata, error)
}

type Result struct {
	Status   string `json:"status"`
	Verified bool   `json:"verified"`
}

type FailureClass string

const (
	FailureAuthentication  FailureClass = "authentication"
	FailureCanceled        FailureClass = "canceled"
	FailureConfiguration   FailureClass = "configuration"
	FailureContract        FailureClass = "contract"
	FailureInvalidResponse FailureClass = "invalid_response"
	FailureProvider        FailureClass = "provider"
	FailureRateLimited     FailureClass = "rate_limited"
	FailureTimeout         FailureClass = "timeout"
	FailureUnavailable     FailureClass = "unavailable"
)

type ProbeError struct {
	Stage string
	Class FailureClass
}

func (e ProbeError) Error() string {
	return fmt.Sprintf("cloudflare sfu probe failed: stage=%s class=%s", e.Stage, e.Class)
}

func (e ProbeError) Unwrap() error {
	switch e.Class {
	case FailureAuthentication:
		return mediaplane.ErrProviderUnauthorized
	case FailureCanceled:
		return context.Canceled
	case FailureConfiguration:
		return sfuadapter.ErrMissingConfig
	case FailureInvalidResponse:
		return ErrInvalidConnectionID
	case FailureRateLimited:
		return mediaplane.ErrProviderRateLimited
	case FailureTimeout:
		return context.DeadlineExceeded
	case FailureUnavailable:
		return mediaplane.ErrPlaneUnavailable
	default:
		return nil
	}
}

type Probe struct {
	client Client
}

func NewProbe(client Client) Probe {
	return Probe{client: client}
}

func (p Probe) Run(parent context.Context) (Result, error) {
	ctx, cancel := context.WithTimeout(parent, probeTimeout)
	defer cancel()

	if p.client == nil {
		return Result{}, ProbeError{Stage: "create_connection", Class: FailureUnavailable}
	}

	join, err := p.client.CreateJoin(ctx, mediaplane.CreateJoinInput{
		Provider: mediaplane.ProviderCloudflareSFU,
		Episode: mediaplane.Episode{
			Provider: mediaplane.ProviderCloudflareSFU,
			Ref:      probeEpisodeRef,
		},
		ParticipantName:       probeParticipantRef,
		ExternalParticipantID: probeParticipantRef,
		ParticipantPreset:     probeParticipantPreset,
	})
	if err != nil {
		return Result{}, classifyProbeError(ctx, "create_connection", err)
	}

	connectionID, err := connectionIDFromJoin(join)
	if err != nil {
		return Result{}, ProbeError{Stage: "create_connection", Class: FailureInvalidResponse}
	}

	_, err = p.client.VerifyConnectionMetadata(ctx, connectionID)
	connectionID = ""
	if err != nil {
		return Result{}, classifyProbeError(ctx, "verify_connection", err)
	}

	return Result{Status: "ok", Verified: true}, nil
}

func connectionIDFromJoin(join mediaplane.Join) (string, error) {
	value, ok := join.ClientPayload["connectionId"]
	if !ok {
		return "", ErrInvalidConnectionID
	}

	connectionID, ok := value.(string)
	if !ok || strings.TrimSpace(connectionID) == "" {
		return "", ErrInvalidConnectionID
	}
	return strings.TrimSpace(connectionID), nil
}

func classifyProbeError(ctx context.Context, stage string, err error) ProbeError {
	class := FailureProvider
	switch {
	case errors.Is(ctx.Err(), context.DeadlineExceeded), errors.Is(err, context.DeadlineExceeded):
		class = FailureTimeout
	case errors.Is(ctx.Err(), context.Canceled), errors.Is(err, context.Canceled):
		class = FailureCanceled
	case providerTimeout(err):
		class = FailureTimeout
	case errors.Is(err, mediaplane.ErrProviderUnauthorized):
		class = FailureAuthentication
	case errors.Is(err, mediaplane.ErrProviderRateLimited):
		class = FailureRateLimited
	case errors.Is(err, mediaplane.ErrInvalidProvider), errors.Is(err, mediaplane.ErrInvalidConnectionRef):
		class = FailureContract
	case errors.Is(err, mediaplane.ErrPlaneUnavailable):
		class = FailureUnavailable
	}
	return ProbeError{Stage: stage, Class: class}
}

func providerTimeout(err error) bool {
	if err == nil {
		return false
	}
	for _, field := range strings.Fields(err.Error()) {
		if field == "provider_code=timeout" {
			return true
		}
	}
	return false
}

func NewClientFromEnv(env func(string) string) (Client, error) {
	if env == nil {
		env = os.Getenv
	}

	appID := strings.TrimSpace(env(config.CloudflareRealtimeAppID))
	appSecret := strings.TrimSpace(env(config.CloudflareRealtimeAppSecret))
	if appID == "" || appSecret == "" {
		return nil, ProbeError{Stage: "config", Class: FailureConfiguration}
	}

	adapter, err := sfuadapter.NewAdapter(config.CloudflareRealtimeConfig{
		RealtimeAppID:     appID,
		RealtimeAppSecret: appSecret,
		RequestTimeout:    probeTimeout,
	})
	if err != nil {
		return nil, ProbeError{Stage: "config", Class: FailureConfiguration}
	}
	return adapter, nil
}
