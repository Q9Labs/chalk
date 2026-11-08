package captureproviders

import (
	"context"
	"errors"
	"fmt"

	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

var (
	ErrInvalidConfig      = errors.New("invalid capture provider registry config")
	ErrInvalidBinding     = errors.New("invalid Episode capture provider binding")
	ErrBindingUnavailable = errors.New("capture provider binding unavailable for Episode")
	ErrAdapterUnavailable = errors.New("capture provider adapter unavailable")
)

// BindingSource resolves provider authority from the durable Episode record.
// Implementations must not fall back to the Space's current media-plane value.
type BindingSource interface {
	ResolveBinding(context.Context, captureplane.CaptureIdentity) (mediaplane.Binding, error)
}

// NodePlanes returns the capture plane of one node of a provider that runs several, issued under
// the binding generation so the node can refuse a capture of a retired allocation.
type NodePlanes interface {
	CapturePlane(node string, generation int64) (captureplane.CapturePlane, error)
}

// Registration associates one real media-plane provider with its capture
// adapter. An unregistered provider is unsupported for capture. Set Plane for a
// provider with one global endpoint, or Nodes for a provider that runs several,
// where the Episode binding names the node that holds the Episode's sessions.
type Registration struct {
	Provider           string
	AdapterFingerprint string
	Plane              captureplane.CapturePlane
	Nodes              NodePlanes
}

type registered struct {
	plane captureplane.CapturePlane
	nodes NodePlanes
}

type adapterKey struct {
	provider    string
	fingerprint string
}

// Registry routes capture signaling from authoritative Episode bindings.
type Registry struct {
	source   BindingSource
	adapters map[adapterKey]registered
}

func NewRegistry(source BindingSource, registrations ...Registration) (*Registry, error) {
	if source == nil || len(registrations) == 0 {
		return nil, ErrInvalidConfig
	}

	adapters := make(map[adapterKey]registered, len(registrations))
	for _, registration := range registrations {
		key := adapterKey{provider: registration.Provider, fingerprint: registration.AdapterFingerprint}
		if err := validateAdapterKey(key); err != nil || (registration.Plane == nil) == (registration.Nodes == nil) {
			return nil, ErrInvalidConfig
		}
		if _, duplicate := adapters[key]; duplicate {
			return nil, ErrInvalidConfig
		}
		adapters[key] = registered{plane: registration.Plane, nodes: registration.Nodes}
	}

	return &Registry{source: source, adapters: adapters}, nil
}

func (r *Registry) Resolve(ctx context.Context, identity captureplane.CaptureIdentity) (captureplane.CapturePlane, error) {
	if r == nil || r.source == nil {
		return nil, ErrInvalidConfig
	}
	if err := identity.Validate(); err != nil {
		return nil, fmt.Errorf("%w: capture identity", ErrInvalidBinding)
	}

	binding, err := r.source.ResolveBinding(ctx, identity)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if errors.Is(err, mediaplane.ErrInvalidBinding) {
			return nil, resolutionError(ErrInvalidBinding, captureplane.ProviderFailureProtocol, "invalid_binding", false)
		}
		return nil, resolutionError(ErrBindingUnavailable, captureplane.ProviderFailureUnavailable, "binding_unavailable", true)
	}
	if err := binding.Validate(); err != nil {
		return nil, resolutionError(ErrInvalidBinding, captureplane.ProviderFailureProtocol, "invalid_binding", false)
	}
	adapter, ok := r.adapters[adapterKey{provider: binding.Provider, fingerprint: binding.AdapterFingerprint}]
	if !ok {
		return nil, resolutionError(ErrAdapterUnavailable, captureplane.ProviderFailureUnavailable, "adapter_unavailable", false)
	}
	if adapter.nodes == nil {
		return adapter.plane, nil
	}
	// An Episode never moves between nodes: its sessions live on the node its binding names.
	if binding.Node == "" {
		return nil, resolutionError(ErrInvalidBinding, captureplane.ProviderFailureProtocol, "binding_without_node", false)
	}
	plane, err := adapter.nodes.CapturePlane(binding.Node, binding.Generation)
	if err != nil {
		return nil, resolutionError(ErrAdapterUnavailable, captureplane.ProviderFailureUnavailable, "node_unavailable", true)
	}
	return plane, nil
}

func resolutionError(kind error, class captureplane.ProviderFailureClass, code string, retryable bool) error {
	return errors.Join(kind, captureplane.ProviderError{Class: class, Code: code, Retryable: retryable})
}

func validateAdapterKey(key adapterKey) error {
	return (mediaplane.Binding{
		SchemaVersion:       mediaplane.BindingSchemaVersion,
		Provider:            key.provider,
		ConfigurationSource: mediaplane.BindingSourceDeploymentDefault,
		AdapterFingerprint:  key.fingerprint,
	}).Validate()
}

var _ captureplane.Resolver = (*Registry)(nil)
