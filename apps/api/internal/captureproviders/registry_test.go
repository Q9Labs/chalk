package captureproviders

import (
	"context"
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var errUnsupportedTestOperation = errors.New("unsupported test operation")

func TestRegistryRoutesAuthoritativeEpisodeBindingsToDistinctAdapters(t *testing.T) {
	firstIdentity := captureIdentity(1)
	secondIdentity := captureIdentity(2)
	firstBinding := mustBinding(t, "test_provider_one", "first-test-app")
	secondBinding := mustBinding(t, "test_provider_two", "second-test-app")
	source := &bindingSource{bindings: map[utilities.ID]mediaplane.Binding{
		firstIdentity.EpisodeID:  firstBinding,
		secondIdentity.EpisodeID: secondBinding,
	}}
	registry, err := NewRegistry(source,
		Registration{Provider: firstBinding.Provider, AdapterFingerprint: firstBinding.AdapterFingerprint, Plane: firstCaptureTestPlane{}},
		Registration{Provider: secondBinding.Provider, AdapterFingerprint: secondBinding.AdapterFingerprint, Plane: alternateCaptureTestPlane{}},
	)
	if err != nil {
		t.Fatalf("new registry: %v", err)
	}

	first, err := registry.Resolve(context.Background(), firstIdentity)
	if err != nil {
		t.Fatalf("resolve first binding: %v", err)
	}
	firstResult, err := first.CreateCaptureConnection(context.Background(), captureplane.CreateCaptureConnectionInput{Metadata: operationMetadata(firstIdentity)})
	if err != nil {
		t.Fatalf("first adapter create: %v", err)
	}
	if got := firstResult.Connection.ConnectionReference.String(); got != "first-test-connection" {
		t.Fatalf("first adapter connection = %q", got)
	}

	second, err := registry.Resolve(context.Background(), secondIdentity)
	if err != nil {
		t.Fatalf("resolve second binding: %v", err)
	}
	secondResult, err := second.CreateCaptureConnection(context.Background(), captureplane.CreateCaptureConnectionInput{Metadata: operationMetadata(secondIdentity)})
	if err != nil {
		t.Fatalf("second adapter create: %v", err)
	}
	if got := secondResult.Connection.ConnectionReference.String(); got != "alternate-test-connection" {
		t.Fatalf("second adapter connection = %q", got)
	}
	if source.calls != 2 {
		t.Fatalf("binding source calls = %d, want 2", source.calls)
	}
}

func TestRegistryRejectsUnregisteredProviderWithoutFallingBack(t *testing.T) {
	identity := captureIdentity(3)
	managedBinding := mustBinding(t, "cf_sfu", "managed-sfu-test-app")
	tenantBinding := mustBinding(t, "cf_sfu", "tenant-sfu-test-app")
	source := &bindingSource{bindings: map[utilities.ID]mediaplane.Binding{
		identity.EpisodeID: tenantBinding,
	}}
	registry, err := NewRegistry(source, Registration{Provider: managedBinding.Provider, AdapterFingerprint: managedBinding.AdapterFingerprint, Plane: firstCaptureTestPlane{}})
	if err != nil {
		t.Fatalf("new registry: %v", err)
	}

	_, err = registry.Resolve(context.Background(), identity)
	if !errors.Is(err, ErrAdapterUnavailable) {
		t.Fatalf("resolve error = %v, want %v", err, ErrAdapterUnavailable)
	}
}

func TestRegistryClassifiesMissingAndUnavailableBindingAuthority(t *testing.T) {
	identity := captureIdentity(4)
	binding := mustBinding(t, "cf_sfu", "managed-sfu-test-app")
	tests := []struct {
		name          string
		sourceError   error
		wantSentinel  error
		wantCode      string
		wantRetryable bool
	}{
		{name: "legacy Episode has no frozen binding", sourceError: mediaplane.ErrInvalidBinding, wantSentinel: ErrInvalidBinding, wantCode: "invalid_binding"},
		{name: "binding store unavailable", sourceError: errors.New("store unavailable"), wantSentinel: ErrBindingUnavailable, wantCode: "binding_unavailable", wantRetryable: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			registry, err := NewRegistry(&bindingSource{err: test.sourceError}, Registration{
				Provider: binding.Provider, AdapterFingerprint: binding.AdapterFingerprint, Plane: firstCaptureTestPlane{},
			})
			if err != nil {
				t.Fatalf("new registry: %v", err)
			}
			_, err = registry.Resolve(context.Background(), identity)
			var providerErr captureplane.ProviderError
			if !errors.Is(err, test.wantSentinel) || !errors.As(err, &providerErr) {
				t.Fatalf("resolve error = %#v, want %v and bounded provider error", err, test.wantSentinel)
			}
			if providerErr.Code != test.wantCode || providerErr.Retryable != test.wantRetryable {
				t.Fatalf("provider error = %#v", providerErr)
			}
		})
	}
}

func TestNewRegistryRejectsInvalidAndDuplicateRegistrations(t *testing.T) {
	source := &bindingSource{}
	binding := mustBinding(t, "cf_sfu", "managed-sfu-test-app")
	tests := []struct {
		name          string
		source        BindingSource
		registrations []Registration
	}{
		{name: "missing source", registrations: []Registration{{Provider: binding.Provider, AdapterFingerprint: binding.AdapterFingerprint, Plane: firstCaptureTestPlane{}}}},
		{name: "missing registrations", source: source},
		{name: "missing plane", source: source, registrations: []Registration{{Provider: binding.Provider, AdapterFingerprint: binding.AdapterFingerprint}}},
		{name: "invalid provider", source: source, registrations: []Registration{{Provider: "UNKNOWN", AdapterFingerprint: binding.AdapterFingerprint, Plane: firstCaptureTestPlane{}}}},
		{name: "duplicate provider", source: source, registrations: []Registration{
			{Provider: binding.Provider, AdapterFingerprint: binding.AdapterFingerprint, Plane: firstCaptureTestPlane{}},
			{Provider: binding.Provider, AdapterFingerprint: binding.AdapterFingerprint, Plane: alternateCaptureTestPlane{}},
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := NewRegistry(test.source, test.registrations...)
			if !errors.Is(err, ErrInvalidConfig) {
				t.Fatalf("new registry error = %v, want %v", err, ErrInvalidConfig)
			}
		})
	}
}

type bindingSource struct {
	bindings map[utilities.ID]mediaplane.Binding
	calls    int
	err      error
}

func (s *bindingSource) ResolveBinding(_ context.Context, identity captureplane.CaptureIdentity) (mediaplane.Binding, error) {
	s.calls++
	if s.err != nil {
		return mediaplane.Binding{}, s.err
	}
	binding, ok := s.bindings[identity.EpisodeID]
	if !ok {
		return mediaplane.Binding{}, errors.New("binding not found")
	}
	return binding, nil
}

type unsupportedTestPlane struct{}

func (unsupportedTestPlane) PullCaptureTracks(context.Context, captureplane.PullCaptureTracksInput) (captureplane.PullCaptureTracksResult, error) {
	return captureplane.PullCaptureTracksResult{}, errUnsupportedTestOperation
}

func (unsupportedTestPlane) RenegotiateCaptureConnection(context.Context, captureplane.RenegotiateCaptureConnectionInput) (captureplane.RenegotiateCaptureConnectionResult, error) {
	return captureplane.RenegotiateCaptureConnectionResult{}, errUnsupportedTestOperation
}

func (unsupportedTestPlane) InspectCaptureConnection(context.Context, captureplane.InspectCaptureConnectionInput) (captureplane.InspectCaptureConnectionResult, error) {
	return captureplane.InspectCaptureConnectionResult{}, errUnsupportedTestOperation
}

func (unsupportedTestPlane) CloseCaptureTracks(context.Context, captureplane.CloseCaptureTracksInput) (captureplane.CloseCaptureTracksResult, error) {
	return captureplane.CloseCaptureTracksResult{}, errUnsupportedTestOperation
}

func (unsupportedTestPlane) CloseCaptureConnection(context.Context, captureplane.CloseCaptureConnectionInput) (captureplane.CloseCaptureConnectionResult, error) {
	return captureplane.CloseCaptureConnectionResult{}, errUnsupportedTestOperation
}

type firstCaptureTestPlane struct{ unsupportedTestPlane }

func (firstCaptureTestPlane) CreateCaptureConnection(_ context.Context, input captureplane.CreateCaptureConnectionInput) (captureplane.CreateCaptureConnectionResult, error) {
	return createResult(input.Metadata, "first-test-connection"), nil
}

type alternateCaptureTestPlane struct{ unsupportedTestPlane }

func (alternateCaptureTestPlane) CreateCaptureConnection(_ context.Context, input captureplane.CreateCaptureConnectionInput) (captureplane.CreateCaptureConnectionResult, error) {
	return createResult(input.Metadata, "alternate-test-connection"), nil
}

func createResult(metadata captureplane.OperationMetadata, reference string) captureplane.CreateCaptureConnectionResult {
	return captureplane.CreateCaptureConnectionResult{
		Connection: captureplane.CaptureConnection{
			ConnectionReference: captureplane.ProviderReference(reference),
			CaptureEpoch:        metadata.CaptureEpoch,
			PlanRevision:        metadata.PlanRevision,
		},
		Negotiation: captureplane.Negotiation{Requirement: captureplane.NegotiationNotRequired},
	}
}

func captureIdentity(value byte) captureplane.CaptureIdentity {
	return captureplane.CaptureIdentity{
		TenantID:    utilities.IDFromBytes([16]byte{value, 1}),
		SpaceID:     utilities.IDFromBytes([16]byte{value, 2}),
		EpisodeID:   utilities.IDFromBytes([16]byte{value, 3}),
		RecordingID: utilities.IDFromBytes([16]byte{value, 4}),
	}
}

func operationMetadata(identity captureplane.CaptureIdentity) captureplane.OperationMetadata {
	return captureplane.OperationMetadata{Identity: identity, CaptureEpoch: 1, PlanRevision: 1, IdempotencyKey: "capture-provider-test"}
}

func mustBinding(t *testing.T, provider, applicationID string) mediaplane.Binding {
	t.Helper()
	binding, err := mediaplane.NewBinding(provider, mediaplane.BindingSourceDeploymentDefault, applicationID)
	if err != nil {
		t.Fatalf("new media plane binding: %v", err)
	}
	return binding
}
